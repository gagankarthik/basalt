import "server-only";
import crypto from "node:crypto";
import { HttpError } from "./auth";
import { withConn } from "./engine";
import { maskSalt, readJson, writeJson } from "./files";
import { publish, rebuildAfter } from "./live";
import { columnName, flatten, MAX_COLUMNS, mergeKind, storedType, streamName, type Kind } from "@/lib/ingest";
import { detectLive, maskExpr } from "@/lib/pii";
import { lit, q } from "@/lib/sql";
import type { Rule } from "@/lib/types";

/** Streams live in raw_events, so models can read them with {{ source('events', 'name') }}. */
export const SCHEMA = "raw_events";
const FILE = "ingest-streams.json", INTERNAL = "basalt_internal", KEYS = `"${INTERNAL}"."ingest_keys"`;
const FLUSH_MS = 100, FLUSH_ROWS = 20000, MAX_QUEUED = 200000, MAX_REQUESTS = 200, KEEP_KEYS_HOURS = 24;

export type Stream = { id: string; name: string; uniqueField?: string; rules: Record<string, Rule>; hash: string; prefix: string; createdAt: string; createdBy: string; rebuildModels?: boolean; heldBack?: { column: string; kind: string }[]; lastError?: string };
export const listStreams = () => readJson<Stream[]>(FILE, []);
const saveStreams = (s: Stream[]) => writeJson(FILE, s);
const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const newToken = () => `bsin_${crypto.randomBytes(24).toString("hex")}`;

export function createStream(rawName: string, uniqueField: string | undefined, by: string) {
  const name = streamName(rawName);
  if (!name) throw new HttpError(400, "Enter a stream name.");
  if (listStreams().some((s) => s.name === name)) throw new HttpError(409, `There's already a stream called ${name}.`);
  const token = newToken();
  saveStreams([...listStreams(), { id: crypto.randomUUID(), name, uniqueField: uniqueField?.trim() || undefined, rules: {}, hash: hashToken(token), prefix: token.slice(0, 10), createdAt: new Date().toISOString(), createdBy: by }]);
  return { name, token };
}
export function rotateToken(id: string) {
  const token = newToken();
  saveStreams(listStreams().map((s) => s.id === id ? { ...s, hash: hashToken(token), prefix: token.slice(0, 10) } : s));
  return token;
}
export function updateStream(id: string, p: Pick<Stream, "rules" | "rebuildModels">) {
  saveStreams(listStreams().map((s) => s.id === id ? { ...s, rules: p.rules, rebuildModels: p.rebuildModels, heldBack: s.heldBack?.filter((h) => !p.rules[h.column]) } : s));
}
export async function deleteStream(id: string) {
  const s = listStreams().find((x) => x.id === id);
  if (!s) return;
  saveStreams(listStreams().filter((x) => x.id !== id));
  await withConn((c) => c.run(`DROP TABLE IF EXISTS ${q(SCHEMA)}.${q(s.name)}`));
}
/** Only hashes are stored, and they're compared in constant time. A token opens one stream and can only add to it. */
export function streamFor(name: string, raw: string) {
  const s = listStreams().find((x) => x.name === name), want = Buffer.from(hashToken(raw), "hex");
  // The comparison still runs for an unknown stream, so timing doesn't reveal which names exist
  const good = crypto.timingSafeEqual(Buffer.from(s?.hash ?? "0".repeat(64), "hex"), want);
  if (!s || !good || !raw) throw new HttpError(401, "This token isn't valid for that stream.");
  return s;
}

type Item = { rows: Record<string, string | null>[]; kinds: Record<string, Kind>; key?: string; done: (r: { accepted: number; duplicate: boolean }) => void; fail: (e: unknown) => void };
type Queue = { items: Item[]; rows: number; timer?: ReturnType<typeof setTimeout>; busy: boolean };
type Store = { queues: Map<string, Queue>; hits: Map<string, number[]>; seconds: Map<string, Map<number, number>>; lastAt: Map<string, string>; prunedAt: number; pending: Map<string, Promise<{ accepted: number; duplicate: boolean }>> };
const g = globalThis as unknown as { __basaltIngest?: Store };
const store: Store = (g.__basaltIngest ??= { queues: new Map(), hits: new Map(), seconds: new Map(), lastAt: new Map(), prunedAt: 0, pending: new Map() });

