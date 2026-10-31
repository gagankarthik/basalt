// The built-in builder. Incremental strategies, on_schema_change and snapshots are ported from dbt-core's global_project macros and
// dbt-duckdb's overrides, and freshness from dbt-core (Apache-2.0); see NOTICE. Takes a connection so it runs without the server and against any DuckDB file.
import type { DuckDBConnection } from "@duckdb/node-api";
import { compileModel, effectiveOf, renderSql, testSql, testStatus, testName, auditName, type Ctx, type Effective } from "./dbt-compile.ts";
import { nodeId } from "./dbt-select.ts";
import { lit, q } from "./sql.ts";
import type { Exposure, FreshnessRule, Model, ModelTest } from "./types.ts";

type Conn = DuckDBConnection;
const rows = async (c: Conn, sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
const describe = async (c: Conn, rel: string) => (await rows(c, `DESCRIBE SELECT * FROM ${rel}`)).map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
const keysOf = (m: Model) => (m.uniqueKey ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const stripComments = (s: string) => s.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "");

/** One SELECT and nothing after it, checked by DuckDB's parser, so a model can't smuggle in another statement. */
export async function assertSelect(c: Conn, sql: string, what: string) {
  const r = JSON.parse(String((await rows(c, `SELECT json_serialize_sql(${lit(sql)}) AS s`))[0].s));
  if (r.error) throw new Error(`${what} has to be one SELECT statement. ${r.error_message ?? ""}`.trim());
  if (r.statements?.length !== 1) throw new Error(`${what} has to be one SELECT statement.`);
}
const HOOK = /^(insert|update|delete|merge|create|alter|drop|select|with)\b/i;
/** Hooks run on the warehouse, so they get the same limits as the SQL editor and can't end the build's transaction or change settings. */
export async function assertHook(c: Conn, sql: string) {
  const st = await c.extractStatements(sql);
  if (st.count !== 1) throw new Error("Each hook has to be one SQL statement.");
  if (!HOOK.test(stripComments(sql))) throw new Error("A hook can only use INSERT, UPDATE, DELETE, MERGE, CREATE, ALTER, DROP or SELECT.");
}
const hooks = async (c: Conn, list: string[] | undefined, ctx: Ctx, self: string) => { for (const h of list ?? []) { const sql = renderSql(h, ctx, self); await assertHook(c, sql); await c.run(sql); } };

/* ---- seeds ---- */
export function parseCsv(text: string) {
  const out: string[][] = []; let row: string[] = [], cell = "", inQ = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch; continue; }
    if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x !== "") || row.length > 1) out.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}
async function buildSeed(c: Conn, m: Model) {
  const [head, ...body] = parseCsv(m.csv ?? "");
  if (!head?.length) throw new Error("This seed has no CSV data.");
  const dup = head.find((h, i) => head.indexOf(h) !== i); if (dup) throw new Error(`The seed has the column ${dup} twice.`);
  const bad = body.findIndex((r) => r.length !== head.length); if (bad >= 0) throw new Error(`Row ${bad + 2} of the seed has ${body[bad].length} values, not ${head.length}.`);
  await c.run(`CREATE OR REPLACE TEMP TABLE _seed (${head.map((h) => `${q(h)} VARCHAR`).join(", ")})`);
  const app = await c.createAppender("_seed", "main", "temp");
  for (const r of body) { for (const v of r) { if (v === "") app.appendNull(); else app.appendVarchar(v); } app.endRow(); }
  app.closeSync();
  // The order dbt's CSV type inference settles on
  const types: string[] = [];
  for (const h of head) {
    let chosen = "VARCHAR";
    for (const t of ["INTEGER", "BIGINT", "DOUBLE", "BOOLEAN", "DATE", "TIMESTAMP"]) {
      // TRY_CAST rounds 1.5 to an integer instead of failing
      if (t.endsWith("INT") || t === "INTEGER") { if (body.some((r) => r[head.indexOf(h)] !== "" && !/^-?\d+$/.test(r[head.indexOf(h)]))) continue; }
      const r = (await rows(c, `SELECT count(${q(h)}) a, count(TRY_CAST(${q(h)} AS ${t})) b FROM _seed`))[0];
      if (Number(r.a) > 0 && r.a === r.b) { chosen = t; break; }
    }
    types.push(chosen);
  }
  await c.run(`CREATE OR REPLACE TABLE "analytics".${q(m.name)} AS SELECT ${head.map((h, i) => `TRY_CAST(${q(h)} AS ${types[i]}) AS ${q(h)}`).join(", ")} FROM _seed`);
  await c.run("DROP TABLE _seed");
  return `Loaded ${body.length} rows`;
}

