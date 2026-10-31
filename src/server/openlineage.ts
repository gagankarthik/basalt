import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import { compileModel, effectiveOf, makeCtx, type Ctx } from "@/lib/dbt-compile";
import { checkFacets, columnLineage, connectionDataset, drain, emptyQueue, enqueue, buildJobName, lineageEndpoint, modelInputs, rawTable, storedInputs, runEvent, scrub, schemaFacet, syncDatasets, syncError, terminalType, warehouseDataset, type Dataset, type EventType, type JobRef, type OpenRun, type QueueState, type RunEvent, type RunRef, type Schemas, type TestResult, facet } from "@/lib/openlineage";
import { lit } from "@/lib/sql";
import { postJson } from "@/lib/webhook";
import type { Column, Config, Connection, Model, Pipeline, Run } from "@/lib/types";
import { dataPath, withConn } from "./engine";
import { deleteSecret, getSecret, readJson, saveRun, saveSecret, writeJson } from "./files";

export type LineageSettings = { transport: "none" | "http" | "file"; url: string; namespace: string; includeSql: boolean };
const SETTINGS = "openlineage-settings.json", QUEUE = "openlineage-queue.json", LOG = "openlineage-events.ndjson", KEY = "openlineage:apikey", MAX_LOG = 50 * 1024 * 1024;
const DEFAULTS: LineageSettings = { transport: "none", url: "", namespace: "basalt", includeSql: false };

export const getLineageSettings = () => ({ ...DEFAULTS, ...readJson<Partial<LineageSettings>>(SETTINGS, {}) });
const loadQueue = (): QueueState => ({ ...emptyQueue(), ...readJson<Partial<QueueState>>(QUEUE, {}) });
const saveQueue = (s: QueueState) => writeJson(QUEUE, s);
const shared = globalThis as unknown as { __basaltLineage?: { boot: string; draining?: boolean; timer?: NodeJS.Timeout } };
const state = (shared.__basaltLineage ??= { boot: crypto.randomUUID() });

/** Lineage must never fail or hold up a data run, so everything that touches it goes through here. */
function quiet<T>(fn: () => T, fallback?: T): T | undefined {
  try { return fn(); } catch (e) { console.error("OpenLineage:", e instanceof Error ? e.message : e); return fallback; }
}

/* ---- transport ---- */
const sendTo = (url: string, key: string | undefined, body: string) => postJson(lineageEndpoint(url), body, key ? { authorization: `Bearer ${key}` } : {});

export function drainLineage() {
  const cfg = getLineageSettings();
  if (cfg.transport !== "http" || !cfg.url || state.draining) return;
  state.draining = true;
  void drain(loadQueue, saveQueue, (body) => sendTo(cfg.url, getSecret(KEY), body)).catch((e) => console.error("OpenLineage:", e)).finally(() => {
    state.draining = false;
    // The once-a-minute tick would also retry; this makes the short backoffs real
    const q = quiet(() => loadQueue());
    clearTimeout(state.timer);
    if (q?.nextAt) { state.timer = setTimeout(drainLineage, Math.max(q.nextAt - Date.now(), 1000)); state.timer.unref?.(); }
    // Something queued while the last send was finishing
    else if (q?.items.length) drainLineage();
  });
}

function deliver(ev: RunEvent, open?: Omit<OpenRun, "boot">) {
  const cfg = getLineageSettings();
  if (cfg.transport === "file") {
    const file = dataPath(LOG);
    try { if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, `${file}.1`); } catch { /* no log yet */ }
    fs.appendFileSync(file, `${JSON.stringify(ev)}\n`);
  } else if (cfg.transport === "http") {
    const s = loadQueue();
    enqueue(s, ev);
    s.open = s.open.filter((x) => x.runId !== ev.run.runId);
    if (open) s.open.push({ ...open, boot: state.boot });
    saveQueue(s);
    drainLineage();
  }
}

