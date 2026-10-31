const REF = /\{\{\s*ref\(\s*['"](\w+)['"]\s*\)\s*\}\}/g;
const SRC = /\{\{\s*source\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]\s*\)\s*\}\}/g;

export const refsOf = (sql: string) => [...sql.matchAll(REF)].map((m) => m[1]);
export const sourcesOf = (sql: string) => [...sql.matchAll(SRC)].map((m) => `raw_${m[1]}.${m[2]}`);
export const compileSql = (sql: string) =>
  sql.replace(REF, (_, n) => `"analytics"."${n}"`).replace(SRC, (_, a, b) => `"raw_${a}"."${b}"`);

/** Dependency order; throws on an unknown ref or a cycle so a bad model never half-runs the graph. */
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
