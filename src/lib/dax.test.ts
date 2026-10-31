import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { daxToSql, DaxError, type DaxContext } from "./dax.ts";

const { DuckDBInstance } = createRequire(import.meta.url)("@duckdb/node-api");
const db = await DuckDBInstance.create(":memory:"), c = await db.connect();
// Two years of known monthly sales: 100 a month in 2025, 200 a month in 2026 to June. Split evenly by two kinds.
await c.run(`CREATE SCHEMA a;
  CREATE TABLE a.s AS SELECT d::DATE AS d, k, CASE WHEN year(d) = 2025 THEN 50 ELSE 100 END AS amount, 2 AS qty, 1 AS cid FROM generate_series(DATE '2025-01-01', DATE '2026-06-01', INTERVAL 1 MONTH) g(d), (VALUES ('x'), ('y')) v(k);
  CREATE TABLE a.cust AS SELECT 1 AS id, 'NY' AS city;
  -- By k: a 30, b 40, c 10, d 40, blank 1. By m: January 56, February 65. By ship year: 2026 61, 2027 60.
  CREATE TABLE a.t AS SELECT k, amt, m::DATE AS m, ship::DATE AS ship FROM (VALUES ('a', 10, '2026-01-01', '2026-01-01'), ('a', 20, '2026-02-01', '2027-01-01'), ('b', 40, '2026-01-01', '2026-01-01'), ('c', 5, '2026-01-01', '2026-01-01'), ('c', 5, '2026-02-01', '2026-02-01'), ('d', 40, '2026-02-01', '2027-02-01'), (NULL, 1, '2026-01-01', '2026-01-01')) v(k, amt, m, ship);
  CREATE TABLE a.d AS SELECT day::DATE AS day, year(day::DATE) AS yr FROM (VALUES ('2026-01-01'), ('2026-02-01'), ('2027-01-01'), ('2027-02-01')) v(day);`);
const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Record<string, string | number | null>[];
const month = "DATE_TRUNC('month', \"d\")::DATE";
const byMonth: DaxContext = { from: `"a"."s"`, fullTable: "a.s", dim: { column: "d", expr: month } };
const monthly = async (dax: string, ctx = byMonth) => rows(`SELECT ${month} AS m, ${daxToSql(dax, ctx)} AS v FROM "a"."s" GROUP BY 1 ORDER BY 1`);
const at = (r: Record<string, unknown>[], m: string) => Number(r.find((x) => String(x.m).startsWith(m))?.v);
const one = async (dax: string, ctx: DaxContext = { from: `"a"."s"`, fullTable: "a.s" }) => Number((await rows(`SELECT ${daxToSql(dax, ctx)} AS v FROM "a"."s"`))[0].v);

test("plain measures and CALCULATE filters", async () => {
  assert.equal(await one("SUM(S[amount])"), 2 * (12 * 50 + 6 * 100));
  assert.equal(await one("COUNTROWS(S)"), 36);
  assert.equal(await one("DISTINCTCOUNT(S[k])"), 2);
  assert.equal(await one('CALCULATE(SUM(S[amount]), S[k] = "x")'), 12 * 50 + 6 * 100);
  assert.equal(await one('CALCULATE(COUNTROWS(S), S[k] IN {"x", "y"}, S[amount] > 50)'), 12);
  assert.equal(await one("Total := DIVIDE(SUM(S[amount]), COUNTROWS(S))"), (2 * (600 + 600)) / 36);
  assert.equal(await one("DIVIDE(1, 0, 7)"), 7);
});

