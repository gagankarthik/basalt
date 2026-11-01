import assert from "node:assert/strict";
import { test } from "node:test";
import { groupRuns } from "./runGroups.ts";

const r = (name: string, status: string, id: number) => ({ id, name, kind: "models", status });
test("runs in a row group, and a failure is never folded in", () => {
  const out = groupRuns([r("All", "succeeded", 3), r("All", "succeeded", 2), r("All", "failed", 1), r("All", "succeeded", 0)]);
  assert.deepEqual(out.map((x) => [x.id, x.status, x.count]), [[3, "succeeded", 2], [1, "failed", 1], [0, "succeeded", 1]]);
  assert.deepEqual(groupRuns([]), []);
});
