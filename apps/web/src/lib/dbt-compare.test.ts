// Runs one small project through the built-in builder and through real dbt, over two days of changes, and compares every table exactly.
// Skipped unless BASALT_DBT points at a dbt install.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildNode, runTest, sourceFreshness } from "./dbt-build.ts";
import { effectiveOf, makeCtx } from "./dbt-compile.ts";
import { dbtProjectFiles, readDbtResults } from "./dbt-project.ts";
import { topoSort } from "./graph.ts";
import type { Model, Project } from "./types.ts";

const { DuckDBInstance } = createRequire(import.meta.url)("@duckdb/node-api");
const DBT = process.env.BASALT_DBT;
const model = (name: string, sql: string, p: Partial<Model> = {}): Model => ({ id: name, name, description: "", materialized: "table", sql, tests: [], owner: "", ...p });
const SRC = "{{ source('app', 'orders') }}";
const models: Model[] = [
  model("regions", "", { kind: "seed", csv: "code,label,rate,active,opened\nN,North,1.5,true,2026-01-01\nS,,2,false,2026-02-01\n" }),
  model("v_orders", `SELECT id, status, amount, region, updated_at FROM ${SRC}`, { materialized: "view" }),
  model("eph", "WITH o AS (SELECT * FROM {{ ref('v_orders') }}) SELECT id, amount * {{ var('factor', 2) }} AS doubled FROM o", { materialized: "ephemeral" }),
  model("t_joined", "SELECT o.id, o.status, r.label, e.doubled FROM {{ ref('v_orders') }} o LEFT JOIN {{ ref('regions') }} r ON o.region = r.code JOIN {{ ref('eph') }} e ON e.id = o.id", {
    tags: ["daily"],
    tests: [
      { type: "not_null", column: "label", severity: "warn" },
      { type: "unique", column: "id", block: true },
      { type: "accepted_values", column: "status", values: ["new", "paid"], storeFailures: true },
      { type: "relationships", column: "id", to: "v_orders", field: "id" },
      { type: "custom", column: "", sql: "SELECT * FROM {{ ref('t_joined') }} WHERE doubled < 0" },
      { type: "row_count", column: "id", min: 100, errorIf: ">5", warnIf: ">0" },
    ],
  }),
  model("inc_merge", `SELECT id, status, amount FROM ${SRC}{% if is_incremental() %} WHERE updated_at > (SELECT max(u) FROM (SELECT DATE '2026-01-01' AS u)){% endif %}`, { materialized: "incremental", incrementalStrategy: "merge", uniqueKey: "id" }),
  model("inc_del", `SELECT id, status, amount FROM ${SRC}`, { materialized: "incremental", incrementalStrategy: "delete+insert", uniqueKey: "id" }),
  model("inc_two_keys", `SELECT id, region, amount FROM ${SRC}`, { materialized: "incremental", incrementalStrategy: "delete+insert", uniqueKey: "id,region" }),
  model("inc_app", `SELECT id, status FROM ${SRC}`, { materialized: "incremental", incrementalStrategy: "append" }),
  model("inc_cursor", `SELECT id, status, updated_at FROM ${SRC}`, { materialized: "incremental", cursor: "updated_at", uniqueKey: "id" }),
  model("inc_new_col", `SELECT id, status{% if var('day2', false) %}, amount{% endif %} FROM ${SRC}`, { materialized: "incremental", incrementalStrategy: "append", onSchemaChange: "append_new_columns" }),
  model("inc_sync", `SELECT id{% if var('day2', false) %}, CAST(amount AS DOUBLE) AS amount, region{% else %}, amount, status{% endif %} FROM ${SRC}`, { materialized: "incremental", incrementalStrategy: "merge", uniqueKey: "id", onSchemaChange: "sync_all_columns" }),
  model("inc_ignore", `SELECT id, status{% if var('day2', false) %}, amount{% endif %} FROM ${SRC}`, { materialized: "incremental", incrementalStrategy: "append", onSchemaChange: "ignore" }),
  model("snap_ts", `SELECT id, status, updated_at FROM ${SRC}`, { materialized: "snapshot", snapshotStrategy: "timestamp", uniqueKey: "id", updatedAt: "updated_at" }),
  model("snap_del", `SELECT id, status, updated_at FROM ${SRC}`, { materialized: "snapshot", snapshotStrategy: "timestamp", uniqueKey: "id", updatedAt: "updated_at", hardDeletes: "invalidate" }),
  model("snap_chk", `SELECT id, status, amount FROM ${SRC}`, { materialized: "snapshot", snapshotStrategy: "check", uniqueKey: "id", checkCols: "status" }),
  model("hooked", `SELECT id FROM ${SRC}`, { postHook: ["UPDATE {{ this }} SET id = id * 10"] }),
  model("contracted", `SELECT id, status FROM ${SRC}`, { contract: [{ name: "id", type: "int", notNull: true }, { name: "status", type: "varchar" }] }),
];
// Times differ by nature when a build stamps the clock, so those columns are compared as set or empty
const CLOCK = new Set(["dbt_valid_from", "dbt_valid_to", "dbt_updated_at", "dbt_scd_id"]);
const project = (day2: boolean): Project => ({ vars: day2 ? { day2: true } : {}, sources: [{ source: "app", table: "orders", loadedAtField: "updated_at", warnAfter: { count: 1, period: "day" } }], exposures: [{ name: "board", type: "dashboard", ownerName: "Finance", dependsOn: ["t_joined"] }] });
const ORDERS = "id INTEGER, status VARCHAR, amount INTEGER, region VARCHAR, updated_at TIMESTAMP";
const DAY1 = `INSERT INTO raw_app.orders VALUES (1,'new',10,'N','2026-01-01 00:00:00'),(2,'new',20,'S','2026-01-01 00:00:00'),(3,'new',30,'N','2026-01-01 00:00:00')`;
const DAY2 = `UPDATE raw_app.orders SET status = 'paid', amount = 11, updated_at = '2026-01-05 00:00:00' WHERE id = 1; DELETE FROM raw_app.orders WHERE id = 3; INSERT INTO raw_app.orders VALUES (4,'odd',40,'Z','2026-01-06 00:00:00');`;