/** A run left open by a restart will never finish, so receivers are told it was aborted. Basalt's own run record isn't changed here. */
export function tickLineage() {
  quiet(() => {
    const stale = loadQueue().open.filter((x) => x.boot !== state.boot);
    for (const x of stale) deliver(runEvent({ type: "ABORT", time: new Date().toISOString(), runId: x.runId, job: x.job, jobType: x.jobType, parent: x.parent, error: "Basalt restarted before this run finished" }));
    drainLineage();
  });
}

export function lineageStatus() {
  const { items, dropped, lastError, lastErrorAt, lastSentAt } = loadQueue();
  return { queued: items.length, dropped, lastError, lastErrorAt, lastSentAt };
}

export function saveLineageSettings(next: LineageSettings, apiKey?: string) {
  if (next.transport === "http") lineageEndpoint(next.url);
  const prev = getLineageSettings();
  writeJson(SETTINGS, next);
  // A saved key isn't carried to a different server unless it's entered again
  if (apiKey) saveSecret(KEY, apiKey);
  else if (prev.url && next.url && originOf(prev.url) !== originOf(next.url)) deleteSecret(KEY);
  const s = loadQueue();
  saveQueue({ ...s, failures: 0, nextAt: undefined, ...(next.transport === "http" ? {} : { items: [], open: [] }) });
  drainLineage();
}
const originOf = (url: string) => { try { return new URL(url).origin; } catch { return url; } };
export const hasLineageKey = () => !!getSecret(KEY);
export const removeLineageKey = () => deleteSecret(KEY);

/** Sends one harmless event straight to the address on screen and reports what happened. */
export async function testLineage(url: string, apiKey: string | undefined, namespace: string) {
  const saved = getLineageSettings().url;
  const key = apiKey || (saved && originOf(saved) === originOf(url) ? getSecret(KEY) : undefined);
  const body = JSON.stringify(runEvent({ type: "OTHER", time: new Date().toISOString(), runId: crypto.randomUUID(), job: { namespace, name: "basalt.connection_test" }, jobType: "TEST" }));
  try {
    const status = await sendTo(url, key, body);
    if (status < 200 || status >= 300) throw new Error(`The endpoint answered with status ${status}.`);
    saveQueue({ ...loadQueue(), lastSentAt: new Date().toISOString() });
    return "";
  } catch (e) {
    const problem = e instanceof Error ? e.message : String(e);
    saveQueue({ ...loadQueue(), lastError: problem, lastErrorAt: new Date().toISOString() });
    return problem;
  }
}

