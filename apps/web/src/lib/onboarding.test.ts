import assert from "node:assert/strict";
import { test } from "node:test";
import { canLoadSample } from "./onboarding.ts";
import type { Config } from "./types.ts";

const empty = { connections: [], pipelines: [], models: [], dashboards: [], views: [], metrics: [] } as unknown as Config;
test("the sample is offered only to a workspace with nothing to overwrite", () => {
  assert.equal(canLoadSample(empty), true);
  for (const k of Object.keys(empty) as (keyof typeof empty)[]) assert.equal(canLoadSample({ ...empty, [k]: [{}] }), false, k);
});

test("sample revenue counts paid payments only, and a metric someone changed is left alone", async () => {
  const { repairSampleMetrics, PAID_REVENUE } = await import("./onboarding.ts");
  type Measure = { column: string; agg: string; expr?: string };
  const rev = { id: "m-rev", name: "Revenue collected", measure: { column: "amount", agg: "sum" } as Measure };
  assert.equal(repairSampleMetrics({ metrics: [rev] }).metrics[0].measure.expr, PAID_REVENUE);
  const own = { ...rev, measure: { column: "total", agg: "sum" } as Measure };
  assert.equal(repairSampleMetrics({ metrics: [own] }).metrics[0].measure.expr, undefined);
});
