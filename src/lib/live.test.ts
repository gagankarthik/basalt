import assert from "node:assert/strict";
import test from "node:test";
import { coalescer, incrementalDownstream, tableKey, withViews } from "./live.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a change goes at once, and a burst becomes one more at the end of the gap", async () => {
  const fired: string[][] = [], c = coalescer(300, (k) => fired.push(k));
  c.add(["a"]);
  assert.deepEqual(fired, [["a"]]);
  for (let i = 0; i < 3; i++) { c.add(["a"]); await wait(5); }
  assert.equal(fired.length, 1);
  await wait(400);
  assert.deepEqual(fired, [["a"], ["a"]]);
  await wait(400);
  assert.equal(fired.length, 2);
  c.stop();
});

test("each key has its own gap", async () => {
  const fired: string[][] = [], c = coalescer(300, (k) => fired.push(k));
  c.add(["a"]); c.add(["b"]); c.add(["a"]);
  assert.deepEqual(fired, [["a"], ["b"]]);
  await wait(400);
  assert.deepEqual(fired, [["a"], ["b"], ["a"]]);
  c.stop();
});

test("stop drops what's waiting", async () => {
  const fired: string[][] = [], c = coalescer(20, (k) => fired.push(k));
  c.add(["a"]); c.add(["a"]); c.stop();
  await wait(40);
  assert.equal(fired.length, 1);
});

const MODELS = [
  { name: "v1", materialized: "view", sql: "select * from {{ source('live','ev') }}" },
  { name: "v2", materialized: "view", sql: "select * from {{ ref('v1') }}" },
  { name: "t1", materialized: "table", sql: "select * from {{ ref('v1') }}" },
  { name: "v3", materialized: "view", sql: "select * from {{ ref('t1') }}" },
  { name: "inc", materialized: "incremental", sql: "select * from {{ ref('v2') }}" },
  { name: "other", materialized: "incremental", sql: "select * from {{ source('live','other') }}" },
];

test("readers of a view hear about changes under it, but a built table stops the chain", () => {
  assert.deepEqual(withViews(MODELS, ["raw_live.ev"]).sort(), ["analytics.v1", "analytics.v2", "raw_live.ev"]);
  assert.deepEqual(withViews(MODELS, ["analytics.t1"]).sort(), ["analytics.t1", "analytics.v3"]);
  assert.deepEqual(withViews(MODELS, ['"RAW_LIVE"."zzz"']), ["raw_live.zzz"]);
});

test("only incremental models downstream of the change rebuild", () => {
  assert.deepEqual(incrementalDownstream(MODELS, ["raw_live.ev"]), ["inc"]);
  assert.deepEqual(incrementalDownstream(MODELS, ["raw_live.other"]), ["other"]);
  assert.deepEqual(incrementalDownstream(MODELS, ["raw_live.none"]), []);
  assert.equal(tableKey('"A"."B"'), "a.b");
});
