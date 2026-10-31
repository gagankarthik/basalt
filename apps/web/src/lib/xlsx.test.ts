import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resultSheet, toXlsx } from "./xlsx.ts";

const python = process.env.BASALT_PYTHON ?? "python";
const hasOpenpyxl = spawnSync(python, ["-c", "import openpyxl"]).status === 0;
/** Reads the file with a separate, widely used library, so this tests the format rather than this code's idea of it. */
function read(bytes: Uint8Array) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-xlsx-"));
  try {
    const file = path.join(dir, "t.xlsx");
    fs.writeFileSync(file, bytes);
    const code = "import json,sys,openpyxl\nw=openpyxl.load_workbook(sys.argv[1])\ns=w.active\nprint(json.dumps({'sheet':s.title,'bold':s['A1'].font.b,'types':[c.data_type for c in s[2]],'rows':[[c.value for c in r] for r in s.iter_rows()]}))";
    const p = spawnSync(python, ["-c", code, file], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("Excel's format is read back exactly, with real types", { skip: !hasOpenpyxl }, () => {
  const r = read(toXlsx([["name", "n", "ok", "none"], ["Oslo", 1.5, true, null], ["Århus 日本 &<>\"", -2, false, ""]], "Orders"));
  assert.equal(r.sheet, "Orders");
  assert.equal(r.bold, true);
  assert.deepEqual(r.rows, [["name", "n", "ok", "none"], ["Oslo", 1.5, true, null], ["Århus 日本 &<>\"", -2, false, null]]);
});
test("a value that looks like a formula stays text", { skip: !hasOpenpyxl }, () => {
  const r = read(toXlsx([["a"], ["=HYPERLINK(\"http://x\",\"y\")"], ["+1+1"]]));
  assert.deepEqual(r.types, ["s"]);
  assert.equal(r.rows[1][0], '=HYPERLINK("http://x","y")');
});
test("characters XML can't hold and long text don't break the file", { skip: !hasOpenpyxl }, () => {
  const r = read(toXlsx([["a"], ["bad\u0001char\nline2"], ["x".repeat(40000)]]));
  assert.equal(r.rows[1][0], "badchar\nline2");
  assert.equal(r.rows[2][0].length, 32767);
});
test("columns past Z get correct references, and a sheet name can't be invalid", { skip: !hasOpenpyxl }, () => {
  const wide = Array.from({ length: 30 }, (_, i) => i);
  const r = read(toXlsx([wide, wide], "a/b:c*" + "d".repeat(40)));
  assert.equal(r.rows[1][29], 29);
  assert.ok(r.sheet.length <= 31 && !/[/:*]/.test(r.sheet));
});
test("non-finite numbers and objects become text, and an empty sheet opens", { skip: !hasOpenpyxl }, () => {
  const r = read(toXlsx([["a", "b"], [NaN as number, { x: 1 } as unknown as string]]));
  assert.deepEqual(r.rows[1], ["NaN", '{"x":1}']);
  assert.ok(read(toXlsx([])));
});
test("a query result becomes a header and rows", () => {
  assert.deepEqual(resultSheet({ columns: [{ name: "a" }, { name: "b" }], rows: [{ a: 1, b: "x" }] }), [["a", "b"], [1, "x"]]);
});
