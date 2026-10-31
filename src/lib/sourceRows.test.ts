import assert from "node:assert/strict";
import test from "node:test";
import { EXTRA, cursorValue, inferColumns, rowOf, sampleOf } from "./sourceRows.ts";
import { scanStructured, findInNested } from "./pii.ts";

const docs = [{ id: "a", n: 1, price: 1.5, ok: true, tags: ["x"], Name: "A" }, { id: "b", n: 2, price: 2, name: "second spelling", mixed: 1 }, { id: "c", mixed: "text", gone: null }];

test("infers types from a sample and always keeps a place for surprises", () => {
  const cols = inferColumns(docs, ["id"]);
  assert.equal(cols[0].name, "id");
  const t = Object.fromEntries(cols.map((c) => [c.name, c.type]));
  assert.deepEqual(t, { id: "VARCHAR", n: "BIGINT", price: "DOUBLE", ok: "BOOLEAN", tags: "JSON", Name: "VARCHAR", mixed: "VARCHAR", gone: "VARCHAR", [EXTRA]: "JSON" });
  assert.equal(cols.filter((c) => c.name.toLowerCase() === "name").length, 1, "DuckDB would reject a second spelling");
});

test("a column limit and reserved names never fail inference", () => {
  const wide = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`f${i}`, i]));
  assert.ok(inferColumns([wide]).length <= 301);
  assert.ok(!inferColumns([{ _basalt_synced_at: 1, "": 2 }]).some((c) => c.name === "_basalt_synced_at" || c.name === ""));
  assert.equal(inferColumns([{ [EXTRA]: 1 }]).filter((c) => c.name === EXTRA).length, 1);
});

test("an unseen field or a wrong type moves to the extra column and isn't lost", () => {
  const cols = inferColumns(docs, ["id"]), known = new Set(cols.map((c) => c.name));
  const row = rowOf({ id: "z", n: "not a number", later: { deep: 1 }, name: "x" }, cols, known);
  const at = (c: string) => row[cols.findIndex((x) => x.name === c)];
  assert.equal(at("id"), "z"); assert.equal(at("n"), null);
  assert.deepEqual(JSON.parse(at(EXTRA)!), { n: "not a number", later: { deep: 1 }, name: "x" });
  assert.equal(rowOf({ id: "y" }, cols, known)[cols.length - 1], null);
});

test("a field left out of the read never reappears in the extra column", () => {
  const cols = inferColumns(docs, ["id"]), known = new Set(cols.map((c) => c.name)), asked = cols.filter((c) => c.name !== "price");
  assert.equal(rowOf({ id: "a", price: 9 }, asked, known).at(-1), null);
});

test("a field with a rule stays out of the extra column when a later sample misses it", () => {
  const cols = [{ name: "id", type: "VARCHAR" }, { name: EXTRA, type: "JSON" }], known = new Set(cols.map((c) => c.name));
  assert.equal(rowOf({ id: "a", NOTES: "secret" }, cols, known, new Set(["notes"])).at(-1), null);
});

test("personal data in an unseen field is found by the same scan as JSON columns", () => {
  const cols = inferColumns([{ id: "a" }], ["id"]), known = new Set(cols.map((c) => c.name));
  for (const [doc, kind] of [[{ id: "b", email: "x" }, "Email address"], [{ id: "c", note: "write to a@b.co" }, "Email address"], [{ id: "d", deep: { ssn: 1 } }, "Government ID"]] as const) {
    const extra = rowOf(doc, cols, known).at(-1)!;
    assert.equal(scanStructured(EXTRA, extra)?.kind, kind);
  }
  assert.equal(findInNested(EXTRA, rowOf({ id: "e", color: "red" }, cols, known).at(-1)!), null);
});

test("samples and cursor values", () => {
  assert.deepEqual(sampleOf([{ a: { b: 1 } }, { a: null }, {}, { a: "x" }], "a"), ['{"b":1}', "x"]);
  assert.equal(sampleOf(Array.from({ length: 80 }, () => ({ a: 1 })), "a").length, 50);
  assert.equal(cursorValue("DOUBLE", "1.5"), 1.5);
  assert.equal(cursorValue("VARCHAR", "x"), "x");
  assert.equal((cursorValue("TIMESTAMP", "2024-01-02 03:04:05") as Date).toISOString(), "2024-01-02T03:04:05.000Z");
  assert.throws(() => cursorValue("BIGINT", "x"));
});
