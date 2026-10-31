import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { after, before } from "node:test";
import { compileSql, refsOf } from "./graph.ts";
import { distributionSql, formulaSql, qualitySql, readQuality, type QueryParam } from "./query.ts";
import { compileSteps, promoteRenames, walkSteps, type Step } from "./transform.ts";

const { DuckDBInstance } = createRequire(import.meta.url)("@duckdb/node-api");
type Row = Record<string, unknown>;
let db: { connect(): Promise<Conn>; closeSync(): void }, c: Conn;
type Conn = { run(s: string): Promise<unknown>; runAndReadAll(s: string): Promise<{ getRowObjectsJson(): Row[]; columnNames(): string[]; columnTypes(): { toString(): string }[] }>; closeSync(): void };

before(async () => {
  db = await DuckDBInstance.create(":memory:"); c = await db.connect();
  await c.run(`CREATE SCHEMA analytics`);
  await c.run(`CREATE TABLE analytics.people AS SELECT * FROM (VALUES
    (1, 'Ann Lee', 'a,b', '03/15/2026', '$1,200.50', 'east', 10, '{"city":"Austin","tags":[1,2]}'),
    (2, 'BOB RAY', 'c,d', 'not a date', 'n/a', 'east', 20, '{"city":"Boise","tags":[]}'),
    (3, ' cy ', NULL, '', NULL, 'west', 30, NULL),
    (4, 'Dee', 'e', '12/01/2025', '7', NULL, 40, '{"city":"Reno"}')
  ) v(id, name, tags, day, price, region, score, doc)`);
  await c.run(`CREATE TABLE analytics.regions AS SELECT * FROM (VALUES ('east', 'E'), ('north', 'N')) v(code, label)`);
  await c.run(`CREATE TABLE analytics.more AS SELECT 5 AS id, 'Eve' AS name`);
  await c.run(`CREATE TABLE analytics.sales AS SELECT * FROM (VALUES ('east','q1',1),('east','q2',2),('west','q1',3),('west','q1',4)) v(region, qtr, amt)`);
  await c.run(`CREATE TABLE analytics.gaps AS SELECT * FROM (VALUES (1,'x'),(2,NULL),(3,NULL),(4,'y'),(5,NULL)) v(id, v)`);
  await c.run(`CREATE TABLE analytics.raw AS SELECT * FROM (VALUES ('Name','Age'),('Ann','30')) v(column0, column1)`);
  await c.run(`CREATE TABLE analytics.nest AS SELECT 1 AS id, {'p': 5, 'q': 'x'} AS st, [7, 8] AS li`);
});
after(() => { c.closeSync(); db.closeSync(); });

const body = (steps: Step[], from = "people", params?: QueryParam[], track = false) => compileSql(compileSteps(`model:${from}`, steps, { params, track }));
const run = async (steps: Step[], from = "people", params?: QueryParam[]) => (await c.runAndReadAll(body(steps, from, params))).getRowObjectsJson();
const s = (type: Step["type"], p: Partial<Step> = {}): Step => ({ id: type, type, ...p });
const pick = (rows: Row[], k: string) => rows.map((r) => r[k]);
const N = (rows: Row[], k: string) => rows.map((r) => (r[k] == null ? null : Number(r[k])));
const byId = { id: "o", type: "sort", sorts: [{ column: "id", dir: "asc" }] } as Step;

test("choose and remove columns", async () => {
  assert.deepEqual(Object.keys((await run([s("keep", { columns: ["name", "id"] })]))[0]), ["name", "id"]);
  assert.ok(!("doc" in (await run([s("remove", { columns: ["doc"] })]))[0]));
});

test("filter rows with several conditions, all or any", async () => {
  const f = (id: string, column: string, op: "eq" | "gt", value: string) => ({ id, column, op, value });
  assert.deepEqual(N(await run([s("filter", { filters: [f("a", "region", "eq", "east"), f("b", "score", "gt", "10")] }), byId]), "id"), [2]);
  assert.deepEqual(N(await run([s("filter", { match: "any", filters: [f("a", "region", "eq", "west"), f("b", "score", "gt", "35")] }), byId]), "id"), [3, 4]);
});