async function withDb<T>(file: string, fn: (c: never) => Promise<T>) {
  const db = await DuckDBInstance.create(file), c = await db.connect();
  try { return await fn(c as never); } finally { c.closeSync(); db.closeSync(); }
}
const dump = (file: string) => withDb(file, async (c: { runAndReadAll(s: string): Promise<{ getRowObjectsJson(): Record<string, unknown>[] }> }) => {
  const out: Record<string, unknown> = {};
  const tables = (await c.runAndReadAll(`SELECT table_schema s, table_name t FROM information_schema.tables WHERE table_schema LIKE 'analytics%' AND table_name NOT LIKE 'not_null%' ORDER BY 1, 2`)).getRowObjectsJson();
  for (const x of tables) {
    const rel = `"${x.s}"."${x.t}"`, cols = (await c.runAndReadAll(`DESCRIBE SELECT * FROM ${rel}`)).getRowObjectsJson();
    const sel = cols.map((k) => (CLOCK.has(String(k.column_name)) && String(x.t) === "snap_chk" ? `"${k.column_name}" IS NULL AS "${k.column_name}"` : String(k.column_name) === "dbt_scd_id" && String(x.t) !== "snap_ts" ? `"dbt_scd_id" IS NULL AS "dbt_scd_id"` : String(k.column_name) === "dbt_valid_to" && String(x.t) === "snap_del" ? `"dbt_valid_to" IS NULL AS "dbt_valid_to"` : `"${k.column_name}"`)).join(", ");
    out[`${x.s}.${x.t}`] = { columns: cols.map((k) => `${k.column_name} ${k.column_type}`), rows: (await c.runAndReadAll(`SELECT ${sel} FROM ${rel} ORDER BY ALL`)).getRowObjectsJson() };
  }
  return out;
});
const setup = (file: string, sql: string) => withDb(file, async (c: { run(s: string): Promise<unknown> }) => { await c.run(sql); });

