"use client";
import type { ReactNode } from "react";
import { Icon, Logo, type BrandName } from "./icons";

const U = 34, OX = 392, OY = 262, COS = 0.866, SIN = 0.5;
const STEP = 3.6;
/** World units to screen: x runs down-right, y runs down-left, z runs up. */
export const P = (x: number, y: number, z = 0): [number, number] => [OX + (x - y) * COS * U, OY + (x + y) * SIN * U - z * U];
const pts = (...list: [number, number, number?][]) => list.map(([x, y, z]) => P(x, y, z).map((n) => n.toFixed(1)).join(",")).join(" ");
const line = (...list: [number, number][]) => "M" + list.map(([x, y]) => P(x, y).map((n) => n.toFixed(1)).join(" ")).join("L");

export type Tone = { top: string; left: string; right: string; edge: string; cyl?: string };
/** One linear gradient: vertical by default, horizontal for round surfaces. Ids stay unique per scene because a hidden SVG's gradients don't resolve. */
export const Grad = ({ id, stops, across }: { id: string; stops: string[]; across?: boolean }) => (
  <linearGradient id={id} x1="0" y1="0" x2={across ? 1 : 0} y2={across ? 0 : 1}>{stops.map((c, i) => <stop key={i} offset={i / (stops.length - 1)} stopColor={c} />)}</linearGradient>
);
const g = (id: string) => `url(#h-${id})`;
const SLATE: Tone = { top: g("w-t"), left: g("w-l"), right: g("w-r"), edge: "rgba(96,114,142,.6)", cyl: g("c-w") };
const PLATE: Tone = { top: g("p-t"), left: g("w-l"), right: g("w-r"), edge: "rgba(96,114,142,.5)" };
const BLUE: Tone = { top: g("b-t"), left: g("b-l"), right: g("b-r"), edge: "#0f3f9e", cyl: g("c-b") };
const AQUA: Tone = { top: g("a-t"), left: g("a-l"), right: g("a-r"), edge: "#0b7f70" };
const AMBER: Tone = { top: g("m-t"), left: g("m-l"), right: g("m-r"), edge: "#946a0c" };
const WHITE: Tone = { top: g("p-w"), left: g("w-l"), right: g("w-r"), edge: "rgba(96,114,142,.55)" };

export function Box({ x, y, z = 0, w, d, h, t = SLATE }: { x: number; y: number; z?: number; w: number; d: number; h: number; t?: Tone }) {
  return (
    <g stroke={t.edge} strokeWidth="1" strokeLinejoin="round">
      <polygon points={pts([x, y + d, z + h], [x + w, y + d, z + h], [x + w, y + d, z], [x, y + d, z])} fill={t.left} />
      <polygon points={pts([x + w, y, z + h], [x + w, y + d, z + h], [x + w, y + d, z], [x + w, y, z])} fill={t.right} />
      <polygon points={pts([x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h])} fill={t.top} />
      <polyline points={pts([x, y + d, z + h], [x + w, y + d, z + h], [x + w, y, z + h])} fill="none" stroke="rgba(255,255,255,.6)" strokeWidth=".8" />
    </g>
  );
}
/** Draws children flat on a surface, so icons foreshorten like the rest of the scene. */
export const OnGround = ({ x, y, z = 0, children }: { x: number; y: number; z?: number; children: ReactNode }) => { const [a, b] = P(x, y, z); return <g transform={`matrix(${COS} ${SIN} ${-COS} ${SIN} ${a} ${b})`}>{children}</g>; };
/** Face looking along +x: u runs toward the viewer's right, v runs down. */
export const OnFace = ({ x, y, z, children }: { x: number; y: number; z: number; children: ReactNode }) => { const [a, b] = P(x, y, z); return <g transform={`matrix(${COS} ${-SIN} 0 1 ${a} ${b})`}>{children}</g>; };

export function Disc({ cx, cy, z, r, h, t }: { cx: number; cy: number; z: number; r: number; h: number; t: Tone }) {
  const [a, top] = P(cx, cy, z + h), [, bot] = P(cx, cy, z), rx = r * U * 1.22, ry = rx * 0.577;
  return (
    <g stroke={t.edge} strokeWidth="1">
      <path d={`M${a - rx} ${top}V${bot}A${rx} ${ry} 0 0 0 ${a + rx} ${bot}V${top}Z`} fill={t.cyl ?? t.right} />
      <ellipse cx={a} cy={top} rx={rx} ry={ry} fill={t.top} />
      <ellipse cx={a} cy={top} rx={rx * 0.62} ry={ry * 0.62} fill="none" stroke="rgba(23,26,33,.2)" />
    </g>
  );
}