test("iterators, FILTER and VAR", async () => {
  assert.equal(await one("SUMX(S, S[amount] * S[qty])"), 2 * 2 * 1200);
  assert.equal(await one('SUMX(FILTER(S, S[k] = "x"), S[amount] * S[qty])'), 2 * 1200);
  assert.equal(await one("MAXX(S, S[amount] + 1)"), 101);
  assert.equal(await one("COUNTROWS(FILTER(S, S[amount] > 50))"), 12);
  assert.equal(await one('CALCULATE(SUM(S[amount]), FILTER(S, S[k] = "y"))'), 1200);
  assert.equal(await one("VAR a = SUM(S[amount]) VAR b = COUNTROWS(S) RETURN a / b"), 2400 / 36);
  assert.equal((await rows(`SELECT ${daxToSql('CONCATENATEX(VALUES(S[k]), S[k], ",")')} AS v FROM (SELECT 'x' k UNION ALL SELECT 'y')`))[0].v?.toString().length, 3);
});

test("time intelligence over a date grouping", async () => {
  const py = await monthly("CALCULATE(SUM(S[amount]), SAMEPERIODLASTYEAR(S[d]))");
  assert.equal(at(py, "2026-03"), 100);
  assert.ok(Number.isNaN(at(py, "2025-03")) || at(py, "2025-03") === 0);
  const prev = await monthly("CALCULATE(SUM(S[amount]), DATEADD(S[d], -1, MONTH))");
  assert.equal(at(prev, "2026-01"), 100);
  assert.equal(at(prev, "2026-02"), 200);
  assert.equal(at(await monthly("CALCULATE(SUM(S[amount]), PREVIOUSMONTH(S[d]))"), "2026-02"), 200);
  assert.equal(at(await monthly("CALCULATE(SUM(S[amount]), NEXTMONTH(S[d]))"), "2025-12"), 200);
  const ytd = await monthly("TOTALYTD(SUM(S[amount]), S[d])");
  assert.equal(at(ytd, "2025-12"), 1200);
  assert.equal(at(ytd, "2026-03"), 600);
  assert.equal(at(await monthly("CALCULATE(SUM(S[amount]), DATESYTD(S[d]))"), "2026-02"), 400);
  assert.equal(at(await monthly("TOTALQTD(SUM(S[amount]), S[d])"), "2026-05"), 400);
  const yoy = await monthly("DIVIDE(SUM(S[amount]) - CALCULATE(SUM(S[amount]), SAMEPERIODLASTYEAR(S[d])), CALCULATE(SUM(S[amount]), SAMEPERIODLASTYEAR(S[d])))");
  assert.equal(at(yoy, "2026-01"), 1);
  assert.equal(at(await monthly('TOTALYTD(SUM(S[amount]), S[d], S[k] = "x")'), "2026-02"), 200);
  assert.equal(at(await monthly("CALCULATE(AVERAGE(S[amount]), SAMEPERIODLASTYEAR(S[d]))"), "2026-02"), 50);
});

test("time intelligence splits by the visual's other grouping", async () => {
  const r = await rows(`SELECT ${month} AS m, "k", ${daxToSql("CALCULATE(SUM(S[amount]), SAMEPERIODLASTYEAR(S[d]))", { ...byMonth, groups: ['"k"'] })} AS v FROM "a"."s" GROUP BY 1, 2 ORDER BY 1, 2`);
  assert.equal(Number(r.find((x) => String(x.m).startsWith("2026-02") && x.k === "x")?.v), 50);
});

test("a single number with time intelligence uses the selected dates", async () => {
  const ctx: DaxContext = { from: `"a"."s"`, fullTable: "a.s", where: `WHERE "d" >= DATE '2026-01-01'` };
  const v = Number((await rows(`SELECT ${daxToSql("CALCULATE(SUM(S[amount]), SAMEPERIODLASTYEAR(S[d]))", ctx)} AS v FROM "a"."s" ${ctx.where}`))[0].v);
  assert.equal(v, 6 * 100);
  assert.equal(Number((await rows(`SELECT ${daxToSql("TOTALYTD(SUM(S[amount]), S[d])", { from: `"a"."s"`, fullTable: "a.s" })} AS v FROM "a"."s"`))[0].v), 1200);
});