/* ---- contracts ---- */
const TYPE = /^[\w ,()[\]]+$/;
export async function checkContract(c: Conn, m: Model, compiled: string) {
  const want = m.contract!, mismatches: string[] = [];
  const have = await rows(c, `DESCRIBE ${compiled}`), found = new Map(have.map((r) => [String(r.column_name).toLowerCase(), String(r.column_type)]));
  for (const col of want) {
    if (!col.type || !TYPE.test(col.type)) throw new Error(`The contract for ${col.name} needs a valid data type.`);
    const canon = String((await rows(c, `SELECT typeof(CAST(NULL AS ${col.type})) t`))[0].t), got = found.get(col.name.toLowerCase());
    if (!got) mismatches.push(`${col.name} is in the contract but not the query`);
    else if (got !== canon) mismatches.push(`${col.name} is ${got}, and the contract says ${canon}`);
  }
  for (const r of have) if (!want.some((x) => same(x.name, String(r.column_name)))) mismatches.push(`${r.column_name} is in the query but not the contract`);
  if (mismatches.length) throw new Error(`Contract failed: ${mismatches.join("; ")}.`);
}
const contractDdl = (m: Model) => m.contract!.map((x) => [q(x.name), x.type, x.primaryKey ? "PRIMARY KEY" : "", x.notNull ? "NOT NULL" : "", x.unique ? "UNIQUE" : ""].filter(Boolean).join(" ")).join(", ");
async function createTable(c: Conn, m: Model, compiled: string) {
  const t = `"analytics".${q(m.name)}`;
  if (!m.contract?.length) { await c.run(`CREATE OR REPLACE TABLE ${t} AS ${compiled}`); return; }
  await c.run(`CREATE OR REPLACE TABLE ${t} (${contractDdl(m)})`);
  const names = m.contract.map((x) => q(x.name)).join(", ");
  await c.run(`INSERT INTO ${t} (${names}) SELECT ${names} FROM (\n${compiled}\n)`);
}

