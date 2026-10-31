import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { checkFacets, columnLineage, connectionDataset, drain, emptyQueue, enqueue, lineageEndpoint, MAX_QUEUE, runEvent, safeHost, schemaFacet, scrub, syncDatasets, facet, warehouseDataset, type QueueState, type RunEvent, type Schemas } from "./openlineage.ts";
import { postJson } from "./webhook.ts";
import type { Connection, ModelTest, Pipeline, StreamStat } from "./types.ts";

/* ---- a small validator for the official schemas. An unknown keyword throws, so nothing can pass by being ignored. ---- */
type S = Record<string, unknown>;
const spec = (f: string) => JSON.parse(fs.readFileSync(new URL(`./openlineage-spec/${f}.json`, import.meta.url), "utf8")) as S;
const FILES = ["OpenLineage", "ParentRunFacet", "ErrorMessageRunFacet", "JobTypeJobFacet", "SQLJobFacet", "SchemaDatasetFacet", "OutputStatisticsOutputDatasetFacet", "DataQualityMetricsInputDatasetFacet", "DataQualityAssertionsDatasetFacet", "ColumnLineageDatasetFacet"];
const docs = new Map(FILES.map((f) => { const d = spec(f); return [String(d.$id), d]; }));
const CORE = spec("OpenLineage");
const IGNORED = new Set(["$schema", "$id", "$defs", "description", "example", "title", "deprecated"]);
const FORMATS: Record<string, RegExp> = { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, uri: /^[a-z][a-z0-9+.-]*:\S+$/i, "date-time": /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/ };

function check(v: unknown, s: S, doc: S, at: string, errors: string[]) {
  const here = errors.length;
  for (const [k, val] of Object.entries(s)) {
    if (IGNORED.has(k)) continue;
    const obj = v as Record<string, unknown>, isObj = !!v && typeof v === "object" && !Array.isArray(v);
    switch (k) {
      case "$ref": {
        const [file, frag] = String(val).split("#"), d = file ? docs.get(file) : doc;
        assert.ok(d, `missing schema ${file}`);
        let t: unknown = d; for (const p of (frag ?? "").split("/").filter(Boolean)) t = (t as S)[p];
        assert.ok(t, `bad $ref ${val}`);
        check(v, t as S, d!, at, errors);
        break;
      }
      case "allOf": for (const x of val as S[]) check(v, x, doc, at, errors); break;
      case "anyOf": if (!(val as S[]).some((x) => { const e: string[] = []; check(v, x, doc, at, e); return !e.length; })) errors.push(`${at}: no anyOf match`); break;
      case "oneOf": if ((val as S[]).filter((x) => { const e: string[] = []; check(v, x, doc, at, e); return !e.length; }).length !== 1) errors.push(`${at}: not exactly one oneOf match`); break;
      case "not": { const e: string[] = []; check(v, val as S, doc, at, e); if (!e.length) errors.push(`${at}: matches a not`); break; }
      case "type": if (!(val === "integer" ? Number.isInteger(v) : val === "array" ? Array.isArray(v) : val === "object" ? isObj : typeof v === val)) errors.push(`${at}: expected ${val}`); break;
      case "enum": if (!(val as unknown[]).includes(v)) errors.push(`${at}: ${v} not allowed`); break;
      case "format": if (typeof v === "string" && !FORMATS[String(val)].test(v)) errors.push(`${at}: bad ${val}: ${v}`); break;
      case "minimum": if (typeof v === "number" && v < Number(val)) errors.push(`${at}: below minimum`); break;
      case "required": if (isObj) for (const r of val as string[]) if (!(r in obj)) errors.push(`${at}: missing ${r}`); break;
      case "properties": if (isObj) for (const [p, sub] of Object.entries(val as S)) if (p in obj) check(obj[p], sub as S, doc, `${at}.${p}`, errors); break;
      case "additionalProperties":
        if (isObj && val && typeof val === "object") { const known = (s.properties ?? {}) as S; for (const [p, x] of Object.entries(obj)) if (!(p in known)) check(x, val as S, doc, `${at}.${p}`, errors); }
        else if (isObj && val === false) { const known = (s.properties ?? {}) as S; for (const p of Object.keys(obj)) if (!(p in known)) errors.push(`${at}: extra ${p}`); }
        break;
      case "items": if (Array.isArray(v)) v.forEach((x, i) => check(x, val as S, doc, `${at}[${i}]`, errors)); break;
      default: assert.fail(`validator doesn't know the keyword ${k}`);
    }
  }
  return errors.length === here;
}

