"use client";
import { LiveControl } from "@/components/LiveStatus";
import { useLiveFeed } from "@/lib/liveClient";
import { tablesOf } from "@/lib/report";
import Link from "next/link";
import { Suspense, use, useEffect, useRef, useState, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Tile, THEMES } from "@/components/ReportTile";
import { TileMarks, TileSheet, useTileNotes } from "@/components/TileSheet";
import { FilterEditor } from "@/components/FilterEditor";
import { Icon, type IconName } from "@/components/icons";
import { Btn, Empty, Field, Modal, MoreMenu, Pop, Sel, Sk, toast } from "@/components/ui";
import { call, columnsOf, download, uid, useApp, useSem, useTables } from "@/lib/client";
import { checkDax, fieldsOf, isModelled, measuresOf, MODEL_DAX_FUNCTIONS } from "@/lib/semantic";
import { arrange } from "@/lib/layout";
import { answer } from "@/lib/qna";
import { DAX_FUNCTIONS, daxToSql } from "@/lib/dax";
import { filtersFor, levelsOf, slicerFiltersOf, withParams } from "@/lib/report";
import { tilesPng } from "@/lib/tilePng";
import { SPEC_STARTERS } from "@/lib/customVisual";
import { kindOf, toCsv, widgetSql, prettyField } from "@/lib/sql";
import type { Agg, CfRule, Dashboard, Filter, ReportBookmark, VisualType, Widget } from "@/lib/types";

const COLS = 12, ROW = 34, GAP = 8;
const VISUALS: [VisualType, IconName, string][] = [["custom", "code", "Custom visual"], ["matrix", "pivot", "Matrix"], ["decomp", "lineage", "Decomposition tree"], ["kpi", "kpi", "Number"], ["column", "column", "Column"], ["bar", "bar", "Bar"], ["stacked_column", "stacked", "Stacked column"], ["line", "line", "Line"], ["area", "area", "Area"], ["combo", "combo", "Column and line"], ["pie", "pie", "Pie"], ["donut", "donut", "Donut"], ["treemap", "treemap", "Treemap"], ["funnel", "funnel", "Funnel"], ["gauge", "gauge", "Gauge"], ["heatmap", "heat", "Heatmap"], ["scatter", "scatter", "Scatter"], ["waterfall", "waterfall", "Waterfall"], ["table", "table", "Table"], ["slicer", "slicer", "Slicer"], ["text", "text", "Text"]];
const AGGS: [Agg, string][] = [["sum", "Sum"], ["avg", "Average"], ["median", "Median"], ["count", "Count"], ["count_distinct", "Unique count"], ["min", "Lowest"], ["max", "Highest"]];
const needsSeries = (t: VisualType) => t === "heatmap" || t === "stacked_column" || t === "column" || t === "line" || t === "area" || t === "bar";

