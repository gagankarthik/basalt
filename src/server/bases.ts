import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { applyOp, compute, recById, matches, newTable, newView, viewRecords, warehouseColumns, type Automation, type Base, type Field, type Op, type Table } from "@/lib/base";
import { lit, q } from "@/lib/sql";
import { raise, sendWebhook } from "./alerts";
import { dataPath, withConn } from "./engine";
import { sendMail } from "./mail";
import { readJson, writeJson } from "./files";

const id = () => crypto.randomUUID();
const dir = () => dataPath("bases");
const file = (bid: string) => { if (!/^[\w-]+$/.test(bid)) throw new Error("This base no longer exists."); return dataPath(`bases/${bid}.json`); };
type Store = { watchers: Map<string, Set<(v: number) => void>>; all: Map<string, Base>; loaded: boolean; saves: Map<string, ReturnType<typeof setTimeout>>; pubs: Map<string, ReturnType<typeof setTimeout>>; waits?: Map<string, { at: number; sync: boolean }> };
const g = globalThis as unknown as { __basaltBases?: Store };
const store: Store = (g.__basaltBases ??= { watchers: new Map(), all: new Map(), loaded: false, saves: new Map(), pubs: new Map() });
export function watchBase(id: string, fn: (v: number) => void) { const s = store.watchers.get(id) ?? new Set(); s.add(fn); store.watchers.set(id, s); return () => { s.delete(fn); }; }

function load() {
  if (store.loaded) return;
  fs.mkdirSync(dir(), { recursive: true });
  for (const f of fs.readdirSync(dir())) if (f.endsWith(".json")) { const b = JSON.parse(fs.readFileSync(`${dir()}/${f}`, "utf8")) as Base; store.all.set(b.id, b); }
  store.loaded = true;
}
function writeNow(b: Base) {
  const p = file(b.id), tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b));
  fs.renameSync(tmp, p);
}
// shortcut: the whole base is rewritten after a short pause, so a crash can lose up to two seconds of edits; move to row-level storage if bases outgrow 50,000 records
function save(b: Base, chained = false) {
  store.watchers.get(b.id)?.forEach((fn) => fn(b.version));
  // Steady editing keeps pushing the pause back, so the wait is measured from the first unsaved edit. A chained save mustn't cancel a sync refresh that's still owed
  const waits = (store.waits ??= new Map()), w = waits.get(b.id) ?? { at: Date.now(), sync: false };
  w.sync ||= !chained; waits.set(b.id, w);
  clearTimeout(store.saves.get(b.id));
  store.saves.set(b.id, setTimeout(() => {
    store.saves.delete(b.id); waits.delete(b.id);
    // A full disk mustn't lose the edits for good, so they're written again later. A deleted base stays deleted
    try { writeNow(b); } catch (e) { console.error("Base save failed", e); setTimeout(() => { if (store.all.get(b.id) === b) save(b, !w.sync); }, 30000); return; }
    if (w.sync) try { refreshSyncs(b); } catch (e) { console.error("Base sync failed", e); }
  }, Math.max(0, Math.min(400, w.at + 2000 - Date.now()))));
  if (b.publish) {
    clearTimeout(store.pubs.get(b.id));
    store.pubs.set(b.id, setTimeout(() => { store.pubs.delete(b.id); publishBase(b).catch((e) => console.error("Base publish failed", e)); }, 3000));
  }
}

export const listBases = () => { load(); return [...store.all.values()].map((b) => ({ id: b.id, name: b.name, tables: b.tables.length, records: b.tables.reduce((n, t) => n + t.records.length, 0), updatedAt: b.updatedAt, createdBy: b.createdBy, publish: b.publish })); };
export function getBase(bid: string): Base | null { load(); return store.all.get(bid) ?? null; }