/** The whole event against OpenLineage.json, then each facet against its own file, which the core schema doesn't do. */
function errorsIn(ev: RunEvent) {
  const errors: string[] = [];
  check(ev, CORE, CORE, "$", errors);
  const facets = (group: Record<string, unknown> | undefined, at: string) => {
    for (const [name, value] of Object.entries(group ?? {})) {
      const url = String((value as S)._schemaURL), [file, frag] = url.split("#"), d = docs.get(file);
      if (!d) { errors.push(`${at}.${name}: no schema for ${url}`); continue; }
      if (!(d.properties as S)[name]) errors.push(`${at}.${name}: ${file} doesn't define this facet`);
      else check(value, (d.properties as S)[name] as S, d, `${at}.${name}`, errors);
      if (`#${frag}` !== ((d.properties as S)[name] as S | undefined)?.$ref) errors.push(`${at}.${name}: _schemaURL fragment ${frag}`);
    }
  };
  facets(ev.run.facets, "run"); facets(ev.job.facets, "job");
  for (const d of [...ev.inputs, ...ev.outputs]) { facets(d.facets, d.name); facets(d.inputFacets, d.name); facets(d.outputFacets, d.name); }
  return errors;
}
const valid = (ev: RunEvent) => assert.deepEqual(errorsIn(ev), [], `${ev.eventType} ${ev.job.name}`);

/* ---- fixtures ---- */
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e", PARENT = "7c9e6679-7425-40de-944b-e07fc1f90ae7", NS = "basalt", T = "2026-10-30T12:00:00.000Z";
const pg: Connection = { id: "c1", name: "App", type: "postgres", slug: "app", host: "db.internal", port: 5432, database: "shop", user: "basalt", createdAt: T };
const job = { namespace: NS, name: "sync.app" }, parent = { runId: PARENT, job: { namespace: NS, name: "flow.all" } };
const pipeline: Pipeline = { id: "p", name: "App", connectionId: "c1", schedule: 0, runModelsAfter: false, paused: false, streams: [
  { name: "customers", enabled: true, mode: "full_refresh", rules: { email: "hash", phone: "mask", dob: "month", ssn: "drop" } },
  { name: "billing.invoices", enabled: true, mode: "full_refresh", rules: {} },
  { name: "off", enabled: false, mode: "full_refresh", rules: {} },
] };
const stats: StreamStat[] = [
  { name: "customers", status: "ok", read: 5, written: 5, sourceRows: 5, copyRows: 5, heldBack: ["notes"] },
  { name: "billing.invoices", status: "failed", read: 0, written: 0, heldBack: [], error: "boom" },
];
const catalog = { customers: ["id", "email", "phone", "dob", "ssn", "notes"].map((name) => ({ name, type: "VARCHAR" })) };
const schemas: Schemas = new Map([
  ["raw_app.customers", ["id", "email", "phone", "dob", "_basalt_synced_at"].map((name) => ({ name, type: "VARCHAR" }))],
  ["analytics.orders", ["id", "amount", "status", "customer_id"].map((name) => ({ name, type: "INTEGER" }))],
  ["raw_app.people", ["customer_id", "name", "email"].map((name) => ({ name, type: "VARCHAR" }))],
]);

