"use client";
import { cellText } from "@/lib/nested";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DataGrid, Cell, type GridCol } from "@/components/DataGrid";
import { formatsFor } from "@/lib/fieldFormat";
import { FilterChip, FilterEditor } from "@/components/FilterEditor";
import { Icon } from "@/components/icons";
import { LiveControl } from "@/components/LiveStatus";
import { useLiveFeed, useLiveQuery, useLiveTick } from "@/lib/liveClient";
import { LoadingTable, MoreMenu, NoResults, Btn, Empty, Field, Modal, PageHead, Pop, Seg, Sel, Sk, toast, Split } from "@/components/ui";
import { download, fmt, sql, uid, useApp, useTables, useNewHandler } from "@/lib/client";
import { kindOf, lit, measureSql, orderSql, prettyField, q, table, toCsv, whereSql } from "@/lib/sql";
import type { Agg, ColorRule, DataView, FilterOp } from "@/lib/types";

const PAGE = 200, DENSITY = { compact: 36, regular: 48, roomy: 64 };
const newView = (tbl: string, name = "Untitled view"): DataView => ({ id: uid(), name, table: tbl, layout: "grid", filters: [], match: "all", sorts: [], hidden: [], widths: {}, frozen: 1, density: "compact", colorRules: [], shared: true });

const KEEP_PAGES = 3;
function useRows(where: string, order: string, tbl: string, enabled: boolean) {
  const [count, setCount] = useState<number | null>(null), [error, setError] = useState(""), [, bump] = useState(0);
  const pages = useRef(new Map<number, Record<string, unknown>[]>()), inflight = useRef(new Set<number>());
  const base = `FROM ${tbl ? table(tbl) : '""'} ${where}`;
  const key = useRef(0);
  useEffect(() => {
    pages.current = new Map(); inflight.current = new Set(); key.current++; setError("");
    if (!enabled) return;
    let live = true; setCount(null);
    sql(`SELECT count(*) AS n ${base}`).then((r) => live && setCount(Number(r.rows[0].n)), (e) => live && setError(e.message));
    return () => { live = false; };
  }, [base, order, enabled]);
  const load = useCallback((start: number, end: number) => {
    for (let p = Math.floor(start / PAGE); p <= Math.floor(end / PAGE) + 1; p++) {
      if (pages.current.has(p) || inflight.current.has(p)) continue;
      inflight.current.add(p);
      const k = key.current;
      sql(`SELECT * ${base} ${order} LIMIT ${PAGE} OFFSET ${p * PAGE}`).then((r) => { if (k === key.current) { pages.current.set(p, r.rows); bump((x) => x + 1); } }, (e) => k === key.current && setError(e.message));
    }
  }, [base, order]);
  // On a change the rows on screen stay until their replacements arrive. Pages further away are dropped and read again when scrolled to.
  const tick = useLiveTick([tbl]);
  const lastTick = useRef(tick);
  useEffect(() => {
    if (tick === lastTick.current || !enabled) return;
    lastTick.current = tick;
    const k = key.current, kept = [...pages.current.keys()].slice(-KEEP_PAGES);
    pages.current = new Map(kept.map((p) => [p, pages.current.get(p)!]));
    sql(`SELECT count(*) AS n ${base}`).then((r) => { if (k === key.current) setCount(Number(r.rows[0].n)); }, (e) => k === key.current && setError(e.message));
    for (const p of kept) sql(`SELECT * ${base} ${order} LIMIT ${PAGE} OFFSET ${p * PAGE}`).then((r) => { if (k === key.current) { pages.current.set(p, r.rows); bump((x) => x + 1); } }, (e) => k === key.current && setError(e.message));
  }, [tick, base, order, enabled]);
  const row = useCallback((i: number) => pages.current.get(Math.floor(i / PAGE))?.[i % PAGE], []);
  return { count, error, load, row, base };
}

function Record({ cols, row, onClose, onFilter }: { cols: GridCol[]; row: Record<string, unknown>; onClose: () => void; onFilter?: (c: string, v: string) => void }) {
  return (
    <aside className="drawer" aria-label="Row details">
      <div className="modal-head"><h2 className="grow">Row details</h2><Btn icon="x" variant="ghost" aria-label="Close" onClick={onClose} /></div>
      <dl className="kv" style={{ padding: 16 }}>{cols.filter((c) => !c.name.startsWith("_rn") && c.name !== "_total").map((c) => <div key={c.name} style={{ display: "contents" }}><dt className="small">{c.label ?? c.name}</dt><dd className="rec-val"><Cell col={c} v={row[c.name]} />{onFilter && row[c.name] != null && typeof row[c.name] !== "object" && <button className="link small" onClick={() => onFilter(c.name, String(row[c.name]))}>Filter to this</button>}</dd></div>)}</dl>
    </aside>
  );
}

