"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { lineage } from "@/lib/graph";

export function Lineage({ models, selected, onPick }: { models: { name: string; sql: string }[]; selected?: string; onPick?: (n: string) => void }) {
  const g = useMemo(() => { try { return lineage(models); } catch { return null; } }, [models]);
  if (!g) return <div className="banner bad"><Icon name="warn" />The lineage can&apos;t be drawn because a model refers to something missing or models depend on each other.</div>;
  const W = 210, H = 32, GX = 56, GY = 10;
  const layers = new Map<number, typeof g.nodes>();
  g.nodes.forEach((n) => { if (!layers.has(n.layer)) layers.set(n.layer, []); layers.get(n.layer)!.push(n); });
  const pos = new Map<string, { x: number; y: number }>();
  [...layers.entries()].sort((a, b) => a[0] - b[0]).forEach(([l, ns]) => ns.forEach((n, i) => pos.set(n.id, { x: l * (W + GX) + 2, y: i * (H + GY) + 2 })));
  const width = Math.max(...[...pos.values()].map((p) => p.x)) + W + 4, height = Math.max(...[...pos.values()].map((p) => p.y)) + H + 4;
  const near = new Set<string>();
  if (selected) { near.add(selected); g.edges.forEach((e) => { if (e.to === selected) near.add(e.from); if (e.from === selected) near.add(e.to); }); }
  return (
    <div style={{ overflow: "auto" }}>
      <svg width={width} height={height} role="img" aria-label="Lineage graph of sources and models">
        {g.edges.map((e, i) => { const a = pos.get(e.from)!, b = pos.get(e.to)!, x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, on = selected && (e.from === selected || e.to === selected); return <path key={i} d={`M${x1} ${y1}C${x1 + 30} ${y1} ${x2 - 30} ${y2} ${x2} ${y2}`} fill="none" stroke={on ? "var(--accent)" : "var(--line-2)"} strokeWidth={on ? 1.8 : 1} />; })}
        {g.nodes.map((n) => { const p = pos.get(n.id)!, on = n.id === selected, dim = selected && !near.has(n.id); return <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={dim ? 0.45 : 1} style={{ cursor: n.kind === "model" ? "pointer" : "default" }} onClick={() => n.kind === "model" && onPick?.(n.id)}>
          <rect width={W} height={H} rx={4} fill={on ? "var(--accent)" : n.kind === "source" ? "var(--bg-2)" : "var(--bg)"} stroke={on ? "var(--accent)" : "var(--line-2)"} />
          <text x={10} y={20} fontSize={12} fill={on ? "var(--accent-ink)" : "var(--ink)"}>{n.label.length > 27 ? `${n.label.slice(0, 26)}…` : n.label}</text>
        </g>; })}
      </svg>
    </div>
  );
}

export type FlowNode = { id: string; stage: string; col: number; name: string; glyph: ReactNode; status: string; statusIcon: IconName; tone?: "good" | "warn" | "bad" | "info" };
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
/** Long names take a second line instead of being cut, breaking at an underscore where one is near. */
const twoLines = (t: string, n: number): [string, string?] => { if (t.length <= n) return [t]; const at = Math.max(t.lastIndexOf("_", n - 1), t.lastIndexOf(" ", n - 1)); const cut = at > n / 3 ? at + 1 : n; return [t.slice(0, cut), clip(t.slice(cut), n)]; };