test("sync events are valid in every state, with parent and error facets", () => {
  const d = syncDatasets(pipeline, pg, NS, stats, catalog, schemas);
  valid(runEvent({ type: "START", time: T, runId: RUN, job, jobType: "SYNC", parent, ...syncDatasets(pipeline, pg, NS, []) }));
  valid(runEvent({ type: "RUNNING", time: T, runId: RUN, job, jobType: "SYNC", ...syncDatasets(pipeline, pg, NS, stats.slice(0, 1)) }));
  valid(runEvent({ type: "COMPLETE", time: T, runId: RUN, job, jobType: "SYNC", ...d }));
  valid(runEvent({ type: "FAIL", time: T, runId: RUN, job, jobType: "SYNC", parent: { ...parent, root: parent }, error: "billing.invoices: boom", ...d }));
  valid(runEvent({ type: "ABORT", time: T, runId: RUN, job, jobType: "SYNC", error: "restarted" }));
  valid(runEvent({ type: "COMPLETE", time: T, runId: RUN, job: { namespace: NS, name: "model.x" }, jobType: "MODEL", sql: "SELECT 1", inputs: [{ ...warehouseDataset(NS, "raw_app", "customers"), facets: schemaFacet(catalog.customers) }], outputs: [{ ...warehouseDataset(NS, "analytics", "x"), outputFacets: { outputStatistics: facet("outputStatistics", { rowCount: 3 }) } }] }));
  const tests: ModelTest[] = [{ type: "not_null", column: "id" }, { type: "custom", column: "", sql: "SELECT 1", block: true }, { type: "accepted_values", column: "status", values: ["secret-value"] }];
  const cf = checkFacets(tests.map((t, i) => ({ test: t, name: `t${i}`, result: { unique_id: `t${i}`, status: i ? "pass" : "fail", failures: i ? 0 : 2 } })), 10);
  valid(runEvent({ type: "FAIL", time: T, runId: RUN, job: { namespace: NS, name: "model.x.checks" }, jobType: "MODEL_CHECKS", inputs: [{ ...warehouseDataset(NS, "analytics", "x"), inputFacets: cf }] }));
  assert.deepEqual((cf.dataQualityMetrics as unknown as { columnMetrics: unknown }).columnMetrics, { id: { nullCount: 2 } });
  assert.ok(!JSON.stringify(cf).includes("secret-value"), "configured check values stay out");
  assert.ok(!JSON.stringify(cf).includes("SELECT"), "check SQL stays out");
});

test("the validator catches bad events", () => {
  const good = () => runEvent({ type: "START", time: T, runId: RUN, job, jobType: "SYNC" });
  assert.deepEqual(errorsIn(good()), []);
  for (const breakIt of [
    (e: RunEvent) => { e.eventTime = "yesterday"; }, (e: RunEvent) => { e.run.runId = "not-a-uuid"; }, (e: RunEvent) => { (e as Partial<RunEvent>).producer = undefined; delete (e as Partial<RunEvent>).producer; },
    (e: RunEvent) => { (e as { eventType: string }).eventType = "DONE"; }, (e: RunEvent) => { e.job.facets = { jobType: facet("jobType", { integration: "BASALT" }) }; },
    (e: RunEvent) => { e.run.facets = { parent: facet("parent", { run: { runId: RUN } }) }; }, (e: RunEvent) => { e.outputs = [{ namespace: "x" } as never]; },
    (e: RunEvent) => { e.inputs = [{ namespace: "x", name: "y", inputFacets: { dataQualityMetrics: facet("dataQualityMetrics", { rowCount: 1 }) } }]; },
  ]) { const e = good(); breakIt(e); assert.ok(errorsIn(e).length, breakIt.toString()); }
});