/* ---- recording ---- */
const nowIso = () => new Date().toISOString();
/** A stable id for a step inside a run, derived from the run, shaped like a version 5 UUID. */
function childId(runId: string, name: string) {
  const h = crypto.createHash("sha1").update(`${runId}/${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(parseInt(h[16], 16) & 3 | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const rootOf = (p: RunRef) => p.root ?? { runId: p.runId, job: p.job };

function record(run: Run, ev: RunEvent) {
  run.artifacts = { ...run.artifacts, openlineage: [...((run.artifacts?.openlineage as RunEvent[] | undefined) ?? []), ev] };
}

function send(run: Run, o: Parameters<typeof runEvent>[0]) {
  const ev = runEvent(o);
  record(run, ev);
  quiet(() => deliver(ev, o.type === "START" || o.type === "RUNNING" ? { runId: o.runId, job: o.job, jobType: o.jobType, parent: o.parent } : undefined));
}

async function warehouseSchemas(): Promise<Schemas> {
  return withConn(async (c) => {
    const rows = (await c.runAndReadAll(`SELECT table_schema s, table_name t, column_name n, data_type d FROM information_schema.columns ORDER BY s, t, ordinal_position`)).getRowObjectsJson() as Record<string, string>[];
    const out: Schemas = new Map();
    for (const r of rows) { const k = `${r.s}.${r.t}`.toLowerCase(); out.set(k, [...(out.get(k) ?? []), { name: r.n, type: r.d }]); }
    return out;
  });
}
const noSchemas = (e: unknown): Schemas => { console.error("OpenLineage:", e); return new Map(); };

export function startSyncLineage(run: Run, p: Pipeline, conn: Connection, parent?: RunRef) {
  const dead = { progress() {}, async finish() {} };
  return quiet(() => {
    const { namespace: ns } = getLineageSettings(), job: JobRef = { namespace: ns, name: `sync.${conn.slug}` };
    const common = { runId: run.id, job, jobType: "SYNC", parent };
    send(run, { ...common, type: "START", time: run.startedAt, ...syncNames(p, conn, ns) });
    return {
      /** Only for several tables: the tables finished so far. */
      progress() {
        quiet(() => { if (p.streams.filter((s) => s.enabled).length > 1) send(run, { ...common, type: "RUNNING", time: nowIso(), ...syncDatasets(p, conn, ns, run.streams ?? []) }); });
      },
      async finish() {
        try {
          const catalog = (run.messages ?? []).find((m) => m.type === "CATALOG")?.catalog as { streams: { name: string; json_schema: Record<string, string> }[] } | undefined;
          const columns = Object.fromEntries((catalog?.streams ?? []).map((s) => [s.name, Object.entries(s.json_schema).map(([name, type]): Column => ({ name, type }))]));
          const schemas = await warehouseSchemas().catch(noSchemas);
          send(run, { ...common, type: terminalType(run.status), time: run.endedAt ?? nowIso(), error: syncError(run), ...syncDatasets(p, conn, ns, run.streams ?? [], columns, schemas) });
        } catch (e) { console.error("OpenLineage:", e); }
      },
    };
  }, dead) ?? dead;
}

function syncNames(p: Pipeline, conn: Connection, ns: string) {
  const enabled = p.streams.filter((s) => s.enabled);
  return { inputs: enabled.map((s) => connectionDataset(conn, s.name, ns)), outputs: enabled.map((s) => warehouseDataset(ns, `raw_${conn.slug}`, rawTable(s.name))) };
}

export function startBuildLineage(run: Run, cfg: Pick<Config, "models" | "project">, only?: string, downstream?: boolean, parent?: RunRef) {
  const dead = { model(_m: Model) { void _m; }, async finish(_r: TestResult[]) { void _r; } };
  return quiet(() => {
    const { namespace: ns, includeSql } = getLineageSettings(), job: JobRef = { namespace: ns, name: buildJobName(only, downstream) };
    const self: RunRef = { runId: run.id, job, root: parent ? rootOf(parent) : undefined };
    const common = { runId: run.id, job, jobType: "MODEL_BUILD", parent };
    const started = new Map<string, string>();
    let ctx: Ctx;
    try { ctx = makeCtx(cfg.models, cfg.project); } catch { ctx = makeCtx(cfg.models); }
    // The SQL the warehouse runs. Python and full Jinja have none here, and a model that doesn't compile fails its own build
    const compiled = (m: Model) => { if (m.kind === "python" || m.jinja) return undefined; try { return compileModel(m, ctx); } catch { return undefined; } };
    const sqlOf = (m: Model) => (includeSql ? compiled(m) : undefined), outputsOf = (m: Model) => (effectiveOf(m, ctx).materialized === "ephemeral" ? [] : [warehouseDataset(ns, "analytics", m.name)]);
    const modelJob = (name: string): JobRef => ({ namespace: ns, name: `model.${name}` });
    send(run, { ...common, type: "START", time: run.startedAt });
    return {
      /** Called as each model's turn comes, so its START carries the real time. */
      model(m: Model) {
        quiet(() => {
          const time = nowIso();
          started.set(m.name, time);
          send(run, { type: "START", time, runId: childId(run.id, `model.${m.name}`), job: modelJob(m.name), jobType: "MODEL", parent: self, sql: sqlOf(m), inputs: [...storedInputs(m, ctx).refs.map((r) => warehouseDataset(ns, "analytics", r)), ...storedInputs(m, ctx).sources.map((s) => { const [a, b] = s.split("."); return warehouseDataset(ns, a, b); })], outputs: outputsOf(m) });
        });
      },
      async finish(results: TestResult[]) {
        try {
          const schemas = await warehouseSchemas().catch(noSchemas);
          await withConn(async (c) => {
            for (const m of cfg.models.filter((x) => started.has(x.name))) {
              const time = started.get(m.name)!, id = `model.basalt.${m.name}`, r = results.find((x) => x.unique_id === id);
              const end = new Date(Date.parse(time) + (r?.execution_time ?? 0) * 1000).toISOString();
              const text = compiled(m), ast = text == null ? null : await c.runAndReadAll(`SELECT json_serialize_sql(${lit(text)}) j`).then((x) => JSON.parse(String(x.getRowObjectsJson()[0].j)), () => null);
              const cols = schemas.get(`analytics.${m.name}`.toLowerCase()), ok = r?.status === "success";
              const rows = ok && (m.kind === "python" || m.materialized !== "view") ? await c.runAndReadAll(`SELECT count(*) n FROM "analytics"."${m.name.replace(/"/g, '""')}"`).then((x) => Number(x.getRowObjectsJson()[0].n), () => undefined) : undefined;
              const fields = ok ? columnLineage(ast, cols, schemas, ns) : null;
              const output: Dataset = { ...warehouseDataset(ns, "analytics", m.name), ...(ok ? { facets: { ...schemaFacet(cols), ...(fields ? { columnLineage: facet("columnLineage", { fields }) } : {}) } } : {}), ...(rows != null ? { outputFacets: { outputStatistics: facet("outputStatistics", { rowCount: rows }) } } : {}) };
              const type: EventType = ok ? "COMPLETE" : r?.status === "error" ? "FAIL" : "ABORT";
              // Python errors can print row values in any form, so only that it failed is reported
              const error = r?.status === "error" ? (m.kind === "python" ? "The Python model failed" : r.message ?? "The model failed") : type === "ABORT" ? r?.message ?? "This model didn't finish" : undefined;
              send(run, { type, time: end, runId: childId(run.id, `model.${m.name}`), job: modelJob(m.name), jobType: "MODEL", parent: self, error, sql: sqlOf(m), inputs: modelInputs(m, storedInputs(m, ctx).refs, storedInputs(m, ctx).sources, ast, ns, schemas), outputs: outputsOf(m).length ? [output] : [] });
              if (ok) sendChecks(run, ns, self, m, results, end, cols, rows);
            }
          });
        } catch (e) { console.error("OpenLineage:", e); }
        quiet(() => send(run, { ...common, type: terminalType(run.status), time: run.endedAt ?? nowIso(), error: run.status === "succeeded" ? undefined : run.summary }));
      },
    };
  }, dead) ?? dead;
}

