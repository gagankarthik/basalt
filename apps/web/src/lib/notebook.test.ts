import assert from "node:assert/strict";
import { test } from "node:test";
import { isDue, pythonEdited, rowsToResult, runCells, type Notebook, type NotebookCell } from "./notebook.ts";

const nb = (id: string, cells: Partial<NotebookCell>[], every?: number): Notebook => ({ id, name: id, owner: "a", updatedAt: "", every, cells: cells.map((c, i) => ({ id: String(i), kind: "sql", source: "", ...c })) });

test("adding, changing or removing Python counts as an edit, and SQL doesn't", () => {
  const before = [nb("n", [{ kind: "sql", source: "SELECT 1" }, { kind: "python", source: "print(1)" }])];
  assert.equal(pythonEdited(before, [nb("n", [{ kind: "sql", source: "SELECT 2" }, { kind: "python", source: "print(1)" }])]), false);
  assert.equal(pythonEdited(before, [nb("n", [{ kind: "python", source: "print(2)" }])]), true);
  assert.equal(pythonEdited(before, [nb("n", [{ kind: "sql", source: "SELECT 1" }])]), true);
  assert.equal(pythonEdited([], [nb("new", [{ kind: "python", source: "x" }])]), true);
  assert.equal(pythonEdited(before, []), true);
  assert.equal(pythonEdited([nb("n", [{ kind: "sql", source: "SELECT 1" }])], []), false);
});

test("a schedule is due only once its time has passed", () => {
  assert.equal(isDue(nb("n", []), undefined, 0), false);
  assert.equal(isDue(nb("n", [], 15), undefined, 0), true);
  const at = "2026-01-01T00:00:00.000Z", t = Date.parse(at);
  assert.equal(isDue(nb("n", [], 15), at, t + 14 * 60000), false);
  assert.equal(isDue(nb("n", [], 15), at, t + 15 * 60000), true);
});

test("cells run in order, later ones see earlier results, and a failure stops the rest", async () => {
  const seen: string[][] = [];
  const cells = nb("n", [{ source: "a" }, { kind: "text", source: "note" }, { source: "b" }, { source: "bad" }, { source: "never" }]).cells;
  const { results, failed } = await runCells(cells, async (c, earlier) => { seen.push(Object.keys(earlier)); if (c.source === "bad") throw new Error("boom"); return c.source; });
  assert.deepEqual(results, { cell1: "a", cell3: "b" });
  assert.deepEqual(failed, { index: 3, message: "boom" });
  assert.deepEqual(seen, [[], ["cell1"], ["cell1", "cell3"]]);
});

test("rows from Python become a result with usable column kinds", () => {
  const r = rowsToResult([{ city: "Oslo", n: 1, ok: true }, { city: null, n: 2.5, ok: false, extra: { a: 1 } }]);
  assert.deepEqual(r.columns.map((c) => [c.name, c.kind]), [["city", "text"], ["n", "number"], ["ok", "bool"], ["extra", "json"]]);
  assert.equal(rowsToResult([{ a: 1 }, { a: 2 }], 0, 1).truncated, true);
  assert.deepEqual(rowsToResult([]).columns, []);
});