export function checkRate(id: string) {
  const now = Date.now(), hits = (store.hits.get(id) ?? []).filter((t) => now - t < 1000);
  if (hits.length >= MAX_REQUESTS) throw new HttpError(429, `Too many requests. The limit is ${MAX_REQUESTS} a second for each stream.`);
  hits.push(now); store.hits.set(id, hits);
}

/** Resolves once the events are committed, so a client that gets a success knows they're stored, and one that doesn't can safely send them again. */
export function enqueue(s: Stream, events: Record<string, unknown>[], idempotencyKey?: string) {
  const rows: Item["rows"] = [], kinds: Item["kinds"] = {};
  for (const e of events) {
    let f; try { f = flatten(e); } catch (x) { throw new HttpError(400, x instanceof Error ? x.message : String(x)); }
    rows.push(f.row);
    for (const [k, v] of Object.entries(f.kinds)) kinds[k] = mergeKind(kinds[k], v);
  }
  const key = idempotencyKey ? hashToken(`${s.id}:${idempotencyKey}`) : undefined;
  const same = key && store.pending.get(key);
  if (same) return same.then((r) => ({ ...r, duplicate: true }));
  const queue = store.queues.get(s.id) ?? { items: [], rows: 0, busy: false };
  store.queues.set(s.id, queue);
  if (queue.rows + rows.length > MAX_QUEUED) throw new HttpError(429, "This stream is behind. Wait a moment and send these events again.");
  const p = new Promise<{ accepted: number; duplicate: boolean }>((done, fail) => queue.items.push({ rows, kinds, key, done, fail }));
  if (key) { store.pending.set(key, p); void p.catch(() => {}).finally(() => store.pending.delete(key)); }
  queue.rows += rows.length;
  schedule(s.id, queue);
  return p;
}

function schedule(id: string, queue: Queue) {
  if (queue.busy) return;
  if (queue.rows >= FLUSH_ROWS) { clearTimeout(queue.timer); queue.timer = undefined; void flush(id, queue); }
  else queue.timer ??= setTimeout(() => { queue.timer = undefined; void flush(id, queue); }, FLUSH_MS);
}

async function flush(id: string, queue: Queue) {
  if (queue.busy || !queue.items.length) return;
  queue.busy = true;
  const items = queue.items;
  queue.items = []; queue.rows = 0;
  const s = listStreams().find((x) => x.id === id);
  try {
    if (!s) throw new HttpError(404, "This stream no longer exists.");
    const written = await writeBatch(s, items);
    const count = items.reduce((a, i) => a + (written.dupes.has(i) ? 0 : i.rows.length), 0);
    for (const i of items) i.done({ accepted: i.rows.length, duplicate: written.dupes.has(i) });
    const sec = Math.floor(Date.now() / 1000), m = store.seconds.get(id) ?? new Map<number, number>();
    m.set(sec, (m.get(sec) ?? 0) + count);
    for (const k of m.keys()) if (k < sec - 60) m.delete(k);
    store.seconds.set(id, m); store.lastAt.set(id, new Date().toISOString());
    const table = `${SCHEMA}.${s.name}`;
    publish([table]);
    if (s.rebuildModels) rebuildAfter([table]);
    const held = Object.entries(written.held).map(([column, kind]) => ({ column, kind }));
    if (JSON.stringify(held) !== JSON.stringify(s.heldBack ?? []) || s.lastError) saveStreams(listStreams().map((x) => x.id === id ? { ...x, heldBack: held, lastError: undefined } : x));
  } catch (e) {
    for (const i of items) i.fail(e);
    if (s) saveStreams(listStreams().map((x) => x.id === id ? { ...x, lastError: e instanceof Error ? e.message : String(e) } : x));
  } finally {
    queue.busy = false;
    if (queue.items.length) schedule(id, queue);
  }
}

