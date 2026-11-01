const REF = /\{\{\s*ref\(\s*['"](\w+)['"]\s*\)\s*\}\}/g;
const SRC = /\{\{\s*source\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]\s*\)\s*\}\}/g;

export const refsOf = (sql: string) => [...sql.matchAll(REF)].map((m) => m[1]);
export const sourcesOf = (sql: string) => [...sql.matchAll(SRC)].map((m) => `raw_${m[1]}.${m[2]}`);
export const compileSql = (sql: string) =>
  sql.replace(REF, (_, n) => `"analytics"."${n}"`).replace(SRC, (_, a, b) => `"raw_${a}"."${b}"`);

/** Dependency order; throws on an unknown ref or a cycle so a bad model never half-runs the graph. */
/** Adds the tables dbt-style Python names in code to the inputs kept beside it, so it builds in the right order and shows in lineage. */
export function syncPythonInputs(python: string, sql: string) {
  const refs = [...python.matchAll(/dbt\.ref\(\s*["'](\w+)["']/g)].map((m) => `{{ ref('${m[1]}') }}`);
  const srcs = [...python.matchAll(/dbt\.source\(\s*["'](\w+)["']\s*,\s*["'](\w+)["']/g)].map((m) => `{{ source('${m[1]}', '${m[2]}') }}`);
  const known = new Set(refsOf(sql)), knownSrc = new Set(sourcesOf(sql));
  const add = [...new Set([...refs, ...srcs])].filter((t) => !known.has(refsOf(t)[0]) && !knownSrc.has(sourcesOf(t)[0]));
  return [sql, ...add].filter(Boolean).join("\n");
}
export function topoSort<T extends { name: string; sql: string }>(models: T[], depsOf: (m: T) => string[] = (m) => refsOf(m.sql)): T[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const seen = new Map<string, 1 | 2>(), out: T[] = [];
  const visit = (m: T, path: string[]) => {
    if (seen.get(m.name) === 2) return;
    if (seen.get(m.name) === 1) throw new Error(`Models depend on each other: ${[...path, m.name].join(" > ")}`);
    seen.set(m.name, 1);
    for (const r of depsOf(m)) {
      const dep = byName.get(r);
      if (!dep) throw new Error(`Model ${m.name} refers to ${r}, which doesn't exist`);
      visit(dep, [...path, m.name]);
    }
    seen.set(m.name, 2); out.push(m);
  };
  models.forEach((m) => visit(m, []));
  return out;
}

/**
 * The order to build in, and the models that can't be built with why. One broken model stops only itself and what depends on it, so a cycle in one corner of a project doesn't stop the rest.
 */
export function planBuild<T extends { name: string; sql: string }>(models: T[], depsOf: (m: T) => string[] = (m) => refsOf(m.sql)) {
  const byName = new Map(models.map((m) => [m.name, m])), blocked = new Map<string, string>();
  for (const m of models) { const gone = depsOf(m).find((d) => !byName.has(d)); if (gone) blocked.set(m.name, `Model ${m.name} refers to ${gone}, which doesn't exist`); }
  // Whatever can't be reached by repeatedly taking models whose inputs are all ready is in, or after, a cycle
  const ready = new Set<string>();
  for (let moved = true; moved;) {
    moved = false;
    for (const m of models) if (!ready.has(m.name) && !blocked.has(m.name) && depsOf(m).every((d) => ready.has(d))) { ready.add(m.name); moved = true; }
  }
  const stuck = models.filter((m) => !ready.has(m.name) && !blocked.has(m.name));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => depsOf(byName.get(from)!).some((d) => byName.has(d) && !seen.has(d) && (seen.add(d), d === to || reaches(d, to, seen)));
  for (const m of stuck) {
    if (reaches(m.name, m.name)) { const next = depsOf(m).find((d) => byName.has(d) && reaches(d, m.name)); blocked.set(m.name, `Models depend on each other: ${m.name} > ${next} > ... > ${m.name}`); }
    else blocked.set(m.name, `Model ${m.name} depends on a model that can't be built`);
  }
  return { order: topoSort(models.filter((m) => ready.has(m.name)), (m) => depsOf(m)), blocked };
}

/** Only what leads to a table and what it leads to, with the columns closed up, so one table's lineage stays readable. Empty if nothing connects to it. */
export function focusLineage(g: { nodes: GNode[]; edges: { from: string; to: string }[] }, id: string) {
  const walk = (from: "from" | "to", to: "from" | "to") => { const seen = new Set([id]); for (const stack = [id]; stack.length;) { const at = stack.pop()!; for (const e of g.edges) if (e[from] === at && !seen.has(e[to])) { seen.add(e[to]); stack.push(e[to]); } } return seen; };
  const up = walk("to", "from"), down = walk("from", "to"), keep = new Set([...up, ...down]);
  const edges = g.edges.filter((e) => keep.has(e.from) && keep.has(e.to) && ((up.has(e.from) && up.has(e.to)) || (down.has(e.from) && down.has(e.to))));
  if (!edges.length) return { nodes: [], edges: [] };
  const layers = [...new Set(g.nodes.filter((n) => keep.has(n.id)).map((n) => n.layer))].sort((a, b) => a - b);
  return { nodes: g.nodes.filter((n) => keep.has(n.id)).map((n) => ({ ...n, layer: layers.indexOf(n.layer) })), edges };
}

export type GNode = { id: string; label: string; kind: "source" | "model"; layer: number };
export function lineage(models: { name: string; sql: string }[]) {
  const nodes = new Map<string, GNode>(), edges: { from: string; to: string }[] = [];
  const layer = new Map<string, number>();
  for (const m of topoSort(models)) {
    const refs = refsOf(m.sql), srcs = sourcesOf(m.sql);
    srcs.forEach((s) => { nodes.set(s, { id: s, label: s, kind: "source", layer: 0 }); edges.push({ from: s, to: m.name }); });
    refs.forEach((r) => edges.push({ from: r, to: m.name }));
    const l = Math.max(0, ...refs.map((r) => layer.get(r) ?? 0)) + 1;
    layer.set(m.name, l); nodes.set(m.name, { id: m.name, label: m.name, kind: "model", layer: l });
  }
  return { nodes: [...nodes.values()], edges };
}