/** The whole path left to right. Logos and status icons sit in a layer beside the drawing, so it stays one svg of plain shapes and text. */
export function FlowGraph({ nodes, edges, selected, onPick }: { nodes: FlowNode[]; edges: { from: string; to: string }[]; selected?: string; onPick: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null), [avail, setAvail] = useState(0);
  useEffect(() => { const el = box.current?.parentElement; if (!el) return; const ro = new ResizeObserver(() => setAvail(el.clientWidth - 32)); ro.observe(el); return () => ro.disconnect(); }, []);
  const cols = [...new Set(nodes.map((n) => n.col))].sort((a, b) => a - b), pos = new Map<string, { x: number; y: number }>();
  // Columns share the width; only a very deep graph scrolls
  const GX = 32, W = Math.max(136, Math.min(280, avail ? (avail - GX * (cols.length - 1)) / cols.length : 212)), H = 72, GY = 8, TOP = 30, chars = Math.floor((W - 48) / 6.4);
  const heads: { x: number; label: string }[] = [];
  cols.forEach((col, c) => {
    const x = c * (W + GX) + 1, here = nodes.filter((n) => n.col === col);
    // Rows follow the average height of what feeds them, which keeps edges from crossing more than they must
    const rank = (n: FlowNode) => { const ys = edges.filter((e) => e.to === n.id && pos.has(e.from)).map((e) => pos.get(e.from)!.y); return ys.length ? ys.reduce((a, b) => a + b) / ys.length : Infinity; };
    here.map((n) => [n, rank(n)] as const).sort((a, b) => a[1] - b[1]).forEach(([n], i) => pos.set(n.id, { x, y: i * (H + GY) + TOP }));
    if (heads.at(-1)?.label !== here[0].stage) heads.push({ x, label: here[0].stage });
  });
  const width = cols.length * (W + GX) - GX + 2, height = Math.max(...[...pos.values()].map((p) => p.y)) + H + 2;
  const near = new Set<string>();
  if (selected) { near.add(selected); edges.forEach((e) => { if (e.to === selected) near.add(e.from); if (e.from === selected) near.add(e.to); }); }
  const dim = (id: string) => (selected && !near.has(id) ? 0.45 : 1);
  return (
    <div ref={box} className="fl-canvas" style={{ width, height }}>
      <div className="fl-graph">
        <svg width={width} height={height} role="group" aria-label="Flow from pipelines through models to dashboards and exports">
          {heads.map((h) => <text key={h.label} x={h.x} y={14} fontSize={12} fontWeight={500} fill="var(--ink-2)">{h.label}</text>)}
          {edges.map((e, i) => { const a = pos.get(e.from)!, b = pos.get(e.to)!, x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, on = selected && (e.from === selected || e.to === selected); return <path key={i} d={`M${x1} ${y1}C${x1 + 24} ${y1} ${x2 - 24} ${y2} ${x2} ${y2}`} fill="none" stroke={on ? "var(--accent)" : "var(--line-2)"} strokeWidth={on ? 1.8 : 1} />; })}
          {nodes.map((n) => { const p = pos.get(n.id)!, on = n.id === selected; return <g key={n.id} className="fl-node" transform={`translate(${p.x},${p.y})`} opacity={dim(n.id)} role="button" tabIndex={0} aria-pressed={on} aria-label={`${n.name}: ${n.status}`} onClick={() => onPick(n.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(n.id); } }}>
            <title>{n.name}</title>
            <rect width={W} height={H} rx={2} fill={on ? "var(--accent-soft)" : "var(--bg)"} stroke={on ? "var(--accent)" : n.tone === "bad" ? "var(--bad)" : "var(--line-2)"} strokeWidth={on ? 2 : 1} />
            <text x={40} fontSize={13} fontWeight={500} fill="var(--ink)">{twoLines(n.name, chars).map((l, k) => <tspan key={k} x={40} y={22 + k * 16}>{l}</tspan>)}</text>
            <text x={58} y={60} fontSize={12} fill="var(--ink-2)">{clip(n.status, chars - 2)}</text>
          </g>; })}
        </svg>
      </div>
      <div className="fl-glyphs" aria-hidden="true">
        {nodes.map((n) => { const p = pos.get(n.id)!; return <span key={n.id} style={{ opacity: dim(n.id) }}>
          <span style={{ left: p.x + 10, top: p.y + 10 }}>{n.glyph}</span>
          <span className={n.tone ? `fl-tone ${n.tone}` : "fl-tone"} style={{ left: p.x + 40, top: p.y + 49 }}><Icon name={n.statusIcon} size={14} className={n.status === "Running" ? "spin" : undefined} /></span>
        </span>; })}
      </div>
    </div>
  );
}