function starter(by: string, at: string): Table[] {
  const tasks = newTable(id(), "Tasks", id), projects = newTable(id(), "Projects", id);
  const b: Base = { id: "", name: "", slug: "", version: 0, nextAuto: 1, publish: false, tables: [tasks, projects], automations: [], updatedAt: at, createdBy: by };
  const c = (name: string, color: string) => ({ id: id(), name, color });
  const todo = c("To do", "gray"), doing = c("In progress", "blue"), done = c("Done", "green");
  const status: Field = { id: id(), name: "Status", type: "select", choices: [todo, doing, done] }, due: Field = { id: id(), name: "Due date", type: "date" }, hours: Field = { id: id(), name: "Hours", type: "number" }, link: Field = { id: id(), name: "Project", type: "link", linkTable: projects.id };
  const invId = id();
  for (const f of [status, due, hours]) applyOp(b, { kind: "addField", table: tasks.id, field: f }, by, at);
  applyOp(b, { kind: "addField", table: tasks.id, field: link, inverseName: "Tasks", inverseId: invId }, by, at);
  applyOp(b, { kind: "addField", table: projects.id, field: { id: id(), name: "Total hours", type: "rollup", viaField: invId, readField: hours.id, rollup: "SUM" } }, by, at);
  applyOp(b, { kind: "addField", table: projects.id, field: { id: id(), name: "Task count", type: "count", viaField: invId } }, by, at);
  tasks.views.push({ ...newView(id(), "Board", "kanban"), stackBy: status.id }, { ...newView(id(), "Calendar", "calendar"), dateField: due.id });
  const p1 = id(), p2 = id(), today = new Date(), day = (n: number) => new Date(today.getTime() + n * 86400000).toISOString().slice(0, 10);
  applyOp(b, { kind: "addRecords", table: projects.id, records: [{ id: p1, cells: { [projects.fields[0].id]: "Website refresh" } }, { id: p2, cells: { [projects.fields[0].id]: "Quarterly report" } }] }, by, at);
  const row = (name: string, st: string, d: number, h: number, p: string) => ({ id: id(), cells: { [tasks.fields[0].id]: name, [status.id]: st, [due.id]: day(d), [hours.id]: h, [link.id]: [p] } });
  applyOp(b, { kind: "addRecords", table: tasks.id, records: [row("Write the brief", done.id, -3, 4, p1), row("Design the pages", doing.id, 2, 12, p1), row("Review with the team", todo.id, 6, 2, p1), row("Collect the numbers", doing.id, 1, 6, p2), row("Draft the summary", todo.id, 8, 5, p2)] }, by, at);
  return b.tables;
}
export function createBase(name: string, template: string, by: string) {
  load();
  const at = new Date().toISOString(), used = new Set([...store.all.values()].map((b) => b.slug));
  const root = name.toLowerCase().replace(/\W+/g, "_").replace(/^_+|_+$/g, "") || "base";
  let slug = root, i = 2; while (used.has(slug)) slug = `${root}_${i++}`;
  const b: Base = { id: id(), name: name.trim() || "Untitled base", slug, version: 1, nextAuto: 100, publish: false, automations: [], updatedAt: at, createdBy: by, tables: template === "starter" ? starter(by, at) : [newTable(id(), "Table 1", id)] };
  store.all.set(b.id, b); writeNow(b);
  return b;
}
export async function deleteBase(bid: string) {
  const b = getBase(bid); if (!b) return;
  await unpublishBase(b);
  clearTimeout(store.saves.get(bid)); clearTimeout(store.pubs.get(bid)); store.waits?.delete(bid);
  store.all.delete(bid);
  fs.rmSync(file(bid), { force: true });
  writeJson("base-tokens.json", tokens().filter((t) => t.base !== bid));
  const folder = dataPath("base-files");
  if (fs.existsSync(folder)) for (const f of fs.readdirSync(folder)) if (f.startsWith(`${bid}__`)) fs.rmSync(`${folder}/${f}`, { force: true });
}

export const unpublishBase = (b: Base) => withConn((c) => c.run(`DROP SCHEMA IF EXISTS ${q(`base_${b.slug}`)} CASCADE`));

/** The copy in the warehouse, so SQL, models and dashboards can use a base. It's replaced whole, a few seconds after edits stop. */
export async function publishBase(b: Base) {
  const schema = `base_${b.slug}`;
  await withConn(async (c) => {
    // Closing the connection without COMMIT undoes all of it, so a failure leaves the last good copy
    await c.run("BEGIN");
    await c.run(`CREATE SCHEMA IF NOT EXISTS ${q(schema)}`);
    const names: string[] = [];
    for (const t of b.tables) {
      const name = t.name.toLowerCase().replace(/\W+/g, "_").replace(/^_+|_+$/g, "") || "table";
      names.push(name);
      const cols = warehouseColumns(t), eng = compute(b, t);
      await c.run(`CREATE OR REPLACE TEMP TABLE _b (record_id VARCHAR, ${cols.map((x) => `${q(x.name)} VARCHAR`).join(", ")})`);
      const app = await c.createAppender("_b", "main", "temp");
      for (const r of t.records) {
        app.appendVarchar(r.id);
        for (const x of cols) {
          const v = eng.value(r, x.f), raw = x.type === "VARCHAR" ? eng.display(r, x.f) : typeof v === "object" ? null : v;
          if (raw == null || raw === "") app.appendNull(); else app.appendVarchar(String(raw));
        }
        app.endRow();
      }
      app.closeSync();
      await c.run(`CREATE OR REPLACE TABLE ${q(schema)}.${q(name)} AS SELECT record_id, ${cols.map((x) => `TRY_CAST(${q(x.name)} AS ${x.type}) AS ${q(x.name)}`).join(", ")} FROM _b`);
      await c.run("DROP TABLE _b");
    }
    const have = (await c.runAndReadAll(`SELECT table_name n FROM information_schema.tables WHERE table_schema = ${lit(schema)}`)).getRowObjectsJson() as { n: string }[];
    for (const h of have) if (!names.includes(h.n)) await c.run(`DROP TABLE ${q(schema)}.${q(h.n)}`);
    await c.run("COMMIT");
  });
}