const GROUP_PAGE = 100;
function Group({ first, value, n, col, cols, base, order, view, find, menu, onSort }: { first: boolean; value: unknown; n: number; col: GridCol; cols: GridCol[]; base: string; order: string; view: DataView; find: string; menu: (c: GridCol, close: () => void) => React.ReactNode; onSort: (c: string, add: boolean) => void }) {
  // The first group starts open, so a grouped view never looks empty
  const [open, setOpen] = useState(first), g = q(view.groupBy!);
  const cond = value == null ? `${g} IS NULL` : typeof value === "object" ? `CAST(to_json(${g}) AS VARCHAR) = ${lit(JSON.stringify(value))}` : `CAST(${g} AS VARCHAR) = ${lit(String(value))}`;
  const where = /\bWHERE\b/.test(base) ? `${base} AND ${cond}` : `${base} WHERE ${cond}`;
  // A changed filter or sort starts again from the first page
  const query = `${where} ${order}`, [at, setAt] = useState({ query, page: 0 }), page = at.query === query ? at.page : 0, pages = Math.max(1, Math.ceil(n / GROUP_PAGE));
  const { data, error } = useLiveQuery(open ? `SELECT * ${query} LIMIT ${GROUP_PAGE} OFFSET ${page * GROUP_PAGE}` : null, [view.table]);
  const shown = cols.filter((c) => c.name !== view.groupBy);
  return <section className="grp">
    <button className="gr-head" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? "chevDown" : "chevRight"} size={14} /><Cell col={col} v={value} colored={view.colorBy === col.name} /><span className="badge num">{fmt(n)}</span></button>
    {open && (error ? <div className="banner bad" style={{ margin: 8 }}>{error}</div> : !data ? <div style={{ padding: 12 }}><Sk h={60} /></div> : <>
      <div className="grp-table"><DataGrid key={page} bare columns={shown} count={data.rows.length} row={(i) => data.rows[i]} sorts={view.sorts} onSort={onSort} widths={view.widths} frozen={Math.min(view.frozen, 1)} rowH={40} colorRules={view.colorRules} colorBy={view.colorBy} find={find} columnMenu={menu} selectable exportName={view.name} /></div>
      {n > GROUP_PAGE && <div className="grp-pager"><span className="small muted">{fmt(page * GROUP_PAGE + 1)}–{fmt(Math.min(n, (page + 1) * GROUP_PAGE))} of {fmt(n)} rows</span><Btn icon="chevRight" variant="ghost" className="grp-prev" aria-label="Previous page" disabled={page === 0} onClick={() => setAt({ query, page: page - 1 })} /><span className="small">{fmt(page + 1)} / {fmt(pages)}</span><Btn icon="chevRight" variant="ghost" aria-label="Next page" disabled={page >= pages - 1} onClick={() => setAt({ query, page: page + 1 })} /></div>}
    </>)}
  </section>;
}
function GroupedGrid({ view, cols, base, order, labelOf, find, menu, onSort }: { view: DataView; cols: GridCol[]; base: string; order: string; labelOf: (n: string) => string; find: string; menu: (c: GridCol, close: () => void) => React.ReactNode; onSort: (c: string, add: boolean) => void }) {
  const g = q(view.groupBy!);
  const { data, error } = useLiveQuery(`SELECT ${g} AS v, count(*) AS n ${base} GROUP BY 1 ORDER BY 2 DESC LIMIT 200`, [view.table]);
  const col = cols.find((c) => c.name === view.groupBy) ?? { name: view.groupBy!, kind: "text" as const };
  if (error) return <div className="banner bad" style={{ margin: 16 }}>{error}</div>;
  if (!data) return <div style={{ padding: 16 }}><Sk h={200} /></div>;
  return <div className="grs" aria-label={`Grouped by ${labelOf(view.groupBy!)}`}>{data.rows.map((r, i) => <Group key={String(r.v)} first={i === 0} value={r.v} n={Number(r.n)} col={col} cols={cols} base={base} order={order} view={view} find={find} menu={menu} onSort={onSort} />)}{data.rows.length === 200 && <p className="small muted" style={{ padding: 12 }}>Showing the 200 largest groups.</p>}</div>;
}