test("dataset names follow the naming doc and never carry credentials", () => {
  assert.deepEqual(connectionDataset(pg, "customers", NS), { namespace: "postgres://db.internal:5432", name: "shop.public.customers" });
  assert.deepEqual(connectionDataset(pg, "billing.invoices", NS), { namespace: "postgres://db.internal:5432", name: "shop.billing.invoices" });
  assert.deepEqual(connectionDataset({ ...pg, type: "mysql", port: undefined }, "t", NS), { namespace: "mysql://db.internal:3306", name: "shop.t" });
  assert.deepEqual(connectionDataset({ ...pg, type: "s3", database: "lake", prefix: "/raw/" }, "orders", NS), { namespace: "s3://lake", name: "raw/orders" });
  assert.deepEqual(connectionDataset({ ...pg, type: "gcs", database: "lake" }, "orders", NS), { namespace: "gs://lake", name: "orders" });
  assert.deepEqual(connectionDataset({ ...pg, type: "bigquery", database: "proj", prefix: "ds" }, "t", NS), { namespace: "bigquery", name: "proj.ds.t" });
  assert.deepEqual(connectionDataset({ ...pg, type: "snowflake", host: "org-acct", prefix: undefined }, "t", NS), { namespace: "snowflake://org-acct", name: "shop.PUBLIC.t" });
  assert.deepEqual(warehouseDataset(NS, "analytics", "t"), { namespace: "duckdb://basalt", name: "warehouse.analytics.t" });
  for (const host of ["postgres://bob:hunter2@db.internal:5432/shop", "bob:hunter2@db.internal"]) {
    assert.equal(safeHost(host).includes("hunter2"), false, host);
    assert.equal(connectionDataset({ ...pg, host }, "t", NS).namespace, "postgres://db.internal:5432");
  }
});

test("masked columns are marked, left-out and held-back columns have no output lineage", () => {
  const out = syncDatasets(pipeline, pg, NS, stats, catalog, schemas).outputs;
  assert.deepEqual(out.map((o) => o.name), ["warehouse.raw_app.customers"], "a failed table is not an output");
  const f = (out[0].facets!.columnLineage as { fields: Record<string, { inputFields: { name: string; transformations: { subtype: string; masking: boolean }[] }[] }> }).fields;
  assert.deepEqual(Object.keys(f).sort(), ["dob", "email", "id", "phone"]);
  for (const c of ["email", "phone", "dob"]) assert.deepEqual([f[c].inputFields[0].transformations[0].subtype, f[c].inputFields[0].transformations[0].masking], ["TRANSFORMATION", true], c);
  assert.deepEqual([f.id.inputFields[0].transformations[0].subtype, f.id.inputFields[0].transformations[0].masking], ["IDENTITY", false]);
  assert.equal(f.id.inputFields[0].name, "shop.public.customers");
  assert.equal(syncDatasets(pipeline, pg, NS, [{ ...stats[0], copyRows: undefined }], catalog, schemas).outputs.length, 0, "nothing written, so no output");
});

test("error text loses values, addresses and secrets", () => {
  const dirty = `Conversion Error: Could not convert string 'jane@acme.com' to INT32 password=hunter2 at postgres://bob:pw@db/x "10.0.0.5" contact me@acme.com\nLINE 1: SELECT secret FROM t`;
  const clean = scrub(dirty);
  for (const bad of ["jane", "hunter2", "bob", "10.0.0.5", "me@acme", "SELECT"]) assert.ok(!clean.includes(bad), `${bad} in ${clean}`);
  assert.match(clean, /Could not convert string/);
  const ev = runEvent({ type: "FAIL", time: T, runId: RUN, job, jobType: "SYNC", error: dirty });
  valid(ev);
  assert.ok(!JSON.stringify(ev).includes("hunter2"));
});

/* ---- column lineage: these ASTs are real json_serialize_sql output, trimmed ---- */
const col = (...column_names: string[]) => ({ class: "COLUMN_REF", column_names });
const ast = (select_list: unknown[], from_table: unknown, extra = {}) => ({ error: false, statements: [{ node: { type: "SELECT_NODE", cte_map: {}, select_list, from_table, ...extra } }] });
const table = (schema_name: string, table_name: string, alias = "") => ({ type: "BASE_TABLE", schema_name, table_name, alias });
const outCols = (...n: string[]) => n.map((name) => ({ name, type: "INTEGER" }));