test("keep top, bottom and a range", async () => {
  assert.deepEqual(N(await run([byId, s("rows", { mode: "top", n: "2" })]), "id"), [1, 2]);
  assert.deepEqual(N(await run([byId, s("rows", { mode: "bottom", n: "1" })]), "id"), [4]);
  assert.deepEqual(N(await run([byId, s("rows", { mode: "range", n: "2", m: "2" })]), "id"), [2, 3]);
});

test("remove duplicates", async () => {
  assert.equal((await run([s("dedupe", { columns: ["region", "qtr"] })], "sales")).length, 3);
});

test("change type reads US dates and numbers, and failures count as errors", async () => {
  const steps = [s("convert", { column: "day", dataType: "DATE", format: "%m/%d/%Y" }), s("convert", { column: "price", dataType: "DOUBLE", format: "us_number" }), byId];
  const rows = await run(steps);
  assert.deepEqual(pick(rows, "day"), ["2026-03-15", null, null, "2025-12-01"]);
  assert.deepEqual(rows.map((r) => r.price), [1200.5, null, null, 7]);
  assert.ok(!Object.keys(rows[0]).some((k) => k.startsWith("__error__")), "the tracking column stays out of the model");

  const tracked = body(steps, "people", undefined, true);
  const reader = await c.runAndReadAll(`SELECT * FROM (${tracked}) LIMIT 0`);
  const cols = reader.columnNames().map((name, i) => ({ name, type: reader.columnTypes()[i].toString() }));
  const q = readQuality((await c.runAndReadAll(qualitySql(tracked, cols))).getRowObjectsJson()[0], cols);
  const day = q.find((x) => x.name === "day")!, price = q.find((x) => x.name === "price")!, region = q.find((x) => x.name === "region")!;
  assert.deepEqual([day.valid, day.error, day.empty, day.distinct], [2, 1, 1, 2]);
  assert.deepEqual([price.valid, price.error, price.empty], [2, 1, 1]);
  assert.deepEqual([region.valid, region.error, region.empty, region.distinct, region.total], [3, 0, 1, 2, 4]);
  assert.ok(!q.some((x) => x.name.startsWith("__error__")));
});

test("remove errors drops failed conversions and keeps empty values", async () => {
  const rows = await run([s("convert", { column: "day", dataType: "DATE", format: "%m/%d/%Y" }), s("removeerrors"), byId]);
  assert.deepEqual(N(rows, "id"), [1, 3, 4]);
  assert.ok(!Object.keys(rows[0]).some((k) => k.startsWith("__error__")));
  const renamed = await run([s("convert", { column: "day", dataType: "DATE", format: "%m/%d/%Y" }), s("rename", { column: "day", to: "d" }), s("keep", { columns: ["id", "d"] }), s("removeerrors", { columns: ["d"] }), byId]);
  assert.deepEqual(Object.keys(renamed[0]), ["id", "d"]);
  assert.deepEqual(N(renamed, "id"), [1, 3, 4]);
  assert.ok(walkSteps("model:people", [s("removeerrors")]).skipped.includes("removeerrors"), "nothing to remove yet");
});

test("column distribution", async () => {
  const rows = (await c.runAndReadAll(distributionSql(body([]), "region"))).getRowObjectsJson();
  assert.deepEqual(rows.map((r) => [r.value, Number(r.n)]), [["east", 2], ["west", 1], [null, 1]]);
});

test("replace values, exact and within text", async () => {
  const exact = await run([s("replace", { column: "region", from: "east", value: "E" }), byId]);
  assert.deepEqual(pick(exact, "region"), ["E", "E", "west", null]);
  const within = await run([s("replace", { column: "tags", mode: "contains", from: ",", value: "|" }), byId]);
  assert.deepEqual(pick(within, "tags"), ["a|b", "c|d", null, "e"]);
});

test("fill down and fill up", async () => {
  assert.deepEqual(pick(await run([s("fillnear", { column: "v" })], "gaps"), "v"), ["x", "x", "x", "y", "y"]);
  assert.deepEqual(pick(await run([s("fillnear", { column: "v", mode: "up" })], "gaps"), "v"), ["x", "y", "y", "y", null]);
});