/* ---- incremental ---- */
async function legacyIncremental(c: Conn, m: Model, compiled: string) {
  const t = `"analytics".${q(m.name)}`;
  // >= with a key catches rows sharing the last cursor value; without a key that would add duplicates, so it stays >
  const op = m.uniqueKey ? ">=" : ">";
  await c.run(`CREATE OR REPLACE TEMP TABLE _inc AS SELECT * FROM (\n${compiled}\n) WHERE ${q(m.cursor!)} ${op} (SELECT max(${q(m.cursor!)}) FROM ${t}) OR (SELECT max(${q(m.cursor!)}) FROM ${t}) IS NULL`);
  const n = Number((await rows(c, "SELECT count(*) n FROM _inc"))[0].n);
  if (m.uniqueKey) await c.run(`DELETE FROM ${t} WHERE ${q(m.uniqueKey)} IN (SELECT ${q(m.uniqueKey)} FROM _inc)`);
  await c.run(`INSERT INTO ${t} BY NAME SELECT * FROM _inc`);
  await c.run("DROP TABLE _inc");
  return `Processed ${n} new or changed rows`;
}
async function strategyIncremental(c: Conn, m: Effective, compiled: string) {
  const t = `"analytics".${q(m.name)}`, change = m.onSchemaChange ?? "ignore", keys = keysOf(m);
  const filter = m.cursor ? ` WHERE ${q(m.cursor)} ${keys.length ? ">=" : ">"} (SELECT max(${q(m.cursor)}) FROM ${t}) OR (SELECT max(${q(m.cursor)}) FROM ${t}) IS NULL` : "";
  await c.run(`CREATE OR REPLACE TEMP TABLE _inc AS SELECT * FROM (\n${compiled}\n)${filter}`);
  const n = Number((await rows(c, "SELECT count(*) n FROM _inc"))[0].n);
  const source = await describe(c, "_inc"), target = await describe(c, t);
  let dest = target;
  if (change !== "ignore") {
    const add = source.filter((s) => !target.some((x) => same(x.name, s.name))), drop = target.filter((x) => !source.some((s) => same(x.name, s.name)));
    const retype = source.filter((s) => { const x = target.find((y) => same(y.name, s.name)); return x && x.type !== s.type; });
    if ((add.length || drop.length || retype.length) && change === "fail") throw new Error(`The source and target schemas on this incremental model are out of sync. Source columns not in target: ${add.map((x) => x.name).join(", ") || "none"}. Target columns not in source: ${drop.map((x) => x.name).join(", ") || "none"}. New column types: ${retype.map((x) => `${x.name} ${x.type}`).join(", ") || "none"}.`);
    for (const a of add) await c.run(`ALTER TABLE ${t} ADD COLUMN ${q(a.name)} ${a.type}`);
    if (change === "sync_all_columns") {
      for (const d of drop) await c.run(`ALTER TABLE ${t} DROP COLUMN ${q(d.name)}`);
      // dbt's alter_column_type: add, copy, drop, rename. It moves the column to the end, and matching that keeps the two engines' tables identical.
      for (const r of retype) {
        const tmp = q(`${r.name}__dbt_alter`);
        await c.run(`ALTER TABLE ${t} ADD COLUMN ${tmp} ${r.type}`);
        await c.run(`UPDATE ${t} SET ${tmp} = CAST(${q(r.name)} AS ${r.type})`);
        await c.run(`ALTER TABLE ${t} DROP COLUMN ${q(r.name)}`);
        await c.run(`ALTER TABLE ${t} RENAME COLUMN ${tmp} TO ${q(r.name)}`);
      }
    }
    dest = source;
  }
  const cols = dest.map((x) => q(x.name)).join(", ");
  // dbt-duckdb's default strategy is delete+insert, which is a plain insert when there's no key
  const strategy = m.incrementalStrategy ?? "delete+insert";
  if (strategy === "append" || (strategy === "delete+insert" && !keys.length)) await c.run(`INSERT INTO ${t} (${cols}) SELECT ${cols} FROM _inc`);
  else if (strategy === "delete+insert") {
    if (keys.length === 1) await c.run(`DELETE FROM ${t} WHERE (${q(keys[0])}) IN (SELECT (${q(keys[0])}) FROM _inc)`);
    else await c.run(`DELETE FROM ${t} AS d USING _inc WHERE ${keys.map((k) => `_inc.${q(k)} = d.${q(k)}`).join(" AND ")}`);
    await c.run(`INSERT INTO ${t} (${cols}) SELECT ${cols} FROM _inc`);
  } else {
    const on = keys.length ? keys.map((k) => `s.${q(k)} = d.${q(k)}`).join(" AND ") : "FALSE";
    const update = keys.length ? `WHEN MATCHED THEN UPDATE SET ${dest.map((x) => `${q(x.name)} = s.${q(x.name)}`).join(", ")} ` : "";
    await c.run(`MERGE INTO ${t} AS d USING _inc AS s ON (${on}) ${update}WHEN NOT MATCHED THEN INSERT (${cols}) VALUES (${dest.map((x) => `s.${q(x.name)}`).join(", ")})`);
  }
  await c.run("DROP TABLE _inc");
  return `Processed ${n} new or changed rows`;
}