test("ALL, ALLSELECTED, ALLEXCEPT, RANKX, RELATED and named measures", async () => {
  const q = (dax: string, ctx: DaxContext) => rows(`SELECT "k", ${daxToSql(dax, ctx)} AS v FROM "a"."s" GROUP BY 1 ORDER BY 1`);
  const ctx: DaxContext = { from: `"a"."s"`, fullTable: "a.s", groups: ['"k"'] };
  assert.equal(Number((await q("DIVIDE(SUM(S[amount]), CALCULATE(SUM(S[amount]), ALL(S)))", ctx))[0].v), 0.5);
  assert.equal(Number((await q("CALCULATE(SUM(S[amount]), ALLSELECTED(S))", ctx))[0].v), 2400);
  assert.equal(Number((await q("CALCULATE(SUM(S[amount]), ALL(S[k]))", ctx))[1].v), 2400);
  assert.equal(Number((await q("CALCULATE(SUM(S[amount]), ALLEXCEPT(S, S[k]))", ctx))[0].v), 1200);
  assert.deepEqual((await q("RANKX(ALL(S[k]), SUM(S[amount]))", ctx)).map((r) => Number(r.v)), [1, 1]);
  const related = await rows(`SELECT ${daxToSql("MAXX(S, RELATED(Cust[city]))", { ...ctx, relationships: [{ fromTable: "a.s", fromCol: "cid", toTable: "a.cust", toCol: "id" }] })} AS v FROM "a"."s"`);
  assert.equal(related[0].v, "NY");
  assert.equal(Number((await q("[Sales] * 2", { ...ctx, measures: { Sales: "SUM(S[amount])" } }))[0].v), 2400);
  assert.throws(() => daxToSql("[A]", { from: "x", measures: { A: "[A]" } }), DaxError);
});

test("named measures keep the context they're called in", async () => {
  const ctx = { ...byMonth, measures: { Sales: "SUM(S[amount])", Double: "[Sales] * 2" } };
  assert.equal(at(await monthly("[Sales]", ctx), "2026-03"), 200);
  assert.equal(at(await monthly("CALCULATE([Sales], SAMEPERIODLASTYEAR(S[d]))", ctx), "2026-03"), 100);
  assert.equal(at(await monthly("CALCULATE([Double], SAMEPERIODLASTYEAR(S[d]))", ctx), "2026-03"), 200);
  assert.equal(at(await monthly("TOTALYTD([Sales], S[d])", ctx), "2026-03"), 600);
  assert.equal(at(await monthly('CALCULATE([Sales], S[k] = "x")', ctx), "2026-03"), 100);
});

test("scalar functions run", async () => {
  assert.equal(await one("ROUND(SQRT(16) + POWER(2, 3) + ABS(-1), 0)"), 13);
  assert.equal((await rows(`SELECT ${daxToSql('UPPER(LEFT("hello", 2)) & "-" & FORMAT(1234.5, "#,##0.00")')} AS v`))[0].v, "HE-1,234.50");
  assert.equal(await one('DATEDIFF(DATE(2026, 1, 1), DATE(2026, 3, 1), MONTH)'), 2);
  assert.equal(await one('IF(CONTAINSSTRING("Austin", "aus"), 1, 0)'), 1);
  assert.equal(await one('SWITCH(TRUE(), 1 > 2, 5, 2 > 1, 6, 7)'), 6);
  assert.equal(await one("HASONEVALUE(S[k]) + 0"), 0);
});

const T: DaxContext = { from: `"a"."t"`, fullTable: "a.t", measures: { S: "SUM(T[amt])" } };
const num = (v: unknown) => (typeof v === "string" && /^-?[\d.]+$/.test(v) ? Number(v) : v); // DuckDB's big integers arrive as text
const tOne = async (dax: string, ctx = T) => num((await rows(`SELECT ${daxToSql(dax, ctx)} AS v FROM "a"."t" ${ctx.where ?? ""}`))[0].v);
const tBy = async (col: string, dax: string, extra: Partial<DaxContext> = {}) => Object.fromEntries((await rows(`SELECT ${col} AS g, ${daxToSql(dax, { ...T, ...extra })} AS v FROM "a"."t" GROUP BY 1`)).map((r) => [String(r.g).slice(0, 7), Number(r.v)]));