function Board({ view, cols, base, order, onOpen }: { view: DataView; cols: GridCol[]; base: string; order: string; onOpen: (r: Record<string, unknown>) => void }) {
  const g = view.groupBy;
  const title = view.titleColumn ?? cols.find((c) => c.kind === "text")?.name ?? cols[0]?.name;
  const { data, loading, error } = useLiveQuery(g ? `SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY ${q(g)} ${order}) AS _rn, count(*) OVER (PARTITION BY ${q(g)}) AS _total ${base}) WHERE _rn <= 60` : null, [view.table]);
  if (!g) return <Empty icon="table" title="Choose a column to group by">Open View in the toolbar and pick a column. Each value gets its own lane.</Empty>;
  if (error) return <div className="banner bad" style={{ margin: 16 }}>{error}</div>;
  if (loading || !data) return <div style={{ padding: 16 }}><Sk h={200} /></div>;
  const lanes = new Map<string, Record<string, unknown>[]>();
  data.rows.forEach((r) => { const k = cellText(r[g]) || "(empty)"; if (!lanes.has(k)) lanes.set(k, []); lanes.get(k)!.push(r); });
  const shown = cols.filter((c) => c.name !== title && c.name !== g).slice(0, 4);
  return (
    <div className="lanes">
      {[...lanes.entries()].map(([k, rows]) => <div className="lane" key={k}><div className="lane-head"><span>{k}</span><span className="muted num">{fmt(rows[0]._total)}</span></div>
        {rows.map((r, i) => <button key={i} className="rec" onClick={() => onOpen(r)}><b>{cellText(r[title])}</b>{shown.map((c) => <div key={c.name}><span>{c.label}</span><span><Cell inert col={c} v={r[c.name]} colored={view.colorBy === c.name} /></span></div>)}</button>)}
      </div>)}
    </div>
  );
}

function Gallery({ view, cols, base, order, onOpen }: { view: DataView; cols: GridCol[]; base: string; order: string; onOpen: (r: Record<string, unknown>) => void }) {
  const { data, loading, error } = useLiveQuery(`SELECT * ${base} ${order} LIMIT 120`, [view.table]);
  const title = view.titleColumn ?? cols.find((c) => c.kind === "text")?.name ?? cols[0]?.name;
  if (error) return <div className="banner bad" style={{ margin: 16 }}>{error}</div>;
  if (loading || !data) return <div style={{ padding: 16 }}><Sk h={200} /></div>;
  return <div className="gallery">{data.rows.map((r, i) => <button key={i} className="rec" onClick={() => onOpen(r)}><b>{cellText(r[title])}</b>{cols.filter((c) => c.name !== title).slice(0, 6).map((c) => <div key={c.name}><span>{c.label}</span><span><Cell inert col={c} v={r[c.name]} colored={view.colorBy === c.name} /></span></div>)}</button>)}</div>;
}

function Pivot({ view, cols, where, up }: { view: DataView; cols: GridCol[]; where: string; up: (p: Partial<DataView>) => void }) {
  const row = view.pivotRow, col = view.pivotCol, val = view.pivotValue ?? "*", agg = view.pivotAgg ?? "count";
  const names = cols.map((c) => c.name), nums = cols.filter((c) => c.kind === "number").map((c) => c.name);
  const m = measureSql({ column: val, agg });
  const text = row ? `SELECT ${q(row)} AS r, ${col ? `${q(col)} AS c,` : ""} ${m} AS v FROM ${table(view.table)} ${where} GROUP BY ${col ? "1, 2" : "1"} ORDER BY 1 LIMIT 5000` : null;
  const { data, loading, error } = useLiveQuery(text, [view.table]);
  const { heads, rows, totals, grand } = useMemo(() => {
    const heads = [...new Set((data?.rows ?? []).map((x) => String(x.c ?? "(empty)")))].sort().slice(0, 40), by = new Map<string, Record<string, number>>(), totals: Record<string, number> = {};
    let grand = 0;
    (data?.rows ?? []).forEach((x) => { const r = String(x.r ?? "(empty)"), c = String(x.c ?? "(empty)"), v = Number(x.v) || 0; if (!by.has(r)) by.set(r, {}); by.get(r)![c] = v; totals[c] = (totals[c] ?? 0) + v; grand += v; });
    return { heads, rows: [...by.entries()], totals, grand };
  }, [data]);
  const additive = agg === "sum" || agg === "count";
  return (
    <div className="body" style={{ overflow: "auto" }}>
      <div className="form-row" style={{ maxWidth: 780 }}>
        <Field label="Rows"><Sel options={[["", "Choose a column"], ...names.map((n): [string, string] => [n, n])]} value={row ?? ""} onChange={(v) => up({ pivotRow: v || undefined })} /></Field>
        <Field label="Columns"><Sel options={[["", "None"], ...names.map((n): [string, string] => [n, n])]} value={col ?? ""} onChange={(v) => up({ pivotCol: v || undefined })} /></Field>
        <Field label="Value"><Sel options={[["*", "Row count"], ...nums.map((n): [string, string] => [n, n])]} value={val} onChange={(v) => up({ pivotValue: v, pivotAgg: v === "*" ? "count" : agg === "count" ? "sum" : agg })} /></Field>
        <Field label="Calculate"><Sel disabled={val === "*"} options={[["sum", "Sum"], ["avg", "Average"], ["median", "Median"], ["min", "Lowest"], ["max", "Highest"], ["count", "Count"], ["count_distinct", "Unique count"]]} value={agg} onChange={(v) => up({ pivotAgg: v as Agg })} /></Field>
      </div>
      {error && <div className="banner bad">{error}</div>}
      {!row ? <Empty icon="table" title="Choose a column for the rows">Each value of that column becomes a row in the table.</Empty> : loading ? <Sk h={200} /> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>{row}</th>{col ? heads.map((h) => <th key={h} className="r">{h}</th>) : <th className="r">Value</th>}{col && additive && <th className="r">Total</th>}</tr></thead><tbody>
        {rows.map(([r, vals]) => <tr key={r}><td>{r}</td>{(col ? heads : ["(empty)"]).map((h) => <td key={h} className="r">{fmt(vals[h])}</td>)}{col && additive && <td className="r"><b>{fmt(Object.values(vals).reduce((a, b) => a + b, 0))}</b></td>}</tr>)}
        {additive && <tr><td><b>Total</b></td>{(col ? heads : ["(empty)"]).map((h) => <td key={h} className="r"><b>{fmt(totals[h])}</b></td>)}{col && <td className="r"><b>{fmt(grand)}</b></td>}</tr>}
      </tbody></table></div>}
    </div>
  );
}

