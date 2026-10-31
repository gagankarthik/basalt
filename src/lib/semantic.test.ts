import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { DaxError } from "./dax.ts";
import { compileSql } from "./graph.ts";
import { applyRowSecurity } from "./rowSecurity.ts";
import { calcColumnsSql, calcTableSql, dateCheckSql, dateProblem, dateTableSql, generatedModels, kpiStatus, modelProblems, modelSql, modelWidgetSql, relationshipCheckSql, relationshipProblems, stageOf, viewerMayRead, type RelCheck, type Sem, type SemanticModel, type SemRel } from "./semantic.ts";
import type { Metric, RlsRule, Widget } from "./types.ts";

const { DuckDBInstance } = createRequire(import.meta.url)("@duckdb/node-api");
const db = await DuckDBInstance.create(":memory:"), c = await db.connect();
/*
 Sales, worked out by hand. Sale 6 has customer 9, who doesn't exist. Dan (4) never bought.
  id cust prod order       ship        amt channel   customer region
  1  1    1    2025-01-10  2025-01-12  100 web       Ann East
  2  1    2    2025-02-05  2025-03-01  50  web       Ann East
  3  2    1    2025-03-03  2025-03-05  70  store     Bob East
  4  3    3    2026-01-10  2026-02-01  200 web       Cat West
  5  3    2    2026-02-20  2026-02-25  30  store     Cat West
  6  9    1    2026-02-28  2026-03-01  11  web       (none)
  7  2    2    2026-03-30  2026-04-02  9   store     Bob East
 Total 470. East 229, West 230, blank 11. Category A (products 1, 3) 381, B (2) 89. web 361, store 109.
*/
await c.run(`CREATE SCHEMA m; CREATE SCHEMA analytics;
  CREATE TABLE m.region AS SELECT * FROM (VALUES (1, 'East'), (2, 'West')) v(id, region);
  CREATE TABLE m.customer AS SELECT * FROM (VALUES (1, 'Ann', 1, 100), (2, 'Bob', 1, 200), (3, 'Cat', 2, 300), (4, 'Dan', 2, 400)) v(id, name, region_id, credit);
  CREATE TABLE m.product AS SELECT * FROM (VALUES (1, 'A'), (2, 'B'), (3, 'A')) v(id, cat);
  CREATE TABLE m.calendar AS SELECT d::DATE AS d, year(d) AS yr, month(d) AS mo FROM generate_series(DATE '2025-01-01', DATE '2026-12-31', INTERVAL 1 DAY) g(d);
  CREATE TABLE m.sales AS SELECT id, cust, prod, o::DATE AS ord, s::DATE AS ship, amt, ch FROM (VALUES (1, 1, 1, '2025-01-10', '2025-01-12', 100, 'web'), (2, 1, 2, '2025-02-05', '2025-03-01', 50, 'web'), (3, 2, 1, '2025-03-03', '2025-03-05', 70, 'store'), (4, 3, 3, '2026-01-10', '2026-02-01', 200, 'web'), (5, 3, 2, '2026-02-20', '2026-02-25', 30, 'store'), (6, 9, 1, '2026-02-28', '2026-03-01', 11, 'web'), (7, 2, 2, '2026-03-30', '2026-04-02', 9, 'store')) v(id, cust, prod, o, s, amt, ch);
  CREATE TABLE m.segment AS SELECT * FROM (VALUES (1, 'gold'), (1, 'vip'), (3, 'gold')) v(cust, seg);
  CREATE TABLE m.returns AS SELECT * FROM (VALUES (1, 5), (1, 7), (3, 9)) v(cust, amt);`);
const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
const describe = async (full: string) => (await rows(`SELECT column_name n, data_type t FROM information_schema.columns WHERE table_schema || '.' || table_name = '${full}' ORDER BY ordinal_position`)).map((r) => ({ name: String(r.n), type: String(r.t) }));

