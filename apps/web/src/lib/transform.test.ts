import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { compileSteps, type Step } from "./transform.ts";

const { DuckDBInstance } = createRequire(import.meta.url)("@duckdb/node-api");
const run = async (steps: Step[]) => {
  const db = await DuckDBInstance.create(":memory:"), c = await db.connect();
  await c.run(`CREATE TABLE t AS SELECT * FROM (VALUES (1, ' Ann ', 'a,b', DATE '2026-03-15', 10, 20), (2, 'BOB', 'c,d', DATE '2025-07-01', 30, 40)) v(id, name, tags, day, q1, q2)`);
  await c.run(`CREATE TABLE u AS SELECT 3 AS id, 'Cy' AS name`);
  const sql = compileSteps("model:t", steps).replace(/\{\{ ref\('(\w+)'\) \}\}/g, "$1");
  const rows = (await c.runAndReadAll(sql)).getRowObjectsJson();
  c.closeSync(); db.closeSync();
  return rows as Record<string, unknown>[];
};

test("clean text", async () => {
  const r = await run([{ id: "1", type: "clean", column: "name", value: "lower" }]);
  assert.deepEqual(r.map((x) => x.name), [" ann ", "bob"]);
});

test("split a column", async () => {
  const r = await run([{ id: "1", type: "split", column: "tags", value: ",", columns: ["first_tag", "second_tag"] }]);
  assert.equal(r[1].first_tag, "c");
  assert.equal(r[1].second_tag, "d");
});

test("date part", async () => {
  const r = await run([{ id: "1", type: "datepart", column: "day", value: "year", to: "yr" }]);
  assert.equal(Number(r[0].yr), 2026);
});

test("stack tables matches by name and fills the gaps", async () => {
  const r = await run([{ id: "1", type: "union", base: "model:u" }]);
  assert.equal(r.length, 3);
  assert.equal(r.find((x) => x.id === 3)?.tags, null);
});

test("columns to rows", async () => {
  const r = await run([{ id: "1", type: "unpivot", columns: ["q1", "q2"], to: "quarter", value: "amount" }]);
  assert.equal(r.length, 4);
  assert.equal(Number(r.find((x) => x.id === 2 && x.quarter === "q2")?.amount), 40);
});

