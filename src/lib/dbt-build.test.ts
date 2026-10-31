import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { assertHook, assertSelect, buildCatalog, buildManifest, buildNode, freshnessStatus, parseCsv, runTest, sourceFreshness } from "./dbt-build.ts";
import { effectiveOf, makeCtx } from "./dbt-compile.ts";
import type { Model } from "./types.ts";

const { DuckDBInstance } = createRequire(import.meta.url)("@duckdb/node-api");
const model = (name: string, sql: string, p: Partial<Model> = {}): Model => ({ id: name, name, description: "", materialized: "table", sql, tests: [], owner: "", ...p });
async function db() {
  const d = await DuckDBInstance.create(":memory:"), c = await d.connect();
  await c.run(`CREATE SCHEMA analytics; CREATE SCHEMA raw_a; CREATE TABLE raw_a.t AS SELECT * FROM (VALUES (1, 'x'), (2, 'y')) v(id, s)`);
  return { c, rows: async (s: string) => (await c.runAndReadAll(s)).getRowObjectsJson(), done: () => { c.closeSync(); d.closeSync(); } };
}
const build = (c: never, m: Model, all: Model[] = [m], full = false) => { const ctx = makeCtx(all); return buildNode(c, effectiveOf(m, ctx), ctx, full); };

