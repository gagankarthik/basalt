// Node selection ported from dbt-core's core/dbt/graph selector_spec.py, graph.py and selector.py (Apache-2.0); see NOTICE.
import { effectiveOf, type Ctx } from "./dbt-compile.ts";

export const nodeId = (m: { name: string; kind?: string; materialized?: string }) => `${m.kind === "seed" ? "seed" : m.materialized === "snapshot" ? "snapshot" : "model"}.basalt.${m.name}`;
type GraphNode = { id: string; name: string; type: "model" | "seed" | "snapshot" | "source" | "exposure"; tags: string[]; config: Record<string, unknown>; parents: string[] };

export function projectGraph(ctx: Ctx) {
  const nodes = new Map<string, GraphNode>();
  const declared = (ctx.project.sources ?? []).map((s) => `raw_${s.source}.${s.table}`);
  const src = (full: string) => {
    const [s, t] = [full.slice(4, full.indexOf(".")), full.slice(full.indexOf(".") + 1)], id = `source.basalt.${s}.${t}`;
    if (!nodes.has(id)) nodes.set(id, { id, name: `${s}.${t}`, type: "source", tags: [], config: {}, parents: [] });
    return id;
  };
  declared.forEach(src);
  for (const m of ctx.models) {
    const e = effectiveOf(m, ctx), id = nodeId(e);
    nodes.set(id, { id, name: m.name, type: id.split(".")[0] as GraphNode["type"], tags: e.tags ?? [], config: { materialized: e.materialized, incremental_strategy: e.incrementalStrategy, on_schema_change: e.onSchemaChange, strategy: e.snapshotStrategy }, parents: [...e.deps.map((d) => { const x = ctx.byName.get(d); return x ? nodeId(effectiveOf(x, ctx)) : `model.basalt.${d}`; }), ...e.srcs.map(src)] });
  }
  for (const x of ctx.project.exposures ?? []) nodes.set(`exposure.basalt.${x.name}`, { id: `exposure.basalt.${x.name}`, name: x.name, type: "exposure", tags: [], config: {}, parents: x.dependsOn.map((d) => { const m = ctx.byName.get(d); return m ? nodeId(effectiveOf(m, ctx)) : `model.basalt.${d}`; }) });
  return nodes;
}

const RAW_SELECTOR = /^(@)?((\d*)\+)?(?:([\w.]+):)?(.*?)(\+(\d*))?$/;
const wild = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

function walk(nodes: Map<string, GraphNode>, start: Set<string>, next: (id: string) => string[], depth?: number) {
  const out = new Set<string>(); let frontier = [...start];
  for (let d = 0; frontier.length && (depth == null || d < depth); d++) {
    const found: string[] = [];
    for (const id of frontier) for (const n of next(id)) if (nodes.has(n) && !out.has(n)) { out.add(n); found.push(n); }
    frontier = found;
  }
  return out;
}
function criteria(raw: string, nodes: Map<string, GraphNode>, children: Map<string, string[]>) {
  const m = RAW_SELECTOR.exec(raw);
  if (!m) throw new Error(`Can't read the selector "${raw}".`);
  const [, at, parentsOp, parentsDepth, method, value, childrenOp, childrenDepth] = m;
  if (at && childrenOp) throw new Error(`"${raw}" can't use both @ and a trailing +.`);
  if (!value) throw new Error(`The selector "${raw}" has no value.`);
  const rx = wild(value), matched = new Set<string>();
  for (const n of nodes.values()) {
    let hit: boolean;
    if (!method || method === "fqn") hit = n.type !== "source" && n.type !== "exposure" && (rx.test(n.name) || rx.test(`basalt.${n.name}`));
    else if (method === "tag") hit = n.tags.some((t) => rx.test(t));
    else if (method === "source") hit = n.type === "source" && (rx.test(n.name) || rx.test(n.name.split(".")[0]));
    else if (method === "exposure") hit = n.type === "exposure" && rx.test(n.name);
    else if (method === "resource_type") hit = rx.test(n.type);
    else if (method.startsWith("config.")) { const v = n.config[method.slice(7)]; hit = v != null && rx.test(String(v)); }
    else throw new Error(`The selector method ${method} isn't available here. Use a name, tag:, source:, exposure:, resource_type: or config.`);
    if (hit) matched.add(n.id);
  }
  const out = new Set(matched), up = (id: string) => nodes.get(id)?.parents ?? [], down = (id: string) => children.get(id) ?? [];
  if (at) { const below = new Set([...matched, ...walk(nodes, matched, down)]); below.forEach((x) => out.add(x)); walk(nodes, below, up).forEach((x) => out.add(x)); }
  if (parentsOp) walk(nodes, matched, up, parentsDepth ? Number(parentsDepth) : undefined).forEach((x) => out.add(x));
  if (childrenOp) walk(nodes, matched, down, childrenDepth ? Number(childrenDepth) : undefined).forEach((x) => out.add(x));
  return out;
}
const parseSet = (spec: string, nodes: Map<string, GraphNode>, children: Map<string, string[]>) => {
  const out = new Set<string>();
  for (const part of spec.trim().split(/\s+/).filter(Boolean)) {
    const sets = part.split(",").map((c) => criteria(c, nodes, children));
    for (const id of sets[0]) if (sets.every((s) => s.has(id))) out.add(id);
  }
  return out;
};
/** Space means union, comma means intersection, and exclude is taken away last, in dbt's order. Returns buildable model names. */
export function selectNodes(ctx: Ctx, select?: string, exclude?: string): string[] {
  const nodes = projectGraph(ctx), children = new Map<string, string[]>();
  for (const n of nodes.values()) for (const p of n.parents) children.set(p, [...(children.get(p) ?? []), n.id]);
  const chosen = select?.trim() ? parseSet(select, nodes, children) : new Set(nodes.keys());
  if (exclude?.trim()) parseSet(exclude, nodes, children).forEach((x) => chosen.delete(x));
  return [...chosen].map((id) => nodes.get(id)!).filter((n) => n.type !== "source" && n.type !== "exposure").map((n) => n.name);
}
