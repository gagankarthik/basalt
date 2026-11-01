import assert from "node:assert/strict";
import test from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { maskExpr } from "./pii.ts";
import { loadSource, replaceKeysSql, syncProblem } from "./syncPlan.ts";
import type { Rule } from "./types.ts";

const SALT = "salt";
/** Two syncs through the same SQL a real sync runs, on real DuckDB. */
async function twoSyncs(rule: Rule | undefined, first: [string, string][], second: [string, string][]) {
  const db = await DuckDBInstance.create(":memory:"), c = await db.connect(), s = { mode: "incremental_dedupe" as const, primaryKey: "k" };
  const load = async (rows: [string, string][]) => {
    await c.run(`CREATE OR REPLACE TEMP TABLE _load (k VARCHAR, v VARCHAR)`);
    for (const [k, v] of rows) await c.run(`INSERT INTO _load VALUES (${k === "NULL" ? "NULL" : `'${k}'`}, '${v}')`);
    await c.run(`CREATE OR REPLACE TEMP VIEW _typed AS SELECT k, v FROM ${loadSource(s)}`);
  };
  const payload = `SELECT ${maskExpr("k", rule, SALT)}, v FROM _typed`;
  await load(first);
  await c.run(`CREATE TABLE dest AS ${payload}`);
  await load(second);
  await c.run(replaceKeysSql("dest", "k", rule, SALT));
  await c.run(`INSERT INTO dest ${payload}`);
  const rows = (await c.runAndReadAll(`SELECT v FROM dest ORDER BY v`)).getRowObjectsJson().map((r) => String(r.v));
  c.closeSync(); db.closeSync();
  return rows;
}

test("a key replaced with a code still updates its row, rather than adding a duplicate", async () => {
  assert.deepEqual(await twoSyncs("hash", [["a", "old"], ["b", "keep"]], [["a", "new"]]), ["keep", "new"]);
});
test("an unprotected key updates its row", async () => {
  assert.deepEqual(await twoSyncs(undefined, [["a", "old"], ["b", "keep"]], [["a", "new"]]), ["keep", "new"]);
});
test("the last row for a key in one batch wins, and rows with no key all stay", async () => {
  assert.deepEqual(await twoSyncs(undefined, [["a", "1"], ["a", "2"]], [["NULL", "3"], ["NULL", "4"]]), ["2", "3", "4"]);
});

test("a sync that would silently duplicate or lose rows is refused", () => {
  const dedupe = { mode: "incremental_dedupe" as const, cursor: "at", primaryKey: "k", rules: {} };
  const append = { mode: "incremental_append" as const, rules: {} };
  assert.equal(syncProblem({ mode: "full_refresh", rules: {} }, [], false), null, "a full copy needs neither");
  assert.equal(syncProblem(dedupe, ["at", "k"], false), null);
  assert.match(syncProblem(append, ["a"], false)!, /cursor column/);
  assert.equal(syncProblem(append, ["a"], true), null, "a connector keeps its own progress");
  assert.match(syncProblem({ ...append, cursor: "at" }, ["a"], false)!, /held back or left out/);
  assert.match(syncProblem(dedupe, ["at"], false)!, /primary key/);
  assert.match(syncProblem({ ...dedupe, rules: { k: "mask" } }, ["at", "k"], false)!, /Replace with a code/);
  assert.equal(syncProblem({ ...dedupe, rules: { k: "hash" } }, ["at", "k"], false), null);
});