/** Everything in one transaction: the rows, any new columns and the idempotency keys, so a crash leaves all of it or none. */
async function writeBatch(s: Stream, items: Item[]) {
  const salt = maskSalt(), dest = `${q(SCHEMA)}.${q(s.name)}`;
  return withConn(async (c) => {
    const rowsOf = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Record<string, string>[];
    await c.run(`CREATE SCHEMA IF NOT EXISTS ${q(SCHEMA)}; CREATE SCHEMA IF NOT EXISTS ${q(INTERNAL)}; CREATE TABLE IF NOT EXISTS ${KEYS} (key VARCHAR, "at" TIMESTAMP)`);
    await c.run("BEGIN");
    try {
      const keys = items.flatMap((i) => (i.key ? [i.key] : []));
      const seen = new Set(keys.length ? (await rowsOf(`SELECT key FROM ${KEYS} WHERE key IN (${keys.map(lit).join(", ")})`)).map((r) => r.key) : []);
      const dupes = new Set<Item>(), used = new Set<string>();
      for (const i of items) if (i.key) { if (seen.has(i.key) || used.has(i.key)) dupes.add(i); else used.add(i.key); }
      const fresh = items.filter((i) => !dupes.has(i));
      const held: Record<string, string> = {};
      const have = new Map((await rowsOf(`SELECT column_name n, data_type d FROM information_schema.columns WHERE table_schema = ${lit(SCHEMA)} AND table_name = ${lit(s.name)}`)).map((r) => [r.n, r.d]));
      for (const h of s.heldBack ?? []) held[h.column] = h.kind;
      const kinds: Record<string, Kind> = {}, samples: Record<string, (string | null)[]> = {};
      for (const i of fresh) {
        for (const [k, v] of Object.entries(i.kinds)) kinds[k] = mergeKind(kinds[k], v);
        for (const r of i.rows) for (const [k, v] of Object.entries(r)) (samples[k] ??= []).push(v);
      }
      // Same decision as a sync: a rule wins, and personal data with no rule stays out of the warehouse
      const cols: { name: string; rule?: Rule }[] = [];
      for (const name of Object.keys(samples)) {
        const rule = s.rules[name];
        if (rule === "drop") continue;
        if (!rule) {
          const found = detectLive(name, samples[name]);
          if (found) { held[name] = found.kind; continue; }
          delete held[name];
        }
        cols.push({ name, rule });
      }
      if (cols.length) {
        const missing = cols.filter((x) => !have.has(x.name));
        if (have.size + missing.length > MAX_COLUMNS) throw new HttpError(422, `A stream can have at most ${MAX_COLUMNS} columns.`);
        if (!have.size) {
          await c.run(`CREATE TABLE ${dest} (${[...missing.map((x) => `${q(x.name)} ${storedType(kinds[x.name] ?? "text", x.rule)}`), `"_basalt_synced_at" TIMESTAMP`].join(", ")})`);
        } else for (const x of missing) await c.run(`ALTER TABLE ${dest} ADD COLUMN ${q(x.name)} ${storedType(kinds[x.name] ?? "text", x.rule)}`);
        for (const x of missing) have.set(x.name, storedType(kinds[x.name] ?? "text", x.rule));

        await c.run(`CREATE OR REPLACE TEMP TABLE _ev (${cols.map((x) => `${q(x.name)} VARCHAR`).join(", ")}, __n BIGINT)`);
        const app = await c.createAppender("_ev", "main", "temp");
        let n = 0;
        for (const i of fresh) for (const r of i.rows) {
          for (const col of cols) { const v = r[col.name]; if (v == null) app.appendNull(); else app.appendVarchar(v); }
          app.appendBigInt(BigInt(n++)); app.endRow();
        }
        app.closeSync();
        // A value that doesn't fit the column would become empty, so the column widens to text instead of losing it
        const fixed = cols.filter((x) => !x.rule || x.rule === "keep").filter((x) => have.get(x.name) !== "VARCHAR");
        if (fixed.length) {
          const bad = (await rowsOf(`SELECT ${fixed.map((x, k) => `count(*) FILTER (WHERE ${q(x.name)} IS NOT NULL AND TRY_CAST(${q(x.name)} AS ${have.get(x.name)}) IS NULL) AS b${k}`).join(", ")} FROM _ev`))[0];
          for (const [k, x] of fixed.entries()) if (Number(bad[`b${k}`])) { await c.run(`ALTER TABLE ${dest} ALTER COLUMN ${q(x.name)} SET DATA TYPE VARCHAR`); have.set(x.name, "VARCHAR"); }
        }
        // Later events with the same unique value replace earlier ones, here and in the table, so a resent webhook doesn't count twice
        const u = s.uniqueField ? flatKey(s.uniqueField) : "";
        const uniq = u && cols.some((x) => x.name === u) && (s.rules[u] ?? "keep") === "keep" ? u : "";
        const source = uniq ? `(SELECT * FROM _ev QUALIFY row_number() OVER (PARTITION BY ${q(uniq)} ORDER BY __n DESC) = 1 OR ${q(uniq)} IS NULL)` : "_ev";
        if (uniq) await c.run(`DELETE FROM ${dest} WHERE CAST(${q(uniq)} AS VARCHAR) IN (SELECT ${q(uniq)} FROM _ev WHERE ${q(uniq)} IS NOT NULL)`);
        const typed = cols.map((x) => x.rule === "month" ? `TRY_CAST(${q(x.name)} AS TIMESTAMP) AS ${q(x.name)}` : q(x.name)).join(", ");
        const masked = cols.map((x) => maskExpr(x.name, x.rule, salt)).join(", ");
        const finals = cols.map((x) => `TRY_CAST(${q(x.name)} AS ${have.get(x.name)})`).join(", ");
        await c.run(`INSERT INTO ${dest} (${cols.map((x) => q(x.name)).join(", ")}, "_basalt_synced_at") SELECT ${finals}, now()::TIMESTAMP FROM (SELECT ${masked} FROM (SELECT ${typed} FROM ${source}))`);
        await c.run("DROP TABLE _ev");
      }
      const newKeys = fresh.flatMap((i) => (i.key ? [i.key] : []));
      if (newKeys.length) await c.run(`INSERT INTO ${KEYS} VALUES ${newKeys.map((k) => `(${lit(k)}, now()::TIMESTAMP)`).join(", ")}`);
      if (Date.now() - store.prunedAt > 3600000) { store.prunedAt = Date.now(); await c.run(`DELETE FROM ${KEYS} WHERE "at" < now()::TIMESTAMP - INTERVAL ${KEEP_KEYS_HOURS} HOUR`); }
      await c.run("COMMIT");
      return { dupes, held };
    } catch (e) { await c.run("ROLLBACK").catch(() => {}); throw e; }
  });
}
const flatKey = (u: string) => u.split(".").map(columnName).join("_");

