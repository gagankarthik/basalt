import { parseField } from "./semantic.ts";
import { filterSql, lit, q } from "./sql.ts";
import type { CfRule, Dashboard, Filter, Widget } from "./types.ts";

type Row = Record<string, unknown>;
/** Every table a visual reads, including ones it reaches through a relationship. */
export const tablesOf = (w: Widget) => [w.table, ...(w.rels ?? []).flatMap((r) => [r.fromTable, r.toTable])];

export const levelsOf = (w: Widget) => (w.dimension ? [w.dimension, ...(w.hierarchy ?? [])] : []);

/** The visual as it should run at this drill level: the next field, limited to the values chosen on the way down. */
export function atDrill(w: Widget, path: string[] = []): Widget {
  const levels = levelsOf(w);
  if (!path.length || levels.length < 2) return w;
  const depth = Math.min(path.length, levels.length - 1);
  return { ...w, dimension: levels[depth], dateGrain: undefined, filters: [...w.filters, ...path.slice(0, depth).map((value, i): Filter => ({ id: `drill${i}`, column: levels[i], op: "eq", value }))] };
}

/** Swaps {{name}} for the what-if slider's value. Only numbers reach the query. */
export function withParams(sql: string, values: Record<string, number>) {
  return sql.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, n) => (Number.isFinite(values[n]) ? String(values[n]) : all));
}

/** Quick calculations on the results, like Power BI's "show value as". */
export function applyCalc(rows: Row[], calc?: Widget["calc"]): Row[] {
  if (!calc) return rows;
  const nums = rows.map((r) => Number(r.m0) || 0);
  if (calc === "pct_total") { const total = nums.reduce((a, b) => a + b, 0); return rows.map((r, i) => ({ ...r, m0: total ? (nums[i] / total) * 100 : 0 })); }
  if (calc === "running") { let n = 0; return rows.map((r, i) => ({ ...r, m0: (n += nums[i]) })); }
  return rows.map((r, i) => ({ ...r, m0: i && nums[i - 1] ? ((nums[i] - nums[i - 1]) / Math.abs(nums[i - 1])) * 100 : null }));
}

export function matrixOf(rows: Row[]) {
  const label = (v: unknown) => (v == null ? "(empty)" : String(v));
  const cols = [...new Set(rows.map((r) => label(r.s)))].sort(), keys = [...new Set(rows.map((r) => label(r.d)))].sort(), cell = new Map<string, number>();
  for (const r of rows) cell.set(`${label(r.d)}\u0000${label(r.s)}`, Number(r.m0) || 0);
  const at = (k: string, c: string) => cell.get(`${k}\u0000${c}`) ?? null;
  const rowTotal = (k: string) => cols.reduce((n, c) => n + (at(k, c) ?? 0), 0), colTotal = (c: string) => keys.reduce((n, k) => n + (at(k, c) ?? 0), 0);
  return { cols, keys, at, rowTotal, colTotal, total: keys.reduce((n, k) => n + rowTotal(k), 0), values: [...cell.values()] };
}

/** The look of one value under conditional formatting. */
export function cfTone(v: number | null, values: number[], cf?: CfRule): { tone?: string; heat?: number; bar?: number } {
  if (v == null || !cf || cf.mode === "none") return {};
  const hi = Math.max(...values), lo = Math.min(...values), share = hi > lo ? (v - lo) / (hi - lo) : 1;
  if (cf.mode === "scale") return { heat: share };
  if (cf.mode === "bars") return { bar: hi > 0 ? Math.max(0, v / hi) : 0 };
  for (const r of cf.rules ?? []) if (r.op === "gt" ? v > r.value : v < r.value) return { tone: r.tone };
  return {};
}

