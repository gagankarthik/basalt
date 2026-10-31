"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { LiveControl } from "@/components/LiveStatus";
import { Tile, THEMES } from "@/components/ReportTile";
import { TileMarks, TileSheet, useTileNotes } from "@/components/TileSheet";
import { Btn, Empty, Pop, toast } from "@/components/ui";
import type { AppItem } from "@/lib/apps";
import { columnsOf, useApp, useTables, useSem } from "@/lib/client";
import { useLiveFeed } from "@/lib/liveClient";
import { arrange } from "@/lib/layout";
import { filtersFor, levelsOf, slicerFiltersOf, tablesOf, type CrossFilter } from "@/lib/report";
import { prettyField } from "@/lib/sql";
import { tilesPng } from "@/lib/tilePng";
import type { Dashboard, Widget } from "@/lib/types";

const COLS = 12, ROW = 34, GAP = 8;

/** The reading view of a published dashboard: it can be filtered and drilled but not changed, and only reaches pages this person can see. */
export function ReportView({ d, app, items, title }: { d: Dashboard; app: string; items: AppItem[]; title: string }) {
  const pre = useSearchParams(), router = useRouter(), tables = useTables();
  const box = useRef<HTMLDivElement>(null), [width, setWidth] = useState(1000), [refreshKey, setRefreshKey] = useState(0), [sheet, setSheet] = useState<string | null>(null);
  const [pageId, setPageId] = useState(""), [slicers, setSlicers] = useState<Record<string, string[]>>({}), [drills, setDrills] = useState<Record<string, string[]>>({}), [paramVals, setParamVals] = useState<Record<string, number>>({});
  const [cross, setCross] = useState<CrossFilter>(() => { const c = pre.get("column"), v = pre.get("value"); return c && v ? { widget: "drill", column: c, value: v } : null; });
  const { notes, reload } = useTileNotes(d.id, app), semanticTables = useApp((s) => s.config?.semantic?.tables);
  // Events carry only table names. The rows are read again through /api/sql, with this person's row rules
  useLiveFeed(d.widgets.flatMap((w) => (w.model ? (semanticTables ?? []).map((t) => t.full) : tablesOf(w))));
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setWidth(el.clientWidth)); ro.observe(el); setWidth(el.clientWidth); return () => ro.disconnect(); }, [pageId]);

  const pages = d.pages?.length ? d.pages : [{ id: "p1", name: "Page 1" }], page = pages.find((x) => x.id === pageId) ?? pages[0], onPage = d.widgets.filter((w) => (w.page ?? pages[0].id) === page.id);
  const placed = arrange(onPage), bottom = placed.reduce((n, w) => Math.max(n, w.y + w.h), 0), cw = (width - GAP * (COLS - 1)) / COLS;
  const sem = useSem();
  const hasCol = (w: Widget, c: string) => columnsOf(tables, w.table).some((x) => x.name === c);
  const slicerFilters = slicerFiltersOf(onPage, slicers), extraFor = (w: Widget) => filtersFor(d, w, hasCol, slicerFilters, cross);
  const measures = Object.fromEntries((d.measures ?? []).map((m) => [m.name, m.dax]));
  const themed = (w: Widget): Widget => ({ ...w, palette: THEMES[d.theme ?? "default"], daxMeasures: measures, rels: d.relationships, semantic: w.model ? sem : undefined });
  const values = Object.fromEntries((d.params ?? []).map((p) => [p.name, paramVals[p.name] ?? p.value]));
  // A target outside this person's audience isn't in their list, so the click falls back to filtering this page
  const pageOf = (dashboard: string) => items.find((i) => i.kind === "dashboard" && i.dashboard === dashboard);
  const pick = (w: Widget, val: string) => {
    if (!w.dimension) return;
    const depth = drills[w.id]?.length ?? 0;
    if (depth < levelsOf(w).length - 1) { setDrills({ ...drills, [w.id]: [...(drills[w.id] ?? []), val] }); return; }
    if (w.dateGrain) return;
    const q = `column=${encodeURIComponent(w.dimension)}&value=${encodeURIComponent(val)}`, to = w.drillTo && w.drillTo !== "rows" ? pageOf(w.drillTo) : undefined;
    if (w.drillTo === "rows") { router.push(`/explore?table=${encodeURIComponent(w.table)}&${q}`); return; }
    if (to) { router.push(`/apps/${app}?page=${to.id}&${q}`); return; }
    setCross(cross?.widget === w.id && cross.value === val ? null : { widget: w.id, column: w.dimension, value: val });
  };
  const open = d.widgets.find((w) => w.id === sheet);

  return <div className="app-main report-scroll" key={refreshKey}>
    <header className="page-head"><div><h1>{title}</h1></div><div className="actions">
      <LiveControl />
      {!!d.bookmarks?.length && <Pop width={260} align="right" trigger={(_, t) => <Btn icon="save" onClick={t}>Bookmarks</Btn>}>{(close) => <div className="rp-pop">{d.bookmarks!.map((b) => <div key={b.id} className="rp-line"><button type="button" onClick={() => { close(); setPageId(b.page); setSlicers(b.slicers); setCross(b.cross); setDrills(b.drills); setParamVals(b.params); }}>{b.name}</button></div>)}</div>}</Pop>}
      <Btn icon="refresh" aria-label="Refresh data" onClick={() => setRefreshKey((k) => k + 1)} />
      <Pop align="right" trigger={(_, t) => <Btn icon="download" aria-label="Export" onClick={t} />}>{(close) => <div className="menu">
        <button onClick={() => { close(); setTimeout(() => window.print(), 100); }}>Print or save as PDF</button>
        <button onClick={() => { close(); tilesPng([...(box.current?.querySelectorAll<HTMLElement>(".tile") ?? [])], title).catch((e) => toast(e.message, true)); }}>This page as PNG</button>
      </div>}</Pop>
    </div></header>
    {(slicerFilters.length > 0 || cross) && <div className="toolbar small"><span className="muted">Active:</span>
      {slicerFilters.map((s) => <span key={s.from} className="badge info">{s.column}: {s.f.values!.join(", ")}</span>)}
      {cross && <span className="badge info">{cross.column}: {cross.value}</span>}
      <button className="link" onClick={() => { setSlicers({}); setCross(null); }}>Clear all</button>
    </div>}
    {!!d.params?.length && <div className="rp-params">{d.params.map((x) => <label key={x.id}><span>{prettyField(x.name)}: <b>{values[x.name]}</b></span><input type="range" min={x.min} max={x.max} step={x.step} value={values[x.name]} onChange={(e) => setParamVals({ ...paramVals, [x.name]: Number(e.target.value) })} /></label>)}</div>}
    {!onPage.length ? <Empty icon="chart" title="This page is empty">The author hasn&apos;t added anything to this page yet.</Empty> : <div className="board" ref={box} style={{ height: bottom * (ROW + GAP) }}>
      {[...placed].sort((a, b) => a.y - b.y || a.x - b.x).map((w) => {
        const src = w.pinnedFrom && pageOf(w.pinnedFrom.dashboard);
        return <section key={w.id} className={`tile ${w.type === "kpi" || w.type === "slicer" ? "short" : ""}`} aria-label={w.title} data-tile={w.id} style={{ left: w.x * (cw + GAP), top: w.y * (ROW + GAP), width: w.w * cw + (w.w - 1) * GAP, height: w.h * ROW + (w.h - 1) * GAP }}>
          <div className="tile-head"><h3>{w.title}</h3>{src && <Link className="tile-source" href={`/apps/${app}?page=${src.id}`} title={`Open ${w.pinnedFrom!.name}`} aria-label={`Open ${w.pinnedFrom!.name}`}><Icon name="link" size={15} /></Link>}<TileMarks w={w} notes={notes} onOpen={() => setSheet(w.id)} /></div>
          {(drills[w.id]?.length ?? 0) > 0 && <div className="rp-crumb"><button type="button" className="link" onClick={() => setDrills({ ...drills, [w.id]: drills[w.id].slice(0, -1) })}>Up</button><span className="small muted">{drills[w.id].join(" / ")}</span></div>}
          <div className="tile-body"><Tile w={themed(w)} path={drills[w.id]} values={values} extra={extraFor(w)} slicerValue={slicers[w.id]} onSlicer={(v) => setSlicers({ ...slicers, [w.id]: v })} onPick={(v) => pick(w, v)} /></div>
        </section>;
      })}
    </div>}
    {pages.length > 1 && <nav className="rp-tabs" aria-label="Report pages">{pages.map((x) => <span key={x.id} className={x.id === page.id ? "on" : ""}><button type="button" aria-current={x.id === page.id ? "page" : undefined} onClick={() => setPageId(x.id)}>{x.name}</button></span>)}</nav>}
    {open && <TileSheet d={d} w={themed(open)} app={app} extra={extraFor(open)} values={values} notes={notes} reload={reload} pageFilters={[]} onClose={() => setSheet(null)} />}
  </div>;
}