const rels: SemRel[] = [
  { id: "s-c", from: "m.sales", fromCol: "cust", to: "m.customer", toCol: "id" },
  { id: "c-r", from: "m.customer", fromCol: "region_id", to: "m.region", toCol: "id" },
  { id: "s-p", from: "m.sales", fromCol: "prod", to: "m.product", toCol: "id" },
  { id: "s-d", from: "m.sales", fromCol: "ord", to: "m.calendar", toCol: "d" },
  { id: "s-ship", from: "m.sales", fromCol: "ship", to: "m.calendar", toCol: "d", active: false },
  { id: "s-seg", from: "m.sales", fromCol: "cust", to: "m.segment", toCol: "cust", kind: "many" },
  { id: "r-c", from: "m.returns", fromCol: "cust", to: "m.customer", toCol: "id" },
];
const model: SemanticModel = { relationships: rels, tables: [
  { full: "m.sales", label: "Sales" }, { full: "m.customer", label: "Customers" }, { full: "m.region", label: "Regions" }, { full: "m.product", label: "Products" }, { full: "m.calendar", label: "Dates", dateColumn: "d" }, { full: "m.segment", label: "Segments" }, { full: "m.returns", label: "Returns" },
] };
const schemaFor = async (extra: string[] = []) => Object.fromEntries(await Promise.all([...model.tables.map((t) => t.full), ...extra].map(async (f) => [f, await describe(f)])));
const metric = (name: string, dax: string): Metric => ({ id: name, name, description: "", table: "m.sales", measure: { column: "*", agg: "count", dax }, format: "number", owner: "" });
const metrics = [metric("Revenue", "SUM(Sales[amt])"), metric("Twice", "[Revenue] * 2"), { ...metric("Orders", ""), measure: { column: "*", agg: "count" as const } }];
const sem: Sem = { model, metrics, schema: await schemaFor() };
const num = (v: unknown) => (typeof v === "string" && /^-?[\d.]+$/.test(v) ? Number(v) : v);
const by = async (field: string, dax: string, opts: { grain?: string; s?: Sem; filters?: Parameters<typeof modelSql>[1]["filters"]; series?: string } = {}) => {
  const out = await rows(modelSql(opts.s ?? sem, { home: "m.sales", groups: [{ as: "d", field, grain: opts.grain }, ...(opts.series ? [{ as: "s", field: opts.series }] : [])], filters: opts.filters, measures: [{ as: "m0", measure: { column: "*", agg: "count", dax } }] }));
  return Object.fromEntries(out.map((r) => [`${String(r.d).slice(0, 7)}${opts.series ? `/${r.s}` : ""}`, num(r.m0)]));
};
const one = async (dax: string, s = sem, filters?: Parameters<typeof modelSql>[1]["filters"]) => num((await rows(modelSql(s, { home: "m.sales", groups: [], filters, measures: [{ as: "m0", measure: { column: "*", agg: "count", dax } }] })))[0].m0);
const R = "m.region[region]", CAT = "m.product[cat]", CUST = "m.customer[name]", SEG = "m.segment[seg]", CH = "m.sales[ch]", DATE = "m.calendar[d]";

test("filters flow across many-to-one relationships, through a chain, with orphans under a blank", async () => {
  assert.equal(await one("SUM(Sales[amt])"), 470);
  assert.deepEqual(await by(R, "SUM(Sales[amt])"), { East: 229, West: 230, null: 11 });
  assert.deepEqual(await by(CAT, "SUM(Sales[amt])"), { A: 381, B: 89 });
  assert.deepEqual(await by(CUST, "[Revenue]"), { Ann: 150, Bob: 79, Cat: 230, null: 11 }); // Dan's row is blank, so it's dropped
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), Regions[region] = "West")`), 230);
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), Regions[region] = "west")`), 230); // DAX text ignores case
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), Regions[region] <> "West")`), 240); // the blank row isn't West
  assert.equal(await one(`CALCULATE(COUNTROWS(Sales), Customers[name] = "Ann", Products[cat] = "B")`), 1);
  assert.equal(await one("COUNTROWS(Customers)"), 4);
});

test("a visual with fields from several related tables", async () => {
  // East: A 170 (100+70), B 59 (50+9). West: A 200, B 30. Blank: A 11
  assert.deepEqual(await by(R, "SUM(Sales[amt])", { series: CAT }), { "East/A": 170, "East/B": 59, "West/A": 200, "West/B": 30, "null/A": 11 });
  assert.deepEqual(await by(R, "DIVIDE(SUM(Sales[amt]), COUNTROWS(Sales))", { filters: [{ id: "f", column: CH, op: "eq", value: "store" }] }), { East: 79 / 2, West: 30 });
  assert.deepEqual(await by(CAT, "SUM(Sales[amt])", { filters: [{ id: "f", column: R, op: "eq", value: "West" }] }), { A: 200, B: 30 });
});

test("a join can't inflate a SUM: fan-out traps give exact numbers", async () => {
  // Filter against the one-to-many direction: Ann has two web sales but her credit counts once. web: Ann, Cat = 400. store: Bob, Cat = 500
  const both = "CALCULATE(SUM(Customers[credit]), CROSSFILTER(Sales[cust], Customers[id], Both))";
  assert.deepEqual(await by(CH, both), { web: 400, store: 500 });
  // Single direction: the filter stops at Sales, so every channel shows all credit
  assert.deepEqual(await by(CH, "SUM(Customers[credit])"), { web: 1000, store: 1000 });
  // A customer with many sales and many returns: returns stay 21 in total, Ann's 12, whatever Sales has
  assert.deepEqual(await by(CUST, "SUM(Returns[amt])"), { Ann: 12, Cat: 9 });
  assert.equal(await one("SUM(Returns[amt])"), 21);
  // Two facts side by side under one dimension. Neither multiplies the other
  assert.deepEqual(await by(R, "SUM(Sales[amt]) + SUM(Returns[amt])"), { East: 229 + 12, West: 230 + 9, null: 11 });
  // Through both-direction relationships to another table's filter: products 1 and 3 reach Ann, Bob, Cat, once each
  assert.equal(await one(`CALCULATE(SUM(Customers[credit]), Products[cat] = "A", CROSSFILTER(Sales[cust], Customers[id], Both))`), 600);
});

test("many-to-many: each group is right, and the total isn't their sum", async () => {
  // gold: customers 1, 3 = 150 + 230 = 380. vip: customer 1 = 150. No blank row for limited relationships
  assert.deepEqual(await by(SEG, "SUM(Sales[amt])"), { gold: 380, vip: 150 });
  assert.equal(await one("SUM(Sales[amt])"), 470);
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), Segments[seg] IN {"gold", "vip"})`), 380);
  assert.throws(() => modelSql(sem, { home: "m.sales", groups: [], measures: [{ as: "m", measure: { column: "*", agg: "count", dax: "SUMX(Sales, RELATED(Segments[seg]))" } }] }), /many-to-many/);
});