/* ---- snapshots ---- */
/** The original history table: closes a changed or removed row and keeps _valid_from and _valid_to. */
async function legacySnapshot(c: Conn, m: Model, compiled: string, exists: boolean) {
  const t = `"analytics".${q(m.name)}`, key = m.uniqueKey;
  if (!key) throw new Error("Choose a unique key for this snapshot.");
  const cols = (await rows(c, `DESCRIBE ${compiled}`)).map((r) => String(r.column_name));
  if (!cols.includes(key)) throw new Error(`The unique key ${key} isn't a column of this model.`);
  const hash = `md5(concat_ws('|', ${cols.map((x) => `coalesce(CAST(${q(x)} AS VARCHAR), chr(0))`).join(", ")}))`;
  await c.run(`CREATE OR REPLACE TEMP TABLE _snap AS SELECT *, ${hash} AS _row_hash FROM (\n${compiled}\n)`);
  const dupes = Number((await rows(c, `SELECT count(*) n FROM (SELECT ${q(key)} FROM _snap GROUP BY 1 HAVING count(*) > 1)`))[0].n);
  if (dupes) throw new Error(`The unique key ${key} has ${dupes} duplicated values, so history can't be tracked.`);
  const now = "now()::TIMESTAMP";
  if (!exists) { await c.run(`CREATE TABLE ${t} AS SELECT *, ${now} AS _valid_from, CAST(NULL AS TIMESTAMP) AS _valid_to FROM _snap`); return "Took the first snapshot"; }
  const have = (await rows(c, `SELECT column_name n FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = ${lit(m.name)}`)).map((r) => String(r.n));
  const missing = cols.filter((x) => !have.includes(x));
  if (missing.length) throw new Error(`This model has new columns (${missing.join(", ")}). Snapshots keep history, so add them to the table or start a new snapshot.`);
  await c.run(`UPDATE ${t} SET _valid_to = ${now} WHERE _valid_to IS NULL AND NOT EXISTS (SELECT 1 FROM _snap s WHERE s.${q(key)} = ${t}.${q(key)} AND s._row_hash = ${t}._row_hash)`);
  await c.run(`INSERT INTO ${t} BY NAME SELECT s.*, ${now} AS _valid_from, CAST(NULL AS TIMESTAMP) AS _valid_to FROM _snap s WHERE NOT EXISTS (SELECT 1 FROM ${t} x WHERE x.${q(key)} = s.${q(key)} AND x._valid_to IS NULL)`);
  await c.run("DROP TABLE _snap");
  return "Recorded changes";
}
const SNAP_TIME = "now()::timestamp";
async function strategySnapshot(c: Conn, m: Effective, compiled: string, exists: boolean) {
  const t = `"analytics".${q(m.name)}`, keys = keysOf(m), strategy = m.snapshotStrategy!;
  if (!keys.length) throw new Error("Choose a unique key for this snapshot.");
  if (strategy === "timestamp" && !m.updatedAt) throw new Error("A timestamp snapshot needs an updated_at column.");
  const updated = m.updatedAt ? q(m.updatedAt) : SNAP_TIME;
  const scd = `md5(${[...keys.map(q), updated].map((a) => `coalesce(cast(${a} as varchar), '')`).join(` || '|' || `)})`;
  const valid = `${scd} AS dbt_scd_id, ${updated} AS dbt_updated_at, ${updated} AS dbt_valid_from, nullif(${updated}, ${updated}) AS dbt_valid_to`;
  if (!exists) { await c.run(`CREATE TABLE ${t} AS SELECT *, ${valid} FROM (\n${compiled}\n) sbq`); return "Took the first snapshot"; }
  const target = await describe(c, t);
  if (!target.some((x) => x.name === "dbt_valid_from")) throw new Error("This table was built before snapshot strategies were set. Rename the model or drop the table to start a new snapshot.");
  await c.run(`CREATE OR REPLACE TEMP TABLE _snap AS SELECT * FROM (\n${compiled}\n)`);
  const source = await describe(c, "_snap"), join = keys.map((k) => `s.${q(k)} = d.${q(k)}`).join(" AND ");
  const dupes = Number((await rows(c, `SELECT count(*) n FROM (SELECT ${keys.map(q).join(", ")} FROM _snap GROUP BY ALL HAVING count(*) > 1)`))[0].n);
  if (dupes) throw new Error(`The unique key ${keys.join(", ")} has ${dupes} duplicated values, so history can't be tracked.`);
  const added = source.filter((s) => !target.some((x) => same(x.name, s.name)));
  for (const a of added) await c.run(`ALTER TABLE ${t} ADD COLUMN ${q(a.name)} ${a.type}`);
  let changed: string;
  if (strategy === "timestamp") changed = `d.dbt_valid_from < s.${q(m.updatedAt!)}`;
  else {
    const list = !m.checkCols || m.checkCols === "all" ? source.map((x) => x.name) : m.checkCols.split(",").map((x) => x.trim()).filter(Boolean);
    const existing = list.filter((x) => target.some((y) => same(y.name, x))), addedChecked = list.length !== existing.length;
    changed = addedChecked ? "TRUE" : `(${existing.map((x) => `d.${q(x)} IS DISTINCT FROM s.${q(x)}`).join(" OR ") || "FALSE"})`;
  }
  const su = m.updatedAt ? `s.${q(m.updatedAt)}` : SNAP_TIME;
  await c.run(`CREATE OR REPLACE TEMP TABLE _changed AS SELECT ${keys.map((k) => `s.${q(k)}`).join(", ")}, ${su} AS _at FROM _snap s JOIN ${t} d ON ${join} WHERE d.dbt_valid_to IS NULL AND ${changed}`);
  await c.run(`UPDATE ${t} AS d SET dbt_valid_to = s._at FROM _changed s WHERE ${join} AND d.dbt_valid_to IS NULL`);
  if (m.hardDeletes === "invalidate") await c.run(`UPDATE ${t} AS d SET dbt_valid_to = ${SNAP_TIME} WHERE d.dbt_valid_to IS NULL AND NOT EXISTS (SELECT 1 FROM _snap s WHERE ${join})`);
  const insertCols = [...source.map((x) => q(x.name)), "dbt_scd_id", "dbt_updated_at", "dbt_valid_from", "dbt_valid_to"].join(", ");
  await c.run(`INSERT INTO ${t} (${insertCols}) SELECT *, ${valid} FROM _snap s WHERE NOT EXISTS (SELECT 1 FROM ${t} d WHERE ${join} AND d.dbt_valid_to IS NULL)`);
  await c.run("DROP TABLE _snap"); await c.run("DROP TABLE _changed");
  return "Recorded changes";
}

