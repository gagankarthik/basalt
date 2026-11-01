import assert from "node:assert/strict";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { compileModel, effectiveOf, makeCtx } from "./dbt-compile.ts";
import { storedInputs } from "./openlineage.ts";
import { checkViewerRead, type ViewerLimits } from "./rowSecurity.ts";
import { RUN_HIDDEN, viewerConfig, viewerRun } from "./viewer.ts";
import type { Config, Model, Run } from "./types.ts";

test("viewers get no notebooks, because they hold SQL and Python", () => {
  const v = viewerConfig({ connections: [], pipelines: [], models: [], views: [], dashboards: [], metrics: [], queries: [], notebooks: [{ id: "n", name: "n", owner: "a", updatedAt: "", cells: [{ id: "c", kind: "python", source: "SECRET" }] }] } as unknown as Config, { name: "v", limited: false });
  assert.ok(!JSON.stringify(v).includes("SECRET"));
});

const M = (name: string, x: Partial<Model>): Model => ({ id: name, name, description: "", materialized: "table", sql: "", tests: [], owner: "Ada", ...x });
const models = [
  M("eph", { materialized: "ephemeral", sql: "select id from {{ source('s','t') }} where id > {{ var('min') }}" }),
  M("a", { sql: "-- BODY\nselect * from {{ ref('eph') }}", tests: [{ type: "custom", column: "", sql: "BODY" }] }),
  M("py", { kind: "python", python: "BODY", sql: "{{ ref('a') }}" }),
];
const cfg = { connections: [{ id: "c", name: "c", type: "postgres", slug: "c", host: "BODY", user: "BODY", ca: "BODY", createdAt: "" }], pipelines: [], models, views: [
  { id: "plain", shared: true, filters: [], colorRules: [] }, { id: "filtered", shared: true, filters: [{ value: "BODY" }], colorRules: [] }, { id: "mine", shared: false, filters: [], colorRules: [] },
], dashboards: [{ id: "d", bookmarks: [{ id: "b" }] }], metrics: [], queries: [{ id: "q", name: "x", sql: "BODY", owner: "Ada", updatedAt: "" }, { id: "own", name: "y", sql: "s", owner: "Vi", updatedAt: "" }], settings: {}, project: { vars: { min: 0, k: "BODY" }, macros: "{% macro x() %}BODY{% endmacro %}" } } as unknown as Config;