test("inactive relationships only work through USERELATIONSHIP", async () => {
  const dax = (y: number, m: number) => `CALCULATE(SUM(Sales[amt]), Dates[yr] = ${y}, Dates[mo] = ${m}${""})`;
  assert.equal(await one(dax(2025, 3)), 70); // ordered in March 2025: sale 3
  const ship = (y: number, m: number) => `CALCULATE(SUM(Sales[amt]), USERELATIONSHIP(Sales[ship], Dates[d]), Dates[yr] = ${y}, Dates[mo] = ${m})`;
  assert.equal(await one(ship(2025, 3)), 120); // shipped in March 2025: sales 2 and 3
  assert.equal(await one(dax(2026, 2)), 41); // ordered: 5, 6
  assert.equal(await one(ship(2026, 2)), 230); // shipped: 4, 5
  assert.deepEqual(await by("m.calendar[yr]", "CALCULATE(SUM(Sales[amt]), USERELATIONSHIP(Sales[ship], Dates[d]))"), { 2025: 220, 2026: 250 });
  assert.throws(() => modelSql(sem, { home: "m.sales", groups: [], measures: [{ as: "m", measure: { column: "*", agg: "count", dax: "CALCULATE(SUM(Sales[amt]), USERELATIONSHIP(Sales[amt], Dates[d]))" } }] }), /Add a relationship/);
});