test("split by delimiter and by position", async () => {
  const d = await run([s("split", { column: "tags", value: ",", columns: ["a", "b"] }), byId]);
  assert.deepEqual([d[0].a, d[0].b, d[3].a, d[3].b], ["a", "b", "e", null]);
  const p = await run([s("split", { column: "name", by: "position", value: "3,5", columns: ["x", "y", "z"] }), byId]);
  assert.deepEqual([p[0].x, p[0].y, p[0].z], ["Ann", " L", "ee"]);
  assert.ok(walkSteps("model:people", [s("split", { column: "name", by: "position", value: "5,3", columns: ["x"] })]).skipped.length, "positions must rise");
});

test("merge columns skips empty values", async () => {
  assert.deepEqual(pick(await run([s("mergecols", { columns: ["region", "tags"], value: "-", to: "m" }), byId]), "m"), ["east-a,b", "east-c,d", "west", "e"]);
});

test("extract text", async () => {
  const one = async (p: Partial<Step>) => (await run([s("extracttext", { column: "name", to: "x", ...p }), byId]))[0].x;
  assert.equal(Number(await one({ mode: "length" })), 7);
  assert.equal(await one({ mode: "first", n: "3" }), "Ann");
  assert.equal(await one({ mode: "last", n: "3" }), "Lee");
  assert.equal(await one({ mode: "range", n: "5", m: "2" }), "Le");
  assert.equal(await one({ mode: "before", value: " " }), "Ann");
  assert.equal(await one({ mode: "after", value: " " }), "Lee");
  assert.equal(await one({ mode: "between", value: "A", from: " " }), "nn");
  assert.equal(await one({ mode: "before", value: "#" }), null);
});

test("trim, clean and case", async () => {
  const v = async (value: string) => (await run([s("clean", { column: "name", value }), byId])).map((r) => r.name);
  assert.equal((await v("trim"))[2], "cy");
  assert.equal((await v("lower"))[1], "bob ray");
  assert.equal((await v("upper"))[3], "DEE");
  assert.equal((await v("proper"))[1], "Bob Ray");
  const tab = await run([s("custom", { to: "t", expr: `CONCATENATE("a", "\t", "b")` }), s("clean", { column: "t", value: "clean" }), byId]);
  assert.equal(tab[0].t, "ab", "the tab is gone");
  assert.equal((await v("clean"))[0], "Ann Lee");
});

test("custom columns compile from a safe formula", async () => {
  const rows = await run([s("custom", { to: "x", expr: `IF({score} > 15, UPPER(LEFT({region}, 1)) & "!", TEXT({score} * 2 + 1))` }), byId]);
  assert.deepEqual(pick(rows, "x"), ["21", "E!", "W!", "!"]);
  assert.equal((await run([s("custom", { to: "x", expr: "{score} / 0" }), byId]))[0].x, null);
  const params = [{ name: "rate", value: "2" }];
  assert.deepEqual(N(await run([s("custom", { to: "x", expr: `{score} * PARAM("rate")` }), byId], "people", params), "x"), [20, 40, 60, 80]);
  assert.equal(formulaSql(`DATETIME_DIFF("2026-01-03", "2026-01-01", "day")`), `date_diff('day', TRY_CAST('2026-01-01' AS TIMESTAMP), TRY_CAST('2026-01-03' AS TIMESTAMP))`);
});

test("conditional column", async () => {
  const rows = await run([s("condition", { to: "size", cases: [{ filter: { id: "a", column: "score", op: "gt", value: "25" }, then: "big" }], otherwise: "small" }), byId]);
  assert.deepEqual(pick(rows, "size"), ["small", "small", "big", "big"]);
});

