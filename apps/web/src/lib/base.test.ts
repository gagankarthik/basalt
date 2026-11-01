import assert from "node:assert/strict";
import test from "node:test";
import { applyOp, coerce, restoredBase, snapshotDue, snapshotsToDrop, compute, recById, viewRecords, newTable, newView, type Base, type Field, type Table } from "./base.ts";
import { evalFormula, FormulaError, parseFormula } from "./formula.ts";

const run = (s: string, f: Record<string, unknown> = {}) => evalFormula(parseFormula(s), { field: (n) => (f[n] ?? null) as never, recordId: "r1", createdAt: "2026-01-01", modifiedAt: "2026-01-02" });
const AT = "2026-03-01T00:00:00.000Z";

test("a malformed change is refused and leaves the base as it was", () => {
  const b = { id: "b", name: "B", slug: "b", version: 1, nextAuto: 1, publish: false, tables: [newTable("t", "T", () => "x" + Math.random())], automations: [], updatedAt: AT, createdBy: "x" } as Base;
  const before = JSON.stringify(b);
  const bad = [{ kind: "saveInterface" }, { kind: "saveInterface", page: { id: "p", name: "P" } }, { kind: "saveExtension", extension: { id: "e" } }, { kind: "saveAutomation" }, { kind: "addTable", table: { id: "n", name: "N" } }, { kind: "addField", table: "t", field: null }, { kind: "addView", table: "t" }, { kind: "addRecords", table: "t", records: [null] }, { kind: "setCells", table: "t" }, { kind: "restoreRecords", table: "t", records: "x" }];
  for (const op of bad) assert.throws(() => applyOp(b, op as never, "x", AT), /isn't valid/, op.kind);
  assert.equal(JSON.stringify(b), before);
  applyOp(b, { kind: "saveInterface", page: { id: "p", name: "P", elements: [] } }, "x", AT);
  assert.equal(b.interfaces?.length, 1);
});

test("snapshots: taken once a day, oldest dropped first, and a restore keeps this base's identity", () => {
  const now = new Date(AT).getTime();
  assert.equal(snapshotDue(undefined, now), true);
  assert.equal(snapshotDue("2026-02-28T12:00:00.000Z", now), false);
  assert.equal(snapshotDue("2026-02-28T00:00:00.000Z", now), true);
  assert.deepEqual(snapshotsToDrop(["c", "a", "b"], 2), ["a"]);
  assert.deepEqual(snapshotsToDrop(["a"], 2), []);
  const cur = { id: "b1", slug: "now", publish: true, version: 9, nextAuto: 50, tables: [], name: "New" } as unknown as Base;
  const old = { id: "x", slug: "old", publish: false, version: 2, nextAuto: 10, tables: [{ id: "t" }], name: "Old" } as unknown as Base;
  const r = restoredBase(cur, old, AT);
  assert.deepEqual([r.id, r.slug, r.publish, r.version, r.nextAuto, r.name, r.tables.length, r.updatedAt], ["b1", "now", true, 10, 50, "Old", 1, AT]);
});

test("formula: operators, text and logic", () => {
  assert.equal(run("1 + 2 * 3"), 7);
  assert.equal(run("(1 + 2) * 3"), 9);
  assert.equal(run('"a" & "b" & 1'), "ab1");
  assert.equal(run('IF({Qty} > 2, "many", "few")', { Qty: 3 }), "many");
  assert.equal(run('SWITCH("b", "a", 1, "b", 2, 9)'), 2);
  assert.equal(run('SWITCH("z", "a", 1, 9)'), 9);
  assert.equal(run('UPPER(LEFT("hello", 2))'), "HE");
  assert.equal(run('SUBSTITUTE("a-b-c", "-", "+")'), "a+b+c");
  assert.equal(run('FIND("c", "abc")'), 3);
  assert.equal(run("ROUND(2.345, 2)"), 2.35);
  assert.equal(run("AND(1, 0)"), 0);
  assert.equal(run("ISERROR(1 / 0)"), 1);
  assert.equal(run('REGEX_REPLACE("a1b2", "[0-9]", "")'), "ab");
});

test("formula: dates", () => {
  assert.equal(run('DATESTR(DATEADD("2026-01-31", 1, "days"))'), "2026-02-01");
  assert.equal(run('DATETIME_DIFF("2026-03-01", "2026-02-01", "days")'), 28);
  assert.equal(run('DATETIME_FORMAT("2026-03-05", "MMM D, YYYY")'), "Mar 5, 2026");
  assert.equal(run('WORKDAY_DIFF("2026-03-02", "2026-03-06")'), 5);
  assert.equal(run('YEAR("2026-03-05")'), 2026);
});

test("formula: nothing outside the listed functions can run", () => {
  assert.throws(() => run('process("x")'), FormulaError);
  assert.throws(() => parseFormula("constructor.constructor"), FormulaError);
  assert.throws(() => run('REGEX_MATCH("a", "(")'), FormulaError);
  assert.throws(() => parseFormula('"unterminated'), FormulaError);
});

const mk = (): { b: Base; t: Table; o: Table; f: Record<string, Field> } => {
  let n = 0;
  const id = () => `i${++n}`;
  const t = newTable("t1", "Orders", id), o = newTable("t2", "Customers", id);
  const b: Base = { id: "b", name: "B", slug: "b", version: 0, nextAuto: 1, publish: false, tables: [t, o], automations: [], updatedAt: AT, createdBy: "A" };
  const amt: Field = { id: "amt", name: "Amount", type: "currency" }, st: Field = { id: "st", name: "Status", type: "select", choices: [{ id: "c1", name: "Open", color: "blue" }, { id: "c2", name: "Done", color: "green" }] };
  applyOp(b, { kind: "addField", table: "t1", field: amt }, "A", AT);
  applyOp(b, { kind: "addField", table: "t1", field: st }, "A", AT);
  applyOp(b, { kind: "addField", table: "t1", field: { id: "lnk", name: "Customer", type: "link", linkTable: "t2" }, inverseId: "inv", inverseName: "Orders" }, "A", AT);
  applyOp(b, { kind: "addField", table: "t2", field: { id: "rol", name: "Total", type: "rollup", viaField: "inv", readField: "amt", rollup: "SUM" } }, "A", AT);
  applyOp(b, { kind: "addField", table: "t2", field: { id: "lkp", name: "Statuses", type: "lookup", viaField: "inv", readField: "st" } }, "A", AT);
  applyOp(b, { kind: "addField", table: "t2", field: { id: "cnt", name: "Count", type: "count", viaField: "inv" } }, "A", AT);
  applyOp(b, { kind: "addField", table: "t1", field: { id: "fx", name: "Tax", type: "formula", expr: "{Amount} * 0.1" } }, "A", AT);
  const nm = t.fields[0].id;
  applyOp(b, { kind: "addRecords", table: "t2", records: [{ id: "c1r", cells: { [o.fields[0].id]: "Acme" } }] }, "A", AT);
  applyOp(b, { kind: "addRecords", table: "t1", records: [{ id: "a", cells: { [nm]: "A", amt: "$1,000.50", st: "open", lnk: ["c1r"] } }, { id: "b", cells: { [nm]: "B", amt: 200, st: "Done", lnk: ["c1r"] } }] }, "A", AT);
  return { b, t, o, f: { amt, st } };
};

test("links are two-way, and lookup, rollup and count follow them", () => {
  const { b, t, o } = mk();
  const c = compute(b, o), cust = o.records[0], f = (n: string) => o.fields.find((x) => x.id === n)!;
  assert.deepEqual(cust.cells.inv, ["a", "b"]);
  assert.equal(c.value(cust, f("rol")), 1200.5);
  assert.equal(c.value(cust, f("cnt")), 2);
  assert.deepEqual(c.value(cust, f("lkp")), ["Open", "Done"]);
  assert.equal(compute(b, t).display(t.records[0], t.fields.find((x) => x.id === "lnk")!), "Acme");
  applyOp(b, { kind: "setCells", table: "t1", updates: [{ id: "a", cells: { lnk: [] } }] }, "A", AT);
  assert.deepEqual(cust.cells.inv, ["b"]);
  applyOp(b, { kind: "deleteRecords", table: "t1", ids: ["b"] }, "A", AT);
  assert.deepEqual(cust.cells.inv, []);
});

test("formulas read fields, and errors and cycles stay in their cell", () => {
  const { b, t } = mk();
  const fx = t.fields.find((x) => x.id === "fx")!;
  assert.equal(compute(b, t).value(t.records[1], fx), 20);
  applyOp(b, { kind: "addField", table: "t1", field: { id: "l1", name: "L1", type: "formula", expr: "{L2}" } }, "A", AT);
  applyOp(b, { kind: "addField", table: "t1", field: { id: "l2", name: "L2", type: "formula", expr: "{L1}" } }, "A", AT);
  assert.equal(compute(b, t).display(t.records[0], t.fields.find((x) => x.id === "l1")!), "#ERROR");
  assert.throws(() => applyOp(b, { kind: "addField", table: "t1", field: { id: "b1", name: "Bad", type: "formula", expr: "1 +" } }, "A", AT));
});

test("typed and pasted values are converted, and bad ones become empty", () => {
  assert.equal(coerce({ id: "x", name: "x", type: "number" }, "1,234.5"), 1234.5);
  assert.equal(coerce({ id: "x", name: "x", type: "number" }, "abc"), null);
  assert.equal(coerce({ id: "x", name: "x", type: "checkbox" }, "yes"), true);
  assert.equal(coerce({ id: "x", name: "x", type: "date" }, "nope"), null);
  assert.equal(coerce({ id: "x", name: "x", type: "rating", max: 5 }, "9"), 5);
  assert.deepEqual(coerce({ id: "x", name: "x", type: "multiSelect", choices: [{ id: "a", name: "Red", color: "red" }] }, "red, blue"), ["a"]);
});

test("views filter, sort and search without changing the data", () => {
  const { b, t } = mk(), c = compute(b, t), v = newView("v", "V", "grid");
  assert.deepEqual(viewRecords(c, t, { ...v, sorts: [{ field: "amt", dir: "asc" }] }).map((r) => r.id), ["b", "a"]);
  assert.deepEqual(viewRecords(c, t, { ...v, filters: [{ id: "f", field: "st", op: "is", value: "done" }] }).map((r) => r.id), ["b"]);
  assert.deepEqual(viewRecords(c, t, { ...v, filters: [{ id: "f", field: "amt", op: "gt", value: "500" }] }).map((r) => r.id), ["a"]);
  assert.deepEqual(viewRecords(c, t, v, "acme").length, 2);
  assert.equal(t.records.length, 2);
});

test("computed fields, the primary field and history behave", () => {
  const { b, t } = mk(), a = t.records[0];
  applyOp(b, { kind: "setCells", table: "t1", updates: [{ id: "a", cells: { fx: 999, amt: 5 } }] }, "Sam", AT);
  assert.equal(a.cells.fx, undefined);
  assert.equal(a.history[0].field, "Amount");
  assert.equal(a.modifiedBy, "Sam");
  assert.throws(() => applyOp(b, { kind: "deleteField", table: "t1", id: t.fields[0].id }, "A", AT));
  assert.throws(() => applyOp(b, { kind: "addField", table: "t1", field: { id: "z", name: "amount", type: "text" } }, "A", AT));
  applyOp(b, { kind: "updateField", table: "t1", id: "amt", patch: { type: "text" } }, "A", AT);
  assert.equal(a.cells.amt, "5");
});

test("records stay findable by id through add, delete and restore", () => {
  let n = 0; const t = newTable("t", "T", () => `i${n++}`), b = { id: "b", name: "B", version: 1, nextAuto: 1, tables: [t], automations: [] } as unknown as Base;
  t.records = [];
  applyOp(b, { kind: "addRecords", table: "t", records: [{ id: "a", cells: {} }, { id: "b", cells: {} }] }, "x", AT);
  assert.equal(recById(t, "b")?.id, "b");
  applyOp(b, { kind: "addRecords", table: "t", records: [{ id: "b", cells: {} }, { id: "c", cells: {} }] }, "x", AT);
  assert.equal(t.records.length, 3); assert.equal(recById(t, "c")?.id, "c");
  const gone = recById(t, "a")!;
  applyOp(b, { kind: "deleteRecords", table: "t", ids: ["a"] }, "x", AT);
  assert.equal(recById(t, "a"), undefined);
  applyOp(b, { kind: "restoreRecords", table: "t", records: [gone] }, "x", AT);
  assert.equal(recById(t, "a"), gone);
});