/* ---- one node ---- */
/** Builds a SQL, steps or seed model. Its DDL, DML and hooks commit together, so a failed hook leaves the old table in place. */
export async function buildNode(c: Conn, m: Effective, ctx: Ctx, fullRefresh = false): Promise<string> {
  if (m.jinja) throw new Error("This model uses full Jinja, which needs the dbt engine, and it isn't available on this server. Contact your administrator.");
  if (m.compileError) throw new Error(m.compileError);
  if (m.materialized === "ephemeral" && m.kind !== "seed") { compileModel(m, ctx); return "Ephemeral: used inside the models that refer to it"; }
  const t = `"analytics".${q(m.name)}`, seed = m.kind === "seed";
  const type = !seed && m.materialized === "view" ? "VIEW" : "BASE TABLE";
  const had = (await rows(c, `SELECT table_type t FROM information_schema.tables WHERE table_schema = 'analytics' AND table_name = ${lit(m.name)}`))[0]?.t as string | undefined;
  const isInc = m.materialized === "incremental" && !seed, exists = had === "BASE TABLE";
  const compiled = seed ? "" : compileModel(m, ctx, isInc && exists && !fullRefresh);
  if (!seed) await assertSelect(c, compiled, `The model ${m.name}`);
  if (m.contract?.length) {
    if (seed || m.materialized === "snapshot") throw new Error("Contracts apply to tables, views and incremental models.");
    if (isInc && m.onSchemaChange !== "append_new_columns" && m.onSchemaChange !== "fail") throw new Error("A contract on an incremental model needs on_schema_change set to append_new_columns or fail.");
    await checkContract(c, m, compiled);
  }
  if (isInc && !m.cursor && !m.incrementalStrategy && !m.onSchemaChange && !m.sql.includes("is_incremental")) throw new Error("Choose a cursor column for this incremental model.");
  await c.run("BEGIN");
  try {
    // a model can switch between view and table, and DuckDB won't replace one with the other
    if (had && had !== type) await c.run(`DROP ${had === "VIEW" ? "VIEW" : "TABLE"} ${t} CASCADE`);
    await hooks(c, m.preHook, ctx, m.name);
    let message: string;
    if (seed) message = await buildSeed(c, m);
    else if (isInc) {
      if (!exists || fullRefresh) { await createTable(c, m, compiled); message = "Built in full"; }
      else if (!m.incrementalStrategy && !m.onSchemaChange && m.cursor) message = await legacyIncremental(c, m, compiled);
      else message = await strategyIncremental(c, m, compiled);
    } else if (m.materialized === "snapshot") message = m.snapshotStrategy ? await strategySnapshot(c, m, compiled, exists) : await legacySnapshot(c, m, compiled, exists);
    else if (m.materialized === "view") { await c.run(`CREATE OR REPLACE VIEW ${t} AS ${compiled}`); message = "CREATE VIEW"; }
    else { await createTable(c, m, compiled); message = "CREATE TABLE"; }
    await hooks(c, m.postHook, ctx, m.name);
    await c.run("COMMIT");
    return message;
  } catch (e) { await c.run("ROLLBACK").catch(() => {}); throw e; }
}

