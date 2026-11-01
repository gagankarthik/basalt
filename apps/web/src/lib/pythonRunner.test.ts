import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { focusLineage, lineage, syncPythonInputs } from "./graph.ts";
import { CELL_RUNNER, MODEL_RUNNER } from "./pythonRunner.ts";

const python = process.env.BASALT_PYTHON ?? "python";
const hasPython = spawnSync(python, ["--version"]).status === 0;
function run(code: string, data: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-runner-"));
  try {
    fs.writeFileSync(path.join(dir, "runner.py"), MODEL_RUNNER);
    fs.writeFileSync(path.join(dir, "user_code.py"), code);
    fs.writeFileSync(path.join(dir, "input.json"), JSON.stringify(data));
    const p = spawnSync(python, ["-I", "runner.py", "input.json", "output.json", "user_code.py"], { cwd: dir, encoding: "utf8" });
    return { status: p.status, stderr: p.stderr, rows: p.status === 0 ? JSON.parse(fs.readFileSync(path.join(dir, "output.json"), "utf8")) : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Cells in one session: each runs in a new process, sharing only the saved state, as on the server. */
function session() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-cells-"));
  fs.writeFileSync(path.join(dir, "runner.py"), CELL_RUNNER);
  fs.writeFileSync(path.join(dir, "input.json"), JSON.stringify({ cell1: [{ a: 1 }] }));
  return {
    cell(code: string) {
      fs.writeFileSync(path.join(dir, "user_code.py"), code);
      fs.rmSync(path.join(dir, "output.json"), { force: true });
      const p = spawnSync(python, ["-I", "runner.py", "input.json", "output.json", "user_code.py"], { cwd: dir, encoding: "utf8" });
      return { status: p.status, out: p.stdout.trim(), err: p.stderr, rows: fs.existsSync(path.join(dir, "output.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "output.json"), "utf8")) : null };
    },
    end() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
test("variables, functions, classes and imports carry to later cells", { skip: !hasPython }, () => {
  const s = session();
  try {
    assert.equal(s.cell('total = 5\nimport math\nfrom json import dumps as d\ndef twice(x):\n    return x * 2\nclass Box:\n    def __init__(self, v):\n        self.v = v\nb = Box(21)').status, 0);
    assert.equal(s.cell('print(twice(total), math.floor(2.5), d([1]), b.v * 2, Box(1).v)').out, "10 2 [1] 42 1");
  } finally { s.end(); }
});
test("decorated functions come back whole, and a redefinition replaces the old one", { skip: !hasPython }, () => {
  const s = session();
  try {
    s.cell('import functools\ndef deco(f):\n    @functools.wraps(f)\n    def w(*a):\n        return f(*a) + 1\n    return w\n@deco\ndef one():\n    return 1');
    assert.equal(s.cell('print(one())').out, "2");
    s.cell('def one():\n    return 100');
    assert.equal(s.cell('print(one())').out, "100");
  } finally { s.end(); }
});
test("deleted variables stay deleted, and what a failed cell made before failing is kept", { skip: !hasPython }, () => {
  const s = session();
  try {
    s.cell('a = 1\nb = 2');
    s.cell('del a');
    assert.match(s.cell('print(a)').err, /NameError/);
    const failed = s.cell('c = 3\nraise ValueError("boom")');
    assert.equal(failed.status, 1);
    assert.match(failed.err, /ValueError: boom/);
    assert.ok(!failed.err.includes("runner.py"), failed.err);
    assert.equal(s.cell('print(b, c)').out, "2 3");
  } finally { s.end(); }
});
test("a value that can't be saved is named and the rest still carry", { skip: !hasPython }, () => {
  const s = session();
  try {
    const r = s.cell('f = open("input.json")\nkept = 1');
    assert.match(r.out, /Not kept for later cells: f/);
    assert.equal(s.cell('print(kept)').out, "1");
  } finally { s.end(); }
});
test("display and results still work, and a syntax error doesn't lose earlier variables", { skip: !hasPython }, () => {
  const s = session();
  try {
    s.cell('x = results["cell1"]');
    assert.deepEqual(s.cell('display(x + [{"a": float("nan")}])').rows, [{ a: 1 }, { a: null }]);
    assert.equal(s.cell('if').status, 1);
    assert.deepEqual(s.cell('print(x)').out, "[{'a': 1}]");
  } finally { s.end(); }
});
test("dbt.ref and dbt.source read the right table even when names match", { skip: !hasPython }, () => {
  const r = run('def model(dbt, session):\n    dbt.config(materialized="table")\n    return dbt.ref("orders") + dbt.source("shop", "orders")', { refs: { orders: [{ from: "model" }] }, sources: { "raw_shop.orders": [{ from: "source" }] } });
  assert.deepEqual(r.rows, [{ from: "model" }, { from: "source" }]);
});
test("one table's lineage keeps its whole chain and drops unrelated and sibling tables", () => {
  const m = (name: string, sql: string) => ({ name, sql });
  const g = lineage([m("a", "{{ source('s', 't') }}"), m("b", "{{ ref('a') }}"), m("c", "{{ ref('b') }}"), m("sib", "{{ ref('a') }}"), m("other", "{{ source('s', 'u') }}")]);
  const f = focusLineage(g, "b");
  assert.deepEqual(f.nodes.map((n) => n.id).sort(), ["a", "b", "c", "raw_s.t"]);
  assert.equal(f.edges.length, 3);
  assert.deepEqual(f.nodes.map((n) => n.layer).sort(), [0, 1, 2, 3]);
  assert.deepEqual(focusLineage(g, "missing"), { nodes: [], edges: [] });
  assert.equal(focusLineage(g, "raw_s.t").nodes.some((n) => n.id === "sib"), true);
});
test("config values can be read back", { skip: !hasPython }, () => {
  const r = run('def model(dbt, session):\n    dbt.config(limit=2)\n    return [{"n": dbt.config.get("limit"), "d": dbt.config.get("none", 9)}]', { refs: {}, sources: {} });
  assert.deepEqual(r.rows, [{ n: 2, d: 9 }]);
});
test("an input that wasn't declared fails with a clear message", { skip: !hasPython }, () => {
  const r = run('def model(dbt, session):\n    return dbt.ref("nope")', { refs: {}, sources: {} });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Add nope as an input/);
});
test("transform(tables) keeps working", { skip: !hasPython }, () => {
  const r = run('def transform(tables):\n    return tables["a"] + tables["b"]', { refs: { a: [{ x: 1 }] }, sources: { "raw_s.b": [{ x: 2 }] } });
  assert.deepEqual(r.rows, [{ x: 1 }, { x: 2 }]);
});
test("NaN doesn't break the output", { skip: !hasPython }, () => {
  const r = run('def model(dbt, session):\n    return [{"v": float("nan")}]', { refs: {}, sources: {} });
  assert.deepEqual(r.rows, [{ v: null }]);
});
test("dbt.ref and dbt.source in code become the model's inputs, once each", () => {
  const code = 'def model(dbt, session):\n    a = dbt.ref("a")\n    b = dbt.ref(\'b\')\n    c = dbt.source("shop", "orders")';
  const sql = syncPythonInputs(code, "{{ ref('a') }}");
  assert.match(sql, /ref\('a'\)/); assert.match(sql, /ref\('b'\)/); assert.match(sql, /source\('shop', 'orders'\)/);
  assert.equal(sql.match(/ref\('a'\)/g)!.length, 1);
  assert.equal(syncPythonInputs(code, sql), sql);
  assert.equal(syncPythonInputs("def transform(tables):\n    return []", "{{ ref('x') }}"), "{{ ref('x') }}");
});
