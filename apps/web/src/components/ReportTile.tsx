"use client";
import { useMemo, useState } from "react";
import { Chart } from "@/components/Chart";
import { ResultGrid } from "@/components/DataGrid";
import { Icon } from "@/components/icons";
import { Sk } from "@/components/ui";
import { fmt, useApp, useSem, useTables } from "@/lib/client";
import { useLiveQuery } from "@/lib/liveClient";
import { tablesOf } from "@/lib/report";
import { applyCalc, atDrill, cfTone, levelsOf, matrixOf, withParams } from "@/lib/report";
import { fieldLabel } from "@/lib/semantic";
import { measureLabel, prettyField, widgetSql } from "@/lib/sql";
import type { Filter, Widget } from "@/lib/types";

export const THEMES: Record<string, string[] | undefined> = { default: undefined, warm: ["#eb6834", "#2a78d6", "#eda100", "#6250d6", "#1baf7a", "#e87ba4", "#008300", "#e34948"], green: ["#008300", "#e87ba4", "#2a78d6", "#eda100", "#6250d6", "#eb6834", "#1baf7a", "#e34948"] };

/** Month-by-month line and change. The current month is left out because it's still incomplete. */
function KpiTrend({ w, extra }: { w: Widget; extra: Filter[] }) {
  const text = useMemo(() => widgetSql({ ...w, type: "line", dimension: w.trendDate, dateGrain: "month", sort: undefined, limit: undefined }, extra), [w, extra]);
  const { data } = useLiveQuery(text, tablesOf(w));
  const now = new Date().toISOString().slice(0, 7);
  const vals = (data?.rows ?? []).filter((r) => !String(r.d).startsWith(now)).map((r) => Number(r.m0)).slice(-12);
  if (vals.length < 2) return null;
  const hi = Math.max(...vals), lo = Math.min(...vals), range = hi - lo || 1, last = vals[vals.length - 1], prev = vals[vals.length - 2];
  const change = prev ? ((last - prev) / Math.abs(prev)) * 100 : null;
  const points = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${28 - ((v - lo) / range) * 26}`).join(" ");
  return <div className="kpi-trend"><span>{change == null ? "No earlier month" : `${change >= 0 ? "Up" : "Down"} ${Math.abs(change).toFixed(1)}% vs last month`}</span><svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="Trend over the last 12 months"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" /></svg></div>;
}

function CfCell({ v, values, w, money }: { v: number | null; values: number[]; w: Widget; money: (x: unknown) => string }) {
  const c = cfTone(v, values, w.cf);
  return <td className={`num cf ${c.tone ? `cf-${c.tone}` : ""}`} style={c.heat != null ? { background: `color-mix(in srgb, var(--accent) ${Math.round(c.heat * 45)}%, transparent)` } : undefined}>{c.bar != null && <i style={{ width: `${c.bar * 100}%` }} />}<span>{v == null ? "" : money(v)}</span></td>;
}
const labelOf = (w: Widget, f: string) => (w.model ? fieldLabel(w.semantic, f) : prettyField(f));
function Matrix({ w, rows, money }: { w: Widget; rows: Record<string, unknown>[]; money: (x: unknown) => string }) {
  if (!w.series) return <p className="muted small" style={{ margin: "auto", textAlign: "center" }}>Choose a field under Split into series for the columns.</p>;
  const m = matrixOf(rows);
  return <div className="tbl-wrap rp-matrix"><table className="tbl"><thead><tr><th>{labelOf(w, w.dimension ?? "")}</th>{m.cols.map((c) => <th key={c} className="num">{c}</th>)}{!w.model && <th className="num">Total</th>}</tr></thead>
    <tbody>{m.keys.map((k) => <tr key={k}><td><b className="cell-strong">{k}</b></td>{m.cols.map((c) => <CfCell key={c} v={m.at(k, c)} values={m.values} w={w} money={money} />)}{!w.model && <td className="num"><b>{money(m.rowTotal(k))}</b></td>}</tr>)}</tbody>
    {/* Adding up cells isn't a total for many-to-many or unique counts, so a model visual shows none rather than a wrong one */}
    {!w.model && <tfoot><tr><td><b>Total</b></td>{m.cols.map((c) => <td key={c} className="num"><b>{money(m.colTotal(c))}</b></td>)}<td className="num"><b>{money(m.total)}</b></td></tr></tfoot>}</table></div>;
}

/** Breaks a value down one field at a time. Click a bar to choose what to split next. */
function Decomp({ w, extra, values, money }: { w: Widget; extra: Filter[]; values: Record<string, number>; money: (x: unknown) => string }) {
  const [picked, setPicked] = useState<string[]>([]), levels = levelsOf(w);
  if (levels.length < 2) return <p className="muted small" style={{ margin: "auto", textAlign: "center" }}>Tick fields under Drill down to choose how to split this value.</p>;
  return <div className="rp-decomp">{levels.slice(0, picked.length + 1).map((dim, i) => <DecompLevel key={dim} w={w} dim={dim} filters={picked.slice(0, i).map((value, k): Filter => ({ id: `dc${k}`, column: levels[k], op: "eq", value }))} extra={extra} values={values} money={money} chosen={picked[i]} canGo={i < levels.length - 1} onPick={(v) => setPicked([...picked.slice(0, i), ...(picked[i] === v ? [] : [v])])} />)}</div>;
}
function DecompLevel({ w, dim, filters, extra, values, money, chosen, canGo, onPick }: { w: Widget; dim: string; filters: Filter[]; extra: Filter[]; values: Record<string, number>; money: (x: unknown) => string; chosen?: string; canGo: boolean; onPick: (v: string) => void }) {
  const text = useMemo(() => { const s = widgetSql({ ...w, type: "bar", dateGrain: undefined, dimension: dim, hierarchy: undefined, series: undefined, tips: undefined, limit: 12, sort: "value_desc", filters: [...w.filters, ...filters] }, extra); return s && withParams(s, values); }, [w, dim, filters, extra, values]);
  const { data } = useLiveQuery(text, tablesOf(w)), hi = Math.max(1, ...(data?.rows ?? []).map((r) => Number(r.m0) || 0));
  return <section><h4>{prettyField(dim)}</h4>{!data ? <Sk h={80} /> : data.rows.map((r) => { const v = String(r.d ?? "(empty)"); return <button type="button" key={v} disabled={!canGo} className={chosen === v ? "on" : ""} onClick={() => onPick(v)}><span>{v}</span><b>{money(r.m0)}</b><i><u style={{ width: `${((Number(r.m0) || 0) / hi) * 100}%` }} /></i></button>; })}</section>;
}

export function Tile({ w: base, path, values, extra, slicerValue, onSlicer, onPick }: { w: Widget; path?: string[]; values: Record<string, number>; extra: Filter[]; slicerValue?: string[]; onSlicer: (v: string[]) => void; onPick: (dim: string) => void }) {
  const settings = useApp((s) => s.config!.settings);
  const sem = useSem(), allTables = useTables();
  const w = useMemo(() => atDrill(base.model ? { ...base, semantic: sem } : base, path), [base, path, sem]);
  // The columns are still loading, which isn't the same as there being no model
  const waiting = !!base.model && !sem && !allTables;
  const text = useMemo(() => { if (waiting) return null; const s = widgetSql(w, extra); return s && withParams(s, values); }, [w, extra, values, waiting]);
  const query = useLiveQuery(text, tablesOf(w)), error = query.error, loading = query.loading;
  const data = useMemo(() => (query.data && w.calc ? { ...query.data, rows: applyCalc(query.data.rows, w.calc) } : query.data), [query.data, w.calc]);
  const money = (x: unknown) => (w.calc === "pct_total" || w.calc === "change" ? `${Number(x).toLocaleString("en-US", { maximumFractionDigits: 1 })}%` : fmt(x, w.format, settings.locale, settings.currency));
  if (w.type === "text") return <p style={{ whiteSpace: "pre-wrap" }}>{w.text || "Add your text in the panel on the right."}</p>;
  if (waiting) return <Sk h="100%" />;
  if (!text) return <p className="muted small" style={{ margin: "auto", textAlign: "center" }}>{w.table ? "Choose the fields for this visual." : "Choose a table for this visual."}</p>;
  if (error) return <div className="banner bad small" style={{ margin: "auto 0" }}><Icon name="warn" /><span style={{ overflowWrap: "anywhere" }}>{error.split("\n")[0]}</span></div>;
  if (!data) return <Sk h="100%" />;
  if (!data.rows.length) return <p className="muted small" style={{ margin: "auto", textAlign: "center" }}>No data matches these filters.</p>;
  if (w.type === "kpi") return <div className="kpi" style={{ opacity: loading ? .6 : 1 }}><div className={`kpi-v ${cfTone(Number(data.rows[0].m0), [Number(data.rows[0].m0)], w.cf).tone ? `cf-${cfTone(Number(data.rows[0].m0), [Number(data.rows[0].m0)], w.cf).tone}` : ""}`}>{fmt(data.rows[0].m0, w.format, settings.locale, settings.currency) || "0"}</div>{w.trendDate && <KpiTrend w={w} extra={extra} />}</div>;
  if (w.type === "slicer") return <div className="slicer">{data.rows.map((r) => { const v = String(r.value), on = slicerValue?.includes(v); return <button key={v} className={`chip ${on ? "on" : ""}`} aria-pressed={!!on} onClick={() => onSlicer(on ? slicerValue!.filter((x) => x !== v) : [...(slicerValue ?? []), v])}>{v}</button>; })}</div>;
  if (w.type === "decomp") return <Decomp w={w} extra={extra} values={values} money={money} />;
  if (w.type === "matrix") return <Matrix w={w} rows={data.rows} money={money} />;
  if (w.type === "table" && w.measures.length && w.cf && w.cf.mode !== "none") { const vals = data.rows.map((r) => Number(r.m0)); return <div className="tbl-wrap rp-matrix"><table className="tbl"><thead><tr><th>{prettyField(w.dimension ?? "")}</th><th className="num">{measureLabel(w.measures[0])}</th></tr></thead><tbody>{data.rows.map((r, i) => <tr key={i}><td>{String(r.d ?? "")}</td><CfCell v={r.m0 == null ? null : Number(r.m0)} values={vals} w={w} money={money} /></tr>)}</tbody></table></div>; }
  if (w.type === "table") {
    const rename = w.measures.length ? { columns: data.columns.map((c) => ({ ...c, name: c.name === "s" ? (w.series ?? "s") : c.name === "d" ? (w.dimension ?? "") : c.name.startsWith("m") && w.measures[+c.name.slice(1)] ? measureLabel(w.measures[+c.name.slice(1)]) : c.name })), rows: data.rows.map((r) => Object.fromEntries(data.columns.map((c) => [c.name === "d" ? (w.dimension ?? "") : c.name.startsWith("m") && w.measures[+c.name.slice(1)] ? measureLabel(w.measures[+c.name.slice(1)]) : c.name, r[c.name]]))) } : data;
    return <div className="fill" style={{ margin: "0 -10px -8px" }}><ResultGrid plain result={{ ...rename, columns: rename.columns.map((c) => ({ ...c, label: labelOf(w, c.name) })) }} /></div>;
  }
  return <Chart w={w} result={data} onPick={onPick} />;
}