test("group by with several aggregates", async () => {
  const rows = await run([s("group", { columns: ["region"], aggs: [{ column: "amt", agg: "sum", as: "t" }, { column: "*", agg: "count", as: "n" }, { column: "qtr", agg: "count_distinct", as: "u" }, { column: "amt", agg: "max", as: "hi" }] }), s("sort", { sorts: [{ column: "region", dir: "asc" }] })], "sales");
  assert.deepEqual(rows.map((r) => [r.region, Number(r.t), Number(r.n), Number(r.u), Number(r.hi)]), [["east", 3, 2, 2, 2], ["west", 7, 2, 1, 4]]);
});

test("pivot and unpivot", async () => {
  const p = await run([s("pivot", { column: "qtr", from: "amt", agg: "sum", values: ["q1", "q2"] }), s("sort", { sorts: [{ column: "region", dir: "asc" }] })], "sales");
  assert.deepEqual(p.map((r) => [r.region, Number(r.q1), r.q2 == null ? null : Number(r.q2)]), [["east", 1, 2], ["west", 7, null]]);
  const u = await run([s("keep", { columns: ["id", "score"] }), s("unpivot", { columns: ["score"], to: "k", value: "v" }), byId]);
  assert.deepEqual(u.map((r) => [r.k, Number(r.v)]), [["score", 10], ["score", 20], ["score", 30], ["score", 40]]);
});

test("transpose", async () => {
  const rows = await run([s("transpose", { columns: ["column0", "column1"], n: "2" })], "raw");
  assert.deepEqual(rows, [{ Column: "column0", Column1: "Name", Column2: "Ann" }, { Column: "column1", Column1: "Age", Column2: "30" }]);
  assert.ok(walkSteps("model:raw", [s("transpose", { columns: ["a"], n: "201" })]).skipped.length, "over the limit");
});

test("merge queries, every kind", async () => {
  const kinds: [NonNullable<Step["how"]>, number[], string[]][] = [
    ["inner", [1, 2], ["E", "E"]], ["left", [1, 2, 3, 4], ["E", "E"]], ["anti", [3, 4], []],
  ];
  for (const [how, ids] of kinds) {
    const rows = await run([s("merge", { how, base: "model:regions", columns: ["region"], rightKeys: ["code"], prefix: "r_" }), byId]);
    assert.deepEqual(N(rows, "id"), ids, how);
  }
  const m = { base: "model:regions", columns: ["region"], rightKeys: ["code"], prefix: "r_" };
  const right = await run([s("merge", { how: "right", ...m })]);
  assert.deepEqual(right.map((r) => r.r_label).sort(), ["E", "E", "N"]);
  const full = await run([s("merge", { how: "full", ...m })]);
  assert.equal(full.length, 5);
  assert.deepEqual(await run([s("merge", { how: "right_anti", ...m })]), [{ code: "north", label: "N" }]);
  assert.equal((await run([s("merge", { how: "left", ...m }), byId]))[0].r_code, "east");
});

test("append queries matches by name", async () => {
  const rows = await run([s("keep", { columns: ["id", "name"] }), s("union", { base: "model:more" }), byId]);
  assert.deepEqual(N(rows, "id"), [1, 2, 3, 4, 5]);
});

test("promote headers", async () => {
  const renames = promoteRenames(["column0", "column1"], { column0: "Name", column1: "Age" });
  assert.deepEqual(await run([s("promote", { renames })], "raw"), [{ Name: "Ann", Age: "30" }]);
  assert.deepEqual(promoteRenames(["a", "b", "c"], { a: "X", b: "x", c: null }), [{ from: "a", to: "X" }, { from: "b", to: "x_2" }]);
});

test("expand JSON records and lists with the semi-structured steps", async () => {
  const rec = await run([s("extract", { column: "doc", value: "city", to: "city" }), byId]);
  assert.deepEqual(pick(rec, "city"), ["Austin", "Boise", null, "Reno"]);
  const list = await run([s("keep", { columns: ["id", "doc"] }), s("extract", { column: "doc", value: "tags", to: "tags", dataType: "JSON" }), s("unnest", { column: "tags", dataType: "BIGINT" }), s("sort", { sorts: [{ column: "id", dir: "asc" }, { column: "tags", dir: "asc" }] })]);
  assert.deepEqual(list.map((r) => [Number(r.id), r.tags == null ? null : Number(r.tags)]), [[1, 1], [1, 2], [2, null], [3, null], [4, null]]);
});