test("viewer config has no bodies, and dependencies survive", () => {
  const v = viewerConfig(cfg, { name: "Vi", limited: false });
  assert.ok(!JSON.stringify({ ...v, views: [] }).includes("BODY"));
  assert.deepEqual(v.queries.map((q) => q.id), ["own"]);
  assert.deepEqual(v.views.map((x) => x.id), ["plain", "filtered"]);
  const ctx = makeCtx(v.models, v.project);
  assert.deepEqual(effectiveOf(v.models.find((m) => m.name === "a")!, ctx).deps, ["eph"]);
  assert.deepEqual(effectiveOf(v.models.find((m) => m.name === "py")!, ctx).deps, ["a"]);
  assert.deepEqual(effectiveOf(v.models.find((m) => m.name === "eph")!, ctx).srcs, ["raw_s.t"]);
});
test("a limited viewer also loses saved filter values and bookmarks", () => {
  const v = viewerConfig(cfg, { name: "Vi", limited: true });
  assert.ok(!JSON.stringify(v).includes("BODY"));
  assert.equal(v.dashboards[0].bookmarks, undefined);
});
test("viewer model stubs compile, including one that reads an ephemeral stub", async () => {
  const v = viewerConfig(cfg, { name: "Vi", limited: false }), ctx = makeCtx(v.models, v.project), c = await (await DuckDBInstance.create(":memory:")).connect();
  await c.run(`CREATE SCHEMA analytics; CREATE TABLE analytics.a(i INT); CREATE TABLE analytics.eph(i INT)`);
  assert.equal((await c.runAndReadAll(compileModel(v.models.find((m) => m.name === "a")!, ctx))).columnNames()[0], "i");
});
test("viewer run: no artifacts or error text, and limited viewers no counts", () => {
  const r: Run = { id: "r", kind: "sync", refId: "p", name: "n", status: "failed", startedAt: "", trigger: "manual", actor: "a", summary: "VALUE", artifacts: { x: "VALUE" },
    streams: [{ name: "s", status: "failed", read: 5, written: 5, heldBack: ["h"], error: "VALUE" }],
    messages: [{ type: "STATE", at: "", state: { cursor: "VALUE" } }, { type: "LOG", at: "", message: "VALUE" }, { type: "TRACE", at: "", level: "ERROR", message: "VALUE" }, { type: "TRACE", at: "", level: "INFO", message: "COMPLETE" }] };
  const plain = viewerRun(r, false);
  assert.ok(!JSON.stringify(plain).includes("VALUE"));
  assert.equal(plain.summary, RUN_HIDDEN);
  assert.deepEqual(plain.messages!.map((m) => m.message), ["COMPLETE"]);
  const lim = viewerRun(r, true);
  assert.ok(!JSON.stringify(lim).includes("VALUE"));
  assert.equal(lim.messages, undefined);
  assert.equal(lim.streams![0].read, 0);
});
test("lineage inputs go through ephemeral models to what's stored", () => {
  const ctx = makeCtx(models, { vars: { min: 0 } });
  assert.deepEqual(storedInputs(models[1], ctx), { refs: [], sources: ["raw_s.t"] });
  assert.deepEqual(storedInputs(models[2], ctx), { refs: ["a"], sources: [] });
  assert.match(compileModel(models[1], ctx), /"raw_s"\."t" where id > 0/);
});

const c = await (await DuckDBInstance.create(":memory:")).connect();
await c.run(`CREATE SCHEMA a_dbt_test__audit; CREATE TABLE a_dbt_test__audit.f(i INT); CREATE SCHEMA raw_x; CREATE TABLE raw_x.t(i INT); CREATE TABLE main.loose(i INT)`);
const open: ViewerLimits = { revoked: new Set(), stageClosed: () => false, limited: false };
const closed: ViewerLimits = { revoked: new Set(["raw_x.t"]), stageClosed: (s) => s === "main", limited: true };
const refused = (sql: string, l: ViewerLimits) => assert.rejects(checkViewerRead(c, sql, l), sql);
test("stored failures and view source are refused for every viewer, however they're reached", async () => {
  for (const l of [open, closed]) for (const sql of [
    "select * from a_dbt_test__audit.f", 'select * from "A_DBT_TEST__AUDIT"."f"', "with x as (select * from a_dbt_test__audit.f) select * from x", "select (select max(i) from a_dbt_test__audit.f)", "select 1; select * from a_dbt_test__audit.f",
    "select * from query('select * from a_dbt' || '_test__audit.f')", "select * from query_table('a_dbt_test__audit.f')", "summarize a_dbt_test__audit.f", "select sql from duckdb_views()", "select * from duckdb_views", "select sql from sqlite_master", "select view_definition from information_schema.views", "select definition from pg_catalog.pg_views",
  ]) await refused(sql, l);
});
test("a viewer with no limits keeps what worked", async () => {
  for (const sql of ["explain select 1", "select * from generate_series(1,2)", "select * from raw_x.t", "select * from information_schema.columns", "describe raw_x.t", "with views as (select 1) select * from views"]) await checkViewerRead(c, sql, open);
});
test("revoked tables and closed layers", async () => {
  for (const sql of ["select * from raw_x.t", "select * from RAW_X.T", "with x as (select * from raw_x.t) select * from x", "select * from loose", "explain select 1", "select * from read_csv('x')"]) await refused(sql, closed);
  for (const sql of ["with loose2 as (select 1) select * from loose2", "select * from information_schema.columns", "select * from range(2)"]) await checkViewerRead(c, sql, closed);
});