/** Checks read the model's table, so they're their own step with that table as input, which is where the spec puts these facets. */
function sendChecks(run: Run, ns: string, parent: RunRef, m: Model, results: TestResult[], time: string, cols: Column[] | undefined, rows: number | undefined) {
  const tests = m.tests.flatMap((test) => { const name = `${test.type}_${m.name}_${test.column}`, result = results.find((x) => x.unique_id === `test.basalt.${name}`); return result ? [{ test, name, result }] : []; });
  if (!tests.length) return;
  const job = { namespace: ns, name: `model.${m.name}.checks` }, runId = childId(run.id, job.name), bad = tests.filter((t) => t.result.status !== "pass").length;
  const end = new Date(Date.parse(time) + tests.reduce((a, t) => a + (t.result.execution_time ?? 0), 0) * 1000).toISOString();
  send(run, { type: "START", time, runId, job, jobType: "MODEL_CHECKS", parent });
  send(run, { type: bad ? "FAIL" : "COMPLETE", time: end, runId, job, jobType: "MODEL_CHECKS", parent, error: bad ? `${bad} of ${tests.length} checks failed` : undefined, inputs: [{ ...warehouseDataset(ns, "analytics", m.name), facets: schemaFacet(cols), inputFacets: checkFacets(tests, rows) }] });
}