/** A filter on one table, carried to a related table through the relationship between them. */
export function throughRelationship(d: Pick<Dashboard, "relationships">, sourceTable: string, target: string, f: Filter): Filter | null {
  const where = filterSql(f);
  if (!where || sourceTable === target) return null;
  for (const r of d.relationships ?? []) {
    const [mine, theirs, mineCol, theirCol] = r.fromTable === target && r.toTable === sourceTable ? [r.fromTable, r.toTable, r.fromCol, r.toCol] : r.toTable === target && r.fromTable === sourceTable ? [r.toTable, r.fromTable, r.toCol, r.fromCol] : [];
    if (!mine || !theirs) continue;
    const parts = theirs.split(".");
    return { id: `rel-${f.id}`, column: mineCol!, op: "in_query", value: `SELECT ${q(theirCol!)} FROM ${parts.map(q).join(".")} WHERE ${where}` };
  }
  return null;
}
export { lit };

export type CrossFilter = { widget: string; column: string; value: string } | null;
export const slicerFiltersOf = (onPage: Widget[], slicers: Record<string, string[]>) => onPage.filter((w) => w.type === "slicer" && slicers[w.id]?.length && w.dimension).map((w) => ({ column: w.dimension!, from: w.id, f: { id: w.id, column: w.dimension!, op: "in", values: slicers[w.id] } as Filter }));
/** The filters that reach one visual. They apply wherever the column exists, and otherwise through a relationship. */
export function filtersFor(d: Dashboard, w: Widget, hasCol: (w: Widget, column: string) => boolean, slicerFilters: ReturnType<typeof slicerFiltersOf>, cross: CrossFilter): Filter[] {
  const related = (from: string, f: Filter) => { const src = d.widgets.find((x) => x.id === from); const r = src && throughRelationship(d, src.table, w.table, f); return r ? [r] : []; };
  const crossF: Filter | null = cross && cross.widget !== w.id ? { id: "cross", column: cross.column, op: "eq", value: cross.value } : null;
  // A model visual takes any model field: the relationships carry it. Fields of a plain table have no route in
  if (w.model) return [...d.filters, ...slicerFilters.filter((s) => s.from !== w.id).map((s) => s.f), ...(crossF ? [crossF] : [])].filter((f) => parseField(f.column));
  return [
    ...d.filters.filter((f) => hasCol(w, f.column)),
    ...slicerFilters.filter((s) => s.from !== w.id && hasCol(w, s.column)).map((s) => s.f),
    ...(crossF && hasCol(w, crossF.column) ? [crossF] : []),
    ...slicerFilters.filter((s) => s.from !== w.id && !hasCol(w, s.column)).flatMap((s) => related(s.from, s.f)),
    ...(crossF && !hasCol(w, crossF.column) ? related(cross!.widget, crossF) : []),
  ];
}

/** Copies a tile onto another dashboard, with the measures and sliders it needs. It keeps the page filters it had and links back to where it came from. */
export function pinTile(target: Dashboard, source: Dashboard, w: Widget, pageFilters: Filter[], id: string): Dashboard {
  if (target.id === source.id) throw new Error("This tile is already on that dashboard.");
  if (w.type === "slicer") throw new Error("A slicer only works on its own page, so it can't be pinned.");
  const clash = (source.measures ?? []).find((m) => target.measures?.some((t) => t.name === m.name && t.dax !== m.dax));
  if (clash) throw new Error(`${target.name} already has a measure called ${clash.name} with a different formula.`);
  const first = target.pages?.[0]?.id, bottom = target.widgets.filter((x) => !first || (x.page ?? first) === first).reduce((n, x) => Math.max(n, x.y + x.h), 0);
  const relKey = (r: NonNullable<Dashboard["relationships"]>[number]) => [r.fromTable, r.fromCol, r.toTable, r.toCol].join("|");
  return {
    ...target,
    widgets: [...target.widgets, { ...w, id, x: 0, y: bottom, page: first, filters: [...w.filters, ...pageFilters], pinnedFrom: { dashboard: source.id, widget: w.id, name: source.name } }],
    measures: [...(target.measures ?? []), ...(source.measures ?? []).filter((m) => !target.measures?.some((t) => t.name === m.name))],
    params: [...(target.params ?? []), ...(source.params ?? []).filter((p) => !target.params?.some((t) => t.name === p.name))],
    relationships: [...(target.relationships ?? []), ...(source.relationships ?? []).filter((r) => !target.relationships?.some((t) => relKey(t) === relKey(r)))],
  };
}
