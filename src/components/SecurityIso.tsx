"use client";
import { Box, Disc, Grad, OnFace, OnGround, P, type Tone } from "./HeroIso";
import { Icon, type IconName } from "./icons";

const g = (id: string) => `url(#s-${id})`;
const SLAB: Tone = { top: g("d-t"), left: g("d-l"), right: g("d-r"), edge: "rgba(255,255,255,.34)" };
const BLOCK: Tone = { top: g("k-t"), left: g("d-l"), right: g("k-r"), edge: "rgba(255,255,255,.42)", cyl: g("c-k") };
const GLASS: Tone = { top: g("g-t"), left: g("g-l"), right: g("g-r"), edge: "rgba(173,203,250,.85)" };
const BLUE: Tone = { top: g("b-t"), left: g("b-l"), right: g("b-r"), edge: "#8fb2ee", cyl: g("c-b") };
const AMBER_SLAB: Tone = { top: g("m-t"), left: g("m-l"), right: g("m-r"), edge: "#f0c14b" };
const AQUA: Tone = { top: g("a-t"), left: g("a-l"), right: g("a-r"), edge: "#a5f1e4", cyl: g("c-a") };

const R = 2.8, GAP = 5;
const Slab = ({ z, t = SLAB }: { z: number; t?: Tone }) => <Box x={-R} y={-R} z={z} w={R * 2} d={R * 2} h={0.16} t={t} />;
const Mark = ({ x, y, z, icon, color }: { x: number; y: number; z: number; icon: IconName; color: string }) => <OnFace x={x} y={y} z={z}><g color={color} transform="translate(6 5)"><Icon name={icon} size={22} /></g></OnFace>;

function Sources({ z }: { z: number }) {
  const top = z + 0.16;
  return <g><Slab z={z} />
    {[-1.75, 0, 1.75].map((y) => <g key={y}><Box x={-1.05} y={y - 0.65} z={top} w={2.1} d={1.3} h={0.95} t={BLOCK} />
      <Mark x={1.05} y={y + 0.65} z={top + 0.95} icon="eye" color="#a5f1e4" /></g>)}
  </g>;
}
function Masking({ z }: { z: number }) {
  const top = z + 0.16, on = new Set(["0-1", "0-2", "1-0", "1-3", "2-1", "2-2", "3-0", "3-3"]);
  return <g><Slab z={z} t={AMBER_SLAB} />
    <OnGround x={-2.2} y={-2.2} z={top}>
      {[0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => <rect key={`${r}-${c}`} x={c * 39 + 2} y={r * 39 + 2} width="33" height="33" rx="4" fill={on.has(`${r}-${c}`) ? "#f0c14b" : "rgba(255,255,255,.08)"} stroke={on.has(`${r}-${c}`) ? "#f7dc95" : "rgba(255,255,255,.2)"} />))}
      <rect className="lp-scan" x="-3" y="-2" width="162" height="10" rx="2" fill="#fff5d6" />
    </OnGround>
  </g>;
}
function Warehouse({ z }: { z: number }) {
  const top = z + 0.16, a = 2.25, t = 0.14, h = 1.45;
  return <g><Slab z={z} />
    <Box x={-a} y={-a} z={top} w={a * 2} d={t} h={h} t={GLASS} /><Box x={-a} y={-a} z={top} w={t} d={a * 2} h={h} t={GLASS} />
    {[0, 0.62, 1.24].map((d, k) => <Disc key={d} cx={0} cy={0} z={top + d} r={1.05} h={0.46} t={k === 2 ? BLUE : BLOCK} />)}
    <Box x={a - t} y={-a} z={top} w={t} d={a * 2} h={h} t={GLASS} /><Box x={-a} y={a - t} z={top} w={a * 2} d={t} h={h} t={GLASS} />
    <Mark x={a} y={0.75} z={top + h - 0.1} icon="x" color="#8fb2ee" />
  </g>;
}
function Roles({ z }: { z: number }) {
  const top = z + 0.16;
  const person = (x: number, y: number, t: Tone) => { const [a, b] = P(x, y, top + 1.26); return <g key={`${x}${y}`}><Disc cx={x} cy={y} z={top} r={0.4} h={0.9} t={t} /><circle cx={a} cy={b} r="11" fill={t.top} stroke={t.edge} /></g>; };
  return <g><Slab z={z} />
    <Box x={-2.1} y={-1.95} z={top} w={0.22} d={3.9} h={2.1} t={BLOCK} />
    <OnFace x={-1.88} y={1.95} z={top + 2.1}><g color="#a5f1e4" transform="translate(44 10)"><Icon name="shield" size={36} /></g>{[0, 1].map((k) => <rect key={k} x={30 + k * 8} y={52 + k * 10} width={64 - k * 16} height="4" rx="2" fill="#a5f1e4" opacity={0.6 - k * 0.2} />)}</OnFace>
    {person(0.3, -1.45, BLUE)}{person(0.3, 0, AQUA)}{person(0.3, 1.45, BLOCK)}
  </g>;
}