function Editor({ w, set, onDelete, onClose }: { w: Widget; set: (p: Partial<Widget>) => void; onDelete: () => void; onClose: () => void }) {
  const dashboards = useApp((a) => a.config)!.dashboards;
  const tables = useTables(), sem = useSem(), [persp, setPersp] = useState(""), fields = useMemo(() => (w.model && sem ? fieldsOf(sem, persp) : null), [w.model, sem, persp]);
  const lab = (n: string) => (fields?.find((f) => f.name === n)?.label ?? n);
  const cols = fields ?? columnsOf(tables, w.table), names = cols.map((c) => c.name), nums = cols.filter((c) => kindOf(c.type) === "number").map((c) => c.name);
  const dimIsDate = cols.find((c) => c.name === w.dimension && kindOf(c.type) === "date");
  const chooseCol: [string, string] = ["", "Choose a column"];
  const type = w.type, simple = type === "text";
  const multi = type === "combo" || type === "scatter" || type === "table" || type === "line" || type === "column" || type === "bar" || type === "area";
  return (
    <aside className="editor-panel" aria-label="Visual settings">
      <div style={{ display: "flex", alignItems: "center" }}><h2 className="grow">Visual settings</h2><Btn icon="x" variant="ghost" aria-label="Close panel" onClick={onClose} /></div>
      <Field label="Title"><input className="input" value={w.title} onChange={(e) => set({ title: e.target.value })} /></Field>
      <div className="field"><span className="lab">Visual type</span><div className="vis-picker">{VISUALS.map(([t, ic, l]) => <button key={t} title={l} aria-label={l} aria-pressed={t === type} onClick={() => set({ type: t })}><Icon name={ic} /></button>)}</div></div>
      {type === "custom" && <>
        <Field label="Start from"><Sel options={[["", "Choose an example"], ...SPEC_STARTERS.map(([n]): [string, string] => [n, n])]} value="" onChange={(v) => { const s = SPEC_STARTERS.find(([n]) => n === v); if (s) set({ spec: s[1] }); }} /></Field>
        <Field label="Chart spec" hint="ECharts options as JSON. Use d for Group by, s for Split into series, and m0, m1 for each value. Formatters, images and links are removed so a chart can't run code."><textarea className="input mono small" rows={12} spellCheck={false} aria-label="Chart spec" value={w.spec ?? ""} onChange={(e) => set({ spec: e.target.value })} /></Field>
      </>}
      {simple ? <Field label="Text"><textarea className="input" rows={5} value={w.text ?? ""} onChange={(e) => set({ text: e.target.value })} /></Field> : <>
        {sem && <Field label="Fields from"><Sel options={[["model", "Semantic model"], ["table", "One warehouse table"]]} value={w.model ? "model" : "table"} onChange={(v) => set({ model: v === "model" || undefined, table: v === "model" ? sem.model.tables[0].full : w.table, dimension: undefined, series: undefined, hierarchy: undefined, tips: undefined, measures: [], filters: [] })} /></Field>}
        {w.model && !!sem?.model.perspectives?.length && <Field label="Perspective"><Sel options={[["", "Whole model"], ...sem.model.perspectives.map((x): [string, string] => [x.id, x.name])]} value={persp} onChange={setPersp} /></Field>}
        {w.model && !!sem?.model.hierarchies?.length && <Field label="Hierarchy"><Sel options={[["", "Choose a hierarchy"], ...sem.model.hierarchies.map((x): [string, string] => [x.id, x.name])]} value="" onChange={(v) => { const h = sem.model.hierarchies!.find((x) => x.id === v); if (h) set({ dimension: `${h.table}[${h.levels[0]}]`, hierarchy: h.levels.slice(1).map((l) => `${h.table}[${l}]`), dateGrain: undefined }); }} /></Field>}
        {w.model && !!sem?.metrics.length && type !== "slicer" && <Field label="Add a measure"><Sel options={[["", "Choose a measure"], ...measuresOf(sem, persp).map((x): [string, string] => [x.id, x.folder ? `${x.folder} / ${x.name}` : x.name])]} value="" onChange={(v) => { const x = sem.metrics.find((y) => y.id === v); if (x) set({ measures: [...w.measures, { column: "*", agg: "count", expr: "", dax: `[${x.name}]`, label: x.name }], format: w.format ?? x.format }); }} /></Field>}
        <Field label={w.model ? "Rows counted from" : "Table"}><Sel options={[["", "Choose a table"], ...(w.model && sem ? sem.model.tables.map((t): [string, string] => [t.full, t.label]) : (tables ?? []).map((t): [string, string] => [t.full, t.full]))]} value={w.table} onChange={(v) => set(w.model ? { table: v } : { table: v, dimension: undefined, series: undefined, measures: [], filters: [] })} /></Field>
        {type !== "kpi" && type !== "gauge" && <Field label={type === "slicer" ? "Filter by column" : type === "scatter" ? "One point per" : "Group by"}><Sel options={[[chooseCol[0], type === "table" ? "All rows, no grouping" : "Choose a column"], ...names.map((n): [string, string] => [n, lab(n)])]} value={w.dimension ?? ""} onChange={(v) => set({ dimension: v || undefined, dateGrain: cols.find((c) => c.name === v && kindOf(c.type) === "date") ? "month" : undefined })} /></Field>}
        {dimIsDate && type !== "slicer" && <Field label="Date grouping"><Sel options={[["day", "Day"], ["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]]} value={w.dateGrain ?? "month"} onChange={(v) => set({ dateGrain: v as Widget["dateGrain"] })} /></Field>}
        {needsSeries(type) && <Field label={type === "heatmap" ? "Second group" : "Split into series"}><Sel options={[["", "None"], ...names.map((n): [string, string] => [n, lab(n)])]} value={w.series ?? ""} onChange={(v) => set({ series: v || undefined })} /></Field>}
        {type !== "slicer" && <div className="field"><span className="lab">Values</span>
          <div style={{ display: "grid", gap: 4 }}>{w.measures.map((m, i) => { const up = (p: Partial<typeof m>) => set({ measures: w.measures.map((x, k) => (k === i ? { ...x, ...p } : x)) }); return <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 92px 28px", gap: 3 }}>
            <Sel aria-label="Value column" options={[["*", "All rows"], ...(m.agg === "count" || m.agg === "count_distinct" ? names : nums).map((n): [string, string] => [n, lab(n)])]} value={m.column} onChange={(v) => up({ column: v, agg: v === "*" ? "count" : m.agg })} />
            <Sel aria-label="Calculation" options={[...AGGS, ["custom", "Custom"]] as [string, string][]} value={m.expr != null ? "custom" : m.agg} onChange={(v) => (v === "custom" ? up({ expr: m.expr ?? "", ...(w.model ? { dax: m.dax ?? "" } : {}) }) : up({ expr: undefined, agg: v as Agg, ...(v !== "count" && v !== "count_distinct" && !nums.includes(m.column) ? { column: nums[0] ?? "*" } : {}) }))} />
            <Btn icon="x" variant="ghost" aria-label="Remove value" onClick={() => set({ measures: w.measures.filter((_, k) => k !== i) })} />{m.expr != null && <div style={{ gridColumn: "1 / -1", display: "grid", gap: 3 }}><Sel aria-label="Measure language" options={[["sql", "SQL"], ["dax", "DAX"]]} value={m.dax != null ? "dax" : "sql"} onChange={(v) => (v === "dax" ? up({ dax: m.expr ?? "" }) : up({ dax: undefined }))} /><input className="input mono" aria-label="Custom measure" placeholder={m.dax != null ? "DIVIDE(SUM(Orders[profit]), SUM(Orders[sales]))" : "SUM(price) - SUM(cost)"} value={m.dax ?? m.expr} onChange={(e) => up(m.dax != null ? { dax: e.target.value } : { expr: e.target.value })} />{m.dax != null && w.model && sem && (() => { const bad = checkDax(sem, m.dax, w.table); return bad ? <span className="err small" role="alert">{bad}</span> : <span className="hint">Supported: {MODEL_DAX_FUNCTIONS.join(", ")}</span>; })()}{m.dax != null && !w.model && (() => { try { daxToSql(m.dax, { from: "x", fullTable: w.table, dim: w.dateGrain && w.dimension ? { column: w.dimension, expr: "d" } : undefined, groups: w.dimension && !w.dateGrain ? [`"${w.dimension}"`] : [] }); return <span className="hint">Supported: {DAX_FUNCTIONS.join(", ")}</span>; } catch (x) { return <span className={(x as Error).message.includes("relationship") ? "hint" : "err small"} role="alert">{(x as Error).message}</span>; } })()}<input className="input" aria-label="Measure name" placeholder="Name" value={m.label ?? ""} onChange={(e) => up({ label: e.target.value })} /></div>}</div>; })}</div>
          {(multi || !w.measures.length) && <div style={{ marginTop: 4 }}><Btn icon="plus" disabled={!w.table} onClick={() => set({ measures: [...w.measures, nums[0] ? { column: nums[0], agg: "sum" } : { column: "*", agg: "count" }] })}>Add value</Btn></div>}
        </div>}
        {!["kpi", "gauge", "slicer", "text"].includes(type) && w.dimension && <div className="field"><span className="lab">Drill down</span><span className="hint">Click a value to go to the next field, in the order you tick them.</span><div className="rp-checks">{names.filter((n) => n !== w.dimension).map((n) => <label key={n} className="check small"><input type="checkbox" checked={w.hierarchy?.includes(n) ?? false} onChange={(e) => set({ hierarchy: e.target.checked ? [...(w.hierarchy ?? []), n] : (w.hierarchy ?? []).filter((x) => x !== n) })} />{n}</label>)}</div></div>}
        {["column", "bar", "line", "area", "stacked_column"].includes(type) && w.dimension && !w.series && <div className="field"><span className="lab">Add to tooltip</span><div className="rp-checks">{nums.filter((n) => !w.measures.some((m) => m.column === n)).map((n) => <label key={n} className="check small"><input type="checkbox" checked={w.tips?.some((t) => t.column === n) ?? false} onChange={(e) => set({ tips: e.target.checked ? [...(w.tips ?? []), { column: n, agg: "sum" }] : (w.tips ?? []).filter((t) => t.column !== n) })} />Total {n}</label>)}</div></div>}
        {["column", "bar", "line", "area", "table"].includes(type) && w.dimension && <Field label="Show value as"><Sel options={[["", "The value"], ...(w.model ? [] : [["pct_total", "Percent of total"] as [string, string]]), ["running", "Running total"], ["change", "Change from previous"]]} value={w.calc ?? ""} onChange={(v) => set({ calc: (v || undefined) as Widget["calc"] })} /></Field>}
        {["table", "matrix", "kpi"].includes(type) && <div className="field"><span className="lab">Conditional formatting</span><Sel aria-label="Conditional formatting" options={[["none", "None"], ...(type === "kpi" ? [] : [["scale", "Color scale"], ["bars", "Data bars"]] as [string, string][]), ["rules", "Rules"]]} value={w.cf?.mode ?? "none"} onChange={(v) => set({ cf: { rules: w.cf?.rules ?? [], mode: v as CfRule["mode"] } })} />
          {w.cf?.mode === "rules" && <div style={{ display: "grid", gap: 4, marginTop: 4 }}>{(w.cf.rules ?? []).map((r, i) => { const upR = (p: Partial<typeof r>) => set({ cf: { ...w.cf!, rules: w.cf!.rules!.map((x, k) => (k === i ? { ...x, ...p } : x)) } }); return <div key={i} className="rp-rule"><Sel aria-label="When" options={[["gt", "Above"], ["lt", "Below"]]} value={r.op} onChange={(v) => upR({ op: v as "gt" })} /><input className="input" type="number" aria-label="Value" value={r.value} onChange={(e) => upR({ value: Number(e.target.value) })} /><Sel aria-label="Color" options={[["good", "Green"], ["warn", "Amber"], ["bad", "Red"]]} value={r.tone} onChange={(v) => upR({ tone: v as "good" })} /><Btn icon="x" variant="ghost" aria-label="Remove rule" onClick={() => set({ cf: { ...w.cf!, rules: w.cf!.rules!.filter((_, k) => k !== i) } })} /></div>; })}<div><Btn icon="plus" onClick={() => set({ cf: { ...w.cf!, rules: [...(w.cf!.rules ?? []), { op: "gt", value: 0, tone: "good" }] } })}>Add rule</Btn></div></div>}</div>}
        <div className="field"><span className="lab">Filters on this visual</span><FilterEditor table={w.table} columns={cols} filters={w.filters} onChange={(f) => set({ filters: f })} /></div>
        {type !== "slicer" && <Field label="Number format"><Sel options={[["number", "Number"], ["currency", "Currency"], ["compact", "Compact currency ($1.2M)"], ["percent", "Percent"]]} value={w.format ?? "number"} onChange={(v) => set({ format: v as Widget["format"] })} /></Field>}
        {type === "kpi" && <Field label="Show a trend using" hint="Adds a 12-month line and the change on the month before"><Sel options={[["", "No trend"], ...names.filter((n) => /DATE|TIMESTAMP/i.test(cols.find((c) => c.name === n)?.type ?? "")).map((n): [string, string] => [n, n])]} value={w.trendDate ?? ""} onChange={(v) => set({ trendDate: v || undefined })} /></Field>}
        {type === "gauge" && <Field label="Target"><input className="input" type="number" value={w.target ?? ""} onChange={(e) => set({ target: Number(e.target.value) || undefined })} /></Field>}
        {!["kpi", "gauge", "slicer", "table"].includes(type) && <>
          {!w.dateGrain && <div className="form-row"><Field label="Sort"><Sel options={[["value_desc", "Highest first"], ["value_asc", "Lowest first"], ["label", "By label"]]} value={w.sort ?? "value_desc"} onChange={(v) => set({ sort: v as Widget["sort"] })} /></Field><Field label="Show top"><input className="input" type="number" min={1} max={500} value={w.limit ?? 50} onChange={(e) => set({ limit: Math.min(500, Math.max(1, Number(e.target.value) || 50)) })} /></Field></div>}
          <Field label="When someone clicks a value" hint="Time-based charts can't be clicked through."><Sel options={[["", "Filter this dashboard"], ["rows", "Show the rows behind it"], ...dashboards.filter((x) => !x.widgets.some((y) => y.id === w.id)).map((x): [string, string] => [x.id, `Open ${x.name}`])]} value={w.drillTo ?? ""} onChange={(v) => set({ drillTo: v || undefined })} /></Field>
          <label className="check"><input type="checkbox" checked={!!w.showLabels} onChange={(e) => set({ showLabels: e.target.checked })} />Show data labels</label>
          <label className="check"><input type="checkbox" checked={w.showLegend !== false} onChange={(e) => set({ showLegend: e.target.checked })} />Show legend</label>
        </>}
      </>}
      <Btn variant="danger" icon="trash" onClick={onDelete}>Delete visual</Btn>
    </aside>
  );
}

function Board({ id }: { id: string }) {
  const { config, patch, can } = useApp(), pre = useSearchParams(), router = useRouter(), sem = useSem();
  const d = config!.dashboards.find((x) => x.id === id);
  const [edit, setEdit] = useState(pre.get("edit") === "1"), [sel, setSel] = useState<string | null>(null), [slicers, setSlicers] = useState<Record<string, string[]>>({}), [cross, setCross] = useState<{ widget: string; column: string; value: string } | null>(() => { const c = pre.get("column"), v = pre.get("value"); return c && v ? { widget: "drill", column: c, value: v } : null; }), [refreshKey, setRefreshKey] = useState(0);
  const box = useRef<HTMLDivElement>(null), [width, setWidth] = useState(1000), [drag, setDrag] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null);
  const tables = useTables();
  const [pageId, setPageId] = useState(""), [drills, setDrills] = useState<Record<string, string[]>>({}), [paramVals, setParamVals] = useState<Record<string, number>>({}), [bmName, setBmName] = useState(""), [mz, setMz] = useState({ name: "", dax: "" }), [asking, setAsking] = useState(false), [question, setQuestion] = useState(""), [subOpen, setSubOpen] = useState(false), [marks, setMarks] = useState(false), [rel, setRel] = useState({ fromTable: "", fromCol: "", toTable: "", toCol: "" }), [pm, setPm] = useState({ name: "", min: "0", max: "100", step: "1", value: "50" });
  const [paramDraft, setParamDraft] = useState<Record<string, number>>({});
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setWidth(el.clientWidth)); ro.observe(el); setWidth(el.clientWidth); return () => ro.disconnect(); }, [d?.id, edit]);
  const [sheet, setSheet] = useState<string | null>(null), { notes, reload } = useTileNotes(d?.id);
  useLiveFeed((d?.widgets ?? []).flatMap((w) => (w.model ? (config!.semantic?.tables ?? []).map((t) => t.full) : tablesOf(w))));
  if (!d) return <Empty icon="chart" title={can("editor") ? "This dashboard no longer exists" : "This dashboard isn't available to you"} action={<Link className="btn primary" href="/dashboards">All dashboards</Link>}>Choose another dashboard from the list.</Empty>;
  const upD = (p: Partial<Dashboard>) => patch((c) => ({ ...c, dashboards: c.dashboards.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
  const upW = (wid: string, p: Partial<Widget>) => upD({ widgets: d.widgets.map((w) => (w.id === wid ? { ...w, ...p } : w)) });
  const cw = (width - GAP * (COLS - 1)) / COLS;
  const px = (w: { x: number; y: number; w: number; h: number }) => ({ left: w.x * (cw + GAP), top: w.y * (ROW + GAP), width: w.w * cw + (w.w - 1) * GAP, height: w.h * ROW + (w.h - 1) * GAP });
  const pages = d.pages?.length ? d.pages : [{ id: "p1", name: "Page 1" }], page = pages.find((x) => x.id === pageId) ?? pages[0], onPage = d.widgets.filter((w) => (w.page ?? pages[0].id) === page.id);
  const arranged = arrange(onPage.map((w) => (drag?.id === w.id ? { ...w, ...drag } : w)), drag?.id), layout = (w: Widget) => arranged.find((x) => x.id === w.id) ?? w;
  const bottom = arranged.reduce((n, w) => Math.max(n, w.y + w.h), 0);
  const addWidget = (t: VisualType = "column") => { const nw: Widget = { id: uid(), title: "New visual", type: t, x: 0, y: bottom, w: 6, h: 6, ...(isModelled(config!.semantic) ? { model: true, table: config!.semantic!.tables[0].full } : { table: tables?.find((x) => x.schema === "analytics")?.full ?? "" }), measures: [], filters: [], showLegend: true, page: page.id }; upD({ widgets: [...d.widgets, nw] }); setSel(nw.id); };

  const startMove = (e: React.PointerEvent, w: Widget, mode: "move" | "size") => {
    if (!edit) return;
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY; let cur = { id: w.id, x: w.x, y: w.y, w: w.w, h: w.h };
    const stepX = cw + GAP, stepY = ROW + GAP;
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - x0) / stepX), dy = Math.round((ev.clientY - y0) / stepY);
      cur = mode === "move" ? { ...cur, x: Math.max(0, Math.min(COLS - w.w, w.x + dx)), y: Math.max(0, w.y + dy) } : { ...cur, w: Math.max(2, Math.min(COLS - w.x, w.w + dx)), h: Math.max(2, w.h + dy) };
      setDrag(cur);
    };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); setDrag(null); if (cur.x !== w.x || cur.y !== w.y || cur.w !== w.w || cur.h !== w.h) { const moved = arrange(onPage.map((x) => (x.id === w.id ? { ...x, ...cur } : x)), w.id); upD({ widgets: d.widgets.map((x) => moved.find((y) => y.id === x.id) ?? x) }); } };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
    setSel(w.id);
  };
  // filters apply wherever the column exists, so one slicer can drive visuals on different tables
  const hasCol = (w: Widget, c: string) => columnsOf(tables, w.table).some((x) => x.name === c);
  const slicerFilters = slicerFiltersOf(onPage, slicers);
  const extraFor = (w: Widget): Filter[] => filtersFor(d, w, hasCol, slicerFilters, cross);
  const namedMeasures = Object.fromEntries((d.measures ?? []).map((m) => [m.name, m.dax]));
  const themed = (w: Widget): Widget => ({ ...w, palette: THEMES[d.theme ?? "default"], daxMeasures: namedMeasures, rels: d.relationships, semantic: w.model ? sem : undefined });
  const asked = question.trim() && tables ? answer(question, tables) : null;
  const paramValues = Object.fromEntries((d.params ?? []).map((p) => [p.name, paramVals[p.name] ?? p.value]));
  const saveBookmark = () => { if (!bmName.trim()) return; const b: ReportBookmark = { id: uid(), name: bmName.trim(), page: page.id, slicers, cross, drills, params: paramValues }; upD({ bookmarks: [...(d.bookmarks ?? []), b] }); setBmName(""); toast("Bookmark saved"); };
  const applyBookmark = (b: ReportBookmark) => { setPageId(b.page); setSlicers(b.slicers); setCross(b.cross); setDrills(b.drills); setParamVals(b.params); };
  const addPage = () => { const id = uid(), n = { id, name: `Page ${pages.length + 1}` }; upD({ pages: [...pages, n] }); setPageId(id); };
  const delPage = () => { const first = pages.find((x) => x.id !== page.id)!; upD({ pages: pages.filter((x) => x.id !== page.id), widgets: d.widgets.map((w) => ((w.page ?? pages[0].id) === page.id ? { ...w, page: first.id, y: w.y + 1000 } : { ...w, page: w.page ?? pages[0].id })) }); setPageId(first.id); toast(`Moved its visuals to ${first.name}`); };
  const tableOpts = (tables ?? []).map((t): [string, string] => [t.full, t.full]), colOpts = (t: string) => columnsOf(tables, t).map((c): [string, string] => [c.name, c.name]);
  const allColumns = [...new Map(d.widgets.flatMap((w) => columnsOf(tables, w.table)).map((c) => [c.name, c])).values()];
  const selected = d.widgets.find((w) => w.id === sel);
  const activeCount = d.filters.length + slicerFilters.length + (cross ? 1 : 0);

  return (
    <div className="fill" style={{ flexDirection: "row" }}>
      <div style={{ flex: 1, minWidth: 0, overflow: "auto" }} className={`report-scroll ${edit ? "editing" : ""}`} key={refreshKey}>
        <header className="page-head"><div>{edit ? <input className="input" aria-label="Dashboard name" style={{ fontWeight: 600, width: "min(420px, 100%)" }} value={d.name} onChange={(e) => upD({ name: e.target.value })} /> : <h1>{d.name}</h1>}</div>
          <div className="actions">
            <LiveControl />
            <Btn icon="search" onClick={() => setAsking(true)}>Ask</Btn>
            {edit && <Sel aria-label="Report theme" options={[["default", "Theme: Standard"], ["warm", "Theme: Warm"], ["green", "Theme: Green"]]} value={d.theme ?? "default"} onChange={(v) => upD({ theme: v })} />}
                        {edit && <Pop width={420} align="right" trigger={(_, t) => <Btn icon="lineage" onClick={t}>Model</Btn>}><div className="rp-pop">
              <h3>Relationships</h3><p className="muted small">Connect two tables, and slicers on one filter the other.</p>
              {d.relationships?.map((r) => <div key={r.id} className="rp-line small"><span className="mono">{r.fromTable}.{r.fromCol} to {r.toTable}.{r.toCol}</span><Btn icon="x" variant="ghost" aria-label="Remove relationship" onClick={() => upD({ relationships: d.relationships!.filter((x) => x.id !== r.id) })} /></div>)}
              <div className="form-row"><Sel aria-label="From table" options={[["", "From table"], ...tableOpts]} value={rel.fromTable} onChange={(v) => setRel({ ...rel, fromTable: v, fromCol: "" })} /><Sel aria-label="From field" options={[["", "Field"], ...colOpts(rel.fromTable)]} value={rel.fromCol} onChange={(v) => setRel({ ...rel, fromCol: v })} /><Sel aria-label="To table" options={[["", "To table"], ...tableOpts]} value={rel.toTable} onChange={(v) => setRel({ ...rel, toTable: v, toCol: "" })} /><Sel aria-label="To field" options={[["", "Field"], ...colOpts(rel.toTable)]} value={rel.toCol} onChange={(v) => setRel({ ...rel, toCol: v })} /></div>
              <div><Btn disabled={!rel.fromCol || !rel.toCol} onClick={() => { upD({ relationships: [...(d.relationships ?? []), { id: uid(), ...rel }] }); setRel({ fromTable: "", fromCol: "", toTable: "", toCol: "" }); }}>Add relationship</Btn></div>
              <h3>Measures</h3><p className="muted small">Named DAX measures for this report. Use them in any custom measure as [Name].</p>
              {d.measures?.map((x) => <div key={x.id} className="rp-line small"><span className="mono">[{x.name}] = {x.dax}</span><Btn icon="x" variant="ghost" aria-label={`Remove ${x.name}`} onClick={() => upD({ measures: d.measures!.filter((y) => y.id !== x.id) })} /></div>)}
              <div className="form-row"><input className="input" aria-label="Measure name" placeholder="Name, such as Sales" value={mz.name} onChange={(e) => setMz({ ...mz, name: e.target.value })} /><input className="input mono" aria-label="Measure DAX" placeholder="SUM(Orders[amount])" value={mz.dax} onChange={(e) => setMz({ ...mz, dax: e.target.value })} /></div>
              <div><Btn disabled={!mz.name.trim() || !mz.dax.trim()} onClick={() => { upD({ measures: [...(d.measures ?? []), { id: uid(), name: mz.name.trim(), dax: mz.dax }] }); setMz({ name: "", dax: "" }); }}>Add measure</Btn></div>
              <h3>What-if parameters</h3><p className="muted small">Adds a slider. Use {"{{name}}"} in a custom measure.</p>
              {d.params?.map((x) => <div key={x.id} className="rp-line small"><span className="mono">{x.name}: {x.min} to {x.max}</span><Btn icon="x" variant="ghost" aria-label={`Remove ${x.name}`} onClick={() => upD({ params: d.params!.filter((y) => y.id !== x.id) })} /></div>)}
              <div className="form-row"><input className="input" aria-label="Parameter name" placeholder="Name, such as growth" value={pm.name} onChange={(e) => setPm({ ...pm, name: e.target.value.replace(/\W/g, "_") })} /><input className="input" type="number" aria-label="Lowest" placeholder="Lowest" value={pm.min} onChange={(e) => setPm({ ...pm, min: e.target.value })} /><input className="input" type="number" aria-label="Highest" placeholder="Highest" value={pm.max} onChange={(e) => setPm({ ...pm, max: e.target.value })} /><input className="input" type="number" aria-label="Start at" placeholder="Start at" value={pm.value} onChange={(e) => setPm({ ...pm, value: e.target.value })} /></div>
              <div><Btn disabled={!pm.name || Number(pm.max) <= Number(pm.min)} onClick={() => { upD({ params: [...(d.params ?? []), { id: uid(), name: pm.name, min: Number(pm.min), max: Number(pm.max), step: Number(pm.step) || 1, value: Number(pm.value) }] }); setPm({ name: "", min: "0", max: "100", step: "1", value: "50" }); }}>Add parameter</Btn></div>
            </div></Pop>}
            <Pop width={520} align="right" trigger={(_, t) => <Btn icon="filter" variant={d.filters.length ? "on" : undefined} onClick={t}>Page filters{d.filters.length ? ` (${d.filters.length})` : ""}</Btn>}><FilterEditor columns={allColumns} filters={d.filters} onChange={(f) => upD({ filters: f })} /></Pop>
            {can("editor") && !edit && <Btn icon="edit" className="report-edit-btn" onClick={() => setEdit(true)}>Edit</Btn>}
            {can("editor") && edit && <><Btn icon="plus" onClick={() => addWidget()}>Add visual</Btn><Btn variant="primary" onClick={() => { setEdit(false); setSel(null); toast("Dashboard saved"); }}>Done</Btn></>}
            <MoreMenu width={280}>{(close) => <>
              <button onClick={() => { close(); setRefreshKey((k) => k + 1); }}><Icon name="refresh" />Refresh data</button>
              <button onClick={() => { close(); setMarks(true); }}><Icon name="save" />Bookmarks{d.bookmarks?.length ? ` (${d.bookmarks.length})` : ""}</button>
              <button onClick={() => { close(); setSubOpen(true); }}><Icon name="bell" />Subscribe</button>
              <hr />
              <button onClick={() => { close(); setTimeout(() => window.print(), 100); }}><Icon name="download" />Print or save as PDF</button>
              <button onClick={() => { close(); tilesPng([...(box.current?.querySelectorAll<HTMLElement>(".tile") ?? [])], `${d.name} - ${page.name}`).catch((e) => toast(e.message, true)); }}>This page as PNG</button>
              <button onClick={() => { close(); download(`${d.name}.json`, JSON.stringify(d, null, 2), "application/json"); }}>Dashboard definition (JSON)</button>
              {d.widgets.filter((w) => widgetSql(themed(w), extraFor(w)) && w.type !== "slicer").map((w) => <button key={w.id} onClick={async () => { close(); try { const { sql } = await import("@/lib/client"); const r = await sql(withParams(widgetSql(themed(w), extraFor(w))!, paramValues), 100000); download(`${w.title}.csv`, toCsv(r)); } catch (e) { toast((e as Error).message, true); } }}>{w.title} (CSV)</button>)}
            </>}</MoreMenu>
          </div></header>
        {activeCount > 0 && <div className="toolbar small"><span className="muted">Active:</span>
          {d.filters.map((f) => <span key={f.id} className="badge info">{f.column}: {f.value || f.op}</span>)}
          {slicerFilters.map((s) => <span key={s.from} className="badge info">{s.column}: {s.f.values!.join(", ")}</span>)}
          {cross && <span className="badge info">{cross.column}: {cross.value}<button className="link" aria-label="Clear chart selection" onClick={() => setCross(null)}><Icon name="x" size={11} /></button></span>}
          <button className="link" onClick={() => { setSlicers({}); setCross(null); upD({ filters: [] }); }}>Clear all</button>
        </div>}
        {!!d.params?.length && <div className="rp-params">{d.params.map((x) => <label key={x.id}><span>{prettyField(x.name)}: <b>{paramDraft[x.name] ?? paramValues[x.name]}</b></span><input type="range" min={x.min} max={x.max} step={x.step} value={paramDraft[x.name] ?? paramValues[x.name]} onChange={(e) => setParamDraft({ [x.name]: Number(e.target.value) })} ref={(el) => {
          // React's onChange is really the input event; the native change event is what fires on release, for mouse, touch and keys
          const commit = () => { setParamVals({ ...paramVals, [x.name]: Number(el!.value) }); setParamDraft({}); };
          el?.addEventListener("change", commit);
          return () => el?.removeEventListener("change", commit);
        }} /></label>)}</div>}
        {!onPage.length ? <Empty icon="chart" title={d.widgets.length ? "This page is empty" : "This dashboard is empty"} editor action={<Btn variant="primary" icon="plus" onClick={() => { setEdit(true); addWidget(); }}>Add a visual</Btn>}>Add a chart, a number, a table or a slicer.</Empty> : (
          <div className={`board ${drag ? "dragging" : ""}`} ref={box} style={{ height: bottom * (ROW + GAP) }}>
            {[...onPage].sort((a, b) => a.y - b.y || a.x - b.x).map((w) => {
              const pos = px(layout(w));
              return (
                <section key={w.id} className={`tile ${w.id === sel && edit ? "selected" : ""} ${w.type === "kpi" || w.type === "slicer" ? "short" : ""}`} style={pos} aria-label={w.title} data-tile={w.id} onClick={() => edit && setSel(w.id)}>
                  <div className="tile-head" onPointerDown={(e) => startMove(e, w, "move")}><h3>{w.title}</h3>{w.pinnedFrom && !edit && config!.dashboards.some((x) => x.id === w.pinnedFrom!.dashboard) && <Link className="tile-source" href={`/dashboards/${w.pinnedFrom.dashboard}`} title={`Open ${w.pinnedFrom.name}`} aria-label={`Open ${w.pinnedFrom.name}`}><Icon name="link" size={15} /></Link>}{!edit && <TileMarks w={w} notes={notes} onOpen={() => setSheet(w.id)} />}{edit && <Btn variant="ghost" icon="settings" aria-label={`Edit ${w.title}`} onClick={(e) => { e.stopPropagation(); setSel(w.id); }} onPointerDown={(e) => e.stopPropagation()} />}</div>
                  {(drills[w.id]?.length ?? 0) > 0 && <div className="rp-crumb"><button type="button" className="link" onClick={() => setDrills({ ...drills, [w.id]: drills[w.id].slice(0, -1) })}>Up</button><span className="small muted">{drills[w.id].join(" / ")}</span></div>}
                  <div className="tile-body"><Tile w={themed(w)} path={drills[w.id]} values={paramValues} extra={extraFor(w)} slicerValue={slicers[w.id]} onSlicer={(v) => setSlicers({ ...slicers, [w.id]: v })} onPick={(val) => { if (!w.dimension || edit) return; const depth = drills[w.id]?.length ?? 0, levels = levelsOf(w); if (depth < levels.length - 1) { setDrills({ ...drills, [w.id]: [...(drills[w.id] ?? []), val] }); return; } if (w.dateGrain) return; if (w.drillTo) { const q = `column=${encodeURIComponent(w.dimension)}&value=${encodeURIComponent(val)}`; router.push(w.drillTo === "rows" ? `/explore?table=${encodeURIComponent(w.table)}&${q}` : `/dashboards/${w.drillTo}?${q}`); return; } setCross(cross?.widget === w.id && cross.value === val ? null : { widget: w.id, column: w.dimension, value: val }); }} /></div>
                  {edit && <span className="resize" aria-hidden="true" onPointerDown={(e) => startMove(e, w, "size")} />}
                </section>
              );
            })}
          </div>
        )}
        <nav className="rp-tabs" aria-label="Report pages">{pages.map((x) => <span key={x.id} className={x.id === page.id ? "on" : ""}>{edit && x.id === page.id ? <input className="input" aria-label="Page name" value={x.name} onChange={(e) => upD({ pages: pages.map((y) => (y.id === x.id ? { ...y, name: e.target.value } : y)) })} /> : <button type="button" aria-current={x.id === page.id ? "page" : undefined} onClick={() => { setPageId(x.id); setSel(null); }}>{x.name}</button>}{edit && x.id === page.id && pages.length > 1 && <Btn icon="x" variant="ghost" aria-label={`Delete ${x.name}`} onClick={delPage} />}</span>)}{edit && <Btn icon="plus" variant="ghost" aria-label="Add a page" onClick={addPage} />}</nav>
      </div>
      {asking && <Modal sheet title="Ask a question" onClose={() => setAsking(false)}>
        <Field label="Your question" hint="Such as: total amount by city, average rating by kitchen, top 5 kitchens by revenue, orders by month, count orders where status is delivered"><input className="input" autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} /></Field>
        {asked && "error" in asked && <div className="banner warn" role="status"><Icon name="info" />{asked.error}</div>}
        {asked && !("error" in asked) && <><p className="small muted">{asked.title}, from {asked.table}</p><div className="rp-answer"><Tile w={themed({ id: "ask", x: 0, y: 0, w: 6, h: 6, showLegend: false, ...asked })} values={paramValues} extra={[]} onSlicer={() => {}} onPick={() => {}} /></div>{can("editor") && <div><Btn variant="primary" icon="plus" onClick={() => { const nw: Widget = { id: uid(), x: 0, y: bottom, w: 6, h: asked.type === "kpi" ? 3 : 7, showLegend: false, page: page.id, ...asked }; upD({ widgets: [...d.widgets, nw] }); setAsking(false); setQuestion(""); toast("Added to this page"); }}>Add to this page</Btn></div>}</>}
      </Modal>}
      {marks && <Modal sheet title="Bookmarks" onClose={() => setMarks(false)}><div className="rp-pop" style={{ padding: 0 }}>{!d.bookmarks?.length && <p className="muted small">Save the current page, slicers and drill position to come back to them.</p>}
              {d.bookmarks?.map((b) => <div key={b.id} className="rp-line"><button type="button" onClick={() => { setMarks(false); applyBookmark(b); }}>{b.name}</button>{can("editor") && <Btn icon="x" variant="ghost" aria-label={`Delete ${b.name}`} onClick={() => upD({ bookmarks: d.bookmarks!.filter((x) => x.id !== b.id) })} />}</div>)}
              {can("editor") && <div className="rp-line"><input className="input" aria-label="Bookmark name" placeholder="Name this view" value={bmName} onChange={(e) => setBmName(e.target.value)} /><Btn disabled={!bmName.trim()} onClick={saveBookmark}>Save</Btn></div>}</div></Modal>}
      {(() => { const open = d.widgets.find((w) => w.id === sheet); return open ? <TileSheet d={d} w={themed(open)} extra={extraFor(open)} values={paramValues} notes={notes} reload={reload} pageFilters={d.filters.filter((f) => hasCol(open, f.column))} onClose={() => setSheet(null)} /> : null; })()}
      {subOpen && <SubscribeSheet dashboard={d.id} name={d.name} onClose={() => setSubOpen(false)} />}
      {edit && selected && <Editor w={selected} set={(p) => upW(selected.id, p)} onClose={() => setSel(null)} onDelete={() => { upD({ widgets: d.widgets.filter((x) => x.id !== selected.id) }); setSel(null); }} />}
    </div>
  );
}
function SubscribeSheet({ dashboard, name, onClose }: { dashboard: string; name: string; onClose: () => void }) {
  const [state, setState] = useState<{ mail: boolean; subscription: { every: number; lastError?: string } | null } | null>(null), [every, setEvery] = useState("168"), [busy, setBusy] = useState(false);
  const load = () => call<{ mail: boolean; subscription: { every: number; lastError?: string } | null }>(`/api/subscriptions?dashboard=${encodeURIComponent(dashboard)}`).then((r) => { setState(r); if (r.subscription) setEvery(String(r.subscription.every)); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  const save = async (send: boolean) => { setBusy(true); try { await call("/api/subscriptions", { json: { dashboard, every: Number(every), send } }); toast(send ? "Subscribed. A first copy is on its way." : "Subscribed"); await load(); } catch (e) { toast((e as Error).message, true); } setBusy(false); };
  return <Modal sheet title={`Subscribe to ${name}`} onClose={onClose}>
    {!state ? <Sk h={80} /> : !state.mail ? <div className="banner info"><Icon name="info" /><span>An admin needs to set up an email server in Settings before reports can be sent.</span></div> : <>
      <p className="small muted">Reports go to your own email and show only what your access allows. Time-based charts appear in the app, not the email.</p>
      <Field label="Send this report"><Sel options={[["24", "Every day"], ["168", "Every week"], ["720", "Every 30 days"]]} value={every} onChange={setEvery} /></Field>
      {state.subscription?.lastError && <div className="banner bad"><Icon name="warn" />{state.subscription.lastError}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><Btn variant="primary" disabled={busy} onClick={() => save(true)}>{state.subscription ? "Save and send a copy" : "Subscribe and send a copy"}</Btn>{state.subscription && <Btn disabled={busy} onClick={async () => { await call("/api/subscriptions", { json: { dashboard, action: "off" } }); toast("Unsubscribed"); await load(); }}>Unsubscribe</Btn>}</div>
    </>}
  </Modal>;
}
export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <Suspense><Board id={id} /></Suspense>; }