const Plate = ({ cx, cy, t = PLATE }: { cx: number; cy: number; t?: Tone }) => <Box x={cx - 1.7} y={cy - 1.7} w={3.4} d={3.4} h={0.14} t={t} />;
const at = (i: number): [number, number] => [i * STEP, -i * STEP];

function Masking() {
  const [cx, cy] = at(0);
  return <g>
    <Plate cx={cx} cy={cy} />
    <Box x={cx - 0.25} y={cy - 1.25} z={0.14} w={0.5} d={2.5} h={0.22} t={AMBER} />
    <Box x={cx - 0.17} y={cy - 1.12} z={0.36} w={0.34} d={2.24} h={2.5} />
    <Box x={cx - 0.25} y={cy - 1.25} z={2.86} w={0.5} d={2.5} h={0.2} t={AMBER} />
    <OnFace x={cx + 0.17} y={cy + 1.12} z={2.86}>
      <g transform="translate(23 12)" color="#b27c0e"><Icon name="shield" size={40} /></g>
      {[58, 68, 78].map((v, k) => <rect key={v} x={18 + k * 3} y={v} width={50 - k * 6} height="4" rx="2" fill="#c28a12" opacity={0.75 - k * 0.2} />)}
    </OnFace>
  </g>;
}
function Warehouse() {
  const [cx, cy] = at(1);
  return <g>
    <Plate cx={cx} cy={cy} />
    {[0.14, 1.12, 2.1].map((z, k) => <Disc key={z} cx={cx} cy={cy} z={z} r={1.15} h={0.72} t={k === 2 ? BLUE : SLATE} />)}
  </g>;
}
function Transform() {
  const [cx, cy] = at(2);
  return <g>
    <Plate cx={cx} cy={cy} />
    <Box x={cx - 1.15} y={cy - 1.15} z={0.14} w={2.3} d={2.3} h={1.5} />
    <OnFace x={cx + 1.15} y={cy + 1.15} z={1.64}>
      <g fill="none" stroke="#0f9d8a" strokeWidth="1.800"><path d="M12 12C24 12 22 25 34 25M12 38C24 38 22 25 34 25H52" /></g>
      {[[10, 12], [10, 38], [34, 25], [54, 25]].map(([a, b]) => <circle key={`${a}${b}`} cx={a} cy={b} r="3.600" fill="#0f9d8a" />)}
    </OnFace>
    <Box x={cx - 0.72} y={cy - 0.72} z={1.64} w={1.44} d={1.44} h={0.72} t={BLUE} />
    <Box x={cx - 0.36} y={cy - 0.36} z={2.36} w={0.72} d={0.72} h={0.5} t={AQUA} />
  </g>;
}
function Dashboard() {
  const [cx, cy] = at(3);
  return <g>
    <Plate cx={cx} cy={cy} />
    <Box x={cx - 0.5} y={cy - 0.5} z={0.14} w={1} d={1} h={0.16} t={AQUA} />
    <Box x={cx - 0.1} y={cy - 0.1} z={0.3} w={0.2} d={0.2} h={0.5} />
    <Box x={cx - 0.13} y={cy - 1.45} z={0.8} w={0.26} d={2.9} h={2.3} />
    <OnFace x={cx + 0.13} y={cy + 1.45} z={3.1}>
      <rect x="5" y="5" width="104" height="68" rx="3" fill="#f6f8fb" stroke="#aab4c3" />
      {[16, 26, 21, 36, 31, 46].map((h, k) => <rect key={k} x={13 + k * 15} y={66 - h} width="9" height={h} rx="1" fill={k === 5 ? "#0f9d8a" : "#4124fb"} />)}
    </OnFace>
  </g>;
}

const SOURCES: [BrandName, number][] = [["postgres", -4], ["mysql", -2], ["mariadb", 0], ["parquet", 2], ["json", 4]];
const STATIONS: [string, string, string][] = [["Masking", "Before storage", "#b27c0e"], ["Warehouse", "Columnar and fast", "#4124fb"], ["Transformations", "SQL, Python, no-code", "#4124fb"], ["Dashboards", "For the whole team", "#4124fb"]];

