import assert from "node:assert/strict";
import { test } from "node:test";
import { canLoadSample } from "./onboarding.ts";
import type { Config } from "./types.ts";

const empty = { connections: [], pipelines: [], models: [], dashboards: [], views: [], metrics: [] } as unknown as Config;
test("the sample is offered only to a workspace with nothing to overwrite", () => {
  assert.equal(canLoadSample(empty), true);
  for (const k of Object.keys(empty) as (keyof typeof empty)[]) assert.equal(canLoadSample({ ...empty, [k]: [{}] }), false, k);
});