function newRun(kind: Run["kind"], refId: string, name: string, trigger: Run["trigger"], actor: string): Run {
  return { id: crypto.randomUUID(), kind, refId, name, status: "running", startedAt: nowIso(), trigger, actor };
}

/** A flow has its own run in history, and its syncs and builds name it as their parent. */
export async function withFlowLineage<T extends { ok: boolean; summary: string }>(actor: string, fn: (parent: RunRef) => Promise<T>): Promise<T> {
  const run = newRun("flow", "all", "ETL flow", "manual", actor);
  const job = { namespace: getLineageSettings().namespace, name: "flow.all" }, common = { runId: run.id, job, jobType: "FLOW" };
  send(run, { ...common, type: "START", time: run.startedAt });
  saveRun(run);
  const finish = (status: Run["status"], summary: string) => {
    Object.assign(run, { status, summary, endedAt: nowIso() });
    send(run, { ...common, type: terminalType(status), time: run.endedAt!, error: status === "succeeded" ? undefined : summary });
    saveRun(run);
  };
  try {
    const out = await fn({ runId: run.id, job });
    finish(out.ok ? "succeeded" : "failed", out.summary);
    return out;
  } catch (e) { finish("failed", e instanceof Error ? e.message : String(e)); throw e; }
}

/** An export writes a warehouse table somewhere else. Downloads to a browser have no destination to name, so only deliveries get a run. */
export async function withExportLineage<T extends { written: string; rows?: unknown }>(table: string, conn: Connection, actor: string, fn: () => Promise<T>): Promise<T> {
  const run = newRun("export", table, `Export: ${table}`, actor === "Schedule" ? "schedule" : "manual", actor);
  const { namespace: ns } = getLineageSettings(), [schema, name] = table.split(".");
  const job = { namespace: ns, name: `export.${table}.${conn.slug}` }, common = { runId: run.id, job, jobType: "EXPORT" }, input = warehouseDataset(ns, schema, name);
  send(run, { ...common, type: "START", time: run.startedAt, inputs: [input] });
  saveRun(run);
  try {
    const out = await fn();
    const cols = await warehouseSchemas().then((s) => s.get(table.toLowerCase()), () => undefined);
    const target = /^(\w+):\/\/([^/]+)\/(.*)$/.exec(out.written), base = target ? connectionDataset(conn, "", ns) : connectionDataset(conn, out.written, ns);
    const dest = target ? { namespace: base.namespace, name: target[3] } : base;
    const fields = cols && Object.fromEntries(cols.map((c) => [c.name, { inputFields: [{ ...input, field: c.name, transformations: [{ type: "DIRECT", subtype: "IDENTITY", masking: false }] }] }]));
    const rows = typeof out.rows === "number" ? out.rows : undefined;
    Object.assign(run, { status: "succeeded", endedAt: nowIso(), summary: `Wrote ${table} to ${conn.name}` });
    send(run, { ...common, type: "COMPLETE", time: run.endedAt!, inputs: [{ ...input, facets: schemaFacet(cols) }], outputs: [{ ...dest, facets: { ...schemaFacet(cols), ...(fields ? { columnLineage: facet("columnLineage", { fields }) } : {}) }, ...(rows != null ? { outputFacets: { outputStatistics: facet("outputStatistics", { rowCount: rows }) } } : {}) }] });
    saveRun(run);
    return out;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    Object.assign(run, { status: "failed", endedAt: nowIso(), summary: scrub(message) });
    send(run, { ...common, type: "FAIL", time: run.endedAt!, error: message, inputs: [input] });
    saveRun(run);
    throw e;
  }
}
