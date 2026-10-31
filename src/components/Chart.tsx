"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { fmt, useApp } from "@/lib/client";
import { measureLabel } from "@/lib/sql";
import type { Result, Widget } from "@/lib/types";

const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isDark = () => cssVar("color-scheme") === "dark";
// the accent is chosen for light surfaces; lift it on dark ones so marks stay visible
const lift = (hex: string) => { const n = parseInt(hex.slice(1), 16), m = (c: number) => Math.round(c + (255 - c) * 0.45); return `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateLabel(v: unknown, grain?: Widget["dateGrain"]) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (!m || !grain) return v == null ? "(empty)" : String(v);
  const y = m[1], mo = MONTHS[+m[2] - 1], yy = y.slice(2);
  return grain === "year" ? y : grain === "quarter" ? `Q${Math.ceil(+m[2] / 3)} ${yy}` : grain === "month" ? `${mo} ${yy}` : `${+m[3]} ${mo} ${yy}`;
}

export function buildOption(w: Widget, r: Result, f: (v: unknown) => string): echarts.EChartsOption {
  const ink = cssVar("--ink-2"), line = cssVar("--line"), accent = w.palette?.[0] ?? (isDark() ? lift(cssVar("--accent")) : cssVar("--accent")), font = cssVar("--ui").split(",")[0];
  const axis = { axisLine: { lineStyle: { color: line } }, axisTick: { show: false }, axisLabel: { color: ink, fontSize: 11, hideOverlap: true }, splitLine: { lineStyle: { color: line } } };
  const legendOn = w.showLegend !== false;
  const base: echarts.EChartsOption = {
    color: w.palette ?? (isDark() ? DARK : LIGHT), animationDuration: 200, textStyle: { fontFamily: font, color: ink },
    grid: { left: 8, right: 28, top: 12, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: (v) => f(v), ...(w.tips?.length && !w.series ? { formatter: (ps: unknown) => { const list = (Array.isArray(ps) ? ps : [ps]) as { dataIndex: number; seriesName: string; value: unknown; name: string }[], row = r.rows[list[0]?.dataIndex], esc = (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;"); return `<b>${esc(list[0]?.name)}</b><br/>${list.map((x) => `${esc(x.seriesName)}: <b>${esc(f(Array.isArray(x.value) ? x.value[x.value.length - 1] : x.value))}</b>`).join("<br/>")}${w.tips!.map((m, i) => `<br/>${esc(measureLabel(m))}: <b>${esc(row ? Number(row[`t${i}`]).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "")}</b>`).join("")}`; } } : {}), confine: true, backgroundColor: cssVar("--bg"), borderColor: cssVar("--line-2"), textStyle: { color: cssVar("--ink"), fontSize: 12 } },
  };
  const single = (w.measures.length === 1 && !w.series);
  const dims = r.rows.map((x) => dateLabel(x.d, w.dateGrain));
  const label = { show: !!w.showLabels, formatter: (p: { value: unknown }) => f(Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value), fontSize: 11, color: ink };

  const seriesOf = (type: "bar" | "line", extra: object = {}) => {
    if (w.series) {
      const xs = [...new Set(dims)], names = [...new Set(r.rows.map((x) => String(x.s ?? "(empty)")))];
      const shown = names.slice(0, 8);
      return { xs, list: shown.map((name) => ({ name, type, data: xs.map((d) => r.rows.find((x) => dateLabel(x.d, w.dateGrain) === d && String(x.s ?? "(empty)") === name)?.m0 ?? 0), label, ...extra })) };
    }
    return { xs: dims, list: w.measures.map((m, i) => ({ name: measureLabel(m), type, data: r.rows.map((x) => x[`m${i}`]), label, ...(single ? { itemStyle: { color: accent }, lineStyle: { color: accent } } : {}), ...extra })) };
  };
  const legend = (n: number) => (legendOn && n > 1 ? { legend: { top: 0, textStyle: { color: ink, fontSize: 11 }, icon: "roundRect", itemWidth: 10, itemHeight: 10 }, grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true } } : {});
  const valAxis = { type: "value" as const, ...axis, axisLabel: { ...axis.axisLabel, formatter: (v: number) => (Math.abs(v) >= 10000 && (!w.format || w.format === "number") ? new Intl.NumberFormat("en-US", { notation: "compact" }).format(v) : f(v)) } };
  const catAxis = (data: string[]) => ({ type: "category" as const, data, ...axis, splitLine: { show: false } });
  const barItem = { borderRadius: [3, 3, 0, 0] as [number, number, number, number] };

  switch (w.type) {
    case "bar": {
      const { xs, list } = seriesOf("bar", { barMaxWidth: 22, itemStyle: { ...(single ? { color: accent } : {}), borderRadius: [0, 3, 3, 0] } });
      return { ...base, ...legend(list.length), xAxis: valAxis, yAxis: { ...catAxis(xs), inverse: true }, series: list as never };
    }
    case "column": case "stacked_column": {
      const { xs, list } = seriesOf("bar", { barMaxWidth: 36, ...(w.type === "stacked_column" ? { stack: "a" } : {}), itemStyle: { ...(single ? { color: accent } : {}), ...barItem, ...(w.type === "stacked_column" ? { borderColor: cssVar("--bg"), borderWidth: 1 } : {}), ...(w.type === "stacked_column" ? { borderColor: cssVar("--bg"), borderWidth: 1 } : {}) } });
      return { ...base, ...legend(list.length), xAxis: catAxis(xs), yAxis: valAxis, series: list as never };
    }
    case "line": case "area": {
      const { xs, list } = seriesOf("line", { smooth: false, symbolSize: 5, showSymbol: dims.length <= 12, lineStyle: { width: 2, ...(single ? { color: accent } : {}) }, ...(w.type === "area" ? { areaStyle: { opacity: 0.1 } } : {}) });
      return { ...base, ...legend(list.length), xAxis: { ...catAxis(xs), boundaryGap: false }, yAxis: valAxis, series: list as never };
    }
    case "combo": {
      const list = w.measures.map((m, i) => ({ name: measureLabel(m), type: i === 0 ? "bar" : "line", data: r.rows.map((x) => x[`m${i}`]), label, barMaxWidth: 36, lineStyle: { width: 2 } }));
      return { ...base, ...legend(list.length), xAxis: catAxis(dims), yAxis: valAxis, series: list as never };
    }
    case "pie": case "donut": {
      return { ...base, tooltip: { ...base.tooltip, trigger: "item" }, legend: legendOn ? { type: "scroll", orient: "horizontal", bottom: 0, textStyle: { color: ink, fontSize: 11 }, itemWidth: 10, itemHeight: 10 } : undefined,
        series: [{ type: "pie", radius: w.type === "donut" ? ["48%", "72%"] : "72%", center: ["50%", "45%"], avoidLabelOverlap: true, itemStyle: { borderColor: cssVar("--bg"), borderWidth: 2 }, label: { show: !!w.showLabels, color: ink, fontSize: 11 }, data: r.rows.map((x, i) => ({ name: dims[i], value: Number(x.m0) })) }] };
    }
    case "treemap":
      return { ...base, tooltip: { ...base.tooltip, trigger: "item" }, series: [{ type: "treemap", roam: false, nodeClick: false, breadcrumb: { show: false }, left: 0, right: 0, top: 0, bottom: 0, itemStyle: { borderColor: cssVar("--bg"), borderWidth: 2 }, label: { show: true, formatter: "{b}", fontSize: 12, color: "#fff" }, data: r.rows.map((x, i) => ({ name: dims[i], value: Number(x.m0) })) }] };
    case "funnel":
      return { ...base, tooltip: { ...base.tooltip, trigger: "item" }, series: [{ type: "funnel", left: 8, right: 8, top: 4, bottom: 4, sort: "descending", gap: 2, itemStyle: { borderWidth: 0 }, label: { color: ink, position: "right", fontSize: 11 }, labelLine: { show: false }, data: r.rows.map((x, i) => ({ name: dims[i], value: Number(x.m0) })) }] };
    case "gauge": {
      const v = Number(r.rows[0]?.m0 ?? 0);
      return { ...base, series: [{ type: "gauge", min: 0, max: w.target || Math.max(100, v), radius: "95%", center: ["50%", "62%"], startAngle: 200, endAngle: -20, progress: { show: true, width: 10, itemStyle: { color: accent } }, axisLine: { lineStyle: { width: 10, color: [[1, line]] } }, pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, detail: { valueAnimation: false, formatter: (x: number) => f(x), color: cssVar("--ink"), fontSize: 22, fontWeight: 600, offsetCenter: [0, "10%"] }, data: [{ value: v }] }] };
    }
    case "heatmap": {
      const xs = [...new Set(dims)], ys = [...new Set(r.rows.map((x) => String(x.s ?? "(empty)")))];
      const vals = r.rows.map((x) => Number(x.m0));
      return { ...base, tooltip: { ...base.tooltip, trigger: "item", formatter: (p) => { const a = (p as { value: number[] }).value; return `${xs[a[0]]}, ${ys[a[1]]}: ${f(a[2])}`; } }, grid: { left: 8, right: 8, top: 8, bottom: 34, containLabel: true }, xAxis: { ...catAxis(xs), splitArea: { show: false } }, yAxis: catAxis(ys),
        visualMap: { min: Math.min(...vals), max: Math.max(...vals), calculable: false, orient: "horizontal", left: "center", bottom: 0, itemHeight: 90, itemWidth: 10, textStyle: { color: ink, fontSize: 11 }, formatter: (v) => f(v), inRange: { color: [cssVar("--bg-3"), accent] } },
        series: [{ type: "heatmap", data: r.rows.map((x, i) => [xs.indexOf(dims[i]), ys.indexOf(String(x.s ?? "(empty)")), Number(x.m0)]), itemStyle: { borderColor: cssVar("--bg"), borderWidth: 2 }, label: { show: true, formatter: (p) => { const v = (p.value as number[])[2], hi = Math.max(...vals), lo = Math.min(...vals); return `{${hi > lo && (v - lo) / (hi - lo) > 0.45 ? "on" : "off"}|${f(v)}}`; }, rich: { on: { color: isDark() ? "#0e1724" : "#fff", fontSize: 11 }, off: { color: cssVar("--ink"), fontSize: 11 } } } }] };
    }
    case "scatter": {
      return { ...base, tooltip: { ...base.tooltip, trigger: "item", formatter: (p) => { const a = (p as { name: string; value: number[] }); return `${a.name}<br>${f(a.value[0])}, ${f(a.value[1])}`; } }, xAxis: { ...valAxis, name: w.measures[0] && measureLabel(w.measures[0]), nameLocation: "middle", nameGap: 24 }, yAxis: { ...valAxis, name: w.measures[1] && measureLabel(w.measures[1]) },
        series: [{ type: "scatter", symbolSize: 9, itemStyle: { color: accent, opacity: .75 }, data: r.rows.map((x, i) => ({ name: dims[i], value: [Number(x.m0), Number(x.m1 ?? 0)] })) }] };
    }
    case "waterfall": {
      let run = 0; const hidden: number[] = [], up: (number | string)[] = [], down: (number | string)[] = [];
      r.rows.forEach((x) => { const v = Number(x.m0); hidden.push(v >= 0 ? run : run + v); up.push(v >= 0 ? v : "-"); down.push(v < 0 ? -v : "-"); run += v; });
      return { ...base, xAxis: catAxis(dims), yAxis: valAxis, series: [{ type: "bar", stack: "w", silent: true, itemStyle: { color: "transparent" }, data: hidden, tooltip: { show: false } }, { name: "Increase", type: "bar", stack: "w", data: up, itemStyle: { color: accent, ...barItem }, barMaxWidth: 36 }, { name: "Decrease", type: "bar", stack: "w", data: down, itemStyle: { color: LIGHT[7], ...barItem }, barMaxWidth: 36 }] };
    }
  }
  return base;
}

export function Chart({ w, result, onPick, themeKey }: { w: Widget; result: Result; onPick?: (dim: string) => void; themeKey?: string }) {
  const ref = useRef<HTMLDivElement>(null), inst = useRef<echarts.ECharts | null>(null);
  const settings = useApp((s) => s.config?.settings);
  const pick = useRef(onPick);
  useEffect(() => { pick.current = onPick; }, [onPick]);
  useEffect(() => {
    if (!ref.current) return;
    const c = (inst.current = echarts.init(ref.current));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    c.on("click", (p) => { if (p.name) pick.current?.(p.name); else if (typeof (p as { value?: unknown }).value === "string") pick.current?.(String((p as { value?: unknown }).value)); });
    return () => { ro.disconnect(); c.dispose(); };
  }, []);
  useEffect(() => {
    const f = (v: unknown) => fmt(v, w.format, settings?.locale, settings?.currency);
    inst.current?.setOption(buildOption(w, result, f), true);
  }, [w, result, settings?.locale, settings?.currency, settings?.accent, settings?.theme, themeKey]);
  return <div ref={ref} role="img" aria-label={`${w.type.replace("_", " ")} chart: ${w.title}`} style={{ flex: 1, minHeight: 0, width: "100%", height: "100%" }} />;
}