/* ---- tests ---- */
export const AUDIT_SCHEMA = "analytics_dbt_test__audit";
export type TestResult = { unique_id: string; status: "pass" | "warn" | "fail" | "error"; failures: number | null; execution_time: number; message: string | null };
export async function runTest(c: Conn, m: Model, t: ModelTest, i: number, ctx: Ctx): Promise<TestResult> {
  const unique_id = `test.basalt.${testName(m, t)}`, t0 = Date.now(), done = (status: TestResult["status"], failures: number | null, message: string | null): TestResult => ({ unique_id, status, failures, execution_time: (Date.now() - t0) / 1000, message });
  try {
    const sql = testSql(m, t, ctx);
    await assertSelect(c, sql, "A check");
    const n = Number((await rows(c, `SELECT count(*) n FROM (\n${sql}\n)`))[0].n), status = testStatus(n, t);
    if (t.storeFailures) { await c.run(`CREATE SCHEMA IF NOT EXISTS ${AUDIT_SCHEMA}`); await c.run(`CREATE OR REPLACE TABLE ${AUDIT_SCHEMA}.${q(auditName(m, i))} AS ${sql}`); }
    return done(status, n, n ? `${n} rows failed` : null);
  } catch (e) { return done("error", null, e instanceof Error ? e.message : String(e)); }
}

/* ---- source freshness ---- */
const secs = (r?: FreshnessRule) => (r ? r.count * { minute: 60, hour: 3600, day: 86400 }[r.period] : Infinity);
/** Ported from FreshnessThreshold.status: error_after first, then warn_after. */
export const freshnessStatus = (age: number, warn?: FreshnessRule, error?: FreshnessRule) => (age > secs(error) ? "error" : age > secs(warn) ? "warn" : "pass");
export async function sourceFreshness(c: Conn, ctx: Ctx) {
  const results: Record<string, unknown>[] = [], t0 = Date.now();
  for (const s of ctx.project.sources ?? []) {
    if (!s.warnAfter && !s.errorAfter) continue;
    const unique_id = `source.basalt.${s.source}.${s.table}`, field = s.loadedAtField || "_basalt_synced_at";
    try {
      const r = (await rows(c, `SELECT max(${q(field)})::VARCHAR AS max_loaded_at, now()::TIMESTAMP::VARCHAR AS snapshotted_at, date_diff('second', max(${q(field)})::TIMESTAMP, now()::TIMESTAMP) AS age FROM ${q(`raw_${s.source}`)}.${q(s.table)}${s.filter ? ` WHERE ${s.filter}` : ""}`))[0];
      const age = r.age == null ? Infinity : Number(r.age);
      results.push({ unique_id, max_loaded_at: r.max_loaded_at, snapshotted_at: r.snapshotted_at, max_loaded_at_time_ago_in_s: Number.isFinite(age) ? age : null, status: freshnessStatus(age, s.warnAfter, s.errorAfter), criteria: { warn_after: s.warnAfter ?? null, error_after: s.errorAfter ?? null, filter: s.filter ?? null } });
    } catch (e) { results.push({ unique_id, status: "runtime error", error: e instanceof Error ? e.message : String(e) }); }
  }
  return { metadata: { generated_at: new Date().toISOString(), dbt_schema_version: "https://schemas.getdbt.com/dbt/sources/v3.json" }, results, elapsed_time: (Date.now() - t0) / 1000 };
}

