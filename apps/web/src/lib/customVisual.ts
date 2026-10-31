/**
 * A custom visual is a chart described in JSON, never code, because whoever writes it is showing it to everyone who opens the report.
 * Anything in a chart library's options that can run HTML, load from elsewhere or open a link is removed.
 */
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype", "formatter", "extraCssText", "renderMode", "appendToBody", "appendTo", "graphic", "toolbox", "dataset", "image", "link", "sublink", "target", "sublinkTarget", "html"]);
const BLOCKED_TEXT = /^\s*(image:\/\/|https?:|data:|javascript:|url\()/i;
export const MAX_SPEC = 20000;
// The library draws nothing, and says nothing, for a type it doesn't know. "map" needs loaded geography and "custom" needs code, so neither can work from JSON
const SERIES_TYPES = new Set(["line", "bar", "pie", "scatter", "effectScatter", "radar", "tree", "treemap", "sunburst", "boxplot", "candlestick", "heatmap", "parallel", "lines", "graph", "sankey", "funnel", "gauge", "pictorialBar", "themeRiver"]);

function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (typeof v === "string") return BLOCKED_TEXT.test(v) ? undefined : v;
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) { if (BLOCKED_KEYS.has(k)) continue; const c = clean(x); if (c !== undefined) out[k] = c; }
  return out;
}

/** Reads a spec, or says in plain words what's wrong with it. */
export function parseSpec(text: string | undefined): { option: Record<string, unknown>; error?: undefined } | { option?: undefined; error: string } {
  if (!text?.trim()) return { error: "Write a chart spec in the panel on the right." };
  if (text.length > MAX_SPEC) return { error: "This chart spec is too long." };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { error: `This chart spec isn't valid JSON: ${e instanceof Error ? e.message : e}` }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "A chart spec is one JSON object." };
  const option = clean(raw) as Record<string, unknown>;
  const series = option.series;
  if (!Array.isArray(series) || !series.length || !series.every((s) => s && typeof s === "object" && typeof (s as { type?: unknown }).type === "string")) return { error: "A chart spec needs a series list, and each series needs a type." };
  const unknown = (series as { type: string }[]).find((s) => !SERIES_TYPES.has(s.type));
  if (unknown) return { error: `Custom visuals can't draw the series type "${unknown.type}". Try one of: ${[...SERIES_TYPES].join(", ")}.` };
  return { option };
}

// Formatters aren't allowed, so values are tidied here. Long decimals from a sum would otherwise fill the chart
const tidy = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v]));

/** Adds this visual's rows. They use the visual's own columns: d for Group by, s for Split into series, and m0, m1 for each value. */
export function customOption(option: Record<string, unknown>, rows: Record<string, unknown>[]) {
  const tooltip = option.tooltip && typeof option.tooltip === "object" ? option.tooltip : {};
  return { ...option, tooltip: { trigger: "item", ...tooltip, renderMode: "richText" }, dataset: { source: rows.map(tidy) } };
}

/** Starting points that show what's possible. */
export const SPEC_STARTERS: [string, string][] = [
  ["Rounded bars", JSON.stringify({ xAxis: { type: "category" }, yAxis: {}, series: [{ type: "bar", encode: { x: "d", y: "m0" }, itemStyle: { borderRadius: [8, 8, 0, 0] } }] }, null, 2)],
  ["Rose chart", JSON.stringify({ series: [{ type: "pie", roseType: "area", radius: ["16%", "80%"], encode: { itemName: "d", value: "m0" }, itemStyle: { borderRadius: 8 } }] }, null, 2)],
  ["Smooth area", JSON.stringify({ xAxis: { type: "category", boundaryGap: false }, yAxis: {}, series: [{ type: "line", smooth: true, areaStyle: { opacity: 0.2 }, encode: { x: "d", y: "m0" } }] }, null, 2)],
  ["Lollipop", JSON.stringify({ yAxis: { type: "category" }, xAxis: {}, series: [{ type: "bar", barWidth: 2, encode: { y: "d", x: "m0" } }, { type: "scatter", symbolSize: 12, encode: { y: "d", x: "m0" } }] }, null, 2)],
];
