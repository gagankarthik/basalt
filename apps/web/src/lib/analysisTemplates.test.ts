import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { templateCells, TEMPLATES } from "./analysisTemplates.ts";

let c: DuckDBConnection;
const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
const sqlOf = (id: string, p: Record<string, string>) => { let n = 0; return templateCells(id, p, () => String(n++))!.filter((x) => x.kind === "sql").map((x) => x.source); };
const O = { table: "main.orders", user: "who", date: "ts", value: "amount" };

before(async () => {
  c = await (await DuckDBInstance.create(":memory:")).connect();
  await c.run(`CREATE TABLE orders (id INT, who VARCHAR, ts DATE, amount DOUBLE, region VARCHAR)`);
  // u1 in Jan, Feb. u2 in Jan only. u3 in Feb only.
  await c.run(`INSERT INTO orders VALUES (1,'u1','2026-01-05',10,'N'),(2,'u1','2026-02-05',20,'N'),(3,'u2','2026-01-06',30,'S'),(4,'u3','2026-02-07',100,'S'),(4,NULL,'2099-01-01',1,'S')`);
  await c.run(`CREATE TABLE ledger (ts DATE, amount DOUBLE)`);
  await c.run(`INSERT INTO ledger VALUES ('2026-01-01',40),('2026-02-01',999)`);
  await c.run(`CREATE TABLE events (who VARCHAR, step VARCHAR)`);
  await c.run(`INSERT INTO events VALUES ('a','visit'),('b','visit'),('c','visit'),('d','visit'),('a','cart'),('b','cart'),('a','buy')`);
  await c.run(`CREATE TABLE ab AS SELECT CASE WHEN i < 1000 THEN 'A' ELSE 'B' END AS v, CASE WHEN i < 1000 THEN i < 100 ELSE i < 1200 END AS done FROM range(2000) t(i)`);
  await c.run(`CREATE TABLE ab_same AS SELECT CASE WHEN i % 2 = 0 THEN 'A' ELSE 'B' END AS v, i % 20 < 2 AS done FROM range(2000) t(i)`);
});
after(() => c.closeSync());

test("every template's SQL runs when given columns", async () => {
  const all = { ...O, key: "id", step: "region", variant: "region", converted: "id", dim: "region", table2: "main.ledger", date2: "ts", value2: "amount" };
  for (const t of TEMPLATES) for (const s of sqlOf(t.id, all)) await assert.doesNotReject(rows(s), `${t.id}: ${s}`);
});
test("quality audit counts real problems", async () => {
  const [r] = await rows(sqlOf("quality", { ...O, key: "id" })[0]);
  assert.equal(Number(r.total_rows), 5);
  assert.equal(Number(r.duplicate_keys), 1);
  assert.equal(Number(r.future_dates), 1);
  assert.equal(Number(r.missing_keys), 0);
});
test("cohort retention follows people from their first month", async () => {
  const r = await rows(sqlOf("cohort", O)[0]);
  const at = (cohort: string, m: number) => r.find((x) => x.cohort === cohort && Number(x.months_since_start) === m);
  assert.equal(Number(at("2026-01", 0)!.retention_pct), 100);
  assert.equal(Number(at("2026-01", 1)!.retention_pct), 50);
  assert.equal(Number(at("2026-02", 0)!.people), 1);
});
test("funnel orders steps and measures drop-off", async () => {
  const r = await rows(sqlOf("funnel", { table: "main.events", user: "who", step: "step" })[0]);
  assert.deepEqual(r.map((x) => [x.step, Number(x.people), Number(x.pct_of_first_step)]), [["visit", 4, 100], ["cart", 2, 50], ["buy", 1, 25]]);
  assert.equal(Number(r[2].pct_of_previous_step), 50);
});
test("A/B test tells a real gap from none", async () => {
  const verdict = async (table: string) => (await rows(sqlOf("abtest", { table, variant: "v", converted: "done" })[1]))[0];
  const big = await verdict("main.ab");
  assert.equal(big.verdict, "Significant");
  assert.equal(Number(big.difference_points), 10);
  assert.equal((await verdict("main.ab_same")).verdict, "Not significant");
  await c.run(`CREATE TABLE ab3 AS SELECT * FROM ab UNION ALL SELECT 'C', true`);
  assert.equal((await verdict("main.ab3")).verdict, "Needs exactly two variants");
});
test("trend adds up months and forecasts forward", async () => {
  const [monthly, forecast] = sqlOf("trend", { table: "main.ledger", date: "ts", value: "amount" }).map((s) => s);
  const m = await rows(monthly);
  assert.deepEqual(m.map((x) => Number(x.total)), [40, 999]);
  const f = await rows(forecast);
  assert.deepEqual(f.map((x) => x.month), ["2026-03", "2026-04", "2026-05"]);
  assert.equal(Number(f[0].forecast), 1958);
});
test("what changed ranks the biggest mover first", async () => {
  const r = await rows(sqlOf("rootcause", { table: "main.ledger", date: "ts", value: "amount", dim: "amount" })[0]);
  assert.ok(r.length > 0);
  const g = await rows(sqlOf("rootcause", { ...O, table: "main.orders", dim: "region" })[0]);
  assert.equal(g[0].segment, "S");
});
test("reconcile shows only months that disagree", async () => {
  const r = await rows(sqlOf("reconcile", { ...O, table2: "main.ledger", date2: "ts", value2: "amount" })[0]);
  assert.deepEqual(r.map((x) => x.month).sort(), ["2026-02", "2099-01"]);
});
test("a column name can't change the query", async () => {
  const [s] = sqlOf("funnel", { table: "main.events", user: `who"; DROP TABLE events; --`, step: "step" });
  await assert.rejects(rows(s));
  assert.equal((await rows("SELECT count(*) n FROM events"))[0].n, "7");
});