test("column lineage for plain SELECTs", () => {
  const a = ast([{ ...col("o", "id"), alias: "order_id" }, { class: "FUNCTION", alias: "total", function_name: "sum", arguments: [{ expression: col("amount") }] }, { class: "FUNCTION", alias: "n", function_name: "count_star" }, { class: "FUNCTION", alias: "h", function_name: "sha256", arguments: [{ expression: col("p", "email") }] }, { class: "CASE", alias: "k", case_checks: [{ when_expr: { class: "COMPARISON", left: col("status"), right: { class: "CONSTANT" } }, then_expr: col("o", "amount") }], else_expr: { class: "CONSTANT" } }], { type: "JOIN", ref_type: "REGULAR", left: table("analytics", "orders", "o"), right: table("raw_app", "people", "p") });
  const f = columnLineage(a, outCols("order_id", "total", "n", "h", "k"), schemas, NS)!;
  assert.deepEqual(f.order_id.inputFields[0].transformations[0].subtype, "IDENTITY");
  assert.equal(f.order_id.inputFields[0].field, "id");
  assert.equal(f.order_id.inputFields[0].name, "warehouse.analytics.orders");
  assert.equal(f.total.inputFields[0].transformations[0].subtype, "AGGREGATION");
  assert.equal(f.n, undefined, "count(*) reads no one column");
  assert.equal(f.h.inputFields[0].transformations[0].masking, true);
  assert.deepEqual(f.k.inputFields.map((x) => [x.field, x.transformations[0].type]), [["amount", "DIRECT"], ["status", "INDIRECT"]]);
  const v = runEvent({ type: "COMPLETE", time: T, runId: RUN, job, jobType: "MODEL", outputs: [{ ...warehouseDataset(NS, "analytics", "x"), facets: { columnLineage: facet("columnLineage", { fields: f }) } }] });
  valid(v);
  // SELECT * from one table expands from its known columns
  assert.deepEqual(Object.keys(columnLineage(ast([{ class: "STAR" }], table("analytics", "orders")), outCols("id", "amount", "status", "customer_id"), schemas, NS)!), ["id", "amount", "status", "customer_id"]);
});

test("column lineage is left out rather than guessed", () => {
  const orders = table("analytics", "orders"), cols = outCols("id", "x");
  assert.equal(columnLineage({ error: true }, cols, schemas, NS), null, "parse error");
  assert.equal(columnLineage(ast([col("id")], orders, { cte_map: { map: [{}] } }), cols, schemas, NS), null, "CTE");
  assert.equal(columnLineage({ error: false, statements: [{ node: { type: "SET_OPERATION_NODE" } }] }, cols, schemas, NS), null, "UNION");
  assert.equal(columnLineage(ast([col("id")], { type: "SUBQUERY" }), cols, schemas, NS), null, "subquery");
  assert.equal(columnLineage(ast([col("id")], table("", "orders")), cols, schemas, NS), null, "no schema");
  assert.equal(columnLineage(ast([col("id")], table("analytics", "unknown")), cols, schemas, NS), null, "unknown table");
  const one = (item: unknown, from: unknown = orders) => columnLineage(ast([item], from), cols, schemas, NS);
  assert.equal(one({ class: "WINDOW", alias: "x" }), null, "window");
  assert.equal(one({ class: "SUBQUERY", alias: "x" }), null, "scalar subquery");
  assert.equal(one({ class: "FUNCTION", function_name: "upper", arguments: [{ expression: col("status") }] }), null, "no alias, so the name is DuckDB's own");
  assert.equal(one({ ...col("not_there"), alias: "x" }), null, "unknown column");
  assert.equal(one({ ...col("id"), alias: "not_in_output" }), null, "not an output column");
  assert.equal(one({ ...col("customer_id"), alias: "x" }, { type: "JOIN", ref_type: "REGULAR", left: orders, right: table("raw_app", "people") }), null, "ambiguous");
  assert.equal(one({ class: "STAR", exclude_list: ["id"] }), null, "star with exclude");
  assert.equal(columnLineage(ast([{ class: "STAR" }], { type: "JOIN", ref_type: "REGULAR", left: orders, right: table("raw_app", "people") }), cols, schemas, NS), null, "star over a join");
  assert.equal(columnLineage(ast([{ class: "FUNCTION", alias: "x", function_name: "weird_udf", arguments: [{ expression: col("status") }] }], orders, { group_expressions: [{}] }), cols, schemas, NS), null, "unknown function in GROUP BY");
  assert.equal(columnLineage(ast([col("id"), { ...col("amount"), alias: "id" }], orders), cols, schemas, NS), null, "two columns, one name");
});

