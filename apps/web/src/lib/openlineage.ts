import { effectiveOf, type Ctx } from "./dbt-compile.ts";
import type { Column, Connection, Model, ModelTest, Pipeline, Run, Rule, StreamStat } from "./types.ts";

/** Builds OpenLineage 2-0-2 RunEvents. Pure, so the tests can check them against the official schemas. */
export const PRODUCER = "urn:basalt:0.1.0";
const SCHEMA_URL = "https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent";
const FACETS = {
  parent: "1-2-0/ParentRunFacet", errorMessage: "1-0-1/ErrorMessageRunFacet", jobType: "2-0-4/JobTypeJobFacet", sql: "1-1-0/SQLJobFacet", schema: "1-2-0/SchemaDatasetFacet",
  outputStatistics: "1-0-2/OutputStatisticsOutputDatasetFacet", dataQualityMetrics: "1-0-3/DataQualityMetricsInputDatasetFacet", dataQualityAssertions: "1-1-0/DataQualityAssertionsDatasetFacet", columnLineage: "1-2-0/ColumnLineageDatasetFacet",
};
export const facet = (key: keyof typeof FACETS, body: object) => ({ _producer: PRODUCER, _schemaURL: `https://openlineage.io/spec/facets/${FACETS[key]}.json#/$defs/${FACETS[key].split("/")[1]}`, ...body });

export type EventType = "START" | "RUNNING" | "COMPLETE" | "ABORT" | "FAIL" | "OTHER";
export type JobRef = { namespace: string; name: string };
export type RunRef = { runId: string; job: JobRef; root?: { runId: string; job: JobRef } };
export type Dataset = JobRef & { facets?: Record<string, unknown>; inputFacets?: Record<string, unknown>; outputFacets?: Record<string, unknown> };
export type RunEvent = { eventType: EventType; eventTime: string; producer: string; schemaURL: string; run: { runId: string; facets?: Record<string, unknown> }; job: JobRef & { facets?: Record<string, unknown> }; inputs: Dataset[]; outputs: Dataset[] };
export type Schemas = Map<string, Column[]>;
type Transformation = { type: "DIRECT" | "INDIRECT"; subtype: string; description?: string; masking: boolean };
export type Fields = Record<string, { inputFields: (JobRef & { field: string; transformations: Transformation[] })[] }>;

export function runEvent(o: { type: EventType; time: string; runId: string; job: JobRef; jobType: string; parent?: RunRef; error?: string; sql?: string; inputs?: Dataset[]; outputs?: Dataset[] }): RunEvent {
  const runFacets: Record<string, unknown> = {};
  if (o.parent) runFacets.parent = facet("parent", { run: { runId: o.parent.runId }, job: o.parent.job, ...(o.parent.root ? { root: { run: { runId: o.parent.root.runId }, job: o.parent.root.job } } : {}) });
  if (o.error) runFacets.errorMessage = facet("errorMessage", { message: scrub(o.error), programmingLanguage: "TypeScript" });
  return {
    eventType: o.type, eventTime: o.time, producer: PRODUCER, schemaURL: SCHEMA_URL,
    run: { runId: o.runId, ...(o.parent || o.error ? { facets: runFacets } : {}) },
    job: { ...o.job, facets: { jobType: facet("jobType", { processingType: "BATCH", integration: "BASALT", jobType: o.jobType }), ...(o.sql ? { sql: facet("sql", { query: o.sql, dialect: "duckdb" }) } : {}) } },
    inputs: o.inputs ?? [], outputs: o.outputs ?? [],
  };
}

/** Engine errors can quote row values, addresses and SQL, so only the first line goes out, with anything quoted or secret-shaped removed. */
export function scrub(message: string) {
  return message.split("\n")[0]
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*/gi, "[url]")
    .replace(/'(?:[^']|'')*'/g, "'?'").replace(/"[^"]*"/g, '"?"')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|account[_-]?key|authorization)\b\s*[=:]\s*\S+/gi, "$1=[removed]")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .slice(0, 500);
}

