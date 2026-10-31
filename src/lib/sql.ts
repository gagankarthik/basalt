import { daxToSql, type DaxContext } from "./dax.ts";
import { modelWidgetSql } from "./semantic.ts";
import type { Filter, Measure, Result, Sort, Widget, Kind } from "./types.ts";

export const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
export const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
export const table = (full: string) => full.split(".").map(q).join(".");

const ACRONYMS = new Set(["id", "url", "sql", "api", "csv", "ip", "pii", "upi", "usd", "sku", "csat"]);
/** "order_id" becomes "Order ID"; used wherever a field is shown to people. */
export const prettyField = (name: string) => name.replace(/^.*\[(.*)\]$/, "$1").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().split(/\s+/).map((w, i) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join(" ");

export function kindOf(type: string): Kind {
  const t = type.toUpperCase();
  if (/\[\]|STRUCT|MAP|JSON|LIST/.test(t)) return "json";
  if (/INT|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC/.test(t)) return "number";
  if (/DATE|TIME/.test(t)) return "date";
  if (/BOOL/.test(t)) return "bool";
  return "text";
}

const numOrStr = (v = "") => (/^-?\d+(\.\d+)?$/.test(v) ? v : lit(v));

export function filterSql(f: Filter, column?: string): string | null {
  const c = column ?? q(f.column), txt = `CAST(${c} AS VARCHAR)`, v = f.value ?? "";
  const like = (s: string) => lit(s.replace(/[\\%_]/g, "\\$&"));
  switch (f.op) {
    case "in_query": return f.value ? `${c} IN (${f.value})` : null;
    case "empty": return `(${c} IS NULL OR ${txt} = '')`;
    case "not_empty": return `(${c} IS NOT NULL AND ${txt} <> '')`;
    case "in": return f.values?.length ? `${txt} IN (${f.values.map(lit).join(", ")})` : null;
    case "not_in": return f.values?.length ? `(${txt} NOT IN (${f.values.map(lit).join(", ")}) OR ${c} IS NULL)` : null;
    case "last_days": { const n = Number(v); return Number.isInteger(n) && n > 0 ? `${c} >= now()::TIMESTAMP - INTERVAL ${n} DAY` : null; }
  }
  if (v === "") return null;
  switch (f.op) {
    case "eq": return `${txt} = ${lit(v)}`;
    case "neq": return `(${txt} <> ${lit(v)} OR ${c} IS NULL)`;
    case "contains": return `${txt} ILIKE '%' || ${like(v)} || '%' ESCAPE '\\'`;
    case "not_contains": return `(${txt} NOT ILIKE '%' || ${like(v)} || '%' ESCAPE '\\' OR ${c} IS NULL)`;
    case "starts": return `${txt} ILIKE ${like(v)} || '%' ESCAPE '\\'`;
    case "gt": return `${c} > ${numOrStr(v)}`;
    case "gte": return `${c} >= ${numOrStr(v)}`;
    case "lt": return `${c} < ${numOrStr(v)}`;
    case "lte": return `${c} <= ${numOrStr(v)}`;
    case "between": return f.value2 ? `${c} BETWEEN ${numOrStr(v)} AND ${numOrStr(f.value2)}` : null;
  }
  return null;
}

export const whereSql = (filters: Filter[], match: "all" | "any" = "all") => {
  // A group uses the opposite joiner from the top level: "A and (B or C)", or "A or (B and C)"
  const outer = match === "all" ? " AND " : " OR ", inner = match === "all" ? " OR " : " AND ";
  const parts: string[] = [], seen = new Set<string>();
  for (const f of filters) {
    if (!f.group) { const one = filterSql(f); if (one) parts.push(one); continue; }
    if (seen.has(f.group)) continue;
    seen.add(f.group);
    const members = filters.filter((x) => x.group === f.group).map((m) => filterSql(m)).filter(Boolean);
    if (members.length) parts.push(members.length > 1 ? `(${members.join(inner)})` : members[0]!);
  }
  return parts.length ? `WHERE ${parts.join(outer)}` : "";
};
export const orderSql = (sorts: Sort[]) => (sorts.length ? `ORDER BY ${sorts.map((s) => `${q(s.column)} ${s.dir === "desc" ? "DESC" : "ASC"} NULLS LAST`).join(", ")}` : "");

export function measureSql(m: Measure, ctx?: DaxContext) {
  if (m.dax?.trim()) { try { return `(${daxToSql(m.dax, ctx)})`; } catch (e) { return `error(${lit(e instanceof Error ? e.message : "This measure isn't valid.")})`; } }
  if (m.expr?.trim()) return `(${m.expr})`;
  const c = m.column === "*" ? "*" : q(m.column);
  if (m.agg === "count") return `COUNT(${c})`;
  if (m.agg === "count_distinct") return `COUNT(DISTINCT ${c})`;
  return `${m.agg.toUpperCase()}(${c})`;
}
export const measureLabel = (m: Measure) => m.label || (m.expr || m.dax ? "Custom measure" : "") || (m.column === "*" ? "Rows" : `${{ sum: "Total", avg: "Average", count: "Count of", count_distinct: "Unique", min: "Lowest", max: "Highest", median: "Median" }[m.agg]} ${m.column.replace(/_/g, " ")}`);

export function widgetSql(w: Widget, extra: Filter[] = []): string | null {
  if (w.model) return modelWidgetSql(w, extra);
  if (w.type === "text" || !w.table) return null;
  const where = whereSql([...w.filters, ...extra]);
  const from = table(w.table);
  if (w.type === "slicer") return w.dimension ? `SELECT DISTINCT CAST(${q(w.dimension)} AS VARCHAR) AS value FROM ${from} WHERE ${q(w.dimension)} IS NOT NULL ORDER BY 1 LIMIT 200` : null;
  if (w.type === "table" && !w.measures.length) return `SELECT * FROM ${from} ${where} LIMIT ${w.limit ?? 100}`;
  const single = w.type === "kpi" || w.type === "gauge" || !w.dimension, grain = w.dateGrain && !single ? `date_trunc('${w.dateGrain}', ${q(w.dimension!)})::DATE` : undefined;
  const ctx: DaxContext = { from, where, fullTable: w.table, measures: w.daxMeasures, relationships: w.rels, dim: grain ? { column: w.dimension!, expr: grain } : undefined, groups: [...(!single && !grain ? [q(w.dimension!)] : []), ...(!single && w.series ? [q(w.series)] : [])] };
  const ms = [...w.measures.map((m, i) => `${measureSql(m, ctx)} AS ${q(`m${i}`)}`), ...(w.dimension && w.type !== "kpi" ? (w.tips ?? []).map((m, i) => `${measureSql(m)} AS ${q(`t${i}`)}`) : [])];
  if (!ms.length) return null;
  if (w.type === "kpi" || w.type === "gauge" || !w.dimension) return `SELECT ${ms.join(", ")} FROM ${from} ${where}`;
  const d = w.dateGrain ? `date_trunc('${w.dateGrain}', ${q(w.dimension)})::DATE` : q(w.dimension);
  const sel = [`${d} AS d`, ...(w.series ? [`${q(w.series)} AS s`] : []), ...ms];
  const groups = w.series ? "1, 2" : "1";
  const sort = w.dateGrain || w.sort === "label" || w.calc || w.type === "matrix" ? "ORDER BY 1" : w.sort === "value_asc" ? `ORDER BY ${q("m0")} ASC` : `ORDER BY ${q("m0")} DESC`;
  const lim = w.dateGrain ? "" : `LIMIT ${w.type === "matrix" ? 5000 : w.series ? 400 : w.limit ?? 50}`;
  return `SELECT ${sel.join(", ")} FROM ${from} ${where} GROUP BY ${groups} ${sort} ${lim}`.replace(/\s+/g, " ").trim();
}

export function toCsv(r: Pick<Result, "columns" | "rows">) {
  const cell = (v: unknown) => { if (v == null) return ""; const s = typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [r.columns.map((c) => cell(c.name)).join(","), ...r.rows.map((row) => r.columns.map((c) => cell(row[c.name])).join(","))].join("\n");
}