test("disabled steps are skipped; half-filled steps are reported", () => {
  const w = walkSteps("model:people", [s("keep", { columns: ["id"], disabled: true }), s("rename")]);
  assert.ok(!w.sql.includes("step_"));
  assert.deepEqual(w.skipped, ["rename"]);
});

test("parameters fill values and stay literals", async () => {
  const params = [{ name: "min", value: "25" }, { name: "evil", value: "x' OR 1=1 --" }];
  const f = (value: string) => s("filter", { filters: [{ id: "a", column: value === "@min" ? "score" : "region", op: value === "@min" ? "gt" : "eq", value }] });
  assert.deepEqual(N(await run([f("@min"), byId], "people", params), "id"), [3, 4]);
  assert.deepEqual(await run([f("@evil")], "people", params), []);
  assert.deepEqual(N(await run([byId, s("rows", { n: "@min" })], "people", [{ name: "min", value: "1" }]), "id"), [1]);
  assert.ok(walkSteps("model:people", [s("rows", { n: "@min" })], { params: [{ name: "min", value: "1; DROP TABLE x" }] }).skipped.length);
});

// Every field a person can type, carrying the same payload, must be data: the marker table survives, and the row count proves nothing was bypassed.
test("injection: hostile identifiers and values stay inert", async () => {
  await c.run(`CREATE TABLE analytics.hostile AS SELECT 1 AS a, 'x' AS "evil""; DROP TABLE analytics.people; --", 'y' AS b`);
  const X = `'; DROP TABLE analytics.people; --`, I = `evil"; DROP TABLE analytics.people; --`;
  const cases: Step[] = [
    s("keep", { columns: [I] }), s("remove", { columns: [I] }), s("rename", { column: I, to: `z"; DROP TABLE analytics.people; --` }),
    s("filter", { filters: [{ id: "f", column: I, op: "eq", value: X }] }), s("filter", { filters: [{ id: "f", column: "b", op: "gt", value: `1 OR 1=1` }] }),
    s("replace", { column: I, from: X, value: X }), s("replace", { column: I, mode: "contains", from: X, value: X }),
    s("fillnear", { column: I }), s("fill", { column: I, value: X }),
    s("split", { column: I, value: X, columns: [`n"; DROP TABLE analytics.people; --`] }),
    s("mergecols", { columns: [I, "b"], value: X, to: `m"--` }), s("extracttext", { column: I, to: `e"--`, mode: "before", value: X }),
    s("custom", { to: `c"--`, expr: `"${X}" & {${I}}` }),
    s("condition", { to: `k"--`, cases: [{ filter: { id: "f", column: I, op: "eq", value: X }, then: X }], otherwise: X }),
    s("group", { columns: [I], aggs: [{ column: I, agg: "max", as: `g"--` }] }),
    s("pivot", { column: I, from: "a", agg: "sum", values: [X, `w"--`] }),
    s("unpivot", { columns: ["b"], to: `t"--`, value: `v"--` }),
    s("transpose", { columns: [I, "b"], n: "1" }),
    s("merge", { base: "model:hostile", how: "left", columns: [I], rightKeys: [I], prefix: "p_" }),
    s("promote", { renames: [{ from: I, to: `h"; DROP TABLE analytics.people; --` }] }),
    s("extract", { column: I, to: `j"--`, value: "a" }), s("unnest", { column: I }),
    s("convert", { column: I, dataType: "DATE", format: "%m/%d/%Y" }), s("clean", { column: I, value: "proper" }),
    s("sort", { sorts: [{ column: I, dir: "desc" }] }), s("dedupe", { columns: [I] }),
  ];
  for (const step of cases) await c.runAndReadAll(body([step], "hostile"));
  assert.equal((await run([])).length, 4, "people still there");
});

