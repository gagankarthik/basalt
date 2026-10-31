import { test } from "node:test";
import assert from "node:assert/strict";
import { filterSql, q, lit, widgetSql, toCsv, prettyField, whereSql } from "./sql.ts";
import { topoSort, compileSql, lineage } from "./graph.ts";
import { detectPii, maskExpr } from "./pii.ts";
import { compileSteps } from "./transform.ts";

test("conditional column step", () => {
  const sql = compileSteps("model:orders", [{ id: "1", type: "condition", to: "size", cases: [{ filter: { id: "f", column: "amount", op: "gt", value: "100" }, then: "Large" }, { filter: { id: "g", column: "amount", op: "gt", value: "10" }, then: "O'Neil" }], otherwise: "0" }]);
  assert.match(sql, /CASE WHEN "amount" > 100 THEN 'Large' WHEN "amount" > 10 THEN 'O''Neil' ELSE 0 END AS "size"/);
});
test("no-code steps compile to SQL", () => {
  const sql = compileSteps("model:orders", [
    { id: "1", type: "filter", filter: { id: "f", column: "status", op: "eq", value: "paid" } },
    { id: "2", type: "calculate", to: "tax", expr: "amount * 0.1" },
    { id: "3", type: "rename", column: "tax", to: "sales_tax" },
    { id: "4", type: "keep" },
    { id: "5", type: "group", columns: ["city"], aggs: [{ column: "amount", agg: "sum", as: "total" }] },
    { id: "6", type: "join", base: "source:app.cities", columns: ["city"], how: "left" },
  ]);
  assert.match(sql, /FROM \{\{ ref\('orders'\) \}\}/);
  assert.match(sql, /\{\{ source\('app', 'cities'\) \}\} USING \("city"\)/);
  assert.ok(!sql.includes("_keep"), "an unfinished step is skipped");
  assert.throws(() => compileSteps("model:x'; drop", []), /Choose a table/);
});

test("identifiers and literals are escaped", () => {
  assert.equal(q('a"b'), '"a""b"');
  assert.equal(lit("o'brien"), "'o''brien'");
  assert.match(filterSql({ id: "1", column: "n", op: "eq", value: "x' OR 1=1 --" })!, /'x'' OR 1=1 --'/);
});
test("field names and multi-select filters", () => {
  assert.equal(prettyField("order_id"), "Order ID");
  assert.equal(prettyField("deliveryMinutes"), "Delivery minutes");
  assert.equal(filterSql({ id: "1", column: "s", op: "in", values: ["a", "b'c"] }), `CAST("s" AS VARCHAR) IN ('a', 'b''c')`);
  assert.match(filterSql({ id: "1", column: "s", op: "not_in", values: ["a"] })!, /NOT IN \('a'\) OR "s" IS NULL/);
  assert.equal(filterSql({ id: "1", column: "s", op: "in", values: [] }), null);
});
test("condition groups", () => {
  const a = { id: "a", column: "a", op: "gt", value: "1" } as const, b = { id: "b", column: "b", op: "gt", value: "2", group: "g" } as const, c = { id: "c", column: "c", op: "gt", value: "3", group: "g" } as const;
  assert.equal(whereSql([a, b, c]), 'WHERE "a" > 1 AND ("b" > 2 OR "c" > 3)');
  assert.equal(whereSql([a, b, c], "any"), 'WHERE "a" > 1 OR ("b" > 2 AND "c" > 3)');
  assert.equal(whereSql([a, { ...b, value: "" }, c]), 'WHERE "a" > 1 AND "c" > 3');
});
test("filters", () => {
  assert.equal(filterSql({ id: "1", column: "a", op: "gt", value: "5" }), '"a" > 5');
  assert.equal(filterSql({ id: "1", column: "a", op: "contains", value: "" }), null);
  assert.equal(filterSql({ id: "1", column: "a", op: "last_days", value: "1; DROP" }), null);
  assert.match(filterSql({ id: "1", column: "a", op: "contains", value: "50%" })!, /50\\%/);
});
test("model order and cycles", () => {
  const a = { name: "a", sql: "select 1" }, b = { name: "b", sql: "select * from {{ ref('a') }}" };
  assert.deepEqual(topoSort([b, a]).map((m) => m.name), ["a", "b"]);
  assert.throws(() => topoSort([{ name: "x", sql: "{{ ref('y') }}" }, { name: "y", sql: "{{ ref('x') }}" }]), /depend on each other/);
  assert.throws(() => topoSort([{ name: "x", sql: "{{ ref('nope') }}" }]), /doesn't exist/);
  assert.equal(compileSql("from {{ source('app','t') }} join {{ref('m')}}"), 'from "raw_app"."t" join "analytics"."m"');
  assert.equal(lineage([b, a]).edges.length, 1);
});
test("personal data detection", () => {
  assert.equal(detectPii("customer_email")?.rule, "hash");
  assert.equal(detectPii("plan"), null);
  assert.equal(detectPii("field_7", ["(212) 555-0142", "312-555-0199", "5125550173"])?.kind, "Phone number");
  assert.equal(detectPii("field_8", ["123-45-6789", "987-65-4321", "111-22-3333"])?.kind, "Government ID");
  assert.equal(detectPii("routing_number")?.kind, "Financial account");
  assert.equal(detectPii("order_count"), null);
  assert.equal(detectPii("cancelled_at"), null);
  assert.equal(detectPii("cell_phone")?.kind, "Phone number");
  assert.equal(maskExpr("x", "drop", "s"), null);
  assert.match(maskExpr("x", "hash", "s")!, /sha256/);
});
test("visual SQL and CSV", () => {
  const w = { id: "1", title: "", type: "bar", x: 0, y: 0, w: 1, h: 1, table: "a.b", dimension: "k", measures: [{ column: "v", agg: "sum" }], filters: [] } as never;
  assert.equal(widgetSql(w), 'SELECT "k" AS d, SUM("v") AS "m0" FROM "a"."b" GROUP BY 1 ORDER BY "m0" DESC LIMIT 50');
  assert.equal(toCsv({ columns: [{ name: "a", type: "", kind: "text" }], rows: [{ a: 'x,"y' }] }), 'a\n"x,""y"');
});