/* ---- artifacts ---- */
const exposureNode = (x: Exposure) => ({ unique_id: `exposure.basalt.${x.name}`, name: x.name, resource_type: "exposure", type: x.type, owner: { name: x.ownerName, email: x.ownerEmail ?? null }, url: x.url ?? null, description: x.description ?? "", maturity: x.maturity ?? null, depends_on: { nodes: x.dependsOn.map((d) => `model.basalt.${d}`) } });
/** manifest.json's shape, for the whole project. */
export function buildManifest(ctx: Ctx, metadata: Record<string, unknown> = {}) {
  const nodes: Record<string, unknown> = {}, sources: Record<string, unknown> = {}, parent_map: Record<string, string[]> = {}, child_map: Record<string, string[]> = {};
  const idOf = (n: string) => { const x = ctx.byName.get(n); return x ? nodeId(effectiveOf(x, ctx)) : `model.basalt.${n}`; };
  const addEdge = (id: string, parents: string[]) => { parent_map[id] = parents; child_map[id] ??= []; for (const p of parents) (child_map[p] ??= []).push(id); };
  for (const m of ctx.models) {
    const e = effectiveOf(m, ctx), id = nodeId(e);
    let compiled: string | null = null; try { if (m.kind !== "seed" && !m.jinja) compiled = compileModel(m, ctx); } catch { /* shown when the model builds */ }
    const parents = [...e.deps.map(idOf), ...e.srcs.map((s) => `source.basalt.${s.slice(4)}`)];
    nodes[id] = { unique_id: id, name: m.name, resource_type: id.split(".")[0], schema: "analytics", tags: e.tags ?? [], config: { materialized: e.materialized, incremental_strategy: e.incrementalStrategy ?? null, on_schema_change: e.onSchemaChange ?? "ignore", unique_key: e.uniqueKey ?? null, strategy: e.snapshotStrategy ?? null, updated_at: e.updatedAt ?? null, check_cols: e.checkCols ?? null, contract: { enforced: !!m.contract?.length }, "pre-hook": e.preHook ?? [], "post-hook": e.postHook ?? [] }, raw_code: m.kind === "seed" ? "" : m.sql, compiled_code: compiled, description: m.description, columns: Object.fromEntries([...new Set([...Object.keys(m.columnDocs ?? {}), ...(m.contract ?? []).map((x) => x.name)])].map((n) => [n, { name: n, description: m.columnDocs?.[n] ?? "", data_type: m.contract?.find((x) => x.name === n)?.type ?? null }])), depends_on: { nodes: parents }, meta: { owner: m.owner } };
    addEdge(id, parents);
    m.tests.forEach((t, i) => { const tid = `test.basalt.${auditName(m, i)}`; nodes[tid] = { unique_id: tid, name: auditName(m, i), resource_type: "test", config: { severity: (t.severity ?? "error").toUpperCase(), error_if: t.errorIf ?? "!=0", warn_if: t.warnIf ?? "!=0", store_failures: !!t.storeFailures, where: t.where ?? null }, column_name: t.column || null, depends_on: { nodes: [id] } }; addEdge(tid, [id]); });
  }
  for (const s of ctx.project.sources ?? []) { const id = `source.basalt.${s.source}.${s.table}`; sources[id] = { unique_id: id, source_name: s.source, name: s.table, schema: `raw_${s.source}`, description: s.description ?? "", loaded_at_field: s.loadedAtField ?? "_basalt_synced_at", freshness: { warn_after: s.warnAfter ?? null, error_after: s.errorAfter ?? null, filter: s.filter ?? null } }; }
  const exposures = Object.fromEntries((ctx.project.exposures ?? []).map((x) => { const n = exposureNode(x); n.depends_on.nodes = x.dependsOn.map(idOf); addEdge(n.unique_id, n.depends_on.nodes); return [n.unique_id, n]; }));
  return { metadata, nodes, sources, exposures, macros: {}, parent_map, child_map };
}
/** catalog.json's shape, read from the warehouse. */
export async function buildCatalog(c: Conn, ctx: Ctx) {
  const cols = await rows(c, `SELECT table_schema s, table_name t, column_name n, data_type y, ordinal_position i FROM information_schema.columns WHERE table_schema = 'analytics' OR table_schema LIKE 'raw\\_%' ESCAPE '\\' ORDER BY 1, 2, 5`);
  const nodes: Record<string, unknown> = {}, sources: Record<string, unknown> = {}, ids = new Map(ctx.models.map((m) => [m.name, nodeId(effectiveOf(m, ctx))]));
  for (const r of cols) {
    const s = String(r.s), t = String(r.t), bag = s === "analytics" ? nodes : sources, id = s === "analytics" ? ids.get(t) : `source.basalt.${s.slice(4)}.${t}`;
    if (!id) continue;
    const e = (bag[id] ??= { unique_id: id, metadata: { schema: s, name: t }, columns: {} }) as { columns: Record<string, unknown> };
    e.columns[String(r.n)] = { name: r.n, type: r.y, index: Number(r.i) };
  }
  return { metadata: { generated_at: new Date().toISOString() }, nodes, sources };
}