test("an unknown clean option or date part is refused, not put in the SQL", async () => {
  assert.doesNotMatch(compileSteps("model:t", [{ id: "1", type: "clean", column: "name", value: "drop table" }]), /drop table/);
  assert.doesNotMatch(compileSteps("model:t", [{ id: "1", type: "datepart", column: "day", value: "x'); --", to: "y" }]), /x'\)/);
});

test("a first dashboard skips key columns and places every tile on the 12-column grid", async () => {
  const { autoWidgets } = await import("./autoDashboard.ts");
  let n = 0;
  const w = autoWidgets("a.t", [{ name: "order_id", type: "BIGINT" }, { name: "amount", type: "DOUBLE" }, { name: "placed_at", type: "TIMESTAMP" }, { name: "city", type: "VARCHAR" }, { name: "plan", type: "VARCHAR" }], () => String(++n));
  assert.ok(!JSON.stringify(w).includes("order_id"));
  assert.equal(w.find((x) => x.type === "line")?.dimension, "placed_at");
  assert.deepEqual(w.filter((x) => x.type === "bar").map((x) => x.dimension), ["city", "plan"]);
  assert.ok(w.every((x) => x.x >= 0 && x.x + x.w <= 12));
});

test("dashboard tiles never overlap, however one is moved or resized", async () => {
  const { arrange } = await import("./layout.ts");
  const clash = (l: { x: number; y: number; w: number; h: number }[]) => l.some((a, i) => l.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
  const start = [{ id: "a", x: 0, y: 0, w: 6, h: 4 }, { id: "b", x: 6, y: 0, w: 6, h: 4 }, { id: "c", x: 0, y: 4, w: 12, h: 4 }, { id: "d", x: 0, y: 8, w: 4, h: 3 }];
  const grown = arrange(start.map((t) => (t.id === "a" ? { ...t, w: 12, h: 9 } : t)), "a");
  assert.ok(!clash(grown));
  assert.deepEqual(grown.find((t) => t.id === "a"), { id: "a", x: 0, y: 0, w: 12, h: 9 });
  assert.equal(grown.find((t) => t.id === "b")!.y, 9);
  for (let x = 0; x < 10; x += 3) for (let y = 0; y < 14; y += 2) assert.ok(!clash(arrange(start.map((t) => (t.id === "d" ? { ...t, x, y, w: 3, h: 5 } : t)), "d")));
  assert.ok(!clash(arrange([{ id: "p", x: 0, y: 0, w: 4, h: 4 }, { id: "q", x: 2, y: 2, w: 4, h: 4 }])), "saved overlaps get fixed");
});

test("report helpers: drill, what-if, calculations, matrix, formatting and relationships", async () => {
  const r = await import("./report.ts");
  const w = { id: "w", title: "", type: "bar", x: 0, y: 0, w: 1, h: 1, table: "a.t", dimension: "city", hierarchy: ["kitchen", "meal"], dateGrain: "month", measures: [], filters: [] } as never;
  const down = r.atDrill(w, ["Austin"]) as { dimension: string; dateGrain?: string; filters: { column: string; value: string }[] };
  assert.equal(down.dimension, "kitchen"); assert.equal(down.dateGrain, undefined); assert.deepEqual(down.filters.map((f) => [f.column, f.value]), [["city", "Austin"]]);
  assert.equal((r.atDrill(w, ["a", "b", "c", "d"]) as { dimension: string }).dimension, "meal");
  assert.equal(r.withParams("SUM(x) * {{ growth }} + {{nope}}", { growth: 2 }), "SUM(x) * 2 + {{nope}}");
  assert.equal(r.withParams("{{x}}", { x: NaN }), "{{x}}");
  const rows = [{ m0: 10 }, { m0: 30 }, { m0: 60 }];
  assert.deepEqual(r.applyCalc(rows, "pct_total").map((x) => x.m0), [10, 30, 60]);
  assert.deepEqual(r.applyCalc(rows, "running").map((x) => x.m0), [10, 40, 100]);
  assert.deepEqual(r.applyCalc(rows, "change").map((x) => x.m0), [null, 200, 100]);
  const m = r.matrixOf([{ d: "A", s: "x", m0: 1 }, { d: "A", s: "y", m0: 2 }, { d: "B", s: "x", m0: 4 }]);
  assert.deepEqual([m.cols, m.keys, m.rowTotal("A"), m.colTotal("x"), m.total, m.at("B", "y")], [["x", "y"], ["A", "B"], 3, 5, 7, null]);
  assert.equal(r.cfTone(5, [0, 10], { mode: "scale" }).heat, 0.5);
  assert.equal(r.cfTone(5, [0, 10], { mode: "bars" }).bar, 0.5);
  assert.equal(r.cfTone(5, [5], { mode: "rules", rules: [{ op: "gt", value: 9, tone: "good" }, { op: "lt", value: 9, tone: "bad" }] }).tone, "bad");
  const f = r.throughRelationship({ relationships: [{ id: "1", fromTable: "a.orders", fromCol: "cid", toTable: "a.cust", toCol: "id" }] }, "a.cust", "a.orders", { id: "s", column: "city", op: "in", values: ["Austin"] });
  assert.equal(f?.column, "cid"); assert.match(f!.value!, /SELECT "id" FROM "a"\."cust" WHERE/);
  assert.equal(r.throughRelationship({}, "a", "b", { id: "s", column: "c", op: "eq", value: "1" }), null);
});

test("DAX compiles common measures and refuses what it doesn't support", async () => {
  const { daxToSql, DaxError } = await import("./dax.ts");
  assert.equal(daxToSql("SUM(Orders[amount])"), 'SUM("amount")');
  assert.equal(daxToSql("Total := SUM('Order Lines'[amount]) * 2"), 'SUM("amount") * 2');
  assert.equal(daxToSql("DIVIDE(SUM(O[a]), COUNTROWS(O))"), '(SUM("a")) / NULLIF(COUNT(*), 0)');
  assert.equal(daxToSql("DIVIDE(SUM(O[a]), SUM(O[b]), 0)"), 'COALESCE((SUM("a")) / NULLIF(SUM("b"), 0), 0)');
  assert.equal(daxToSql('CALCULATE(SUM(O[a]), O[status] = "paid")'), `(SUM("a") FILTER (WHERE "status" = 'paid'))`);
  assert.equal(daxToSql("DISTINCTCOUNT(O[c])"), 'COUNT(DISTINCT "c")');
  assert.equal(daxToSql('IF(SUM(O[a]) > 10, "big", "small")'), `CASE WHEN SUM("a") > 10 THEN 'big' ELSE 'small' END`);
  assert.throws(() => daxToSql("SAMEPERIODLASTYEAR(O[d])"), DaxError);
  assert.throws(() => daxToSql("SUM(O[a]"), DaxError);
  assert.throws(() => daxToSql("SUM(O[a]); DROP TABLE x"), DaxError);
  assert.equal(daxToSql(`CALCULATE(SUM(O[a]), O[s] = "x'); DROP")`), `(SUM("a") FILTER (WHERE "s" = 'x''); DROP'))`);
});

test("questions become visuals, and unclear ones say so", async () => {
  const { answer } = await import("./qna.ts");
  const t = [{ full: "analytics.fct_orders", schema: "analytics", name: "fct_orders", columns: [{ name: "order_id", type: "BIGINT" }, { name: "amount", type: "DOUBLE" }, { name: "rating", type: "INTEGER" }, { name: "city", type: "VARCHAR" }, { name: "status", type: "VARCHAR" }, { name: "ordered_at", type: "TIMESTAMP" }] }, { full: "analytics.dim_customers", schema: "analytics", name: "dim_customers", columns: [{ name: "customer_id", type: "BIGINT" }, { name: "segment", type: "VARCHAR" }] }];
  const a = answer("total amount by city", t) as never as { table: string; dimension: string; measures: { column: string; agg: string }[]; type: string };
  assert.deepEqual([a.table, a.dimension, a.measures[0], a.type], ["analytics.fct_orders", "city", { column: "amount", agg: "sum" }, "bar"]);
  const b = answer("average rating by month", t) as never as { dateGrain: string; dimension: string; type: string; measures: { agg: string }[] };
  assert.deepEqual([b.dateGrain, b.dimension, b.type, b.measures[0].agg], ["month", "ordered_at", "line", "avg"]);
  const c = answer("how many orders where status is delivered last 30 days", t) as never as { type: string; filters: { column: string; value: string; op: string }[] };
  assert.equal(c.type, "kpi"); assert.deepEqual(c.filters.map((f) => [f.column, f.value]), [["status", "delivered"], ["ordered_at", "30"]]);
  assert.equal((answer("top 5 cities by amount", t) as { limit?: number }).limit, 5);
  assert.ok("error" in answer("what is the weather", t));
  assert.ok("error" in answer("", t));
  assert.ok("error" in answer("total amount by planet", t));
});

test("scheduling decisions", async () => {
  const { hoursStale, shouldRetry, withDownstream } = await import("./schedule.ts");
  const now = Date.parse("2026-01-01T12:00:00Z"), run = (status: string, minsAgo: number) => ({ kind: "sync", refId: "p", status, startedAt: new Date(now - minsAgo * 60000).toISOString() }) as never;
  assert.equal(shouldRetry([run("failed", 10)], "p", 0, now), false, "no retries set");
  assert.equal(shouldRetry([run("failed", 2)], "p", 3, now), false, "too soon");
  assert.equal(shouldRetry([run("failed", 10), run("succeeded", 100)], "p", 1, now), true);
  assert.equal(shouldRetry([run("failed", 10), run("failed", 20)], "p", 1, now), false, "out of retries");
  assert.equal(shouldRetry([run("succeeded", 10)], "p", 3, now), false);
  assert.equal(shouldRetry([run("partial", 10), run("succeeded", 100)], "p", 1, now), true, "a partly failed sync retries");
  assert.equal(shouldRetry([run("partial", 10), run("failed", 20)], "p", 1, now), false, "and uses up the same retries");
  assert.equal(hoursStale([run("failed", 10), run("succeeded", 120)], "p", now), 2);
  assert.equal(hoursStale([run("failed", 10)], "p", now), null);
  assert.deepEqual([...withDownstream([{ name: "a", refs: [] }, { name: "b", refs: ["a"] }, { name: "c", refs: ["b"] }, { name: "z", refs: [] }], "a")].sort(), ["a", "b", "c"]);
});

test("every sidebar item has its own icon and label", async () => {
  const { ALL_NAV } = await import("../components/nav.ts");
  assert.equal(new Set(ALL_NAV.map((n) => n.icon)).size, ALL_NAV.length);
  assert.equal(new Set(ALL_NAV.map((n) => n.label)).size, ALL_NAV.length);
  assert.ok(ALL_NAV.length <= 13);
  assert.ok(!ALL_NAV.some((n) => n.icon === "book"), "the top bar's Docs link uses this one");
});

/* ---- messy real work, on real DuckDB ---- */
import { DuckDBInstance as MessyDb, type DuckDBConnection as MessyConn } from "@duckdb/node-api";
import { windowSql } from "./windowStep.ts";
let messy: MessyConn;
const MESSY = `CREATE TABLE IF NOT EXISTS o AS SELECT * FROM (VALUES (1,'A',' Oslo ',10.0,DATE '2026-01-01',1001,'red;blue','x'),(2,'A','Oslo',30.0,DATE '2026-01-02',1002,'red','20'),(3,'A',NULL,NULL,DATE '2026-01-03',1003,NULL,'40'),(4,'B','rome',5.0,DATE '2026-01-01',1004,'',NULL),(5,'B','ROME',15.0,DATE '2026-01-02',1005,' a ; ;b ','10')) t(id,grp,city,amount,day,num,tags,txt)`;
const runSteps = async (steps: object[]) => { messy ??= await (await MessyDb.create(":memory:")).connect(); await messy.run(MESSY); const sql = compileSteps("model:o", steps.map((s, i) => ({ id: String(i), ...s })) as never).replace(/\{\{ ref\('(\w+)'\) \}\}/g, "o"); return (await messy.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[]; };
const pick = (r: Record<string, unknown>[], k: string) => r.map((x) => (x[k] == null ? null : Number(x[k])));
const ORDER = [{ column: "id", dir: "asc" }];

test("cleaning text works on any column type", async () => {
  for (const value of ["trim", "upper", "lower", "blank_null", "clean", "proper", "digits"]) assert.equal((await runSteps([{ type: "clean", column: "num", value }])).length, 5, value);
});
test("an if/then column has one type, and codes keep their zeros", async () => {
  const f = { column: "amount", op: "gt", value: "20" };
  assert.deepEqual((await runSteps([{ type: "condition", to: "b", cases: [{ filter: f, then: "1" }], otherwise: "low" }])).map((x) => x.b), ["low", "1", "low", "low", "low"]);
  assert.deepEqual((await runSteps([{ type: "condition", to: "b", cases: [{ filter: f, then: "high" }], otherwise: "0" }])).map((x) => x.b), ["0", "high", "0", "0", "0"]);
  assert.equal(Number((await runSteps([{ type: "condition", to: "b", cases: [{ filter: f, then: "2" }], otherwise: "1.5" }]))[1].b), 2, "all numbers stay numbers");
  assert.equal((await runSteps([{ type: "condition", to: "b", cases: [{ filter: f, then: "001" }], otherwise: "002" }]))[1].b, "001");
});
test("filling empties works whatever the column type, and a value that can't fit says so", async () => {
  assert.equal((await runSteps([{ type: "fill", column: "city", value: "0" }]))[2].city, "0");
  assert.equal(Number((await runSteps([{ type: "fill", column: "amount", value: "0" }]))[2].amount), 0);
  assert.equal(String((await runSteps([{ type: "fill", column: "day", value: "2026-03-01" }]))[0].day), "2026-01-01");
  await assert.rejects(runSteps([{ type: "fill", column: "amount", value: "n/a" }]), /n\/a/);
});
test("removing duplicates keeps the row you chose", async () => {
  const latest = await runSteps([{ type: "dedupe", columns: ["grp"], sorts: [{ column: "day", dir: "desc" }] }, { type: "sort", sorts: [{ column: "grp", dir: "asc" }] }]);
  assert.deepEqual(latest.map((x) => x.id), [3, 5]);
  const first = await runSteps([{ type: "dedupe", columns: ["grp"], sorts: ORDER }, { type: "sort", sorts: [{ column: "grp", dir: "asc" }] }]);
  assert.deepEqual(first.map((x) => x.id), [1, 4]);
});
test("splitting into rows keeps empty rows and tidies items", async () => {
  const r = await runSteps([{ type: "splitrows", column: "tags", value: ";" }, { type: "sort", sorts: ORDER }]);
  assert.deepEqual(r.filter((x) => x.id === 1).map((x) => x.tags).sort(), ["blue", "red"]);
  assert.deepEqual(r.filter((x) => x.id === 5).map((x) => x.tags).sort(), ["a", "b"]);
  assert.deepEqual(r.filter((x) => x.id === 3 || x.id === 4).map((x) => x.tags), [null, null]);
  assert.equal(r.length, 7);
});
test("calculating across rows gives the right numbers", async () => {
  const w = async (mode: string, extra: object = {}) => pick(await runSteps([{ type: "window", to: "w", mode, column: "amount", sorts: ORDER, ...extra }, { type: "sort", sorts: ORDER }]), "w");
  assert.deepEqual(await w("running_sum"), [10, 40, 40, 45, 60]);
  assert.deepEqual(await w("running_sum", { columns: ["grp"] }), [10, 40, 40, 5, 20], "starts again per group");
  assert.deepEqual(await w("lag"), [null, 10, 30, null, 5]);
  assert.deepEqual(await w("lead", { n: "2" }), [null, 5, 15, null, null]);
  assert.deepEqual(await w("change", { columns: ["grp"] }), [null, 20, null, null, 10]);
  assert.deepEqual(await w("pct_change", { columns: ["grp"] }), [null, 200, null, null, 200]);
  assert.deepEqual(await w("moving_avg", { n: "2", columns: ["grp"] }), [10, 20, 30, 5, 10]);
  assert.deepEqual(await w("pct_total", { columns: ["grp"], sorts: [] }), [25, 75, null, 25, 75]);
  assert.deepEqual(pick(await runSteps([{ type: "window", to: "w", mode: "rank", sorts: [{ column: "grp", dir: "asc" }] }, { type: "sort", sorts: ORDER }]), "w"), [1, 1, 1, 4, 4]);
  assert.deepEqual(pick(await runSteps([{ type: "window", to: "w", mode: "dense_rank", sorts: [{ column: "grp", dir: "asc" }] }, { type: "sort", sorts: ORDER }]), "w"), [1, 1, 1, 2, 2]);
  assert.deepEqual(pick(await runSteps([{ type: "window", to: "w", mode: "running_sum", column: "txt", sorts: ORDER }, { type: "sort", sorts: ORDER }]), "w"), [null, 20, 60, 60, 70], "text that isn't a number counts as empty");
});
test("a half-filled calculation is skipped, and odd input can't reach the SQL", () => {
  assert.equal(windowSql({ mode: "nope", column: "a", sorts: ORDER as never }), null);
  assert.equal(windowSql({ mode: "running_sum", sorts: ORDER as never }), null);
  assert.equal(windowSql({ mode: "rank" }), null);
  assert.ok(!windowSql({ mode: "lag", column: "a", sorts: ORDER as never, n: "1; DROP TABLE o" })!.includes("DROP"));
  assert.ok(windowSql({ mode: "lag", column: 'a"b', sorts: ORDER as never })!.includes('"a""b"'));
});