export async function streamStats() {
  const out = [];
  const list = listStreams();
  const counts = await withConn(async (c) => {
    const r = await c.runAndReadAll(`SELECT table_name n FROM information_schema.tables WHERE table_schema = ${lit(SCHEMA)}`);
    const names = new Set((r.getRowObjectsJson() as { n: string }[]).map((x) => x.n)), m = new Map<string, { rows: number; lastAt?: string; columns: { name: string; type: string }[] }>();
    for (const s of list) {
      if (!names.has(s.name)) continue;
      const a = (await c.runAndReadAll(`SELECT count(*) n, max("_basalt_synced_at")::VARCHAR last_at FROM ${q(SCHEMA)}.${q(s.name)}`)).getRowObjectsJson()[0] as { n: string; last_at: string | null };
      const cols = (await c.runAndReadAll(`SELECT column_name n, data_type d FROM information_schema.columns WHERE table_schema = ${lit(SCHEMA)} AND table_name = ${lit(s.name)} AND column_name <> '_basalt_synced_at' ORDER BY ordinal_position`)).getRowObjectsJson() as { n: string; d: string }[];
      m.set(s.name, { rows: Number(a.n), lastAt: a.last_at ? `${a.last_at.replace(" ", "T")}Z` : undefined, columns: cols.map((x) => ({ name: x.n, type: x.d })) });
    }
    return m;
  });
  const sec = Math.floor(Date.now() / 1000);
  for (const { hash: _h, ...s } of list) {
    void _h;
    const m = store.seconds.get(s.id), recent = m ? [...m.entries()].filter(([k]) => k >= sec - 60 && k < sec).reduce((a, [, v]) => a + v, 0) : 0;
    out.push({ ...s, table: `${SCHEMA}.${s.name}`, rows: counts.get(s.name)?.rows ?? 0, lastAt: store.lastAt.get(s.id) ?? counts.get(s.name)?.lastAt, perSecond: Math.round(recent / 60), columns: counts.get(s.name)?.columns ?? [] });
  }
  return out;
}
