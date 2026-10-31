"use client";
import { useRef, useState } from "react";
import type { SemanticModel, SemRel, SemTable } from "@/lib/semantic";

const W = 190, HEAD = 34, ROW = 22, MAX_ROWS = 8, GAP_X = 70, GAP_Y = 40;
type Pos = { x: number; y: number };

/** Lays out tables nobody has moved yet: most-referenced first, in rows of three. */
export function defaultPos(tables: SemTable[], i: number, t: SemTable): Pos {
  return { x: t.x ?? 20 + (i % 3) * (W + GAP_X), y: t.y ?? 20 + Math.floor(i / 3) * (HEAD + ROW * MAX_ROWS + GAP_Y) };
}

/** The model as boxes and lines: 1 and * mark each end, an arrow shows where filters go, and a dashed line is inactive. */
export function ModelDiagram({ model, columns, onMove, onRel, onTable, selected }: { model: SemanticModel; columns: (t: SemTable) => string[]; onMove?: (full: string, p: Pos) => void; onRel: (r: SemRel) => void; onTable: (t: SemTable) => void; selected?: string }) {
  const [drag, setDrag] = useState<{ full: string; p: Pos } | null>(null), box = useRef<HTMLDivElement>(null);
  const place = (t: SemTable, i: number) => (drag?.full === t.full ? drag.p : defaultPos(model.tables, i, t));
  const shown = (t: SemTable) => columns(t).filter((c) => !t.columns?.[c]?.hidden);
  const height = (t: SemTable) => HEAD + ROW * Math.min(MAX_ROWS, shown(t).length) + (shown(t).length > MAX_ROWS ? ROW : 0);
  const at = (full: string) => { const i = model.tables.findIndex((t) => t.full === full); return i < 0 ? null : { t: model.tables[i], p: place(model.tables[i], i) }; };
  const start = (e: React.PointerEvent, t: SemTable, i: number) => {
    if (!onMove) return;
    const p0 = place(t, i), x0 = e.clientX, y0 = e.clientY; let cur = p0, moved = false;
    const move = (ev: PointerEvent) => { cur = { x: Math.max(0, p0.x + ev.clientX - x0), y: Math.max(0, p0.y + ev.clientY - y0) }; moved = true; setDrag({ full: t.full, p: cur }); };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); setDrag(null); if (moved) onMove(t.full, cur); else onTable(t); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };
  const width = Math.max(720, ...model.tables.map((t, i) => place(t, i).x + W + 20)), tall = Math.max(320, ...model.tables.map((t, i) => place(t, i).y + height(t) + 20));
  return (
    <div className="tbl-wrap" ref={box} style={{ overflow: "auto", maxHeight: "calc(100vh - 220px)" }}>
      <div style={{ position: "relative", width, height: tall }}>
        <svg width={width} height={tall} style={{ position: "absolute", inset: 0 }} role="img" aria-label="Relationships between model tables">
          <defs><marker id="sem-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1 9 5 1 9z" fill="currentColor" /></marker></defs>
          {model.relationships.map((r, k) => {
            const a = at(r.from), b = at(r.to); if (!a || !b) return null;
            const ay = a.p.y + height(a.t) / 2 + k * 4, by = b.p.y + height(b.t) / 2 + k * 4, right = b.p.x > a.p.x;
            const x1 = right ? a.p.x + W : a.p.x, x2 = right ? b.p.x : b.p.x + W, mx = (x1 + x2) / 2, my = (ay + by) / 2, inactive = r.active === false, on = selected === r.id;
            return <g key={r.id} style={{ color: on ? "var(--accent)" : "var(--ink-2)", cursor: "pointer" }} onClick={() => onRel(r)}>
              <path d={`M${x1} ${ay} L${mx} ${ay} L${mx} ${by} L${x2} ${by}`} fill="none" stroke="transparent" strokeWidth="12" />
              <path d={`M${x1} ${ay} L${mx} ${ay} L${mx} ${by} L${x2} ${by}`} fill="none" stroke="currentColor" strokeWidth={on ? 2 : 1.25} strokeDasharray={inactive ? "5 4" : undefined} />
              <path d={`M${mx} ${my + (by > ay ? 6 : -6)} L${mx} ${my + (by > ay ? -6 : 6)}`} fill="none" stroke="currentColor" markerEnd="url(#sem-arrow)" markerStart={r.both ? "url(#sem-arrow)" : undefined} transform={by === ay ? `rotate(${right ? 90 : -90} ${mx} ${my})` : undefined} />
              <text x={x1 + (right ? 6 : -6)} y={ay - 5} textAnchor={right ? "start" : "end"} fontSize="12" fill="currentColor">*</text>
              <text x={x2 + (right ? -6 : 6)} y={by - 5} textAnchor={right ? "end" : "start"} fontSize="12" fill="currentColor">{r.kind === "many" ? "*" : "1"}</text>
            </g>;
          })}
        </svg>
        {model.tables.map((t, i) => { const p = place(t, i), cols = shown(t); return (
          <section key={t.full} aria-label={t.label} style={{ position: "absolute", left: p.x, top: p.y, width: W, background: "var(--bg)", border: "1px solid var(--line)", opacity: t.hidden ? .6 : 1 }}>
            <button type="button" onPointerDown={(e) => start(e, t, i)} onKeyDown={(e) => { if (e.key === "Enter") onTable(t); }} style={{ display: "block", width: "100%", height: HEAD, padding: "0 10px", textAlign: "left", fontWeight: 600, fontSize: 13, background: "none", border: 0, borderBottom: "1px solid var(--line)", color: "inherit", cursor: onMove ? "move" : "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.label}</button>
            {cols.slice(0, MAX_ROWS).map((c) => <div key={c} className="small" style={{ height: ROW, lineHeight: `${ROW}px`, padding: "0 10px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.columns?.[c]?.label || c}{t.dateColumn === c ? " (date)" : ""}</div>)}
            {cols.length > MAX_ROWS && <div className="small muted" style={{ height: ROW, lineHeight: `${ROW}px`, padding: "0 10px" }}>{cols.length - MAX_ROWS} more</div>}
          </section>
        ); })}
      </div>
    </div>
  );
}