const LAYERS: [string, string, string, (z: number) => React.ReactNode][] = [
  ["Roles and audit", "Checked on every API call", "#fff", (z) => <Roles z={z} />],
  ["Sandboxed warehouse", "SQL can't read files or the network", "#8fb2ee", (z) => <Warehouse z={z} />],
  ["Masking", "Originals never reach the disk", "#f0c14b", (z) => <Masking z={z} />],
  ["Read-only sources", "No session can write back", "#fff", (z) => <Sources z={z} />],
];

/** Same world coordinates as the hero; the viewBox frames this scene. */
export default function SecurityIso() {
  return (
    <svg className="lp-stack" viewBox="190 -372 690 752" role="img" aria-label="Four layers protect your data. Read-only sources, masking that keeps originals off the disk, a sandboxed warehouse, and roles with an audit trail.">
      <defs>
        <Grad id="s-d-t" stops={["#34443f", "#171f1d"]} /><Grad id="s-d-l" stops={["#10171a", "#090d0d"]} /><Grad id="s-d-r" stops={["#1a2422", "#0e1413"]} />
        <Grad id="s-k-t" stops={["#4a5e59", "#2b3835"]} /><Grad id="s-k-r" stops={["#2a3734", "#182120"]} /><Grad id="s-c-k" across stops={["#1a2422", "#55695f", "#2b3835", "#121918"]} />
        <Grad id="s-g-t" stops={["rgba(190,214,252,.5)", "rgba(100,150,240,.14)"]} /><Grad id="s-g-l" stops={["rgba(143,178,238,.34)", "rgba(79,140,240,.06)"]} /><Grad id="s-g-r" stops={["rgba(190,214,252,.42)", "rgba(79,140,240,.1)"]} />
        <Grad id="s-b-t" stops={["#5a92f4", "#1f5fe0"]} /><Grad id="s-b-l" stops={["#123a86", "#0c2a63"]} /><Grad id="s-b-r" stops={["#2460cf", "#153f95"]} /><Grad id="s-c-b" across stops={["#10357c", "#4a84f0", "#1f56c4", "#0d2c68"]} />
        <Grad id="s-m-t" stops={["#46391a", "#201a0c"]} /><Grad id="s-m-l" stops={["#17120a", "#0d0a05"]} /><Grad id="s-m-r" stops={["#2a2110", "#171208"]} />
        <Grad id="s-a-t" stops={["#8bf3e1", "#3fd6bf"]} /><Grad id="s-a-l" stops={["#14796d", "#0c5a50"]} /><Grad id="s-a-r" stops={["#1da08f", "#137a6c"]} /><Grad id="s-c-a" across stops={["#0f6b60", "#62e8d2", "#1da08f", "#0b534a"]} />
        <filter id="s-soft" x="-40%" y="-70%" width="180%" height="240%"><feGaussianBlur stdDeviation="20" /></filter>
      </defs>
      {[["#4f8cf0", 1], ["#f0c14b", 2]].map(([c, i]) => { const [x, y] = P(0, 0, (i as number) * GAP); return <ellipse key={i} cx={x} cy={y} rx="150" ry="74" fill={c as string} opacity=".2" filter="url(#s-soft)" />; })}
      {LAYERS.map(([a, b, c, draw], i) => {
        const z = i * GAP, [cx, cy] = P(0, 0, z + 0.16), [lx, ly] = P(R, -R, z + 0.08);
        return <g key={a}>
          <g className="lp-float" style={{ animationDelay: `${-i * 1.1}s` }}>{draw(z)}</g>
          {i < LAYERS.length - 1 && <g>
            <path d={`M${cx} ${cy}V${cy - GAP * 34 + 8}`} stroke="rgba(255,255,255,.2)" strokeDasharray="3 6" />
            {[0, 1].map((k) => <g key={k} className="lp-packet" style={{ animationDelay: `${-(i * 0.5 + k * 1.2)}s`, "--drop": `${GAP * 34 - 8}px` } as React.CSSProperties}><circle cx={cx} cy={cy - GAP * 34 + 8} r="8" fill={i === 1 ? "#f0c14b" : "#3fe0c8"} opacity=".22" /><circle cx={cx} cy={cy - GAP * 34 + 8} r="3.500" fill={i === 1 ? "#f7dc95" : "#a5f1e4"} /></g>)}
          </g>}
          <g className="lbl">
            <path d={`M${lx} ${ly}H${lx + 34}`} stroke={c} opacity=".6" /><circle cx={lx + 34} cy={ly} r="2.500" fill={c} />
            <text x={lx + 46} y={ly - 3} fill={c}>{a}</text><text className="sub" x={lx + 46} y={ly + 18}>{b}</text>
          </g>
        </g>;
      })}
    </svg>
  );
}