test("CROSSFILTER None cuts the path", async () => {
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), Regions[region] = "West", CROSSFILTER(Sales[cust], Customers[id], None))`), 470);
});

test("RELATED, RELATEDTABLE and context transition", async () => {
  // Ann 2 sales x 100, Bob 2 x 200, Cat 2 x 300. Sale 6 has no customer
  assert.equal(await one("SUMX(Sales, RELATED(Customers[credit]))"), 1200);
  assert.equal(await one("SUMX(Sales, RELATED(Regions[id]) * Sales[amt])"), 229 + 460);
  assert.equal(await one("SUMX(Customers, COUNTROWS(RELATEDTABLE(Sales)))"), 6);
  assert.equal(await one("SUMX(Customers, SUMX(RELATEDTABLE(Sales), Sales[amt]))"), 459); // 470 less the orphan's 11
  assert.equal(await one("MAXX(Customers, [Revenue])"), 230);
  assert.equal(await one("AVERAGEX(VALUES(Customers[name]), [Revenue])"), 470 / 4); // Ann, Bob, Cat and the blank row. Dan's is blank, so AVERAGE skips it
  assert.equal(await one("COUNTROWS(VALUES(Customers[name]))"), 5); // the blank row counts
  assert.equal(await one("COUNTROWS(DISTINCT(Customers[name]))"), 4); // DISTINCT has no blank row
  assert.equal(await one("COUNTROWS(ALL(Customers[name]))"), 5);
  assert.equal(await one(`COUNTROWS(FILTER(Customers, [Revenue] > 100))`), 2); // Ann 150, Cat 230
  assert.equal(await one(`SUMX(FILTER(Customers, Customers[credit] > EARLIER(Customers[credit], 1) || TRUE), 1)`).catch(() => "refused"), "refused");
  assert.equal(await one("SUMX(Customers, COUNTROWS(FILTER(Customers, Customers[credit] > EARLIER(Customers[credit]))))"), 6); // 3 + 2 + 1 + 0
});

test("ALL, ALLEXCEPT, ALLSELECTED and REMOVEFILTERS", async () => {
  const share = "DIVIDE(SUM(Sales[amt]), CALCULATE(SUM(Sales[amt]), ALL(Regions)))";
  assert.equal((await by(R, share)).West, 230 / 470);
  assert.deepEqual(await by(R, "CALCULATE(SUM(Sales[amt]), REMOVEFILTERS(Regions[region]))"), { East: 470, West: 470, null: 470 });
  assert.deepEqual(await by(R, "CALCULATE(SUM(Sales[amt]), ALL(Sales))"), { East: 470, West: 470, null: 470 }); // Sales expands to Regions, so that filter goes too
  // ALL(Customers) takes Regions with it, as Customers expands to Regions, but not Products
  assert.deepEqual(await by(R, "CALCULATE(SUM(Sales[amt]), ALL(Customers))", { filters: [{ id: "f", column: CAT, op: "eq", value: "B" }] }), { East: 89, West: 89, null: 89 });
  // Keeps region, drops category: East's rows total 229 whichever category you look at
  assert.deepEqual(await by(R, "CALCULATE(SUM(Sales[amt]), ALLEXCEPT(Sales, Regions[region]))", { series: CAT }), { "East/A": 229, "East/B": 229, "West/A": 230, "West/B": 230, "null/A": 11, "null/B": 11 }); // every non-blank combination, as in Power BI
  // ALLSELECTED keeps the slicer on web (361) and drops the visual's own group
  assert.deepEqual(await by(R, "CALCULATE(SUM(Sales[amt]), ALLSELECTED())", { filters: [{ id: "f", column: CH, op: "eq", value: "web" }] }), { East: 361, West: 361, null: 361 });
  assert.deepEqual(await by(R, "CALCULATE(SUM(Sales[amt]), ALLSELECTED(Regions))", { filters: [{ id: "f", column: CH, op: "eq", value: "web" }] }), { East: 361, West: 361, null: 361 });
  assert.deepEqual(await by(R, "CALCULATE(SUM(Sales[amt]), ALL())", { filters: [{ id: "f", column: CH, op: "eq", value: "web" }] }), { East: 470, West: 470, null: 470 });
  // A filter replaces the one on its column; KEEPFILTERS intersects
  assert.deepEqual(await by(R, `CALCULATE(SUM(Sales[amt]), Regions[region] = "East")`), { East: 229, West: 229, null: 229 });
  assert.deepEqual(await by(R, `CALCULATE(SUM(Sales[amt]), KEEPFILTERS(Regions[region] = "East"))`), { East: 229 });
});

test("table functions: ADDCOLUMNS, grouped SUMMARIZE, TOPN, FILTER", async () => {
  assert.equal(await one(`SUMX(ADDCOLUMNS(Customers, "Twice", Customers[credit] * 2), [Twice])`), 2000);
  assert.equal(await one(`MAXX(ADDCOLUMNS(VALUES(Regions[region]), "R", [Revenue]), [R])`), 230);
  assert.equal(await one(`SUMX(SUMMARIZE(Sales, Regions[region], "T", SUM(Sales[amt])), [T])`), 470);
  assert.equal(await one(`MAXX(SUMMARIZE(Sales, Regions[region], Products[cat], "T", SUM(Sales[amt])), [T])`), 200);
  assert.equal(await one(`COUNTROWS(SUMMARIZE(Sales, Regions[region], Products[cat]))`), 5);
  assert.equal(await one(`SUMX(SUMMARIZE(FILTER(Sales, Sales[ch] = "web"), Regions[region], "T", SUM(Sales[amt])), [T])`), 361);
  assert.deepEqual(await by(CAT, `MAXX(SUMMARIZE(Sales, Regions[region], "T", SUM(Sales[amt])), [T])`), { A: 200, B: 59 });
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), TOPN(1, VALUES(Regions[region]), [Revenue]))`), 230);
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), TOPN(2, Sales, Sales[amt]))`), 300);
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), FILTER(Sales, Sales[amt] >= 100))`), 300);
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), FILTER(ALL(Customers), Customers[credit] >= 300))`), 230);
  assert.equal(await one(`COUNTROWS(CALCULATETABLE(Sales, Regions[region] = "East"))`), 4);
  assert.equal(await one(`SUMX(SELECTCOLUMNS(Customers, "C", Customers[credit]), [C])`), 1000);
  assert.deepEqual(await by(R, "RANKX(ALL(Regions[region]), [Revenue])"), { East: 2, West: 1, null: 3 });
  assert.equal(await one(`VAR t = FILTER(Sales, Sales[amt] > 50) VAR k = 2 RETURN COUNTROWS(t) * k`), 6); // 100, 70, 200
  assert.deepEqual(await by(R, "SELECTEDVALUE(Regions[region], \"many\")"), { East: "East", West: "West", null: "many" }); // the blank group's one value is itself blank
  assert.equal(await one("HASONEVALUE(Regions[region])"), false);
});

test("blanks behave as they do in DAX", async () => {
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), Sales[ch] = "none") + 5`), 5); // blank + 5
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), Sales[ch] = "none") * 5`), null);
  assert.equal(await one(`CALCULATE(COUNTROWS(Sales), Sales[ch] = "none")`), null);
  assert.equal(await one(`IF(CALCULATE(SUM(Sales[amt]), Sales[ch] = "none") < 1, 1, 0)`), 1);
  assert.equal(await one("DIVIDE(1, 0, 7)"), 7);
  assert.equal(await one("DIVIDE(1, 0)"), null);
  assert.equal(await one("DISTINCTCOUNT(Sales[ch])"), 2);
});

test("time intelligence on the marked date table", async () => {
  const m = { grain: "month" };
  assert.equal((await by(DATE, "CALCULATE(SUM(Sales[amt]), SAMEPERIODLASTYEAR(Dates[d]))", m))["2026-02"], 50);
  assert.equal((await by(DATE, "TOTALYTD(SUM(Sales[amt]), Dates[d])", m))["2026-02"], 241); // 200 + 30 + 11
  assert.equal((await by(DATE, "TOTALQTD(SUM(Sales[amt]), Dates[d])", m))["2026-03"], 250);
  assert.equal((await by(DATE, "CALCULATE(SUM(Sales[amt]), DATESMTD(Dates[d]))", m))["2026-03"], 9);
  assert.equal((await by(DATE, "CALCULATE(SUM(Sales[amt]), PREVIOUSMONTH(Dates[d]))", m))["2026-02"], 200);
  assert.equal((await by(DATE, "CALCULATE(SUM(Sales[amt]), NEXTMONTH(Dates[d]))", m))["2026-02"], 9);
  assert.equal((await by(DATE, "CALCULATE(SUM(Sales[amt]), PREVIOUSYEAR(Dates[d]))", m))["2026-02"], 220);
  assert.equal((await by(DATE, "CALCULATE(SUM(Sales[amt]), PARALLELPERIOD(Dates[d], -1, YEAR))", m))["2026-02"], 220);
  // All of February moves to all of March, including the 30th, where a plain date shift would stop at the 28th
  assert.equal((await by(DATE, "CALCULATE(SUM(Sales[amt]), DATEADD(Dates[d], 1, MONTH))", m))["2026-02"], 9);
  assert.equal((await by(DATE, "CALCULATE(SUM(Sales[amt]), DATEADD(Dates[d], -1, MONTH))", m))["2025-03"], 50);
  assert.equal((await by(DATE, `CALCULATE(SUM(Sales[amt]), DATESBETWEEN(Dates[d], DATE(2025, 1, 1), DATE(2025, 2, 28)))`, m))["2026-12"], 150); // replaces the month, so every month shows it
  assert.equal(await one(`CALCULATE(SUM(Sales[amt]), DATESBETWEEN(Dates[d], DATE(2025, 1, 1), DATE(2025, 2, 28)))`), 150);
  // Under a year and a dimension from another table
  assert.deepEqual(await by("m.calendar[yr]", "CALCULATE(SUM(Sales[amt]), SAMEPERIODLASTYEAR(Dates[d]))", { series: CAT }), { "2026/A": 170, "2026/B": 50 });
  assert.throws(() => modelSql(sem, { home: "m.sales", groups: [], measures: [{ as: "m", measure: { column: "*", agg: "count", dax: "CALCULATE(SUM(Sales[amt]), SAMEPERIODLASTYEAR(Sales[ord]))" } }] }), /marked/);
});

test("measures from Metrics are reused by name, including ones with no DAX", async () => {
  assert.equal(await one("[Twice]"), 940);
  assert.equal(await one("[Orders]"), 7);
  assert.deepEqual(await by(R, "[Twice]"), { East: 458, West: 460, null: 22 });
  assert.equal(await one(`CALCULATE([Revenue], Regions[region] = "West")`), 230);
  assert.throws(() => modelSql({ ...sem, metrics: [metric("Loop", "[Loop]")] }, { home: "m.sales", groups: [], measures: [{ as: "m", measure: { column: "*", agg: "count", dax: "[Loop]" } }] }), /too deeply/);
});

test("anything unsupported is refused by name, never guessed", () => {
  const refused = ["CROSSJOIN(Sales, Customers)", "SUMX(CROSSJOIN(Sales, Customers), 1)", "TREATAS(VALUES(Sales[ch]), Customers[name])", "SUM(Nope[amt])", "SUM(Sales[nope])", "Sales[amt]", "RELATED(Customers[credit])", "SUMMARIZECOLUMNS(Sales[ch])", "CALCULATE(SUM(Sales[amt]), Sales[amt] > 1 && Customers[credit] > 1)", "CALCULATE(SUM(Sales[amt]), [Revenue] > 1)", "TOTALYTD(SUM(Sales[amt]), Dates[d], \"6/30\")", "SUMX(Customers, CALCULATE(SUM(Sales[amt]), ALLSELECTED()))", "SAMEPERIODLASTYEAR(Dates[d])", "FORMAT(1, \"0\")", "SUM(Sales[amt]); DROP TABLE x"];
  for (const dax of refused) assert.throws(() => modelSql(sem, { home: "m.sales", groups: [], measures: [{ as: "m", measure: { column: "*", agg: "count", dax } }] }), DaxError, dax);
});

test("an ambiguous path is refused, and so is a bad one-side at run time", async () => {
  const twoWays: SemRel[] = [...rels.filter((r) => r.id !== "r-c"), { id: "r-c", from: "m.returns", fromCol: "cust", to: "m.customer", toCol: "id", both: true }, { id: "r-s", from: "m.returns", fromCol: "cust", to: "m.sales", toCol: "cust", kind: "many", both: true }];
  const s2: Sem = { ...sem, model: { ...model, relationships: twoWays } };
  assert.throws(() => modelSql(s2, { home: "m.sales", groups: [], filters: [{ id: "f", column: "m.customer[name]", op: "eq", value: "Ann" }], measures: [{ as: "m", measure: { column: "amt", agg: "sum" } }] }), /more than one path/);
  assert.ok(modelProblems(s2.model).some((p) => p.includes("More than one active path")));
  assert.deepEqual(modelProblems(model), []);
  // The product table now repeats a key, and every compiled query that joins it stops rather than doubling
  await c.run(`CREATE TABLE m.dup AS SELECT * FROM (VALUES (1, 'A'), (1, 'Z'), (2, 'B'), (3, 'A')) v(id, cat)`);
  const s3: Sem = { ...sem, schema: { ...sem.schema, "m.dup": await describe("m.dup") }, model: { ...model, tables: [...model.tables, { full: "m.dup", label: "Dup" }], relationships: [...rels, { id: "s-dup", from: "m.sales", fromCol: "prod", to: "m.dup", toCol: "id" }] } };
  await assert.rejects(rows(modelSql(s3, { home: "m.sales", groups: [{ as: "d", field: "m.dup[cat]" }], measures: [{ as: "m0", measure: { column: "amt", agg: "sum" } }] })), /duplicate values/);
});

test("relationship validation counts real rows", async () => {
  const check = async (r: SemRel) => Object.fromEntries(Object.entries((await rows(relationshipCheckSql(sem, r)))[0]).map(([k, v]) => [k, Number(v)])) as RelCheck;
  const good = await check(rels[0]);
  assert.deepEqual(good, { fromRows: 7, fromBlank: 0, orphanRows: 1, orphanKeys: 1, toRows: 4, toBlank: 0, duplicateKeys: 0 });
  const p = relationshipProblems(rels[0], good);
  assert.deepEqual(p.blocking, []);
  assert.match(p.notes[0], /1 rows \(1 keys\)/);
  const seg: SemRel = { id: "x", from: "m.sales", fromCol: "cust", to: "m.segment", toCol: "cust" }, bad = await check(seg);
  assert.equal(bad.duplicateKeys, 1);
  assert.equal(bad.orphanRows, 3); // customers 2, 2 and 9
  assert.match(relationshipProblems(seg, bad).blocking[0], /1 values repeat/);
  assert.deepEqual(relationshipProblems({ ...seg, kind: "many" }, bad).blocking, []);
  const d = (await rows(dateCheckSql("m.calendar", "d")))[0];
  assert.equal(dateProblem({ rows: Number(d.rows), filled: Number(d.filled), days: Number(d.days), span: Number(d.span) }), null);
  assert.match(dateProblem({ rows: 3, filled: 3, days: 3, span: 5 })!, /gaps/);
  assert.match(dateProblem({ rows: 3, filled: 2, days: 2, span: 2 })!, /blanks/);
  assert.match(dateProblem({ rows: 3, filled: 3, days: 2, span: 2 })!, /repeated/);
});

test("calculated columns and tables build as tables, then read like any column", async () => {
  await c.run(`CREATE SCHEMA raw_x; CREATE TABLE raw_x.orders AS SELECT * FROM m.sales`);
  const tables = [...model.tables.filter((t) => t.full !== "m.sales"), { full: "raw_x.orders", label: "Sales", calc: [{ name: "credit_of", dax: "RELATED(Customers[credit])" }, { name: "double", dax: "Sales[amt] * 2" }, { name: "plus", dax: "[double] + 1" }, { name: "ch_rev", dax: "CALCULATE(SUM(Sales[amt]), ALLEXCEPT(Sales, Sales[ch]))" }] }];
  const relationships = rels.map((r) => (r.from === "m.sales" ? { ...r, from: "raw_x.orders" } : r));
  const m2: SemanticModel = { ...model, tables, relationships, calcTables: [{ id: "t", name: "by region", dax: `SUMMARIZE(Sales, Regions[region], "total", SUM(Sales[amt]))` }] };
  const s: Sem = { model: m2, metrics: [], schema: { ...sem.schema, "raw_x.orders": await describe("raw_x.orders") } };
  const { models, errors } = generatedModels(s, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(models.map((x) => x.name), ["calc_orders", "calctbl_by_region"]);
  assert.ok(models.every((x) => x.generated && x.materialized === "table"));
  assert.match(models[0].sql, /\{\{ source\('x', 'orders'\) \}\}/, "the builder sees what it reads");
  assert.match(models[1].sql, /\{\{ ref\('calc_orders'\) \}\}/, "built in dependency order");
  for (const x of models) await c.run(`CREATE OR REPLACE TABLE analytics.${x.name} AS ${compileSql(x.sql)}`);
  const built = await rows(`SELECT id, credit_of, double, plus, ch_rev FROM analytics.calc_orders ORDER BY id`);
  assert.deepEqual(built.slice(0, 2).map((r) => [r.id, r.credit_of, r.double, r.plus, num(r.ch_rev)]), [[1, 100, 200, 201, 361], [2, 100, 100, 101, 361]]);
  assert.equal(built[5].credit_of, null); // the orphan
  assert.deepEqual((await rows(`SELECT region, total FROM analytics.calctbl_by_region ORDER BY total`)).map((r) => [r.region, num(r.total)]), [[null, 11], ["East", 229], ["West", 230]]);
  // Once built, the model reads the generated table, so a visual can use the new column across a relationship
  const s2: Sem = { ...s, schema: { ...s.schema, "analytics.calc_orders": await describe("analytics.calc_orders") } };
  assert.deepEqual(await by(R, "SUM(Sales[double])", { s: s2 }).catch(() => null), null); // home for the helper is m.sales, which this model doesn't have
  const q2 = modelSql(s2, { home: "raw_x.orders", groups: [{ as: "d", field: R }], measures: [{ as: "m0", measure: { column: "*", agg: "count", dax: "SUM(Sales[double])" } }] });
  assert.deepEqual(Object.fromEntries((await rows(q2)).map((r) => [String(r.d), num(r.m0)])), { East: 458, West: 460, null: 22 });
  assert.match(q2, /"calc_orders"/);
  // A hand-written model is never replaced
  assert.match(generatedModels(s, [{ id: "1", name: "calc_orders", description: "", materialized: "table", sql: "SELECT 1", tests: [], owner: "" }]).errors[0], /already exists/);
  // Refused cases don't produce a model
  assert.match(generatedModels({ ...s, model: { ...m2, tables: [{ ...tables.at(-1)!, calc: [{ name: "c", dax: "CROSSJOIN(Sales, Regions)" }] }, ...tables.slice(0, -1)], calcTables: [] } }, []).errors[0], /CROSSJOIN/);
  assert.throws(() => calcColumnsSql(s, { full: "m.region", label: "R" }, new Set()), /no calculated columns/);
  assert.throws(() => calcTableSql(s, "1 + 1", new Set()), /needs a table/);
});

test("the auto date table covers whole years with no gaps", async () => {
  const sql = compileSql(dateTableSql([{ table: "m.sales", column: "ord" }, { table: "m.sales", column: "ship" }], new Set()));
  const r = (await rows(`SELECT COUNT(*) n, MIN("date")::VARCHAR lo, MAX("date")::VARCHAR hi, COUNT(DISTINCT "year") y FROM (${sql})`))[0];
  assert.deepEqual([Number(r.n), r.lo, r.hi, Number(r.y)], [730, "2025-01-01", "2026-12-31", 2]);
  assert.throws(() => dateTableSql([], new Set()), DaxError);
});

test("visuals keep the shape charts read, and refusals reach the tile", async () => {
  const w: Widget = { id: "w", title: "", type: "column", x: 0, y: 0, w: 1, h: 1, table: "m.sales", model: true, semantic: sem, dimension: R, measures: [{ column: "amt", agg: "sum" }], filters: [], sort: "value_desc" };
  assert.deepEqual((await rows(modelWidgetSql(w)!)).map((r) => [r.d, num(r.m0)]), [["West", 230], ["East", 229], [null, 11]]);
  assert.deepEqual((await rows(modelWidgetSql({ ...w, type: "kpi" })!)).map((r) => num(r.m0)), [470]);
  assert.deepEqual((await rows(modelWidgetSql({ ...w, type: "slicer" })!)).map((r) => r.value), ["East", "West"]);
  assert.deepEqual((await rows(modelWidgetSql(w, [{ id: "x", column: CAT, op: "eq", value: "B" }])!)).map((r) => num(r.m0)), [59, 30]);
  assert.deepEqual((await rows(modelWidgetSql({ ...w, dimension: DATE, dateGrain: "year" })!)).map((r) => num(r.m0)), [220, 250]);
  await assert.rejects(rows(modelWidgetSql({ ...w, measures: [{ column: "*", agg: "count", dax: "NOPE(1)" }] })!), /NOPE isn't supported/);
  await assert.rejects(rows(modelWidgetSql({ ...w, semantic: undefined })!), /semantic model/);
});

test("row rules hold for every compiled query, each table filtered", async () => {
  await c.run(`CREATE SCHEMA t;
    CREATE TABLE t.cust AS SELECT * FROM (VALUES ('a', 1, 'NY'), ('a', 2, 'LA'), ('b', 3, 'NY')) v(tenant, id, city);
    CREATE TABLE t.prod AS SELECT * FROM (VALUES ('a', 1, 'X'), ('b', 2, 'Y')) v(tenant, id, cat);
    CREATE TABLE t.day AS SELECT d::DATE AS d, 'a' AS tenant FROM generate_series(DATE '2025-01-01', DATE '2026-12-31', INTERVAL 1 DAY) g(d) UNION ALL SELECT d::DATE, 'b' FROM generate_series(DATE '2025-01-01', DATE '2026-12-31', INTERVAL 1 DAY) g(d);
    CREATE TABLE t.fact AS SELECT * FROM (VALUES ('a', 1, 1, DATE '2025-02-01', 10), ('a', 2, 1, DATE '2026-02-01', 20), ('a', 2, 1, DATE '2026-02-02', 5), ('b', 3, 2, DATE '2026-02-01', 1000)) v(tenant, cid, pid, d, amt);
    CREATE TABLE t.open_dim AS SELECT * FROM (VALUES (1, 'x'), (2, 'y')) v(id, label);`);
  const m3: SemanticModel = { tables: [{ full: "t.fact", label: "Fact" }, { full: "t.cust", label: "Cust" }, { full: "t.prod", label: "Prod" }, { full: "t.day", label: "Day" }, { full: "t.open_dim", label: "Open" }], relationships: [{ id: "c", from: "t.fact", fromCol: "cid", to: "t.cust", toCol: "id" }, { id: "p", from: "t.fact", fromCol: "pid", to: "t.prod", toCol: "id" }] };
  const s: Sem = { model: m3, metrics: [], schema: Object.fromEntries(await Promise.all(m3.tables.map(async (t) => [t.full, await describe(t.full)]))) };
  const rule: RlsRule[] = [{ id: "r", userId: "u", column: "tenant", values: ["a"] }];
  const run = async (dax: string, field?: string) => {
    const sql = modelSql(s, { home: "t.fact", groups: field ? [{ as: "d", field }] : [], measures: [{ as: "m0", measure: { column: "*", agg: "count", dax } }] });
    const safe = await applyRowSecurity(c, sql, rule);
    assert.doesNotMatch(safe, /"t"\."/, "no protected table named directly");
    const out = await rows(safe);
    return field ? Object.fromEntries(out.map((r) => [String(r.d), num(r.m0)])) : num(out[0].m0);
  };
  // Unfiltered these are 1035 and include tenant b's NY customer
  assert.equal(await run("SUM(Fact[amt])"), 35);
  assert.deepEqual(await run("SUM(Fact[amt])", "t.cust[city]"), { NY: 10, LA: 25 });
  assert.deepEqual(await run("SUM(Fact[amt])", "t.prod[cat]"), { X: 35 });
  assert.equal(await run(`CALCULATE(SUM(Fact[amt]), Cust[city] = "NY")`), 10);
  assert.equal(await run(`CALCULATE(SUM(Fact[amt]), ALL(Fact))`), 35); // ALL can't get past the rule
  assert.equal(await run(`CALCULATE(SUM(Fact[amt]), ALL())`), 35);
  assert.equal(await run(`SUMX(Fact, RELATED(Cust[id]) * Fact[amt])`), 60); // 10 + 40 + 10
  assert.equal(await run(`SUMX(Cust, SUMX(RELATEDTABLE(Fact), Fact[amt]))`), 35);
  assert.equal(await run(`COUNTROWS(ALL(Cust[city]))`), 2);
  assert.equal(await run(`CALCULATE(SUM(Cust[id]), CROSSFILTER(Fact[cid], Cust[id], Both))`), 3);
  assert.equal(await run(`MAXX(SUMMARIZE(Fact, Cust[city], "T", SUM(Fact[amt])), [T])`), 25);
  assert.equal(await run(`CALCULATE(SUM(Fact[amt]), TOPN(1, VALUES(Cust[city]), CALCULATE(SUM(Fact[amt]))))`), 25);
  // A table without the rule column can't be limited, so reading it is refused rather than left open
  await assert.rejects(applyRowSecurity(c, modelSql(s, { home: "t.fact", groups: [], measures: [{ as: "m0", measure: { column: "*", agg: "count", dax: "COUNTROWS(Open)" } }] }), rule), /can't be limited/);
});

test("data layers", () => {
  const models = [{ name: "calc_orders", generated: true }, { name: "stg_orders" }, { name: "orders" }];
  assert.equal(stageOf("raw_shop", "orders", models), "raw");
  assert.equal(stageOf("sample", "orders", models), "raw");
  assert.equal(stageOf("analytics", "stg_orders", models), "staging");
  assert.equal(stageOf("analytics", "orders", models), "analytics");
  assert.equal(stageOf("analytics", "calc_orders", models), "model");
  assert.equal(stageOf("scratch", "t", models), "other");
  assert.equal(viewerMayRead(undefined, "raw"), true);
  assert.equal(viewerMayRead({ tables: [], relationships: [], viewerStages: { raw: false } }, "raw"), false);
  assert.equal(kpiStatus(5, 3), "good");
  assert.equal(kpiStatus(5, 3, false), "bad");
  assert.equal(kpiStatus(null, 3), null);
});
