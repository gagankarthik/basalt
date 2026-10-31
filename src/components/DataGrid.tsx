"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { Btn, Modal, Sel } from "./ui";
import { cellText, prettyNested } from "@/lib/nested";
import { download, fmt } from "@/lib/client";
import { toCsv } from "@/lib/sql";
import type { ColorRule, Kind, Sort } from "@/lib/types";

export type GridCol = { name: string; kind: Kind; type?: string; label?: string };
type Row = Record<string, unknown>;

const PAGE_SIZES = [10, 25, 50, 100];
const FIELD_ICON: Record<Kind, IconName> = { text: "fieldText", number: "fieldNumber", date: "fieldDate", bool: "fieldBool", json: "fieldJson" };
const estimate = (c: GridCol) => Math.max({ number: 110, date: 180, bool: 90, text: 170, json: 220 }[c.kind], (c.label ?? c.name).length * 8 + 66);
function matches(r: ColorRule, v: unknown) {
  const s = cellText(v), val = r.value ?? "", n = Number(v), m = Number(val);
  switch (r.op) {
    case "eq": return s === val; case "neq": return s !== val; case "contains": return s.toLowerCase().includes(val.toLowerCase());
    case "gt": return n > m; case "gte": return n >= m; case "lt": return n < m; case "lte": return n <= m;
    case "empty": return v == null || s === ""; case "not_empty": return !(v == null || s === "");
    default: return false;
  }
}
const GOOD = /^(delivered|paid|active|success|succeeded|resolved|completed?|won|yes)$/i, BAD = /^(failed|cancell?ed|refunded|error|churned|lost)$/i, WARN = /^(pending|paused|open|waiting|running|at risk|trial)$/i;
const statusTone = (v: string) => (GOOD.test(v) ? "good" : BAD.test(v) ? "bad" : WARN.test(v) ? "warn" : "");