test("a model has to be one SELECT", async () => {
  const { c, done } = await db();
  await assertSelect(c, "WITH a AS (SELECT 1) SELECT * FROM a", "m");
  await assertSelect(c, "FROM raw_a.t", "m");
  for (const bad of ["SELECT 1; DROP SCHEMA analytics CASCADE", "DROP SCHEMA analytics CASCADE", "COPY raw_a.t TO 'x.csv'", "ATTACH 'x.db'"]) await assert.rejects(assertSelect(c, bad, "m"), /one SELECT/, bad);
  await assert.rejects(build(c as never, model("m", "SELECT 1; SET enable_external_access = true")), /one SELECT/);
  done();
});
test("hooks can't end the transaction or change settings", async () => {
  const { c, done } = await db();
  for (const bad of ["COMMIT", "SET lock_configuration = false", "ATTACH 'x'", "LOAD x", "INSTALL x", "SELECT 1; SELECT 2", "PRAGMA x"]) await assert.rejects(assertHook(c, bad), /hook/, bad);
  await assertHook(c, "-- note\nINSERT INTO a VALUES (1)");
  done();
});
test("a failed post-hook rolls back the build and the old table stays", async () => {
  const { c, rows, done } = await db();
  await build(c as never, model("m", "SELECT 1 AS id"));
  await assert.rejects(build(c as never, model("m", "SELECT 2 AS id", { postHook: ["INSERT INTO nope VALUES (1)"] })), /nope/);
  assert.deepEqual(await rows("SELECT id FROM analytics.m"), [{ id: 1 }]);
  await build(c as never, model("m", "SELECT 3 AS id", { preHook: ["CREATE TABLE analytics.log (n INT)"], postHook: ["INSERT INTO analytics.log SELECT id FROM {{ this }}"] }));
  assert.deepEqual(await rows("SELECT n FROM analytics.log"), [{ n: 3 }]);
  done();
});
test("switching view and table, with a rollback when the build fails", async () => {
  const { c, rows, done } = await db();
  await build(c as never, model("m", "SELECT 1 AS id", { materialized: "view" }));
  await assert.rejects(build(c as never, model("m", "SELECT 1 AS id", { postHook: ["INSERT INTO nope VALUES (1)"] })), /nope/);
  assert.deepEqual(await rows(`SELECT table_type t FROM information_schema.tables WHERE table_name = 'm'`), [{ t: "VIEW" }]);
  await build(c as never, model("m", "SELECT 1 AS id"));
  assert.deepEqual(await rows(`SELECT table_type t FROM information_schema.tables WHERE table_name = 'm'`), [{ t: "BASE TABLE" }]);
  done();
});
test("existing incremental models keep their exact cursor behaviour", async () => {
  const { c, rows, done } = await db();
  const m = model("m", "SELECT * FROM {{ source('a', 't') }}", { materialized: "incremental", cursor: "id" });
  await assert.rejects(build(c as never, { ...m, cursor: undefined }), /Choose a cursor/);
  assert.equal(await build(c as never, m), "Built in full");
  await c.run("INSERT INTO raw_a.t VALUES (3, 'z')");
  assert.equal(await build(c as never, m), "Processed 1 new or changed rows");
  assert.deepEqual(await rows("SELECT id FROM analytics.m ORDER BY id"), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  const k = { ...m, name: "k", uniqueKey: "id" };
  await build(c as never, k);
  await c.run("UPDATE raw_a.t SET s = 'zz' WHERE id = 3");
  assert.equal(await build(c as never, k), "Processed 1 new or changed rows");
  assert.deepEqual(await rows("SELECT s FROM analytics.k WHERE id = 3"), [{ s: "zz" }]);
  assert.equal(await build(c as never, k, [k], true), "Built in full");
  done();
});
test("existing snapshots keep _valid_from and _valid_to", async () => {
  const { c, rows, done } = await db();
  const m = model("h", "SELECT * FROM {{ source('a', 't') }}", { materialized: "snapshot", uniqueKey: "id" });
  assert.equal(await build(c as never, m), "Took the first snapshot");
  await c.run("UPDATE raw_a.t SET s = 'q' WHERE id = 1; DELETE FROM raw_a.t WHERE id = 2");
  assert.equal(await build(c as never, m), "Recorded changes");
  assert.deepEqual(await rows("SELECT id, s, _valid_to IS NULL cur FROM analytics.h ORDER BY id, cur"), [{ id: 1, s: "x", cur: false }, { id: 1, s: "q", cur: true }, { id: 2, s: "y", cur: false }]);
  await assert.rejects(build(c as never, { ...m, snapshotStrategy: "check" }), /built before snapshot strategies/);
  done();
});
test("on_schema_change fail stops the build and changes nothing", async () => {
  const { c, rows, done } = await db();
  const m = model("m", "SELECT 1 AS id", { materialized: "incremental", incrementalStrategy: "append", onSchemaChange: "fail" });
  await build(c as never, m);
  await assert.rejects(build(c as never, { ...m, sql: "SELECT 1 AS id, 2 AS extra" }), /out of sync.*extra/);
  assert.deepEqual(await rows("SELECT * FROM analytics.m"), [{ id: 1 }]);
  await assert.rejects(build(c as never, { ...m, sql: "SELECT 'a' AS id" }), /New column types: id VARCHAR/);
  done();
});
test("contracts: names and types, constraints, and the column order they set", async () => {
  const { c, rows, done } = await db();
  const contract = [{ name: "b", type: "string", notNull: true }, { name: "a", type: "int" }];
  await build(c as never, model("m", "SELECT 1 AS a, 'x' AS b", { contract }));
  assert.deepEqual((await rows("DESCRIBE analytics.m")).map((r: never) => [(r as { column_name: string }).column_name, (r as { column_type: string }).column_type]), [["b", "VARCHAR"], ["a", "INTEGER"]]);
  await assert.rejects(build(c as never, model("m", "SELECT 1 AS a, 1 AS b", { contract })), /Contract failed: b is INTEGER, and the contract says VARCHAR/);
  await assert.rejects(build(c as never, model("m", "SELECT 1 AS a", { contract })), /b is in the contract but not the query/);
  await assert.rejects(build(c as never, model("m", "SELECT 1 AS a, 'x' AS b, 2 AS z", { contract })), /z is in the query but not the contract/);
  await assert.rejects(build(c as never, model("m", "SELECT 1 AS a, CAST(NULL AS VARCHAR) AS b", { contract })), /NOT NULL/);
  assert.deepEqual(await rows("SELECT * FROM analytics.m"), [{ b: "x", a: 1 }]);
  await assert.rejects(build(c as never, model("m", "SELECT 1 AS a", { contract: [{ name: "a", type: "int); DROP TABLE x; --" }] })), /valid data type/);
  done();
});
test("seeds infer types and refuse bad CSV", async () => {
  const { c, rows, done } = await db();
  assert.deepEqual(parseCsv('a,b\r\n"x,1","y""z"\n\n3,\n'), [["a", "b"], ["x,1", 'y"z'], ["3", ""]]);
  await build(c as never, model("s", "", { kind: "seed", csv: "i,big,d,b,dt,t,e\n1,9000000000,1.5,true,2026-01-02,hello,\n2,1,2,false,2026-01-03,1x,\n" }));
  assert.deepEqual((await rows("DESCRIBE analytics.s")).map((r: never) => (r as { column_type: string }).column_type), ["INTEGER", "BIGINT", "DOUBLE", "BOOLEAN", "DATE", "VARCHAR", "VARCHAR"]);
  await assert.rejects(build(c as never, model("s", "", { kind: "seed", csv: "a,b\n1\n" })), /Row 2/);
  await assert.rejects(build(c as never, model("s", "", { kind: "seed", csv: "a,a\n1,2\n" })), /twice/);
  await assert.rejects(build(c as never, model("s", "", { kind: "seed", csv: "" })), /no CSV/);
  done();
});
test("store failures keeps the failing rows, replaced on each run", async () => {
  const { c, rows, done } = await db();
  const t = { type: "not_null", column: "v", storeFailures: true, where: "id < 3" } as const;
  const m = model("m", "SELECT * FROM (VALUES (1, NULL), (2, 5), (3, NULL)) x(id, v)", { tests: [t] }), ctx = makeCtx([m]);
  await build(c as never, m);
  assert.deepEqual({ ...(await runTest(c as never, m, t, 0, ctx)), execution_time: 0 }, { unique_id: "test.basalt.not_null_m_v", status: "fail", failures: 1, execution_time: 0, message: "1 rows failed" });
  assert.deepEqual(await rows("SELECT id FROM analytics_dbt_test__audit.not_null_m_v"), [{ id: 1 }]);
  await c.run("DROP TABLE analytics.m"); await c.run("CREATE TABLE analytics.m AS SELECT 1 AS id, 2 AS v");
  assert.equal((await runTest(c as never, m, t, 0, ctx)).status, "pass");
  assert.deepEqual(await rows("SELECT count(*)::INT n FROM analytics_dbt_test__audit.not_null_m_v"), [{ n: 0 }]);
  const bad = await runTest(c as never, m, { type: "custom", column: "", sql: "DROP TABLE analytics.m" }, 0, ctx);
  assert.equal(bad.status, "error");
  assert.deepEqual(await rows("SELECT count(*)::INT n FROM analytics.m"), [{ n: 1 }]);
  done();
});
test("generic test macros and checks on an ephemeral model", async () => {
  const { c, done } = await db();
  const e = model("e", "SELECT 1 AS id, -5 AS v", { materialized: "ephemeral" });
  const t = { type: "generic", column: "v", macro: "positive" } as const, ctx = makeCtx([{ ...e, tests: [t] }], { macros: "{% test positive(model, column_name) %}SELECT * FROM {{ model }} x WHERE {{ column_name }} <= 0{% endtest %}" });
  assert.equal((await buildNode(c as never, effectiveOf(e, ctx), ctx)).startsWith("Ephemeral"), true);
  assert.equal((await runTest(c as never, e, t, 0, ctx)).failures, 1);
  done();
});
test("freshness: error first, then warn; a missing column is a runtime error", async () => {
  const { c, done } = await db();
  assert.deepEqual([100, 3601, 90000].map((a) => freshnessStatus(a, { count: 1, period: "hour" }, { count: 1, period: "day" })), ["pass", "warn", "error"]);
  assert.equal(freshnessStatus(Infinity, { count: 1, period: "hour" }), "warn");
  await c.run(`CREATE TABLE raw_a.f AS SELECT now()::TIMESTAMP - INTERVAL 2 HOUR AS _basalt_synced_at, 1 AS keep UNION ALL SELECT now()::TIMESTAMP, 0`);
  const ctx = makeCtx([], { sources: [
    { source: "a", table: "f", warnAfter: { count: 1, period: "hour" } },
    { source: "a", table: "t", warnAfter: { count: 1, period: "hour" } },
    { source: "a", table: "t", },
  ] });
  const f = await sourceFreshness(c as never, ctx);
  assert.deepEqual(f.results.map((r) => [r.unique_id, r.status]), [["source.basalt.a.f", "pass"], ["source.basalt.a.t", "runtime error"]]);
  const g = await sourceFreshness(c as never, makeCtx([], { sources: [{ source: "a", table: "f", filter: "keep = 1", warnAfter: { count: 1, period: "hour" } }] }));
  assert.equal(g.results[0].status, "warn");
  done();
});
test("manifest and catalog shapes", async () => {
  const { c, done } = await db();
  const a = model("a", "SELECT * FROM {{ source('a', 't') }}", { tags: ["x"], columnDocs: { id: "Key" }, tests: [{ type: "not_null", column: "id" }] });
  const ctx = makeCtx([a, model("s", "", { kind: "seed", csv: "n\n1\n" })], { sources: [{ source: "a", table: "t", description: "Raw" }], exposures: [{ name: "b", type: "dashboard", ownerName: "o", dependsOn: ["a", "s"] }] });
  const m = buildManifest(ctx);
  assert.deepEqual(Object.keys(m.nodes).sort(), ["model.basalt.a", "seed.basalt.s", "test.basalt.not_null_a_id"]);
  assert.deepEqual(m.parent_map["exposure.basalt.b"], ["model.basalt.a", "seed.basalt.s"]);
  assert.deepEqual(m.child_map["model.basalt.a"].sort(), ["exposure.basalt.b", "test.basalt.not_null_a_id"]);
  assert.deepEqual(m.parent_map["model.basalt.a"], ["source.basalt.a.t"]);
  assert.equal((m.nodes["model.basalt.a"] as { compiled_code: string }).compiled_code, 'SELECT * FROM "raw_a"."t"');
  await buildNode(c as never, effectiveOf(a, ctx), ctx);
  const cat = await buildCatalog(c as never, ctx);
  assert.deepEqual((cat.nodes["model.basalt.a"] as { columns: Record<string, unknown> }).columns.id, { name: "id", type: "INTEGER", index: 1 });
  assert.deepEqual(Object.keys(cat.sources), ["source.basalt.a.t"]);
  done();
});