test("TOPN keeps ties, reads the visual's filters, and ranks within each group", async () => {
  const top = (n: number, dir = "") => `CALCULATE(SUM(T[amt]), TOPN(${n}, VALUES(T[k]), [S]${dir}))`;
  assert.equal(await tOne(top(1)), 80);
  assert.equal(await tOne(top(2)), 80);
  assert.equal(await tOne(top(3)), 110);
  assert.equal(await tOne(top(1, ", ASC")), 1); // the blank group, which plain IN would lose
  assert.equal(await tOne(top(2, ", 1")), 11);
  assert.equal(await tOne("SUMX(TOPN(2, T, T[amt]), T[amt])"), 80);
  assert.equal(await tOne("COUNTROWS(TOPN(3, T, T[amt]))"), 3);
  assert.equal(await tOne("SUMX(TOPN(1, FILTER(T, T[k] = \"d\"), T[amt]), T[amt])"), 40); // b has the same amount and isn't in the table
  assert.equal(await tOne(top(1), { ...T, where: `WHERE "k" <> 'b'` }), 40);
  assert.equal(await tOne(`CALCULATE(CALCULATE(SUM(T[amt]), TOPN(1, VALUES(T[k]), [S])), T[k] <> "b")`), 40);
  for (const a of [`T[k] <> "d", TOPN(1, VALUES(T[k]), [S])`, `TOPN(1, VALUES(T[k]), [S]), T[k] <> "d"`]) assert.equal(await tOne(`CALCULATE(SUM(T[amt]), ${a})`), 40); // ranked before the other filter, so b and d tie, then d goes
  assert.deepEqual(await tBy(`DATE_TRUNC('month', "m")::DATE`, top(2), { dim: { column: "m", expr: `DATE_TRUNC('month', "m")::DATE` } }), { "2026-01": 50, "2026-02": 60 });
  assert.deepEqual(await tBy(`"k"`, top(1), { groups: ['"k"'] }), { a: 30, b: 40, c: 10, d: 40, null: 1 });
  for (const bad of ["SUMX(TOPN(0, T, T[amt]), T[amt])", "SUMX(TOPN(1, T), T[amt])", "SUMX(TOPN(1, ALL(T), T[amt]), T[amt])", "SUMX(TOPN(1, T, [S]), T[amt])", "SUMX(TOPN(1, T, T[amt], DESC, T[k], ASC), T[amt])", "SUMX(TOPN(1, Other, Other[amt]), 1)", "CALCULATE(SUM(T[amt]), TOPN(1, VALUES(T[k]), [S]), ALL(T))", "VAR m = SUM(T[amt]) RETURN SUMX(TOPN(1, T, T[amt] - m), T[amt])", "TOPN(1, T, T[amt])"]) assert.throws(() => daxToSql(bad, T), /isn't supported|Expected|whole number|something to order/, bad);
  assert.throws(() => daxToSql("CALCULATE(SUM(T[amt]), SAMEPERIODLASTYEAR(T[m]), TOPN(1, VALUES(T[k]), [S]))", { ...T, dim: { column: "m", expr: `"m"` } }), /isn't supported/);
});

test("SUMMARIZE iterates real groups on a single number", async () => {
  const sum = `SUMMARIZE(T, T[k], "A", SUM(T[amt]))`;
  assert.equal(await tOne(`SUMX(${sum}, [A])`), 121);
  assert.equal(await tOne(`AVERAGEX(${sum}, [A])`), 24.2);
  assert.equal(await tOne(`MAXX(${sum}, [A] * 2)`), 80);
  assert.equal(await tOne("COUNTROWS(SUMMARIZE(T, T[k]))"), 5);
  assert.equal(await tOne("COUNTROWS(SUMMARIZE(T, T[k], T[m]))"), 7);
  assert.equal(await tOne(`AVERAGEX(SUMMARIZE(FILTER(T, T[amt] > 5), T[k], "A", SUM(T[amt])), [A])`), 110 / 3);
  assert.equal(await tOne(`AVERAGEX(TOPN(2, ${sum}, [A]), [A])`), 40);
  assert.equal(await tOne("AVERAGEX(TOPN(3, VALUES(T[k]), [S]), [S])"), 110 / 3);
  assert.equal(await tOne(`CALCULATE(SUM(T[amt]), TOPN(2, ${sum}, [A]))`), 80);
  assert.equal(await tOne(`CALCULATE(SUMX(${sum}, [A]), T[k] IN {"a", "b"})`), 70);
  assert.equal(await tOne(`SUMX(${sum}, [A])`, { ...T, where: `WHERE "amt" >= 20` }), 100);
  assert.equal(await tOne("MAXX(TOPN(1, VALUES(T[k]), [S], ASC), T[k])", { ...T, where: `WHERE "k" IS NOT NULL` }), "c");
  // The groups of a visual can't reach the subquery, and a wrong per-group number is worse than a refusal
  assert.throws(() => daxToSql(`SUMX(${sum}, [A])`, { ...T, groups: ['"m"'] }), /isn't supported on a visual with groups/);
  for (const bad of [sum, "SUMX(SUMMARIZE(T), 1)", `SUMX(SUMMARIZE(T, Other[k]), 1)`, `SUMX(SUMMARIZE(Other, Other[k]), 1)`, `SUMX(SUMMARIZE(T, T[k], "A", CALCULATE(SUM(T[amt]), ALL(T))), [A])`, `SUMX(SUMMARIZE(T, T[k], "A", RANKX(ALL(T[k]), SUM(T[amt]))), [A])`, `CALCULATE(SUMX(${sum}, [A]), SAMEPERIODLASTYEAR(T[m]))`, `CALCULATE(SUM(T[amt]), ${sum})`]) assert.throws(() => daxToSql(bad, T), DaxError, bad);
});

test("EARLIER reads the outer row of a nested iterator, under the same filters", async () => {
  const above = "SUMX(T, COUNTROWS(FILTER(T, T[amt] > EARLIER(T[amt]))))";
  assert.equal(await tOne(above), 19);
  assert.equal(await tOne(above, { ...T, where: `WHERE "k" = 'a'` }), 1);
  assert.equal(await tOne(above.replace("FILTER(T,", "FILTER(ALL(T),"), { ...T, where: `WHERE "k" = 'a'` }), 5);
  assert.equal(await tOne(`CALCULATE(${above}, T[k] = "a")`), 1);
  assert.equal(await tOne("MAXX(T, SUMX(FILTER(T, T[amt] <= EARLIER(T[amt])), T[amt]))"), 121);
  assert.equal(await tOne("COUNTROWS(FILTER(T, COUNTROWS(FILTER(T, T[amt] > EARLIER(T[amt]))) = 0))"), 2);
  assert.deepEqual(await tBy(`DATE_TRUNC('month', "m")::DATE`, above, { dim: { column: "m", expr: `DATE_TRUNC('month', "m")::DATE` } }), { "2026-01": 6, "2026-02": 3 });
  assert.deepEqual(await tBy(`"k"`, above, { groups: ['"k"'] }), { a: 1, b: 0, c: 0, d: 0, null: 0 });
  for (const bad of ["EARLIER(T[amt])", "SUMX(T, EARLIER(T[amt]))", "SUMX(VALUES(T[k]), COUNTROWS(FILTER(T, T[k] = EARLIER(T[k]))))", "SUMX(T, COUNTROWS(FILTER(T, T[amt] > EARLIER(T[amt], 2))))", "SUMX(T, COUNTROWS(FILTER(T, COUNTROWS(FILTER(T, T[amt] > EARLIER(T[amt]))) > 0)))", "SUMX(T, COUNTROWS(FILTER(T, [S] > EARLIER(T[amt]))))", "SUMX(T, COUNTROWS(FILTER(Other, 1 > EARLIER(T[amt]))))", "CALCULATE(SUMX(T, COUNTROWS(FILTER(T, T[amt] > EARLIER(T[amt])))), ALL(T))"]) assert.throws(() => daxToSql(bad, T), /isn't supported/, bad);
});

test("USERELATIONSHIP sends a filter on the other table through the chosen relationship", async () => {
  const relationships = [{ fromTable: "a.t", fromCol: "m", toTable: "a.d", toCol: "day" }, { fromTable: "a.t", fromCol: "ship", toTable: "a.d", toCol: "day" }], R = { ...T, relationships };
  assert.equal(await tOne("CALCULATE(SUM(T[amt]), USERELATIONSHIP(T[ship], D[day]), D[yr] = 2027)", R), 60);
  assert.equal(await tOne("CALCULATE(SUM(T[amt]), D[yr] = 2027, USERELATIONSHIP(D[day], T[ship]))", R), 60);
  assert.equal(await tOne("CALCULATE(SUM(T[amt]), USERELATIONSHIP(T[ship], D[day]), FILTER(D, D[yr] = 2026))", R), 61);
  assert.equal(await tOne("CALCULATE(SUM(T[amt]), USERELATIONSHIP(T[m], D[day]), D[yr] = 2027)", R), null); // no sale happened in 2027
  assert.equal(await tOne("CALCULATE(SUM(T[amt]), USERELATIONSHIP(T[ship], D[day]))", R), 121);
  assert.equal(await tOne(`CALCULATE([S], USERELATIONSHIP(T[ship], D[day]), D[yr] = 2027, T[k] = "a")`, R), 20);
  assert.throws(() => daxToSql("USERELATIONSHIP(T[ship], D[day])", R), /isn't supported/);
  assert.throws(() => daxToSql("CALCULATE(SUM(T[amt]), USERELATIONSHIP(T[amt], D[day]))", R), /Add a relationship/);
  assert.throws(() => daxToSql(`CALCULATE(SUM(T[amt]), USERELATIONSHIP(T[ship], D[day]), D[yr] = 2027 && T[k] = "a")`, R), /isn't supported/);
  // A slicer already crossing the default relationship would narrow the result by the wrong dates
  assert.throws(() => daxToSql("CALCULATE(SUM(T[amt]), USERELATIONSHIP(T[ship], D[day]))", { ...R, where: `WHERE "m" IN (SELECT "day" FROM "a"."d")` }), /isn't supported/);
  assert.throws(() => daxToSql("CALCULATE(SUM(D[yr]), USERELATIONSHIP(T[ship], D[day]))", { ...R, from: `"a"."d"`, fullTable: "a.d" }), /isn't supported/);
});

test("iterators over VALUES and ALL go over the right rows, or refuse", async () => {
  const filtered = { ...T, where: `WHERE "k" = 'a'` }, byK: Partial<DaxContext> = { groups: ['"k"'] };
  assert.equal(await tOne("AVERAGEX(VALUES(T[k]), [S])"), 121 / 5); // per k, where rows would give 121 / 7
  assert.equal(await tOne("SUMX(DISTINCT(T[k]), [S])"), 121);
  assert.equal(await tOne("MAXX(VALUES(T[k]), SUM(T[amt]))", filtered), 30);
  assert.equal(await tOne("AVERAGEX(ALL(T[k]), [S])"), 121 / 5);
  assert.equal(await tOne("COUNTROWS(ALL(T[k]))"), 5);
  assert.equal(await tOne("COUNTROWS(VALUES(T[k]))"), 5); // the blank counts, as in DAX
  assert.equal(await tOne("COUNTROWS(VALUES(T[k]))", filtered), 1);
  assert.equal(await tOne("SUMX(ALL(T), T[amt])", filtered), 121);
  assert.equal(await tOne("COUNTROWS(ALL(T))", filtered), 7);
  assert.equal(await tOne(`CALCULATE(SUMX(ALL(T), T[amt]), T[k] = "a")`), 121);
  assert.equal(await tOne("SUMX(ALLSELECTED(T), T[amt])", filtered), 30);
  assert.deepEqual(await tBy(`"k"`, "SUMX(ALL(T), T[amt])", byK), { a: 121, b: 121, c: 121, d: 121, null: 121 });
  assert.deepEqual(await tBy(`"k"`, "SUMX(ALLSELECTED(T), T[amt])", { ...byK, where: "" }), { a: 121, b: 121, c: 121, d: 121, null: 121 });
  assert.equal(await tOne("CALCULATE(SUM(T[amt]), FILTER(ALL(T), T[amt] > 10))"), 100);
  assert.equal(await tOne(`CONCATENATEX(VALUES(T[k]), T[k], ",")`, filtered), "a"); // not "a,a"
  for (const [bad, ctx] of [["SUMX(VALUES(T[k]), [S])", { ...T, ...byK }], ["SUMX(ALL(T[k]), [S])", { ...T, ...byK }], ["SUMX(ALL(T[k]), [S])", filtered], ["SUMX(ALLSELECTED(T[k]), [S])", T], ["SUMX(ALL(T), [S])", T], ["CALCULATE(SUMX(ALL(T), T[amt]), SAMEPERIODLASTYEAR(T[m]))", T], [`CALCULATE(SUMX(ALLSELECTED(T), T[amt]), T[k] = "a")`, T], ["CALCULATE(SUM(T[amt]), FILTER(ALL(T), T[amt] > 10))", { ...T, ...byK }], ["CALCULATE(SUM(T[amt]), FILTER(ALL(T), T[amt] > 10))", filtered], ["CALCULATE(SUM(T[amt]), FILTER(ALLSELECTED(T), T[amt] > 10))", { ...T, ...byK }], [`CONCATENATEX(ALL(T[k]), T[k], ",")`, T], [`CONCATENATEX(VALUES(T[k]), T[amt], ",")`, T]] as [string, DaxContext][]) assert.throws(() => daxToSql(bad, ctx), /isn't supported/, bad);
});

test("a table name must be the visual's table, or that table's short name", async () => {
  await c.run(`CREATE OR REPLACE TABLE a.fct_orders AS SELECT 5 AS amount, 2026 AS year; CREATE OR REPLACE TABLE a.order_lines AS SELECT 7 AS amount;`);
  const F: DaxContext = { from: `"a"."fct_orders"`, fullTable: "a.fct_orders" }, L: DaxContext = { from: `"a"."order_lines"`, fullTable: "a.order_lines" };
  const run = async (dax: string, ctx: DaxContext) => num((await rows(`SELECT ${daxToSql(dax, ctx)} AS v FROM ${ctx.from}`))[0].v);
  for (const q of ["fct_orders", "FCT_ORDERS", "Orders", "orders", "Order", "'a.fct_orders'"]) assert.equal(await run(`SUM(${q}[amount])`, F), 5, q);
  assert.equal(await run("SUM('Order Lines'[amount])", L), 7);
  assert.equal(await run("COUNTROWS(Orders)", F), 1);
  assert.equal(await run("SUMX(Orders, Orders[amount] * 2)", F), 10);
  assert.equal(await run(`CALCULATE(SUM(Orders[amount]), Orders[year] = 2026)`, F), 5);
  const refused = ["SUM(D[year])", `CALCULATE(SUM(Orders[amount]), D[year] = 2026)`, "SUMX(Orders, D[year])", "COUNTROWS(Dates)", "SUMX(Dates, 1)", "CALCULATE(SUM(Orders[amount]), ALL(Dates))", "CALCULATE(SUM(Orders[amount]), ALL(D[year]))", "CALCULATE(SUM(Orders[amount]), FILTER(Dates, 1 = 1))", "DISTINCTCOUNT(D[year])", "COUNTBLANK(D[year])", "HASONEVALUE(D[year])", "SUM(stg_orders[amount])", "SUM(O[amount])", "SUM(Order_Lines[amount])"];
  for (const bad of refused) assert.throws(() => daxToSql(bad, F), /isn't supported/, bad);
  // Two tables share the short name, so only the exact one counts
  const both = { ...F, relationships: [{ fromTable: "a.fct_orders", fromCol: "id", toTable: "a.dim_orders", toCol: "id" }] };
  assert.throws(() => daxToSql("SUM(Orders[amount])", both), /isn't supported/);
  assert.equal(daxToSql("SUM(fct_orders[amount])", both), 'SUM("amount")');
  // A named measure is checked on its own, and RELATED and USERELATIONSHIP still reach the other table
  assert.throws(() => daxToSql("[M]", { ...F, measures: { M: "SUM(D[year])" } }), /isn't supported/);
  assert.equal(daxToSql("[M]", { ...F, measures: { M: "SUM(Orders[amount])" } }), '(SUM("amount"))');
});

test("everything new stays plain schema-qualified tables, so row security can reach it", async () => {
  const walk = (n: unknown, f: (o: Record<string, unknown>) => void) => { if (Array.isArray(n)) n.forEach((x) => walk(x, f)); else if (n && typeof n === "object") { f(n as Record<string, unknown>); Object.values(n).forEach((x) => walk(x, f)); } };
  await c.run(`CREATE OR REPLACE TEMP VIEW __rls_0 AS SELECT * FROM "a"."t" WHERE "k" = 'a'`);
  // The same swap as src/server/rls.ts: every table read becomes the filtered view
  const secured = async (dax: string) => {
    const parsed = JSON.parse(String((await rows(`SELECT json_serialize_sql('${`SELECT ${daxToSql(dax, T)} AS v FROM "a"."t"`.replace(/'/g, "''")}') AS s`))[0].s));
    assert.equal(parsed.error, false, dax);
    let tables = 0;
    walk(parsed, (o) => { if (typeof o.table_name !== "string") return; assert.equal(o.type, "BASE_TABLE"); assert.equal(o.schema_name, "a"); tables++; if (!o.alias) o.alias = o.table_name; o.schema_name = ""; o.catalog_name = ""; o.table_name = "__rls_0"; if (o.qualified_name) o.qualified_name = { path: ["__rls_0"] }; });
    assert.ok(tables >= 2, dax);
    const out = String((await rows(`SELECT json_deserialize_sql('${JSON.stringify(parsed).replace(/'/g, "''")}') AS s`))[0].s);
    return num((await rows(out))[0].v);
  };
  assert.equal(await secured("SUMX(TOPN(1, T, T[amt]), T[amt])"), 20);
  assert.equal(await secured("CALCULATE(SUM(T[amt]), TOPN(1, VALUES(T[k]), [S]))"), 30);
  assert.equal(await secured(`SUMX(SUMMARIZE(T, T[k], "A", SUM(T[amt])), [A])`), 30);
  assert.equal(await secured("SUMX(T, COUNTROWS(FILTER(T, T[amt] > EARLIER(T[amt]))))"), 1);
});

test("unsupported DAX is refused with a reason, and text can't escape into SQL", () => {
  for (const bad of ["SUMMARIZE(S, S[k])", "USERELATIONSHIP(A[x], B[y])", "EARLIER(S[k])", "NOPE(1)", "SUM(S[a]", "SUM(S[a]); DROP TABLE x", "VAR x = 1", "RELATED(Cust[city])"]) assert.throws(() => daxToSql(bad, { from: "x" }), DaxError, bad);
  assert.throws(() => daxToSql("CALCULATE(SUM(S[a]), SAMEPERIODLASTYEAR(S[other]))", byMonth), /grouped by d/);
  assert.equal(daxToSql(`CALCULATE(SUM(O[a]), O[s] = "x'); DROP")`), `(SUM("a") FILTER (WHERE "s" = 'x''); DROP'))`);
  assert.equal(daxToSql('SUM(O["; DROP TABLE x; --])'), 'SUM("""; DROP TABLE x; --")');
});