/* ---- naming, from the spec's naming doc ---- */
/** Just host and port: the connection field is free text, so it may hold a URL with a user and password in it. */
export function safeHost(host = "") {
  const h = host.trim();
  try { return new URL(h.includes("://") ? h : `x://${h}`).host; } catch { return h.replace(/^.*@/, "").replace(/[/?#].*$/, ""); }
}
export const warehouseNamespace = (ns: string) => `duckdb://${ns}`;
export const warehouseDataset = (ns: string, schema: string, table: string): JobRef => ({ namespace: warehouseNamespace(ns), name: `warehouse.${schema}.${table}` });
/** The name a stream gets in the warehouse. Same rule as the sync itself. */
export const rawTable = (stream: string) => stream.replace(/\W/g, "_");

export function connectionDataset(conn: Connection, stream: string, ns: string): JobRef {
  const tail = stream.split(".").pop()!, schema = stream.includes(".") ? stream.split(".").slice(0, -1).join(".") : undefined;
  const key = [conn.prefix?.replace(/^\/+|\/+$/g, ""), stream].filter(Boolean).join("/");
  switch (conn.type) {
    case "postgres": return { namespace: `postgres://${safeHost(conn.host).replace(/:\d+$/, "")}:${conn.port ?? 5432}`, name: `${conn.database}.${schema ?? "public"}.${tail}` };
    case "mysql": return { namespace: `mysql://${safeHost(conn.host).replace(/:\d+$/, "")}:${conn.port ?? 3306}`, name: `${conn.database}.${tail}` };
    case "s3": return { namespace: `s3://${conn.database}`, name: key };
    case "gcs": return { namespace: `gs://${conn.database}`, name: key };
    case "azure": return { namespace: `abfss://${conn.database}${conn.user ? `@${conn.user}.dfs.core.windows.net` : ""}`, name: key };
    case "bigquery": return { namespace: "bigquery", name: `${conn.database}.${conn.prefix}.${tail}` };
    case "snowflake": return { namespace: `snowflake://${safeHost(conn.host)}`, name: `${conn.database}.${conn.prefix ?? "PUBLIC"}.${tail}` };
    // Sample data and uploaded files sit in Basalt's own source store
    case "sample": return { namespace: warehouseNamespace(ns), name: `sources.sample.${stream}` };
    case "file": return { namespace: warehouseNamespace(ns), name: `sources.file_${conn.slug}.${stream}` };
    // The naming doc has nothing for this kind of source, so it's named by its connection
    default: return { namespace: `${conn.type}://${conn.slug}`, name: stream };
  }
}

export const schemaFacet = (cols?: Column[]) => (cols?.length ? { schema: facet("schema", { fields: cols.map((c, i) => ({ name: c.name, type: c.type, ordinal_position: i + 1 })) }) } : {});
const lookup = (schemas: Schemas, schema: string, table: string) => schemas.get(`${schema}.${table}`.toLowerCase());
const IDENTITY: Transformation = { type: "DIRECT", subtype: "IDENTITY", masking: false };
const MASKS: Partial<Record<Rule, string>> = { hash: "replaced with a salted hash", mask: "characters masked", month: "date rounded to the month" };
const ruleTransformation = (rule: Rule): Transformation => (MASKS[rule] ? { type: "DIRECT", subtype: "TRANSFORMATION", description: MASKS[rule], masking: true } : IDENTITY);

export const terminalType = (status: Run["status"]): EventType => (status === "succeeded" ? "COMPLETE" : "FAIL");

/* ---- sync ---- */
/** Datasets for one sync. A failed table has no output, and a column only gets lineage if this sync really wrote it. */
export function syncDatasets(p: Pipeline, conn: Connection, ns: string, stats: StreamStat[], catalog: Record<string, Column[]> = {}, schemas: Schemas = new Map()) {
  const statOf = (name: string) => stats.find((s) => s.name === name);
  const enabled = p.streams.filter((s) => s.enabled);
  const inputs: Dataset[] = enabled.map((s) => {
    const stat = statOf(s.name), inputFacets: Record<string, unknown> = {};
    if (stat?.status === "ok" && stat.sourceRows != null) {
      inputFacets.dataQualityMetrics = facet("dataQualityMetrics", { rowCount: stat.sourceRows, columnMetrics: {} });
      if (s.mode !== "incremental_append" && !s.maxRows && stat.copyRows != null) inputFacets.dataQualityAssertions = facet("dataQualityAssertions", { assertions: [{ assertion: "row_count_match", success: stat.sourceRows === stat.copyRows, severity: "warn", expected: String(stat.sourceRows), actual: String(stat.copyRows) }] });
    }
    return { ...connectionDataset(conn, s.name, ns), ...(catalog[s.name] ? { facets: schemaFacet(catalog[s.name]) } : {}), ...(Object.keys(inputFacets).length ? { inputFacets } : {}) };
  });
  // No row count means nothing was written: every column was held back or left out
  const outputs: Dataset[] = enabled.filter((s) => statOf(s.name)?.status === "ok" && statOf(s.name)?.copyRows != null).map((s) => {
    const stat = statOf(s.name)!, schema = `raw_${conn.slug}`, table = rawTable(s.name), source = connectionDataset(conn, s.name, ns), cols = lookup(schemas, schema, table), fields: Fields = {};
    for (const c of catalog[s.name] ?? []) {
      const rule = s.rules[c.name] ?? "keep";
      if (rule !== "drop" && !stat.heldBack.includes(c.name) && cols?.some((x) => x.name === c.name)) fields[c.name] = { inputFields: [{ ...source, field: c.name, transformations: [ruleTransformation(rule)] }] };
    }
    return {
      ...warehouseDataset(ns, schema, table),
      facets: { ...schemaFacet(cols), ...(Object.keys(fields).length ? { columnLineage: facet("columnLineage", { fields }) } : {}) },
      ...(stat.copyRows != null ? { outputFacets: { outputStatistics: facet("outputStatistics", { rowCount: stat.copyRows }) } } : {}),
    };
  });
  return { inputs, outputs };
}

export function syncError(run: Run) {
  if (run.status === "succeeded") return undefined;
  const bad = (run.streams ?? []).filter((s) => s.status === "failed");
  return bad.length ? bad.map((s) => `${s.name}: ${s.error ?? "failed"}`).join("; ") : run.summary ?? "The sync failed";
}

/* ---- models ---- */
export const buildJobName = (only?: string, downstream?: boolean) => `models.${only ?? "all"}${only && downstream ? ".downstream" : ""}`;

export function modelInputs(m: Pick<Model, "name">, refs: string[], sources: string[], ast: unknown, ns: string, schemas: Schemas): Dataset[] {
  const seen = new Map<string, [string, string]>();
  const add = (schema: string, table: string) => seen.set(`${schema}.${table}`.toLowerCase(), [schema, table]);
  refs.forEach((r) => add("analytics", r));
  sources.forEach((s) => { const [a, b] = s.split("."); add(a, b); });
  // Tables named directly in the SQL rather than through ref or source. A name without a schema could be a CTE, so it's left out.
  for (const [schema, table] of tablesIn(ast)) if (lookup(schemas, schema, table)) add(schema, table);
  return [...seen.values()].filter(([s, t]) => !(s === "analytics" && t === m.name)).map(([s, t]) => ({ ...warehouseDataset(ns, s, t), facets: schemaFacet(lookup(schemas, s, t)) }));
}

function tablesIn(node: unknown, out: [string, string][] = []) {
  if (Array.isArray(node)) node.forEach((n) => tablesIn(n, out));
  else if (node && typeof node === "object") {
    const n = node as Record<string, unknown>;
    if (n.type === "BASE_TABLE" && n.schema_name) out.push([String(n.schema_name), String(n.table_name)]);
    Object.values(n).forEach((v) => tablesIn(v, out));
  }
  return out;
}

export type TestResult = { unique_id: string; status: string; failures?: number | null; execution_time?: number; message?: string | null };
/** Check results as facets. Counts and column names only: the values a check found are never included. */
export function checkFacets(tests: { test: ModelTest; name: string; result: TestResult }[], rowCount?: number) {
  const columnMetrics: Record<string, { nullCount: number }> = {};
  for (const { test, result } of tests) if (test.type === "not_null" && typeof result.failures === "number") columnMetrics[test.column] = { nullCount: result.failures };
  return {
    dataQualityMetrics: facet("dataQualityMetrics", { ...(rowCount != null ? { rowCount } : {}), columnMetrics }),
    dataQualityAssertions: facet("dataQualityAssertions", { assertions: tests.map(({ test, name, result }) => ({
      assertion: test.type === "custom" ? "custom_sql" : test.type, success: result.status === "pass", name, severity: test.block ? "error" : "warn",
      ...(test.column ? { column: test.column } : {}), ...(typeof result.failures === "number" ? { actual: String(result.failures), expected: "0" } : {}),
    })) }),
  };
}

/* ---- column lineage from DuckDB's json_serialize_sql ---- */
type Node = Record<string, unknown> & { class?: string; type?: string };
type Table = { alias: string; schema: string; table: string; cols: Column[] };
type Ref = { t: Table; col: string; tr: Transformation };
const AGG = new Set(["sum", "avg", "mean", "count", "count_star", "min", "max", "median", "mode", "first", "last", "any_value", "arbitrary", "string_agg", "group_concat", "list", "array_agg", "stddev", "variance", "bool_and", "bool_or"]);
const MASKING = new Set(["md5", "sha1", "sha256", "hash"]);
const TRANSFORMED: Transformation = { type: "DIRECT", subtype: "TRANSFORMATION", masking: false };
const CONDITIONAL: Transformation = { type: "INDIRECT", subtype: "CONDITIONAL", masking: false };

function fromTables(n: Node | undefined, schemas: Schemas, out: Table[]): boolean {
  if (n?.type === "JOIN") return n.ref_type === "REGULAR" && fromTables(n.left as Node, schemas, out) && fromTables(n.right as Node, schemas, out);
  if (n?.type !== "BASE_TABLE" || !n.schema_name) return false;
  const cols = lookup(schemas, String(n.schema_name), String(n.table_name));
  if (!cols) return false;
  out.push({ alias: String(n.alias || n.table_name).toLowerCase(), schema: String(n.schema_name), table: String(n.table_name), cols });
  return true;
}

function resolveColumn(names: string[], tables: Table[]): { t: Table; col: string } | null {
  if (names.length > 2) return null;
  const want = names[names.length - 1].toLowerCase();
  const hits = tables.filter((t) => (names.length === 1 || t.alias === names[0].toLowerCase()) && t.cols.some((c) => c.name.toLowerCase() === want));
  return hits.length === 1 ? { t: hits[0], col: hits[0].cols.find((c) => c.name.toLowerCase() === want)!.name } : null;
}

/** Every column an expression reads, or null for anything not understood, so that column is left out rather than guessed. */
function refsIn(e: Node, tables: Table[], grouped: boolean, tr: Transformation): Ref[] | null {
  // Inside a CASE condition everything stays indirect
  const inner = tr.type === "INDIRECT" ? tr : TRANSFORMED;
  const all = (list: Node[], t: Transformation) => { const out: Ref[] = []; for (const x of list) { const r = refsIn(x, tables, grouped, t); if (!r) return null; out.push(...r); } return out; };
  switch (e.class) {
    case "COLUMN_REF": { const r = resolveColumn(e.column_names as string[], tables); return r && [{ ...r, tr }]; }
    case "CONSTANT": return [];
    case "CAST": return all([e.child as Node], inner);
    case "COMPARISON": return all([e.left as Node, e.right as Node], inner);
    case "OPERATOR": case "CONJUNCTION": return all(e.children as Node[], inner);
    case "CASE": {
      const checks = e.case_checks as { when_expr: Node; then_expr: Node }[];
      const direct = all([...checks.map((c) => c.then_expr), ...(e.else_expr ? [e.else_expr as Node] : [])], inner), indirect = all(checks.map((c) => c.when_expr), CONDITIONAL);
      return direct && indirect && [...direct, ...indirect];
    }
    case "FUNCTION": {
      const name = String(e.function_name).toLowerCase(), agg = AGG.has(name);
      const orders = (e.order_bys as { orders?: unknown[] } | null)?.orders;
      // In a GROUP BY an unfamiliar function may itself be an aggregate, so it isn't labelled either way
      if (e.filter || orders?.length || (grouped && !agg && !/^\W+$/.test(name) && !MASKING.has(name))) return null;
      const args = ((e.arguments ?? e.children ?? []) as Node[]).map((a) => (a.expression as Node) ?? a);
      if (tr.type === "INDIRECT") return all(args, tr);
      return all(args, agg ? { type: "DIRECT", subtype: "AGGREGATION", masking: name === "count" || name === "count_star" } : MASKING.has(name) ? { type: "DIRECT", subtype: "TRANSFORMATION", description: name, masking: true } : TRANSFORMED);
    }
    default: return null;
  }
}

/** Column lineage for one plain SELECT. Anything else (CTE, UNION, subquery in FROM, or a parse error) gives null, and the facet is left out. */
export function columnLineage(ast: unknown, outputCols: Column[] | undefined, schemas: Schemas, ns: string): Fields | null {
  const a = ast as { error?: boolean; statements?: { node: Node }[] } | null;
  if (!outputCols || !a || a.error || a.statements?.length !== 1) return null;
  const n = a.statements[0].node, tables: Table[] = [];
  if (n.type !== "SELECT_NODE" || (n.cte_map as { map?: unknown[] })?.map?.length || !fromTables(n.from_table as Node, schemas, tables)) return null;
  const grouped = !!(n.group_expressions as unknown[])?.length;
  const fields: Fields = {}, seen = new Set<string>();
  const put = (out: string, refs: Ref[]) => {
    const real = outputCols.find((c) => c.name.toLowerCase() === out.toLowerCase())?.name;
    if (!real) return;
    // Two columns with one name get renamed by DuckDB, so neither can be trusted
    if (seen.has(real)) { delete fields[real]; return; }
    seen.add(real);
    if (!refs.length) return;
    const merged = new Map<string, Fields[string]["inputFields"][number]>();
    for (const r of refs) {
      const ds = warehouseDataset(ns, r.t.schema, r.t.table), key = `${ds.name}.${r.col}`, had = merged.get(key);
      if (!had) merged.set(key, { ...ds, field: r.col, transformations: [r.tr] });
      else if (!had.transformations.some((x) => x.type === r.tr.type && x.subtype === r.tr.subtype)) had.transformations.push(r.tr);
    }
    fields[real] = { inputFields: [...merged.values()] };
  };
  for (const item of n.select_list as Node[]) {
    if (item.class === "STAR") {
      const pick = tables.filter((t) => !item.relation_name || t.alias === String(item.relation_name).toLowerCase());
      if (pick.length !== 1 || item.columns || (item.exclude_list as unknown[])?.length || (item.replace_list as unknown[])?.length || (item.rename_list as unknown[])?.length || item.expr) continue;
      for (const c of pick[0].cols) put(c.name, [{ t: pick[0], col: c.name, tr: IDENTITY }]);
      continue;
    }
    const out = (item.alias as string) || (item.class === "COLUMN_REF" ? (item.column_names as string[]).at(-1) : "");
    if (!out) continue;
    const refs = refsIn(item, tables, grouped, IDENTITY);
    if (refs) put(out, refs);
  }
  return Object.keys(fields).length ? fields : null;
}

/* ---- delivery queue: bounded, oldest dropped first, kept on disk by the caller ---- */
/** Which table a SQL cell writes to, and the part of it that reads, since DuckDB only serializes a plain query. */
export function splitCellSql(sql: string) {
  const write = /^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?|INSERT\s+INTO)\s+"?(\w+)"?\."?(\w+)"?/i.exec(sql);
  if (!write) return { read: sql, writes: null as string | null };
  const body = /\b(SELECT|WITH)\b[\s\S]*$/i.exec(sql.slice(write[0].length));
  return { read: body?.[0] ?? "", writes: `${write[1]}.${write[2]}`.toLowerCase() };
}
/** The named tables in one parsed query. A name with no schema is a CTE or a table in main, and neither is worth claiming as a source. */
export function tablesInParsed(parsed: unknown) {
  const out = new Set<string>();
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if (o.type === "BASE_TABLE" && typeof o.table_name === "string" && o.schema_name && !["information_schema", "pg_catalog"].includes(String(o.schema_name).toLowerCase())) out.add(`${o.schema_name}.${o.table_name}`.toLowerCase());
    Object.values(o).forEach(walk);
  };
  walk(parsed);
  return [...out];
}
/** A job name stays readable and can't carry odd characters from what someone called their notebook. */
export const notebookJob = (name: string) => `notebook.${name.toLowerCase().replace(/\W+/g, "_").replace(/^_+|_+$/g, "") || "untitled"}`;

export const MAX_QUEUE = 500;
export type OpenRun = { runId: string; job: JobRef; jobType: string; parent?: RunRef; boot: string };
export type QueueState = { items: RunEvent[]; open: OpenRun[]; dropped: number; failures: number; nextAt?: number; lastError?: string; lastErrorAt?: string; lastSentAt?: string };
export const emptyQueue = (): QueueState => ({ items: [], open: [], dropped: 0, failures: 0 });

export function enqueue(s: QueueState, ev: RunEvent) {
  s.items.push(ev);
  const over = s.items.length - MAX_QUEUE;
  if (over > 0) { s.items.splice(0, over); s.dropped += over; }
}

/** Sends in order until something fails. The queue is re-read after each send because new events can arrive during it. */
export async function drain(load: () => QueueState, save: (s: QueueState) => void, post: (body: string) => Promise<number>, now = Date.now) {
  for (;;) {
    const before = load(), head = before.items[0];
    if (!head || (before.nextAt && now() < before.nextAt)) return;
    const body = JSON.stringify(head);
    let status = 0, problem = "";
    try { status = await post(body); if (status < 200 || status >= 300) problem = `The endpoint answered with status ${status}.`; } catch (e) { problem = e instanceof Error ? e.message : String(e); }
    const s = load(), at = new Date(now()).toISOString(), done = () => { if (JSON.stringify(s.items[0]) === body) s.items.shift(); };
    if (!problem) { done(); s.lastSentAt = at; s.failures = 0; s.nextAt = undefined; save(s); continue; }
    s.lastError = problem; s.lastErrorAt = at;
    // The endpoint rejected this event, and sending it again can't help. 401, 404 and 5xx are about the endpoint, so those events wait.
    if ([400, 413, 422].includes(status)) { done(); s.dropped++; save(s); continue; }
    s.failures++; s.nextAt = now() + Math.min(5000 * 2 ** s.failures, 300000);
    save(s);
    return;
  }
}

/** Accepts a server address on its own, in which case the standard lineage path is used. */
export function lineageEndpoint(url: string) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("The endpoint must start with http:// or https://.");
  if (u.username || u.password) throw new Error("Put the API key in its own field, not in the address.");
  if (u.pathname === "/" || !u.pathname) u.pathname = "/api/v1/lineage";
  return u.toString();
}

/** What a model really reads: an ephemeral model isn't stored anywhere, so it stands for whatever it reads in turn. */
export function storedInputs(m: Model, ctx: Ctx) {
  const refs = new Set<string>(), sources = new Set<string>(), seen = new Set([m.name]);
  const visit = (x: Model) => {
    const e = effectiveOf(x, ctx);
    e.srcs.forEach((s) => sources.add(s));
    for (const d of e.deps) {
      const dep = ctx.byName.get(d);
      if (!dep || effectiveOf(dep, ctx).materialized !== "ephemeral") refs.add(d);
      else if (!seen.has(d)) { seen.add(d); visit(dep); }
    }
  };
  visit(m);
  return { refs: [...refs], sources: [...sources] };
}