function Explore() {
  const { config, patch } = useApp(), tables = useTables(), pre = useSearchParams();
  const views = config!.views;
  const [sel, setSel] = useState(pre.get("view") ?? views[0]?.id ?? ""), [typed, setTyped] = useState(""), [search, setSearch] = useState(""), [rowOpen, setRowOpen] = useState<Record<string, unknown> | null>(null), [creating, setCreating] = useState(false), [draft, setDraft] = useState({ name: "", table: "" });
  const [adhoc, setAdhoc] = useState<DataView | null>(null), [rename, setRename] = useState<string | null>(null), [coloring, setColoring] = useState(false), [tools, setTools] = useState(false);
  useEffect(() => { const t = pre.get("table"), c = pre.get("column"), v = pre.get("value"); if (t) { setAdhoc({ ...newView(t, t), ...(c && v ? { filters: [{ id: "drill", column: c, op: "eq" as const, value: v }] } : {}) }); } }, [pre]);
  useEffect(() => { const t = setTimeout(() => setSearch(typed.trim()), 120); return () => clearTimeout(t); }, [typed]);
  const view = adhoc ?? views.find((v) => v.id === sel) ?? views[0];
  useLiveFeed(view ? [view.table] : []);
  useNewHandler("view", () => { setDraft({ name: "", table: view?.table ?? "" }); setCreating(true); });
  const up = (p: Partial<DataView>) => { if (adhoc) setAdhoc({ ...adhoc, ...p }); else patch((c) => ({ ...c, views: c.views.map((v) => (v.id === view.id ? { ...v, ...p } : v)) })); };

  const info = tables?.find((t) => t.full === view?.table);
  const columns = useMemo(() => info?.columns ?? [], [info]);
  const allCols: GridCol[] = useMemo(() => columns.map((c) => ({ name: c.name, type: c.type, kind: kindOf(c.type), label: view?.labels?.[c.name] || prettyField(c.name), display: view?.formats?.[c.name] })), [columns, view?.labels, view?.formats]);
  const labelOf = (n: string) => allCols.find((c) => c.name === n)?.label ?? n;
  const cols = useMemo(() => {
    if (!view) return [];
    const order = view.order ?? [], rank = (n: string) => { const i = order.indexOf(n); return i < 0 ? 1e6 : i; };
    return allCols.filter((c) => !view.hidden.includes(c.name)).sort((a, b) => rank(a.name) - rank(b.name));
  }, [allCols, view]);
  const searchSql = search ? `(${columns.map((c) => `CAST(${q(c.name)} AS VARCHAR) ILIKE ${lit(`%${search.replace(/[\\%_]/g, "\\$&")}%`)} ESCAPE '\\'`).join(" OR ")})` : "";
  const baseWhere = view ? whereSql(view.filters, view.match) : "";
  const where = searchSql ? (baseWhere ? `WHERE (${baseWhere.slice(6)}) AND ${searchSql}` : `WHERE ${searchSql}`) : baseWhere;
  const order = view ? orderSql(view.sorts.filter((s) => columns.some((c) => c.name === s.column))) : "";
  const { count, error, load, row, base } = useRows(where, order, view?.table ?? "", !!info);
  const sums = Object.entries(view?.summaries ?? {}).filter(([c]) => columns.some((x) => x.name === c));
  const sumQuery = useLiveQuery(info && view?.layout === "grid" && sums.length ? `SELECT ${sums.map(([c, a]) => `${measureSql({ column: c, agg: a })} AS ${q(c)}`).join(", ")} ${base}` : null, [view?.table ?? ""]);

  if (!tables) return <div className="body"><Sk h={300} /></div>;
  if (!view) return <><PageHead title="Data views" /><Empty icon="table" title="No tables to view yet" editor action={<a className="btn primary" href="/connections">Add a connection</a>}>Sync a connection first, then save filtered views of any table here.</Empty></>;

  const onSort = (c: string, add: boolean) => {
    const s = view.sorts.find((x) => x.column === c), others = add ? view.sorts.filter((x) => x.column !== c) : [];
    up({ sorts: !s ? [...others, { column: c, dir: "asc" }] : s.dir === "asc" ? [...others, { column: c, dir: "desc" }] : others });
  };
  const exportCsv = async () => {
    try { const r = await sql(`SELECT * ${base} ${order} LIMIT 100000`, 100000); download(`${view.name}.csv`, toCsv({ columns: r.columns.filter((c) => !view.hidden.includes(c.name)), rows: r.rows })); toast(`Exported ${r.rows.length.toLocaleString("en-US")} rows`); }
    catch (e) { toast((e as Error).message, true); }
  };
  const move = (name: string, dir: -1 | 1) => {
    const names = (view.order?.length ? [...view.order, ...allCols.map((c) => c.name).filter((n) => !view.order!.includes(n))] : allCols.map((c) => c.name));
    const i = names.indexOf(name), j = i + dir;
    if (j < 0 || j >= names.length) return;
    [names[i], names[j]] = [names[j], names[i]];
    up({ order: names });
  };
  const chipCols = view.chips ?? allCols.filter((c) => (c.kind === "text" || c.kind === "bool") && !/(^|_)(id|name|email|phone|address|at)$/i.test(c.name)).slice(0, 4).map((c) => c.name);
  const columnMenu = (c: GridCol, close: () => void) => {
    const go = (fn: () => void) => () => { fn(); close(); };
    return <div className="menu" style={{ padding: 0 }}>
      <div className="field" style={{ padding: "4px 8px 8px" }}><label className="lab" htmlFor="field-name">Field name</label><input id="field-name" className="input" autoFocus defaultValue={c.label} onKeyDown={(e) => { if (e.key === "Enter") { up({ labels: { ...view.labels, [c.name]: e.currentTarget.value.trim() } }); close(); } }} onBlur={(e) => { if (e.target.value.trim() !== c.label) up({ labels: { ...view.labels, [c.name]: e.target.value.trim() } }); }} /><span className="hint mono">{c.name}</span></div>
      {formatsFor(c.kind) && <div className="field" style={{ padding: "0 8px 8px" }}><span className="lab">Show as</span><Sel aria-label={`Show ${c.label ?? c.name} as`} options={formatsFor(c.kind)!} value={view.formats?.[c.name] ?? ""} onChange={(v) => { const next = { ...view.formats }; if (v) next[c.name] = v; else delete next[c.name]; up({ formats: next }); close(); }} /></div>}
      <button onClick={go(() => up({ sorts: [{ column: c.name, dir: "asc" }] }))}><Icon name="sort" />Sort {c.kind === "number" ? "lowest first" : c.kind === "date" ? "oldest first" : "A to Z"}</button>
      <button onClick={go(() => up({ sorts: [{ column: c.name, dir: "desc" }] }))}><Icon name="sort" />Sort {c.kind === "number" ? "highest first" : c.kind === "date" ? "newest first" : "Z to A"}</button>
      <button onClick={go(() => up({ groupBy: view.groupBy === c.name ? undefined : c.name }))}><Icon name="board" />{view.groupBy === c.name ? "Stop grouping" : "Group by this field"}</button>
      <button onClick={go(() => up({ colorBy: view.colorBy === c.name ? undefined : c.name }))}><Icon name="palette" />{view.colorBy === c.name ? "Remove value colors" : "Color each value"}</button>
      <button onClick={go(() => up({ chips: chipCols.includes(c.name) ? chipCols.filter((x) => x !== c.name) : [...chipCols, c.name] }))}><Icon name="filter" />{chipCols.includes(c.name) ? "Remove from filter bar" : "Add to filter bar"}</button>
      <button onClick={go(() => up({ frozen: cols.findIndex((x) => x.name === c.name) + 1 }))}><Icon name="sidebar" />Freeze up to here</button>
      <button onClick={go(() => up({ hidden: [...view.hidden, c.name] }))}><Icon name="eye" />Hide field</button>
      <button onClick={go(() => { const next = { ...(view.summaries ?? {}) }; if (next[c.name]) delete next[c.name]; else next[c.name] = c.kind === "number" ? "sum" : "count"; up({ summaries: next }); })}><Icon name="metric" />{view.summaries?.[c.name] ? "Remove total" : c.kind === "number" ? "Show a total" : "Count filled rows"}</button>
    </div>;
  };
  const addRule = (): ColorRule => ({ id: uid(), column: allCols[0]?.name ?? "", op: "eq", value: "", tone: "warn" });

  return (
    <Split id="views" width={220} label="Views">
      <aside className="tree" aria-label="Views">
        
        {adhoc && <button className="on"><Icon name="table" size={14} /><span>{adhoc.table}</span></button>}
        {views.map((v) => <button key={v.id} className={!adhoc && v.id === view.id ? "on" : ""} onClick={() => { setAdhoc(null); setSel(v.id); setTyped(""); }}><Icon name={v.layout === "grid" ? "table" : v.layout === "board" ? "board" : v.layout === "pivot" ? "pivot" : "grid"} size={14} /><span>{v.name}</span></button>)}
        <button onClick={() => { setDraft({ name: "", table: view.table }); setCreating(true); }}><Icon name="plus" size={14} /><span>Create a view</span></button>
      </aside>
      <section>
      <PageHead title={view.name}><LiveControl /></PageHead>
      <div className={`toolbar phone-fold ${tools ? "open" : ""}`}>
        <Btn className="keep fold-btn" icon="filter" aria-expanded={tools} onClick={() => setTools(!tools)}>Options</Btn>
        <Pop width={680} trigger={(_, t) => <Btn icon="filter" variant={view.filters.length ? "on" : undefined} onClick={t}>Filter{view.filters.length ? ` (${view.filters.length})` : ""}</Btn>}>
          <FilterEditor table={view.table} labelOf={labelOf} columns={columns} filters={view.filters} onChange={(f) => up({ filters: f })} match={view.match} onMatch={(m) => up({ match: m })} />
        </Pop>
        <Pop width={340} trigger={(_, t) => <Btn icon="sort" variant={view.sorts.length ? "on" : undefined} onClick={t}>Sort{view.sorts.length ? ` (${view.sorts.length})` : ""}</Btn>}>
          <div style={{ display: "grid", gap: 6 }}>
            {view.sorts.map((s, i) => <div key={s.column} style={{ display: "flex", gap: 4 }}><Sel aria-label="Sort column" options={allCols.map((c): [string, string] => [c.name, c.label ?? c.name])} value={s.column} onChange={(v) => up({ sorts: view.sorts.map((x, k) => (k === i ? { ...x, column: v } : x)) })} style={{ flex: 1 }} /><Sel aria-label="Direction" options={[["asc", "Ascending"], ["desc", "Descending"]]} value={s.dir} onChange={(v) => up({ sorts: view.sorts.map((x, k) => (k === i ? { ...x, dir: v as "asc" } : x)) })} /><Btn icon="x" variant="ghost" aria-label="Remove sort" onClick={() => up({ sorts: view.sorts.filter((_, k) => k !== i) })} /></div>)}
            {!view.sorts.length && <p className="muted small">Click a column header to sort. Hold Shift to sort by several.</p>}
            <div><Btn icon="plus" onClick={() => { const c = allCols.find((x) => !view.sorts.some((s) => s.column === x.name)); if (c) up({ sorts: [...view.sorts, { column: c.name, dir: "asc" }] }); }}>Add sort</Btn></div>
          </div>
        </Pop>
        <Pop width={300} trigger={(_, t) => <Btn icon="eye" variant={view.hidden.length ? "on" : undefined} onClick={t}>{view.hidden.length ? `${view.hidden.length} hidden` : "Hide fields"}</Btn>}>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}><button className="link small" onClick={() => up({ hidden: [] })}>Show all</button><button className="link small" onClick={() => up({ hidden: allCols.slice(1).map((c) => c.name) })}>Hide all</button></div>
          <div style={{ display: "grid", gap: 2 }}>{(view.order?.length ? [...allCols].sort((a, b) => view.order!.indexOf(a.name) - view.order!.indexOf(b.name)) : allCols).map((c) => <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 4 }}><label className="check grow" style={{ minWidth: 0 }}><input type="checkbox" checked={!view.hidden.includes(c.name)} onChange={(e) => up({ hidden: e.target.checked ? view.hidden.filter((x) => x !== c.name) : [...view.hidden, c.name] })} /><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span></label><Btn variant="ghost" icon="chevDown" style={{ transform: "rotate(180deg)" }} aria-label={`Move ${c.name} up`} onClick={() => move(c.name, -1)} /><Btn variant="ghost" icon="chevDown" aria-label={`Move ${c.name} down`} onClick={() => move(c.name, 1)} /></div>)}</div>
          <Field label="Freeze columns"><Sel options={["0", "1", "2", "3"]} value={String(view.frozen)} onChange={(v) => up({ frozen: Number(v) })} /></Field>
        </Pop>
        <Pop width={320} trigger={(_, t) => <Btn icon="grid" variant={view.groupBy ? "on" : undefined} onClick={t}>View</Btn>}><div className="view-menu">
          <div className="field"><span className="lab">Type</span><Seg label="Layout" value={view.layout} onChange={(l) => up({ layout: l, ...(l === "board" && !view.groupBy ? { groupBy: allCols.find((c) => c.kind === "text")?.name } : {}) })} options={[["grid", <Icon key="g" name="table" size={14} />, "Grid"], ["board", <Icon key="b" name="board" size={14} />, "Board"], ["gallery", <Icon key="c" name="grid" size={14} />, "Gallery"], ["pivot", <Icon key="p" name="pivot" size={14} />, "Pivot table"]]} /></div>
          {view.layout === "grid" && <div className="field"><span className="lab">Row height</span><Seg label="Row height" value={view.density} onChange={(d) => up({ density: d })} options={[["compact", <Icon key="s" name="density" size={12} />, "Short rows"], ["regular", <Icon key="m" name="menu" size={14} />, "Medium rows"], ["roomy", <Icon key="l" name="sidebar" size={14} />, "Tall rows"]]} /></div>}
          {(view.layout === "board" || view.layout === "grid") && <Field label="Group by"><Sel aria-label="Group by" options={[["", "No grouping"], ...allCols.map((c): [string, string] => [c.name, `Group: ${c.label}`])]} value={view.groupBy ?? ""} onChange={(v) => up({ groupBy: v || undefined })} /></Field>}
          {(view.layout === "board" || view.layout === "gallery") && <Field label="Card title"><Sel aria-label="Card title" options={[["", "Automatic"], ...allCols.map((c): [string, string] => [c.name, c.label ?? c.name])]} value={view.titleColumn ?? ""} onChange={(v) => up({ titleColumn: v || undefined })} /></Field>}
        </div></Pop>
                <div className="grow keep" />
        {adhoc && <Btn icon="save" variant="primary" onClick={() => { const saved = { ...adhoc, id: uid() }; patch((c) => ({ ...c, views: [...c.views, saved] })); setSel(saved.id); setAdhoc(null); toast("View saved"); }}>Save view</Btn>}
        <span className="keep"><MoreMenu label="View options">{(close) => <>
          <button onClick={() => { close(); setColoring(true); }}><Icon name="palette" />Color{view.colorRules.length ? ` (${view.colorRules.length})` : ""}</button>
          <button onClick={() => { close(); void exportCsv(); }}><Icon name="download" />Export</button>
          {!adhoc && <><hr /><button onClick={() => { close(); const n = { ...view, id: uid(), name: `${view.name} copy` }; patch((c) => ({ ...c, views: [...c.views, n] })); setSel(n.id); }}><Icon name="copy" />Duplicate view</button>
          <button onClick={() => { close(); setRename(view.name); }}><Icon name="edit" />Rename view</button>
          <button onClick={() => { close(); const rest = views.filter((v) => v.id !== view.id); patch((c) => ({ ...c, views: rest })); setSel(rest[0]?.id ?? ""); toast(`Deleted ${view.name}`); }}><Icon name="trash" />Delete view</button></>}
        </>}</MoreMenu></span>
      </div>
      {info && <div className={`fbar phone-fold ${tools ? "open" : ""}`}>
        <input className="input keep" style={{ width: 200 }} type="search" placeholder="Search this table" aria-label="Search this table" value={typed} onChange={(e) => setTyped(e.target.value)} />
        {chipCols.map((c) => { const f = view.filters.find((x) => x.column === c && x.op === "in"); return <FilterChip key={c} table={view.table} column={c} label={labelOf(c)} filter={f} onChange={(values) => up({ filters: values.length ? (f ? view.filters.map((x) => (x === f ? { ...x, values } : x)) : [...view.filters, { id: uid(), column: c, op: "in", values }]) : view.filters.filter((x) => x !== f) })} />; })}
        {(view.filters.length > 0 || typed) && <button className="link small" onClick={() => { up({ filters: [] }); setTyped(""); setSearch(""); }}>Clear all</button>}
        <span className="grow keep" /><span className="small muted num keep" role="status">{typed.trim() !== search || count == null ? (typed.trim() ? "Searching" : "Counting rows") : `${count.toLocaleString("en-US")} rows`}</span>
      </div>}
      {error && <div className="banner bad" style={{ margin: 12 }}><Icon name="warn" />{error}</div>}
      {!tables ? <div className="body"><LoadingTable cols={6} label="Loading table" /></div> : !info ? <Empty icon="table" title={`Table ${view.table} isn't in the warehouse`} editor action={<a className="btn primary" href="/pipelines">Run a sync</a>}>Run the pipeline or models that create it, or delete this view from the menu above.</Empty>
        : view.layout === "grid" && view.groupBy ? <GroupedGrid view={view} cols={cols} base={base} order={order} labelOf={labelOf} find={search} menu={columnMenu} onSort={onSort} />
        : view.layout === "grid" && count === 0 && (search || view.filters.length > 0) ? <div className="body"><NoResults what="rows" onClear={() => { setTyped(""); setSearch(""); up({ filters: [] }); }} /></div>
        : view.layout === "grid" ? <DataGrid columnMenu={columnMenu} colorBy={view.colorBy} find={search} columns={cols} count={count ?? 0} row={row} onVisible={load} sorts={view.sorts} onSort={onSort} widths={view.widths} onResize={(c, w) => up({ widths: { ...view.widths, [c]: w } })} frozen={view.frozen} rowH={DENSITY[view.density]} colorRules={view.colorRules} onRowClick={setRowOpen} selectable exportName={view.name} summary={!sums.length ? undefined : (c) => {
          const a = view.summaries?.[c.name];
          const opts: [string, string][] = c.kind === "number" ? [["", "Summary"], ["sum", "Sum"], ["avg", "Avg"], ["median", "Median"], ["min", "Min"], ["max", "Max"], ["count_distinct", "Unique"]] : [["", "Summary"], ["count", "Filled"], ["count_distinct", "Unique"]];
          const v = sumQuery.data?.rows[0]?.[c.name];
          return <>{a && <b>{v == null ? "" : fmt(v)}</b>}<Sel className="" aria-label={`Summary for ${c.name}`} value={a ?? ""} onChange={(x) => { const next = { ...(view.summaries ?? {}) }; if (x) next[c.name] = x as Agg; else delete next[c.name]; up({ summaries: next }); }} options={opts} /></>;
        }} />
        : view.layout === "board" ? <Board view={view} cols={cols} base={base} order={order} onOpen={setRowOpen} />
        : view.layout === "gallery" ? <Gallery view={view} cols={cols} base={base} order={order} onOpen={setRowOpen} />
        : <Pivot view={view} cols={allCols} where={where} up={up} />}
      {(view.layout !== "grid" || cols.length !== allCols.length) && <div className="statusbar"><span>{count == null ? "Counting rows" : `${count.toLocaleString("en-US")} rows`}</span><span>{cols.length} of {allCols.length} columns</span></div>}
      </section>
      {rowOpen && <Record cols={allCols} row={rowOpen} onClose={() => setRowOpen(null)} onFilter={(c, v) => { up({ filters: [...view.filters.filter((x) => x.column !== c), { id: uid(), column: c, op: "in", values: [v] }] }); setRowOpen(null); }} />}
      {coloring && <Modal sheet title="Color rows" onClose={() => setColoring(false)} foot={<Btn onClick={() => setColoring(false)}>Done</Btn>}>{view.colorRules.map((r) => { const set = (p: Partial<ColorRule>) => up({ colorRules: view.colorRules.map((x) => (x.id === r.id ? { ...x, ...p } : x)) }); return <div key={r.id} className="rule-stack"><Sel aria-label="Column" options={allCols.map((c) => c.name)} value={r.column} onChange={(v) => set({ column: v })} /><Sel aria-label="Condition" options={[["eq", "is"], ["neq", "is not"], ["contains", "contains"], ["gt", "above"], ["lt", "below"], ["empty", "empty"]]} value={r.op} onChange={(v) => set({ op: v as FilterOp })} />{r.op !== "empty" && <input className="input" aria-label="Value" placeholder="Value" value={r.value ?? ""} onChange={(e) => set({ value: e.target.value })} />}<Sel aria-label="Color" options={[["good", "Green"], ["warn", "Amber"], ["bad", "Red"], ["info", "Blue"], ["violet", "Violet"]]} value={r.tone} onChange={(v) => set({ tone: v as ColorRule["tone"] })} /><Sel aria-label="Apply to" options={[["cell", "This cell"], ["row", "Whole row"]]} value={r.scope ?? "cell"} onChange={(v) => set({ scope: v as ColorRule["scope"] })} /><Btn icon="x" variant="ghost" aria-label="Remove rule" onClick={() => up({ colorRules: view.colorRules.filter((x) => x.id !== r.id) })} /></div>; })}
            <Field label="Color each value of a field"><Sel options={[["", "None"], ...allCols.filter((c) => c.kind !== "json").map((c): [string, string] => [c.name, c.label ?? c.name])]} value={view.colorBy ?? ""} onChange={(v) => up({ colorBy: v || undefined })} /></Field>
            <h4 className="small" style={{ margin: "4px 0 0" }}>Rules</h4>
            {!view.colorRules.length && <p className="muted small">Color cells or whole rows that match a condition.</p>}
            <div><Btn icon="plus" onClick={() => up({ colorRules: [...view.colorRules, addRule()] })}>Add rule</Btn></div></Modal>}
      {rename !== null && <Modal sheet title="Rename view" onClose={() => setRename(null)} foot={<><Btn onClick={() => setRename(null)}>Cancel</Btn><Btn variant="primary" disabled={!rename} onClick={() => { up({ name: rename }); setRename(null); }}>Rename view</Btn></>}><Field label="View name"><input className="input" autoFocus value={rename} onChange={(e) => setRename(e.target.value)} /></Field></Modal>}
      {creating && <Modal sheet title="New view" onClose={() => setCreating(false)} foot={<><Btn onClick={() => setCreating(false)}>Cancel</Btn><Btn variant="primary" disabled={!draft.name || !draft.table} onClick={() => { const n = newView(draft.table, draft.name); patch((c) => ({ ...c, views: [...c.views, n] })); setSel(n.id); setAdhoc(null); setCreating(false); }}>Create view</Btn></>}>
        <Field label="View name"><input className="input" autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
        <Field label="Table"><Sel options={(tables ?? []).map((t) => t.full)} value={draft.table} onChange={(v) => setDraft({ ...draft, table: v })} /></Field>
      </Modal>}
    </Split>
  );
}
export default function Page() { return <Suspense><Explore /></Suspense>; }
