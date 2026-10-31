import assert from "node:assert/strict";
import test from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { incrementalCutoff, retryNames } from "./buildRetry.ts";
import { planBuild } from "./graph.ts";

test("re-running takes what failed and what it stopped, not passed models or failed checks", () => {
  const r = [{ unique_id: "model.basalt.a", status: "success" }, { unique_id: "model.basalt.b", status: "error" }, { unique_id: "model.basalt.c", status: "skipped" }, { unique_id: "test.basalt.not_null_a_id", status: "fail" }, { unique_id: "seed.basalt.s", status: "error" }, { unique_id: "model.basalt.gone", status: "error" }];
  assert.deepEqual(retryNames(r, ["a", "b", "c", "s"]), ["b", "c", "s"]);
  assert.deepEqual(retryNames([], ["a"]), []);
});
const m = (name: string, ...deps: string[]) => ({ name, sql: "", deps });
const plan = (...l: ReturnType<typeof m>[]) => planBuild(l, (x) => x.deps);
test("a cycle stops only what's in it and after it", () => {
  const p = plan(m("ok"), m("after_ok", "ok"), m("a", "b"), m("b", "a"), m("after_cycle", "a"));
  assert.deepEqual(p.order.map((x) => x.name), ["ok", "after_ok"]);
  assert.match(p.blocked.get("a")!, /depend on each other/);
  assert.match(p.blocked.get("b")!, /depend on each other/);
  assert.match(p.blocked.get("after_cycle")!, /can't be built/);
});
test("a model reading itself, and a missing model, are named", () => {
  assert.match(plan(m("a", "a")).blocked.get("a")!, /depend on each other/);
  const p = plan(m("a", "nope"), m("b", "a"), m("c"));
  assert.match(p.blocked.get("a")!, /refers to nope/);
  assert.match(p.blocked.get("b")!, /can't be built/);
  assert.deepEqual(p.order.map((x) => x.name), ["c"]);
});
test("a healthy project builds in dependency order", () => {
  const p = plan(m("c", "b"), m("b", "a"), m("a"));
  assert.deepEqual(p.order.map((x) => x.name), ["a", "b", "c"]);
  assert.equal(p.blocked.size, 0);
});
test("a look-back reaches back from the newest row, by days", async () => {
  const c = await (await DuckDBInstance.create(":memory:")).connect();
  await c.run("CREATE TABLE t AS SELECT TIMESTAMP '2026-01-10 00:00:00' AS ts");
  const at = async (d?: number) => String((await c.runAndReadAll(`SELECT CAST(${incrementalCutoff("ts", "t", d)} AS VARCHAR) v`)).getRowObjectsJson()[0].v);
  assert.equal(await at(), "2026-01-10 00:00:00");
  assert.equal(await at(3), "2026-01-07 00:00:00");
  await c.run("CREATE TABLE d AS SELECT DATE '2026-01-10' AS ts");
  assert.match(String((await c.runAndReadAll(`SELECT CAST(${incrementalCutoff("ts", "d", 3)} AS VARCHAR) v`)).getRowObjectsJson()[0].v), /^2026-01-07/);
  c.closeSync();
});