/* ---- delivery ---- */
const ev = (n: number) => runEvent({ type: "START", time: T, runId: RUN, job: { namespace: NS, name: `j${n}` }, jobType: "SYNC" });
const store = (init: QueueState = emptyQueue()) => { let s = init; return { load: () => JSON.parse(JSON.stringify(s)) as QueueState, save: (x: QueueState) => { s = x; } }; };

test("the queue is bounded, oldest first", () => {
  const s = emptyQueue();
  for (let i = 0; i < MAX_QUEUE + 3; i++) enqueue(s, ev(i));
  assert.equal(s.items.length, MAX_QUEUE);
  assert.equal(s.dropped, 3);
  assert.equal(s.items[0].job.name, "j3");
});

test("delivery to a stub receiver: bearer key, retries with backoff, rejects dropped, order kept", async () => {
  const got: { auth?: string; path?: string; event: RunEvent }[] = [], answers: number[] = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { got.push({ auth: req.headers.authorization, path: req.url, event: JSON.parse(b) }); res.statusCode = answers.shift() ?? 201; res.end(); }); });
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const url = lineageEndpoint(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const post = (body: string) => postJson(url, body, { authorization: "Bearer k" });
  process.env.BASALT_ALLOW_PRIVATE_WEBHOOKS = "1";
  try {
    let clock = 1000;
    const q = store(), now = () => clock;
    const s = q.load(); enqueue(s, ev(1)); enqueue(s, ev(2)); enqueue(s, ev(3)); q.save(s);

    answers.push(503);
    await drain(q.load, q.save, post, now);
    assert.equal(q.load().items.length, 3, "kept after a server error");
    assert.match(q.load().lastError!, /503/);
    assert.ok(q.load().nextAt! > clock);
    const n = got.length;
    await drain(q.load, q.save, post, now);
    assert.equal(got.length, n, "waits out the backoff");

    clock = q.load().nextAt! + 1;
    answers.push(400);
    await drain(q.load, q.save, post, now);
    const end = q.load();
    assert.equal(end.items.length, 0);
    assert.equal(end.dropped, 1, "a rejected event isn't retried forever");
    assert.ok(end.lastSentAt);
    assert.deepEqual(got.map((g) => g.event.job.name), ["j1", "j1", "j2", "j3"]);
    assert.equal(got[0].auth, "Bearer k");
    assert.equal(got[0].path, "/api/v1/lineage");
    got.forEach((g) => valid(g.event));

    // Nobody listening: kept, error recorded, nothing thrown
    server.closeAllConnections(); await new Promise((d) => server.close(d));
    const r = q.load(); enqueue(r, ev(4)); q.save(r);
    await drain(q.load, q.save, post, now);
    assert.equal(q.load().items.length, 1);
    assert.match(q.load().lastError!, /ECONN(REFUSED|RESET)/);
  } finally { delete process.env.BASALT_ALLOW_PRIVATE_WEBHOOKS; server.close(); }
});

test("internal endpoints are refused without the override, and addresses are checked", async () => {
  delete process.env.BASALT_ALLOW_PRIVATE_WEBHOOKS;
  const q = store(); const s = q.load(); enqueue(s, ev(1)); q.save(s);
  await drain(q.load, q.save, (b) => postJson(lineageEndpoint("http://127.0.0.1:1/"), b));
  assert.match(q.load().lastError!, /internal network/);
  assert.equal(lineageEndpoint("https://m.example/"), "https://m.example/api/v1/lineage");
  assert.equal(lineageEndpoint("https://m.example/custom/path"), "https://m.example/custom/path");
  assert.throws(() => lineageEndpoint("ftp://x/"), /http/);
  assert.throws(() => lineageEndpoint("https://u:p@x/"), /API key/);
});