test("injection: stored JSON can't widen a whitelist", () => {
  const smuggled = "x) ; DROP TABLE t; --";
  const none = (steps: Step[]) => assert.doesNotMatch(compileSteps("model:t", steps), /DROP/);
  none([s("convert", { column: "a", dataType: smuggled })]);
  none([s("convert", { column: "a", dataType: "DATE", format: smuggled })]);
  none([s("clean", { column: "a", value: smuggled })]);
  none([s("clean", { column: "a", value: "constructor" })]);
  none([s("datepart", { column: "a", to: "b", value: smuggled })]);
  none([s("group", { aggs: [{ column: "a", agg: smuggled as never, as: "b" }] })]);
  none([s("pivot", { column: "a", from: "b", agg: smuggled as never, values: ["c"] })]);
  none([s("rows", { n: smuggled })]);
  none([s("rows", { mode: "range", n: "1", m: smuggled })]);
  none([s("extracttext", { column: "a", to: "b", mode: "first", n: smuggled })]);
  none([s("split", { column: "a", by: "position", value: smuggled, columns: ["b"] })]);
  none([s("transpose", { columns: ["a"], n: smuggled })]);
  none([s("merge", { base: "model:b", columns: ["a"], rightKeys: ["a"], prefix: `x' ; DROP TABLE t; --` })]);
  none([s("filter", { filters: [{ id: "f", column: "a", op: "in_query", value: "SELECT 1; DROP TABLE t" }] })]);
  none([s("condition", { to: "b", cases: [{ filter: { id: "f", column: "a", op: "in_query", value: "1) OR (DROP" }, then: "c" }] })]);
  none([s("extract", { column: "a", to: "b", value: `x'"]; DROP` })]);
  assert.throws(() => compileSteps("model:x'; DROP TABLE t", []), /Choose a table/);
  assert.throws(() => compileSteps("model:ok", [s("merge", { base: "model:y' ; DROP", columns: ["a"], rightKeys: ["a"] })]), /Choose a table/);
});

test("injection: a custom column can only call listed functions", async () => {
  for (const bad of [`read_csv("/etc/passwd")`, `getenv("HOME")`, `query("SELECT 1")`, `{a}; DROP TABLE t`, `1) OR (1=1`, `constructor(1)`, `__proto__(1)`, `PARAM("nope")`, `DATETIME_DIFF({a}, {b}, "x') --")`, `IF(1)`]) assert.throws(() => formulaSql(bad), Error, bad);
  assert.equal(formulaSql(`{a"; DROP}`), `"a""; DROP"`);
  assert.equal(formulaSql(`"it's"`), `'it''s'`);
  assert.equal(formulaSql(`1 -- x`), `(1 - (-"x"))`, "no comments: two minus signs and a column");
  assert.deepEqual(walkSteps("model:t", [s("custom", { to: "x", expr: `read_csv("x")` })]).skipped, ["custom"]);
  assert.equal(formulaSql(`PARAM("p")`, [{ name: "p", value: "1; DROP" }]), `'1; DROP'`);
});

test("injection: typed text can't smuggle a template into the compiled SQL or lineage", () => {
  const t = `{{ ref("secret") }}`, t2 = `{{ source('x', 'y') }}`;
  for (const step of [s("filter", { filters: [{ id: "f", column: "a", op: "eq", value: t }] }), s("rename", { column: t2, to: "b" }), s("custom", { to: "x", expr: `"${t}"` }), s("replace", { column: "a", from: t, value: "b" }), s("keep", { columns: [t2] })]) {
    const sql = compileSteps("model:t", [step]);
    assert.deepEqual(refsOf(sql), ["t"], JSON.stringify(step));
    assert.doesNotMatch(compileSql(sql), /secret|raw_x/);
  }
  assert.deepEqual(walkSteps("model:t", [s("filter", { filters: [{ id: "f", column: "a", op: "eq", value: "@p" }] })], { params: [{ name: "p", value: t }] }).skipped, ["filter"], "through a parameter too");
});

test("a number that isn't plain digits stays a literal", async () => {
  const sql = compileSteps("model:t", [s("filter", { filters: [{ id: "f", column: "a", op: "gt", value: "Infinity" }, { id: "g", column: "a", op: "lt", value: "1e5" }] })]);
  assert.match(sql, /"a" > 'Infinity'/);
  assert.match(sql, /"a" < '1e5'/);
});