export default function HeroIso() {
  const bus = line([-2.2, -4], [-2.2, 4]);
  const feeds = SOURCES.map(([, y]) => line([-5.1, y], [-2.2, y]));
  const trunk = line([-2.2, 0], [0, 0], [STEP, 0], at(1), [2 * STEP, -STEP], at(2), [3 * STEP, -2 * STEP], at(3));
  return (
    <svg className="lp-river" viewBox="0 0 1200 425" role="img" aria-label="PostgreSQL, MySQL, MariaDB, Parquet and JSON flow into Basalt, through masking before storage, a warehouse, transformations in SQL, Python or no-code, and dashboards for the whole team">
      <defs>
        <Grad id="h-w-t" stops={["#ffffff", "#eef3fb"]} /><Grad id="h-w-l" stops={["#d3dce9", "#b9c5d7"]} /><Grad id="h-w-r" stops={["#eaeff7", "#d3dce9"]} />
        <Grad id="h-p-t" stops={["rgba(255,255,255,.92)", "rgba(226,235,250,.62)"]} /><Grad id="h-p-w" stops={["#ffffff", "#f3f6fb"]} />
        <Grad id="h-b-t" stops={["#7a66ff", "#4124fb"]} /><Grad id="h-b-l" stops={["#241490", "#190d6b"]} /><Grad id="h-b-r" stops={["#3a20d8", "#28169c"]} />
        <Grad id="h-a-t" stops={["#8bf3e1", "#3fd6bf"]} /><Grad id="h-a-l" stops={["#10a08d", "#0a7a6b"]} /><Grad id="h-a-r" stops={["#35cab5", "#179a88"]} />
        <Grad id="h-m-t" stops={["#fcdc7c", "#efb72c"]} /><Grad id="h-m-l" stops={["#c48c13", "#91660a"]} /><Grad id="h-m-r" stops={["#e6ae2d", "#bb8515"]} />
        <Grad id="h-c-w" across stops={["#bcc8da", "#f6f8fc", "#dfe6f0", "#aebbcf"]} /><Grad id="h-c-b" across stops={["#1f1180", "#6650ff", "#3a20d8", "#170c66"]} />
        <filter id="h-soft" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="11" /></filter>
      </defs>
      {[0, 1, 2, 3].map((i) => { const [x, y] = at(i); return <polygon key={i} points={pts([x - 1.5, y - 1.2], [x + 2.2, y - 1.2], [x + 2.2, y + 2.2], [x - 1.5, y + 2.2])} fill="rgb(40 28 130 / .2)" filter="url(#h-soft)" />; })}
      {SOURCES.map(([l, y]) => <polygon key={l} points={pts([-6.8, y - 0.6], [-4.7, y - 0.6], [-4.7, y + 1.2], [-6.8, y + 1.2])} fill="rgb(40 28 130 / .16)" filter="url(#h-soft)" />)}
      {feeds.map((d, i) => <g key={d}><path d={d} className="lp-stream base" /><path d={d} className="lp-stream flow" style={{ animationDelay: `${-i * 0.4}s` }} /></g>)}
      <path d={bus} className="lp-stream base" /><path d={bus} className="lp-stream flow" />
      <path d={trunk} className="lp-trunk base" /><path d={trunk} className="lp-trunk flow" />
      {[...SOURCES].sort((a, b) => a[1] - b[1]).map(([logo, y], i) => <g key={logo} className="lp-float small" style={{ animationDelay: `${-i * 0.7}s` }}>
        <Box x={-6.9} y={y - 0.85} w={1.8} d={1.7} h={0.42} t={WHITE} />
        <OnGround x={-6.9} y={y - 0.85} z={0.42}><g transform="translate(17 15)"><Logo name={logo} size={28} /></g></OnGround>
      </g>)}
      {[<Masking key="m" />, <Warehouse key="w" />, <Transform key="t" />, <Dashboard key="d" />].map((el, i) => <g key={i} className="lp-float" style={{ animationDelay: `${-i * 0.9}s` }}>{el}</g>)}
      {STATIONS.map(([a, b, c], i) => { const [x, y] = at(i), [sx, sy] = P(x, y), top = sy + 72; return <g key={a}>
        <path d={`M${sx} ${sy + 58}V${top - 2}`} stroke={c} strokeWidth="1.500" /><circle cx={sx} cy={sy + 58} r="2.500" fill={c} />
        <text x={sx} y={top + 16} textAnchor="middle">{a}</text><text className="sub" x={sx} y={top + 37} textAnchor="middle">{b}</text>
      </g>; })}
      {(() => { const top = P(...at(0))[1] + 72; return <g><text x={112} y={top + 16} textAnchor="middle">Your databases</text><text className="sub" x={112} y={top + 37} textAnchor="middle">Read-only</text></g>; })()}
    </svg>
  );
}