/** Rebuilds every table that mirrors this base. Synced tables can't themselves be synced, so this can't loop. */
function refreshSyncs(source: Base) {
  for (const dest of store.all.values()) {
    let changed = false;
    for (const t of dest.tables) if (t.sync?.base === source.id && t.sync.version !== source.version) { mirror(dest, t, source); changed = true; }
    if (changed) { dest.version++; save(dest, true); }
  }
}
function mirror(dest: Base, t: Table, source: Base) {
  const from = source.tables.find((x) => x.id === t.sync!.table), at = new Date().toISOString();
  if (!from) { t.sync!.error = "The source table no longer exists."; t.sync!.version = source.version; return; }
  const e = compute(source, from), view = from.views.find((v) => v.id === t.sync!.view), rows = view ? viewRecords(e, from, view) : from.records, old = new Map(t.records.map((r) => [r.id, r]));
  // Values that only make sense in the source, such as links and formulas, arrive as plain text
  const asIs = (f: Field) => ["text", "longText", "number", "currency", "percent", "duration", "rating", "checkbox", "select", "multiSelect", "date", "email", "url", "phone", "barcode"].includes(f.type);
  t.fields = from.fields.map((f) => (asIs(f) ? { ...f, id: f.id } : { id: f.id, name: f.name, type: "text" as const }));
  t.records = rows.map((r) => ({ ...r, comments: old.get(r.id)?.comments ?? [], history: [], cells: Object.fromEntries(from.fields.map((f) => [f.id, asIs(f) ? r.cells[f.id] ?? null : e.display(r, f) || null])) }));
  Object.assign(t.sync!, { at, version: source.version, error: undefined });
}
export function syncTable(bid: string, sourceBase: string, sourceTable: string, view: string | undefined, by: string) {
  const dest = getBase(bid), src = getBase(sourceBase);
  if (!dest || !src) throw new Error("This base no longer exists.");
  const from = src.tables.find((x) => x.id === sourceTable);
  if (!from) throw new Error("Choose a table to sync.");
  if (from.sync) throw new Error("A synced table can't be synced again. Sync from the original.");
  if (bid === sourceBase) throw new Error("Choose a table in another base.");
  const t: Table = { id: id(), name: `${from.name} (synced)`, fields: [], records: [], views: [newView(id(), "Grid view", "grid")], sync: { base: sourceBase, table: sourceTable, view } };
  mirror(dest, t, src);
  applyOp(dest, { kind: "addTable", table: t }, by, new Date().toISOString());
  save(dest);
  return t.id;
}

