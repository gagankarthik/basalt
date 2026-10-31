import { kindOf, prettyField } from "./sql.ts";
import type { Widget } from "./types.ts";

type Col = { name: string; type: string };
const isKey = (n: string) => /(^|_)(id|key|uuid|hash)$/i.test(n) || /^_/.test(n);

// Adding up ratings or durations means nothing, so those are averaged
const isAverage = (n: string) => /(^|_)(rating|score|minutes|hours|days|duration|percent|pct|rate|age|lat|lng|lon)(_|$)/i.test(n);
const isMoney = (n: string) => /(^|_)(amount|price|revenue|cost|fee|sales|mrr|arr)(_|$)/i.test(n);

/** A sensible first dashboard for any table: headline numbers, a trend, and the main breakdowns. People edit it from there. */
export function autoWidgets(table: string, columns: Col[], newId: () => string): Widget[] {
  const of = (k: string) => columns.filter((c) => kindOf(c.type) === k && !isKey(c.name));
  const nums = of("number"), dates = of("date"), texts = of("text");
  const base = (title: string, type: Widget["type"], x: number, y: number, w: number, h: number, extra: Partial<Widget>): Widget => ({ id: newId(), title, type, x, y, w, h, table, measures: [], filters: [], showLegend: true, ...extra });
  const count = { column: "*", agg: "count" as const };
  const main = nums[0] ? { column: nums[0].name, agg: isAverage(nums[0].name) ? "avg" as const : "sum" as const } : count, mainName = nums[0] ? prettyField(nums[0].name) : "Rows";
  const date = dates[0]?.name;
  const heads = [{ title: "Rows", m: count, format: undefined as Widget["format"] }, ...nums.slice(0, 3).map((n) => ({ title: `${isAverage(n.name) ? "Average" : "Total"} ${prettyField(n.name).toLowerCase()}`, m: { column: n.name, agg: isAverage(n.name) ? "avg" as const : "sum" as const }, format: isMoney(n.name) ? "compact" as const : undefined }))];
  const out = heads.map((k, i) => base(k.title, "kpi", i * Math.floor(12 / heads.length), 0, Math.floor(12 / heads.length), 3, { measures: [k.m], trendDate: date, format: k.format }));
  let y = 3;
  if (date) { out.push(base(`${mainName} by month`, "line", 0, y, 12, 7, { dimension: date, dateGrain: "month", measures: [main] })); y += 7; }
  texts.slice(0, 4).forEach((t, i) => {
    out.push(base(`${mainName} by ${prettyField(t.name).toLowerCase()}`, "bar", i % 2 ? 6 : 0, y, 6, 7, { dimension: t.name, measures: [main], limit: 10, sort: "value_desc" }));
    if (i % 2) y += 7;
  });
  return out;
}
