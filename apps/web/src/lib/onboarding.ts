import type { Config } from "./types.ts";

/** The sample company replaces these lists, so it's only offered while there's nothing of the workspace's own to lose. */
export const canLoadSample = (c: Pick<Config, "connections" | "pipelines" | "models" | "dashboards" | "views" | "metrics">) => [c.connections, c.pipelines, c.models, c.dashboards, c.views, c.metrics].every((list) => !list.length);

export const PAID_REVENUE = `SUM("amount") FILTER (WHERE "status" = 'paid')`;
/** Sample workspaces made before this fix counted unpaid payments as revenue. shortcut: only matches the untouched sample metric, drop once no such workspace exists. */
export function repairSampleMetrics<C extends { metrics: { id: string; name: string; measure: { column: string; agg: string; expr?: string; dax?: string } }[] }>(c: C): C {
  if (!c.metrics?.some((m) => m.id === "m-rev" || m.id === "m-del")) return c;
  return { ...c, metrics: c.metrics.map((m) => (m.id === "m-rev" && m.measure.column === "amount" && m.measure.agg === "sum" && !m.measure.expr && !m.measure.dax ? { ...m, measure: { ...m.measure, expr: PAID_REVENUE } } : m.id === "m-del" && m.name === "Average delivery time" ? { ...m, name: "Average delivery time, minutes" } : m)) };
}