test("the built-in builder and real dbt produce the same tables", { skip: DBT ? false : "BASALT_DBT isn't set" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-cmp-")), mine = path.join(dir, "mine.duckdb"), theirs = path.join(dir, "dbt.duckdb"), proj = path.join(dir, "p");
  const dbt = (...args: string[]) => {
    const r = spawnSync(DBT!, ["--no-use-colors", ...args, "--project-dir", proj, "--profiles-dir", proj], { encoding: "utf8", env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: dir, TMP: dir, HOME: dir, USERPROFILE: dir, DBT_SEND_ANONYMOUS_USAGE_STATS: "false", PYTHONUTF8: "1" } as never });
    return { code: r.status, log: r.stdout + r.stderr };
  };
  const statuses: Record<string, string>[] = [];
  for (const [i, sql] of [DAY1, DAY2].entries()) {
    const day2 = i === 1, boot = day2 ? sql : `CREATE SCHEMA raw_app; CREATE TABLE raw_app.orders (${ORDERS}); CREATE SCHEMA analytics; ${sql}`;
    await setup(mine, boot); await setup(theirs, boot);
    const ctx = makeCtx(models, project(day2));
    const builtin: Record<string, string> = {};
    await withDb(mine, async (c: never) => {
      for (const m of topoSort(models, (x) => effectiveOf(x, ctx).deps)) {
        const e = effectiveOf(m, ctx);
        await buildNode(c, e, ctx);
        for (const [k, t] of m.tests.entries()) { const r = await runTest(c, m, t, k, ctx); builtin[r.unique_id] = r.status; }
      }
    });
    fs.rmSync(proj, { recursive: true, force: true });
    for (const [n, text] of Object.entries(dbtProjectFiles(ctx, theirs))) { const p = path.join(proj, ...n.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
    const seed = dbt("seed", "--target", "seed"); assert.equal(seed.code, 0, seed.log);
    const run = dbt("build", "--exclude", "resource_type:seed");
    const results = JSON.parse(fs.readFileSync(path.join(proj, "target", "run_results.json"), "utf8"));
    const got = readDbtResults(results, ctx), real: Record<string, string> = {};
    for (const r of got.results) if (r.unique_id.startsWith("test.")) real[r.unique_id] = r.status;
    const crashed = got.results.filter((r) => r.status === "error").map((r) => `${r.unique_id}: ${r.message}`);
    assert.deepEqual(crashed, [], run.log.slice(-3000));
    assert.deepEqual(real, builtin, `check statuses differ on day ${i + 1}`);
    statuses.push(builtin);
    assert.deepEqual(await dump(mine), await dump(theirs), `tables differ on day ${i + 1}`);
  }
  // Pinned so a silent change in both engines can't pass
  assert.equal(statuses[0]["test.basalt.not_null_t_joined_label"], "warn");
  assert.equal(statuses[1]["test.basalt.accepted_values_t_joined_status"], "fail");
  assert.equal(statuses[0]["test.basalt.row_count_t_joined_id"], "warn");
  await withDb(mine, async (c: never) => {
    const f = await sourceFreshness(c, makeCtx(models, project(true)));
    assert.equal(f.results[0].status, "warn");
  });
  const fresh = dbt("source", "freshness");
  assert.equal(JSON.parse(fs.readFileSync(path.join(proj, "target", "sources.json"), "utf8")).results[0].status, "warn", fresh.log);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the generated dbt project can't read files or carry secrets", { skip: DBT ? false : "BASALT_DBT isn't set" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-sec-")), proj = path.join(dir, "p"), file = path.join(dir, "w.duckdb"), secret = path.join(dir, "secret.txt");
  fs.writeFileSync(secret, "a\nTOPSECRET\n");
  await setup(file, "CREATE SCHEMA analytics");
  const list = [
    model("leak_file", `SELECT * FROM read_csv('${secret.replace(/\\/g, "/")}')`),
    model("literal", "SELECT '{{ \"{{\" }}' AS a, 'x' LIKE '{%' AS b"),
    model("described", "SELECT 1 AS id", { description: "{{ env_var('BASALT_SECRET_TEST') }}" }),
  ];
  const ctx = makeCtx(list);
  for (const [n, text] of Object.entries(dbtProjectFiles(ctx, file))) { const p = path.join(proj, ...n.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  assert.ok(!Object.values(dbtProjectFiles(ctx, file)).some((t) => /env_var\('BASALT_SECRET_TEST'\) \}\}(?! \}\})/.test(t) && !t.includes("{{ '{{' }}")));
  const r = spawnSync(DBT!, ["--no-use-colors", "build", "--project-dir", proj, "--profiles-dir", proj], { encoding: "utf8", env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: dir, TMP: dir, HOME: dir, USERPROFILE: dir, DBT_SEND_ANONYMOUS_USAGE_STATS: "false", PYTHONUTF8: "1" } as never });
  const res = JSON.parse(fs.readFileSync(path.join(proj, "target", "run_results.json"), "utf8")).results as { unique_id: string; status: string; message: string }[];
  const by = Object.fromEntries(res.map((x) => [x.unique_id, x]));
  assert.equal(by["model.basalt.leak_file"].status, "error", r.stdout);
  assert.match(by["model.basalt.leak_file"].message, /file system operations are disabled/);
  assert.equal(by["model.basalt.described"].status, "success", r.stdout);
  assert.equal(by["model.basalt.literal"].status, "success", r.stdout);
  const rows = await withDb(file, async (c: { runAndReadAll(s: string): Promise<{ getRowObjectsJson(): unknown[] }> }) => (await c.runAndReadAll("SELECT a, b FROM analytics.literal")).getRowObjectsJson());
  assert.deepEqual(rows, [{ a: "{{", b: false }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