const fill = (s: string, b: Base, t: Table, rid: string, payload?: Record<string, unknown>) => {
  const r = t.records.find((x) => x.id === rid), e = compute(b, t);
  if (payload) s = s.replace(/\{([^}]+)\}/g, (all, n) => (n in payload ? String(payload[n] ?? "") : all));
  return !r ? s : s.replace(/\{([^}]+)\}/g, (all, n) => { const f = t.fields.find((x) => x.name.toLowerCase() === String(n).toLowerCase()); return f ? e.display(r, f) : all; });
};
/** Admin-written code. A time limit stops runaway loops, but this isn't a security boundary, which is why only admins can save scripts. */
function runScript(code: string, record: Record<string, unknown>, payload: unknown) {
  const logs: string[] = [];
  const out = vm.runInNewContext(`(function (record, payload) {\n${code}\n})(input.record, input.payload)`, { input: JSON.parse(JSON.stringify({ record, payload: payload ?? null })), console: { log: (...a: unknown[]) => { if (logs.length < 50) logs.push(a.map(String).join(" ").slice(0, 500)); } } }, { timeout: 2000 });
  return { result: out == null ? null : JSON.parse(JSON.stringify(out)) as Record<string, unknown>, logs };
}
async function runOne(b: Base, a: Automation, table: Table, rid: string, payload?: Record<string, unknown>) {
  const at = new Date().toISOString(), notes: string[] = [];
  let scope: Record<string, unknown> = { ...payload };
  try {
    for (const x of a.actions) {
      const cells = (t: Table) => Object.fromEntries(Object.entries(x.cells ?? {}).map(([k, v]) => [k, fill(v, b, table, rid, payload)]).filter(([k]) => t.fields.some((f) => f.id === k)));
      if (x.type === "find") {
        // Later actions can use {found_count} and {found_names}
        const t = b.tables.find((y) => y.id === x.table) ?? table, e = compute(b, t), hits = t.records.filter((r) => !x.find || matches(e, t, r, x.find));
        scope = { ...scope, found_count: hits.length, found_names: hits.slice(0, 50).map((r) => e.title(r)).join(", ") };
        payload = scope; notes.push(`Found ${hits.length} records.`);
      } else if (x.type === "email") {
        const to = fill(x.to ?? "", b, table, rid, payload).trim();
        if (!/^\S+@\S+\.\S+$/.test(to)) throw new Error("This automation's email address isn't valid.");
        await sendMail(to, fill(x.subject ?? a.name, b, table, rid, payload), fill(x.message ?? "", b, table, rid, payload));
      } else if (x.type === "script") {
        const r = table.records.find((y) => y.id === rid), e = compute(b, table), fields = r ? Object.fromEntries(table.fields.map((f) => [f.name, e.display(r, f)])) : {};
        const { result, logs } = runScript(x.code ?? "", fields, payload);
        if (logs.length) notes.push(logs.join("; "));
        if (result && r) { const cells: Record<string, unknown> = {}; for (const [k, v] of Object.entries(result)) { const f = table.fields.find((y) => y.name === k); if (f) cells[f.id] = v; } applyOp(b, { kind: "setCells", table: table.id, updates: [{ id: rid, cells }] }, "Automation", at); }
      } else if (x.type === "update") { if (rid) applyOp(b, { kind: "setCells", table: table.id, updates: [{ id: rid, cells: cells(table) }] }, "Automation", at); }
      else if (x.type === "create") { const t = b.tables.find((y) => y.id === x.table) ?? table; applyOp(b, { kind: "addRecords", table: t.id, records: [{ id: id(), cells: cells(t) }] }, "Automation", at); }
      else if (x.type === "webhook") { const problem = await sendWebhook(x.url ?? "", { level: "warn", title: a.name, detail: fill(x.message ?? "", b, table, rid, payload), href: `/bases/${b.id}` }); if (problem) throw new Error(problem); }
      else if (x.type === "alert") await raise(`automation:${a.id}:${id()}`, "warn", a.name, fill(x.message ?? "", b, table, rid, payload), `/bases/${b.id}`);
    }
    a.runs.unshift({ at, ok: true, detail: `Ran ${a.actions.length} action${a.actions.length === 1 ? "" : "s"}${notes.length ? `. ${notes.join(" ")}` : ""}`.slice(0, 2000), record: rid || undefined });
  } catch (e) {
    a.runs.unshift({ at, ok: false, detail: e instanceof Error ? e.message : String(e), record: rid });
    await raise(`automation-failed:${a.id}`, "bad", `Automation failed: ${a.name}`, e instanceof Error ? e.message : String(e), `/bases/${b.id}`);
  }
  a.runs.length = Math.min(a.runs.length, 50);
}
/** Runs after an edit. Changes made by automations don't trigger further automations, so two of them can't loop forever. */
function trigger(b: Base, kind: Automation["trigger"], table: string, ids: string[], matchedBefore?: Map<string, Set<string>>) {
  const list = b.automations.filter((a) => a.on && a.table === table && (a.trigger === kind || (a.trigger === "matches" && kind !== "form")));
  if (!list.length || !ids.length) return;
  const t = b.tables.find((x) => x.id === table); if (!t) return;
  const e = compute(b, t);
  void (async () => {
    for (const a of list) for (const rid of ids) {
      const r = t.records.find((x) => x.id === rid); if (!r) continue;
      if (a.trigger === "matches") { if (!a.condition || !matches(e, t, r, a.condition) || matchedBefore?.get(a.id)?.has(rid)) continue; }
      else if (a.condition && !matches(e, t, r, a.condition)) continue;
      await runOne(b, a, t, rid);
    }
    b.version++; save(b);
  })().catch((err) => console.error("Automation failed", err));
}