const PALETTE = ["#1457d2", "#0f766e", "#b45309", "#6d28d9", "#be185d", "#15803d", "#b91c1c", "#0e7490"];
const hueOf = (v: string) => { let h = 0; for (const c of v) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
function Marked({ text, find }: { text: string; find?: string }) {
  const i = find ? text.toLowerCase().indexOf(find.toLowerCase()) : -1;
  return i < 0 ? <>{text}</> : <>{text.slice(0, i)}<mark className="hit">{text.slice(i, i + find!.length)}</mark>{text.slice(i + find!.length)}</>;
}
/** One line in the table; the whole value, indented, in a sheet. */
function NestedCell({ col, text, full, find }: { col: GridCol; text: string; full: string; find?: string }) {
  const [open, setOpen] = useState(false);
  // Inside a row that opens on click, so neither the button nor the sheet may reach it
  return <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
    <button type="button" className="plain-link mono" style={{ background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer", textAlign: "left" }} aria-label={`View all of ${col.label ?? col.name}`} onClick={() => setOpen(true)}><Marked text={text.length > 200 ? `${text.slice(0, 200)}...` : text} find={find} /></button>
    {open && <Modal sheet title={col.label ?? col.name} onClose={() => setOpen(false)} foot={<Btn onClick={() => setOpen(false)}>Close</Btn>}><pre className="code mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{full}</pre></Modal>}
  </span>;
}
export function Cell({ col, v, tone, colored, find, inert }: { col: GridCol; v: unknown; tone?: string; colored?: boolean; find?: string; inert?: boolean }): ReactNode {
  if (v == null) return <span className="null">Empty</span>;
  const full = prettyNested(v);
  // inert: the cell sits inside a button, which can't hold another
  if (full) return inert ? <span className="mono">{cellText(v)}</span> : <NestedCell col={col} text={cellText(v)} full={full} find={find} />;
  // IDs and keys are labels, not quantities, so they get no thousands separators
  const number = /(^|_)(id|key|code|zip)$/i.test(col.name) ? String(v) : fmt(v);
  if (colored) { const c = hueOf(String(v)); return <span className="badge dot" style={{ color: c, background: `color-mix(in srgb, ${c} 10%, transparent)` }}>{col.kind === "number" ? number : String(v)}</span>; }
  if (tone) return <span className={`badge dot ${tone === "info" ? "info" : tone}`}>{col.kind === "number" ? number : String(v)}</span>;
  if (col.kind === "number") return <span><Marked text={number} find={find} /></span>;
  if (col.kind === "bool") return <span>{v ? "Yes" : "No"}</span>;
  if (typeof v === "object") return <span className="mono">{JSON.stringify(v)}</span>;
  if (/(^|_)status$/i.test(col.name)) return <span className={`badge dot ${statusTone(String(v))}`}><Marked text={String(v)} find={find} /></span>;
  return <span title={String(v)}><Marked text={String(v)} find={find} /></span>;
}

/** Paged table. `row(i)` may return undefined while a page loads, so the same grid serves query results and tables of any size. */
export function DataGrid({ columns, count, row, sorts, onSort, widths, onResize, frozen = 0, rowH = 44, colorRules, onRowClick, onVisible, summary, selectable, exportName, colorBy, find, bare, columnMenu }: {
  columns: GridCol[]; count: number; row: (i: number) => Row | undefined;
  sorts?: Sort[]; onSort?: (col: string, add: boolean) => void; widths?: Record<string, number>; onResize?: (col: string, w: number) => void;
  frozen?: number; rowH?: number; colorRules?: ColorRule[]; onRowClick?: (r: Row, i: number) => void; onVisible?: (start: number, end: number) => void; summary?: (c: GridCol) => ReactNode;
  selectable?: boolean; exportName?: string; colorBy?: string; find?: string; bare?: boolean; columnMenu?: (c: GridCol, close: () => void) => ReactNode;
}) {
  const [page, setPage] = useState(0), [size, setSize] = useState(bare ? 100 : 25), [selected, setSelected] = useState<Map<number, Row>>(new Map());
  const [local, setLocal] = useState<Record<string, number>>({}), [menu, setMenu] = useState<{ col: GridCol; x: number; y: number } | null>(null), lastPick = useRef<number | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const pages = Math.max(1, Math.ceil(count / size)), current = Math.min(page, pages - 1);
  const first = current * size, last = Math.min(count, first + size);
  useEffect(() => { if (count) onVisible?.(first, last - 1); }, [first, last, count, onVisible]);
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [current, size]);
  // row numbers shift when filters or sorting change, so an old selection would point at other rows
  useEffect(() => { setSelected(new Map()); }, [count, sorts]);

  const w = (c: GridCol) => local[c.name] ?? widths?.[c.name] ?? estimate(c);
  const boxW = selectable ? 44 : 0;
  const offs = columns.map((_, i) => columns.slice(0, i).reduce((sum, c) => sum + w(c), boxW));
  const startResize = (e: React.PointerEvent, c: GridCol) => {
    e.stopPropagation(); e.preventDefault();
    const x0 = e.clientX, w0 = w(c);
    const move = (ev: PointerEvent) => setLocal((l) => ({ ...l, [c.name]: Math.max(60, w0 + ev.clientX - x0) }));
    const up = (ev: PointerEvent) => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); onResize?.(c.name, Math.max(60, w0 + ev.clientX - x0)); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  const idx = Array.from({ length: Math.max(0, last - first) }, (_, k) => first + k);
  const allOn = idx.length > 0 && idx.every((i) => selected.has(i));
  const toggle = (i: number, range: boolean) => {
    const r = row(i); if (!r) return;
    const n = new Map(selected), on = !n.has(i);
    // Shift-click selects everything from the last row picked, as in a spreadsheet
    if (range && lastPick.current != null) { const [a, b] = [Math.min(lastPick.current, i), Math.max(lastPick.current, i)]; for (let k = a; k <= b; k++) { const x = row(k); if (x) n.set(k, x); } }
    else if (on) n.set(i, r); else n.delete(i);
    lastPick.current = i; setSelected(n);
  };

  return (
    <div className="dt">
      {selected.size > 0 && <div className="dt-bulk"><b>{selected.size} selected</b><button className="link" onClick={() => setSelected(new Map())}>Clear</button><span className="sep" /><button className="btn" onClick={() => download(`${exportName ?? "rows"}.csv`, toCsv({ columns: columns.map((c) => ({ ...c, type: c.type ?? "" })), rows: [...selected.values()] }))}><Icon name="download" />Export selected</button></div>}
      <div className="dt-scroll" ref={scroll}>
        <table style={{ width: columns.reduce((a, c) => a + w(c), boxW) }}>
          <colgroup>{selectable && <col style={{ width: boxW }} />}{columns.map((c) => <col key={c.name} style={{ width: w(c) }} />)}</colgroup>
          <thead><tr>
            {selectable && <th className="dt-box frozen" style={{ left: 0 }}><input type="checkbox" aria-label="Select all on this page" checked={allOn} onChange={() => { const n = new Map(selected); idx.forEach((i) => { const r = row(i); if (allOn) n.delete(i); else if (r) n.set(i, r); }); setSelected(n); }} /></th>}
            {columns.map((c, i) => {
              const s = sorts?.find((x) => x.column === c.name);
              return (
                <th key={c.name} aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : "none"} className={`${c.kind === "number" ? "n" : ""} ${i < frozen ? "frozen" : ""}`} style={i < frozen ? { left: offs[i] } : undefined} title={c.type ? `${c.name} (${c.type})` : c.name}>
                  <button type="button" disabled={!onSort} onClick={(e) => onSort?.(c.name, e.shiftKey)}>
                    <Icon name={FIELD_ICON[c.kind]} size={13} />
                    <span>{c.label ?? c.name}</span>
                    {s && <Icon name="chevDown" size={13} style={{ transform: s.dir === "asc" ? "rotate(180deg)" : undefined }} />}
                  </button>
                  {columnMenu && <button type="button" className="th-menu" aria-label={`Options for ${c.label ?? c.name}`} onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); setMenu({ col: c, x: Math.max(8, Math.min(b.left, innerWidth - 248)), y: b.bottom + 4 }); }}><Icon name="chevDown" size={13} /></button>}
                  {onResize && <span className="rs" role="separator" aria-label={`Resize ${c.name}`} onPointerDown={(e) => startResize(e, c)} />}
                </th>
              );
            })}
          </tr></thead>
          <tbody>
            {idx.map((n) => {
              const r = row(n), rowTone = r && colorRules?.find((cr) => cr.scope === "row" && matches(cr, r[cr.column]))?.tone;
              return (
                <tr key={n} className={`${selected.has(n) ? "on" : ""} ${rowTone ? `row-${rowTone}` : ""}`} tabIndex={onRowClick ? 0 : undefined} style={{ height: rowH, cursor: onRowClick ? "pointer" : undefined }} onClick={() => r && onRowClick?.(r, n)} onKeyDown={(e) => { if (e.key === "Enter" && r) onRowClick?.(r, n); }}>
                  {selectable && <td className="dt-box frozen" style={{ left: 0 }} onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select row ${n + 1}`} checked={selected.has(n)} readOnly onClick={(e) => toggle(n, e.shiftKey)} /></td>}
                  {columns.map((c, i) => {
                    const val = r?.[c.name], tone = r && colorRules?.find((cr) => cr.scope !== "row" && cr.column === c.name && matches(cr, val))?.tone;
                    return <td key={c.name} className={`${c.kind === "number" ? "n" : ""} ${i < frozen ? "frozen" : ""}`} style={i < frozen ? { left: offs[i] } : undefined}>{r ? <Cell col={c} v={val} tone={tone} colored={colorBy === c.name} find={find} /> : <span className="sk" style={{ width: "70%", height: 10 }} />}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
          {summary && <tfoot><tr>{selectable && <td className="dt-box frozen" style={{ left: 0 }} />}{columns.map((c, i) => <td key={c.name} className={i < frozen ? "frozen" : ""} style={i < frozen ? { left: offs[i] } : undefined}><div className="dt-sum">{summary(c)}</div></td>)}</tr></tfoot>}
        </table>
      </div>
      {menu && columnMenu && <><div className="th-scrim" onClick={() => setMenu(null)} /><div className="pop th-pop" style={{ left: menu.x, top: menu.y }}>{columnMenu(menu.col, () => setMenu(null))}</div></>}
      {!bare && <div className="dt-foot">
        <span className="num">{count ? `${(first + 1).toLocaleString("en-US")}–${last.toLocaleString("en-US")} of ${count.toLocaleString("en-US")}` : "0 results"}</span>
        <div className="dt-pager">
          <label>Rows <Sel value={String(size)} onChange={(v) => { setSize(Number(v)); setPage(0); }} options={PAGE_SIZES.map(String)} /></label>
          <button className="btn ghost icon" aria-label="Previous page" disabled={current === 0} onClick={() => setPage(current - 1)}><Icon name="chevRight" style={{ transform: "rotate(180deg)" }} /></button>
          <span className="num">{(current + 1).toLocaleString("en-US")} / {pages.toLocaleString("en-US")}</span>
          <button className="btn ghost icon" aria-label="Next page" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}><Icon name="chevRight" /></button>
        </div>
      </div>}
    </div>
  );
}

/** Convenience wrapper for results already in memory. */
export function ResultGrid({ result, onRowClick, plain }: { result: { columns: GridCol[]; rows: Row[] }; onRowClick?: (r: Row) => void; plain?: boolean }) {
  return <DataGrid columns={result.columns} count={result.rows.length} row={(i) => result.rows[i]} onRowClick={onRowClick} onResize={() => {}} selectable={!plain} exportName="query-result" />;
}
