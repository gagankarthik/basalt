import "server-only";
import crypto from "node:crypto";
import { HttpError } from "./auth";
import { toDuckType } from "./connectors";
import { withConn } from "./engine";
import { getConfig, getSecret, maskSalt, readJson, saveSecret, writeJson } from "./files";
import { publish, rebuildAfter } from "./live";
import { lit, q } from "@/lib/sql";
import { detectLive, maskExpr, scanStructured } from "@/lib/pii";
import { isNestedType, pgArrayJson } from "@/lib/nested";

export type CdcChange = { table: string; op: "upsert" | "delete" | "truncate"; row?: Record<string, string | null>; unchanged?: string[] };
export type CdcStatus = { enabledAt?: string; lastAt?: string; lastLsn?: string; applied?: number; skipped?: string[]; lastError?: string };
const FILE = "cdc-status.json";
export const getCdcStatus = () => readJson<Record<string, CdcStatus>>(FILE, {});
const setStatus = (id: string, p: Partial<CdcStatus>) => writeJson(FILE, { ...getCdcStatus(), [id]: { ...getCdcStatus()[id], ...p } });

export function enableCdc(id: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  saveSecret(`cdc:${id}`, token);
  setStatus(id, { enabledAt: new Date().toISOString(), lastError: undefined });
  return token;
}
export function checkCdcToken(id: string, token: string) {
  const good = getSecret(`cdc:${id}`);
  if (!good || !token) return false;
  const a = crypto.createHash("sha256").update(good).digest(), b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

const g = globalThis as unknown as { __basaltCdc?: { queue: Promise<unknown>; dirty: Set<string>; held?: Set<string> } };
const shared = (g.__basaltCdc ??= { queue: Promise.resolve(), dirty: new Set<string>() });
const held = (shared.held ??= new Set<string>());
/**
 * A sync replaces rows from a snapshot, so a change applied while it runs would be overwritten, and the worker would already have moved past it.
 * While a sync runs the worker is told to wait, and it sends those changes again afterwards.
 */
export const holdChanges = (id: string) => held.add(id);
export const releaseChanges = (id: string) => held.delete(id);
export const takeDirtyPipelines = () => { const d = [...shared.dirty]; shared.dirty.clear(); return d; };

type Row = { key: string; row: Record<string, string | null>; unchanged: Set<string> };
/** Later changes to the same row win, and merge with earlier ones in the batch. */
export function reduceChanges(changes: CdcChange[], pk: string) {
  const upserts = new Map<string, Row>(), deletes = new Set<string>();
  for (const c of changes) {
    const key = c.row?.[pk];
    if (key == null) continue;
    if (c.op === "delete") { upserts.delete(key); deletes.add(key); continue; }
    const before = upserts.get(key);
    const row = { ...before?.row, ...c.row };
    const unchanged = new Set([...(before?.unchanged ?? []), ...(c.unchanged ?? [])].filter((u) => !(c.row && u in c.row) && !(before && u in before.row)));
    upserts.set(key, { key, row, unchanged });
    deletes.delete(key);
  }
  return { upserts: [...upserts.values()], deletes: [...deletes] };
}

async function applyStream(slug: string, stream: string, pk: string, rules: Record<string, string>, changes: CdcChange[], types: Record<string, string>, note: (m: string) => void) {
  const schema = `raw_${slug}`, name = stream.replace(/\W/g, "_"), dest = `${q(schema)}.${q(name)}`, salt = maskSalt();
  return withConn(async (c) => {
    const info = (await c.runAndReadAll(`SELECT column_name n, data_type d FROM information_schema.columns WHERE table_schema = ${lit(schema)} AND table_name = ${lit(name)} ORDER BY ordinal_position`)).getRowObjectsJson() as { n: string; d: string }[];
    if (!info.length) return `${stream}: run a full sync first`;
    await c.run("BEGIN");
    try {
      const lastTruncate = changes.map((x) => x.op).lastIndexOf("truncate");
      if (changes.some((x) => x.op === "delete" && x.row?.[pk] == null)) note(`${stream}: a delete didn't include ${pk}, so it couldn't be applied. Make ${pk} the table's primary key or replica identity`);
      if (lastTruncate >= 0) await c.run(`DELETE FROM ${dest}`);
      const { upserts, deletes } = reduceChanges(changes.slice(lastTruncate + 1), pk);
      if (deletes.length) await c.run(`DELETE FROM ${dest} WHERE CAST(${q(pk)} AS VARCHAR) IN (${deletes.map(lit).join(", ")})`);
      if (upserts.length) {
        // Only columns already in the copy are kept, so a new source column can't slip past the personal data review
        const cols = info.filter((i) => i.n !== "_basalt_synced_at"), inCopy = new Set(cols.map((x) => x.n));
        for (const n of Object.keys(types)) if (!inCopy.has(n) && rules[n] !== "drop" && !detectLive(n, [])) note(`${stream}: ${n} is new in the source. Run a sync to copy it`);
        // The same decision a sync makes: a column with no rule that looks like personal data stays out of the warehouse
        const heldBack = new Set<string>();
        for (const col of cols) {
          if (rules[col.n]) continue;
          const found = detectLive(col.n, upserts.map((u) => u.row[col.n] ?? null));
          if (found) { heldBack.add(col.n); note(`${stream}: ${found.kind} in ${col.n} left empty until a rule is chosen`); }
        }
        await c.run(`CREATE OR REPLACE TEMP TABLE _cdc (${cols.map((x) => `${q(x.n)} VARCHAR`).join(", ")}, __key VARCHAR, __keep VARCHAR[])`);
        const app = await c.createAppender("_cdc", "main", "temp");
        const keep: string[][] = [];
        for (const u of upserts) {
          for (const col of cols) {
            let v = heldBack.has(col.n) ? null : u.row[col.n];
            // A column kept without a rule can start holding personal data in nested values. That value is left out until a rule is chosen.
            const found = v != null && !rules[col.n] ? scanStructured(col.n, v) : null;
            if (found) { note(`${stream}: ${found.kind} in ${found.path} left empty until a rule is chosen for ${col.n}`); v = null; }
            // Replication sends arrays as PostgreSQL literals, which DuckDB can't read
            if (v != null && /\[\]$/.test(String(col.d))) v = pgArrayJson(v) ?? v;
            if (v == null) app.appendNull(); else app.appendVarchar(v);
          }
          app.appendVarchar(u.key); app.appendNull(); app.endRow();
          keep.push(cols.filter((col) => u.unchanged.has(col.n) || !(col.n in u.row)).map((col) => col.n));
        }
        app.closeSync();
        for (let i = 0; i < upserts.length; i++) if (keep[i].length) await c.run(`UPDATE _cdc SET __keep = [${keep[i].map(lit).join(", ")}] WHERE __key = ${lit(upserts[i].key)}`);
        const fixed = cols.filter((x) => !rules[x.n] || rules[x.n] === "keep").filter((x) => x.d !== "VARCHAR" && !isNestedType(x.d));
        if (fixed.length) {
          const bad = (await c.runAndReadAll(`SELECT ${fixed.map((x, i) => `count(*) FILTER (WHERE ${q(x.n)} IS NOT NULL AND TRY_CAST(${q(x.n)} AS ${x.d}) IS NULL) AS b${i}`).join(", ")} FROM _cdc`)).getRowObjectsJson()[0] as Record<string, string>;
          fixed.forEach((x, i) => { if (Number(bad[`b${i}`])) note(`${stream}: ${bad[`b${i}`]} values in ${x.n} don't fit its ${x.d} column and arrived empty. Run a full sync to pick up the source's new type`); });
        }
        // A sync masks typed values, and a code must come out the same either way: 1.50 from the log and 1.5 from a sync are one number
        const typed = cols.map((col) => { const t = types[col.n], rule = rules[col.n] ?? "keep"; return t && rule !== "keep" && !t.endsWith("[]") ? `TRY_CAST(${q(col.n)} AS ${toDuckType(t)}) AS ${q(col.n)}` : q(col.n); }).join(", ");
        const masked = cols.map((col) => { const e = maskExpr(col.n, (rules[col.n] ?? "keep") as never, salt); return e ?? `NULL AS ${q(col.n)}`; }).join(", ");
        await c.run(`CREATE OR REPLACE TEMP TABLE _old AS SELECT * FROM ${dest} WHERE CAST(${q(pk)} AS VARCHAR) IN (SELECT __key FROM _cdc)`);
        await c.run(`CREATE OR REPLACE TEMP TABLE _m AS SELECT ${masked}, __key, __keep FROM (SELECT ${typed}, __key, __keep FROM _cdc)`);
        await c.run(`DELETE FROM ${dest} WHERE CAST(${q(pk)} AS VARCHAR) IN (SELECT __key FROM _cdc)`);
        const sel = cols.map((col) => `TRY_CAST(CASE WHEN list_contains(coalesce(m.__keep, []), ${lit(col.n)}) THEN CAST(o.${q(col.n)} AS VARCHAR) ELSE CAST(m.${q(col.n)} AS VARCHAR) END AS ${col.d})`).join(", ");
        await c.run(`INSERT INTO ${dest} (${cols.map((x) => q(x.n)).join(", ")}, "_basalt_synced_at") SELECT ${sel}, now()::TIMESTAMP FROM _m m LEFT JOIN _old o ON CAST(o.${q(pk)} AS VARCHAR) = m.__key`);
        await c.run("DROP TABLE _cdc; DROP TABLE _old; DROP TABLE _m;");
      }
      await c.run("COMMIT");
    } catch (e) { await c.run("ROLLBACK").catch(() => {}); throw e; }
    return "";
  });
}

/** One batch at a time: the worker only moves its position forward after this succeeds, so nothing is lost if either side stops. */
export function applyBatch(id: string, lsn: string, changes: CdcChange[], types: Record<string, Record<string, string>> = {}) {
  if (held.has(id)) {
    setStatus(id, { lastAt: new Date().toISOString() }); // still checking in, so this isn't mistaken for a stopped worker
    throw new HttpError(503, "A sync of this pipeline is running. Changes wait until it finishes.");
  }
  const run = async () => {
    const cfg = getConfig(), p = cfg.pipelines.find((x) => x.id === id), conn = cfg.connections.find((x) => x.id === p?.connectionId);
    if (!p || !conn) throw new Error("This pipeline no longer exists.");
    const skipped: string[] = [];
    let applied = 0;
    const byTable = new Map<string, CdcChange[]>();
    for (const c of changes) { const t = c.table.replace(/^public\./, ""), list = byTable.get(t); if (list) list.push(c); else byTable.set(t, [c]); }
    const touched: string[] = [];
    for (const [table, list] of byTable) {
      const s = p.streams.find((x) => x.name === table);
      if (!s?.enabled) continue;
      if (!s.primaryKey) { skipped.push(`${table}: set a primary key to use real-time sync`); continue; }
      if ((s.rules[s.primaryKey] ?? "keep") !== "keep") { skipped.push(`${table}: the primary key can't be masked for real-time sync`); continue; }
      const problem = await applyStream(conn.slug, table, s.primaryKey, s.rules, list, types[`public.${table}`] ?? types[table] ?? {}, (m) => { if (!skipped.includes(m)) skipped.push(m); });
      if (problem) skipped.push(problem); else { applied += list.length; touched.push(`raw_${conn.slug}.${table.replace(/\W/g, "_")}`); }
    }
    if (applied) shared.dirty.add(id);
    publish(touched);
    if (touched.length && p.rebuildOnChange) rebuildAfter(touched);
    setStatus(id, { lastAt: new Date().toISOString(), lastLsn: lsn, applied: (getCdcStatus()[id]?.applied ?? 0) + applied, skipped, lastError: undefined });
    return { applied, skipped };
  };
  const next = shared.queue.then(run, run);
  shared.queue = next.catch(() => {});
  return next.catch((e) => { setStatus(id, { lastError: e instanceof Error ? e.message : String(e) }); throw e; });
}