export async function runHook(hook: string, payload: Record<string, unknown>) {
  load();
  for (const b of store.all.values()) for (const a of b.automations) if (a.hookId === hook && a.on && a.trigger === "webhook") {
    const t = b.tables.find((x) => x.id === a.table); if (!t) return false;
    await runOne(b, a, t, "", payload); b.version++; save(b);
    return true;
  }
  return false;
}
/** Called every minute. A schedule runs its actions once, not once per record. */
export async function runScheduledAutomations() {
  load();
  const now = Date.now();
  for (const b of store.all.values()) {
    let ran = false;
    for (const a of b.automations) {
      if (!a.on || a.trigger !== "schedule" || !a.every) continue;
      if (a.lastAt && now - Date.parse(a.lastAt) < a.every * 60000) continue;
      if (!a.lastAt) { a.lastAt = new Date(now).toISOString(); ran = true; continue; }
      const t = b.tables.find((x) => x.id === a.table); if (!t) continue;
      a.lastAt = new Date(now).toISOString();
      await runOne(b, a, t, ""); ran = true;
    }
    if (ran) { b.version++; save(b); }
  }
}

export function applyOps(bid: string, ops: Op[], by: string) {
  const b = getBase(bid); if (!b) throw new Error("This base no longer exists.");
  for (const op of ops) {
    const at = new Date().toISOString();
    const table = "table" in op && typeof op.table === "string" ? op.table : "";
    const t = b.tables.find((x) => x.id === table), before = new Map<string, Set<string>>();
    if (op.kind === "setCells" && t) {
      const e = compute(b, t);
      for (const a of b.automations) if (a.on && a.trigger === "matches" && a.condition && a.table === table) before.set(a.id, new Set(op.updates.map((u) => u.id).filter((rid) => { const r = recById(t, rid); return r && matches(e, t, r, a.condition!); })));
    }
    applyOp(b, op, by, at);
    if (op.kind === "addRecords") trigger(b, "created", op.table, op.records.map((r) => r.id));
    if (op.kind === "setCells") trigger(b, "updated", op.table, op.updates.map((u) => u.id), before);
  }
  save(b);
  return b.version;
}
type ApiToken = { id: string; base: string; name: string; scope: "read" | "write"; hash: string; prefix: string; createdAt: string; createdBy: string };
const tokens = () => readJson<ApiToken[]>("base-tokens.json", []);
const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
export const listTokens = (base: string) => tokens().filter((t) => t.base === base).map(({ hash: _h, ...t }) => { void _h; return t; });
export function createToken(base: string, name: string, scope: string, by: string) {
  const token = `bslt_${crypto.randomBytes(24).toString("hex")}`;
  writeJson("base-tokens.json", [...tokens(), { id: id(), base, name: name.trim().slice(0, 80), scope: scope === "write" ? "write" : "read", hash: hashToken(token), prefix: token.slice(0, 10), createdAt: new Date().toISOString(), createdBy: by }]);
  return token;
}
export const revokeToken = (base: string, tid: string) => writeJson("base-tokens.json", tokens().filter((t) => !(t.base === base && t.id === tid)));
/** Only hashes are stored, and they're compared in constant time. */
export function apiToken(raw: string) {
  if (!raw) return null;
  const want = Buffer.from(hashToken(raw), "hex");
  return tokens().find((t) => crypto.timingSafeEqual(Buffer.from(t.hash, "hex"), want)) ?? null;
}

export function findForm(share: string) {
  load();
  for (const b of store.all.values()) for (const t of b.tables) for (const v of t.views) if (v.type === "form" && v.form?.shareId && v.form.shareId === share) return { b, t, v };
  return null;
}
export function submitForm(share: string, values: Record<string, unknown>) {
  const m = findForm(share); if (!m) throw new Error("This form is no longer available.");
  const allowed = new Set(m.v.form!.fields), rid = id(), at = new Date().toISOString();
  const cells = Object.fromEntries(Object.entries(values).filter(([k]) => allowed.has(k)));
  applyOp(m.b, { kind: "addRecords", table: m.t.id, records: [{ id: rid, cells }] }, "Form", at);
  trigger(m.b, "form", m.t.id, [rid]);
  trigger(m.b, "created", m.t.id, [rid]);
  save(m.b);
}
