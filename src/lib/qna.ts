/** Answers plain-English questions by matching words to tables and fields. It uses no AI service, so nothing leaves your server, and it says so when it can't tell. */
import type { Agg, Filter, Measure, VisualType } from "./types.ts";

type Tbl = { full: string; schema: string; name: string; columns: { name: string; type: string }[] };
export type Answer = { table: string; type: VisualType; title: string; measures: Measure[]; dimension?: string; dateGrain?: "day" | "week" | "month" | "quarter" | "year"; filters: Filter[]; limit?: number; sort?: "value_desc" | "value_asc" };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const stem = (w: string) => (w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const words = (s: string) => norm(s).split(" ").filter(Boolean).map(stem);
const STOP = new Set(["what", "is", "i", "are", "the", "a", "an", "of", "on", "in", "at", "to", "for", "me", "show", "give", "how", "many", "much", "by", "per", "where", "and", "or", "with", "from", "top", "last", "day", "week", "month", "quarter", "year", "number", "count", "total", "sum", "average", "avg", "mean", "median"]);
const isNum = (t: string) => /INT|DOUBLE|FLOAT|DECIMAL|REAL/i.test(t), isDate = (t: string) => /DATE|TIMESTAMP/i.test(t);

function columnIn(phrase: string, t: Tbl, want?: (c: Tbl["columns"][number]) => boolean) {
  const ask = words(phrase); let best: Tbl["columns"][number] | undefined, score = 0;
  for (const c of t.columns) {
    if (c.name.startsWith("_") || (want && !want(c))) continue;
    const parts = words(c.name.replace(/_/g, " "));
    const hits = parts.filter((p) => ask.includes(p)).length;
    // A full match counts for more than a partial one, and shorter names win ties
    const s = hits === parts.length ? hits + 1 : hits ? hits / parts.length : 0;
    if (s > score) { score = s; best = c; }
  }
  return best;
}

export function answer(question: string, tables: Tbl[]): Answer | { error: string } {
  const q = ` ${norm(question)} `;
  if (!q.trim()) return { error: "Ask a question, such as total amount by city." };
  const ask = words(question).filter((w) => !STOP.has(w));
  const hitsIn = (t: Tbl) => t.columns.filter((c) => words(c.name.replace(/_/g, " ")).some((w) => ask.includes(w))).length;
  const rank = (t: Tbl) => { const name = words(t.name.replace(/_/g, " ")).filter((w) => ask.includes(w)).length; return name + Math.min(hitsIn(t), 4) * 2 + (t.schema === "analytics" ? 0.5 : 0) + (t.name.startsWith("fct_") ? 0.25 : 0); };
  const fits = tables.filter((t) => rank(t) >= 1).sort((a, b) => rank(b) - rank(a));
  if (!fits.length) return { error: "No table matches those words. Try using a table or field name." };
  // The closest table might not have every field asked about, so the next ones get a turn
  let first: { error: string } | undefined;
  for (const t of fits) { const r = fromTable(q, t); if (!("error" in r)) return r; first ??= r; }
  return first!;
}

function fromTable(q: string, t: Tbl): Answer | { error: string } {
  // "by month", "per city", "over time"
  let dimension: string | undefined, dateGrain: Answer["dateGrain"];
  const by = /\b(?:by|per|for each|across|grouped by)\s+([a-z0-9 ]+?)(?=\s+(?:where|in the last|last|top|for|with)\b|\s*$)/.exec(q.trim());
  const grain = /\b(day|week|month|quarter|year)\b/.exec(by?.[1] ?? "")?.[1] ?? (/\b(over time|trend)\b/.test(q) ? "month" : /\b(daily|weekly|monthly|quarterly|yearly)\b/.exec(q)?.[1]?.replace("daily", "day").replace("ly", "").replace("quarter", "quarter"));
  const dateCol = t.columns.find((c) => isDate(c.type));
  if (grain && dateCol) { dimension = dateCol.name; dateGrain = grain as Answer["dateGrain"]; }
  else if (by) { const c = columnIn(by[1], t); if (!c) return { error: `${t.name} has no field like "${by[1]}".` }; dimension = c.name; }

  // The value: "average rating", "how many", "highest price"
  const m = /\b(average|avg|mean|median|total|sum|highest|max|maximum|largest|lowest|min|minimum|smallest|unique|distinct)\s+(?:of\s+|the\s+)?([a-z0-9 ]+?)(?=\s+(?:by|per|for|where|in|last|top|over|across|grouped)\b|\s*$)/.exec(q.trim());
  const AGGS: Record<string, Agg> = { average: "avg", avg: "avg", mean: "avg", median: "median", total: "sum", sum: "sum", highest: "max", max: "max", maximum: "max", largest: "max", lowest: "min", min: "min", minimum: "min", smallest: "min", unique: "count_distinct", distinct: "count_distinct" };
  let measure: Measure = { column: "*", agg: "count" }, valueName = "Records";
  if (m) {
    const agg = AGGS[m[1]], c = columnIn(m[2], t, agg === "count_distinct" ? undefined : (x) => isNum(x.type));
    if (c) { measure = { column: c.name, agg }; valueName = `${m[1][0].toUpperCase()}${m[1].slice(1)} ${c.name.replace(/_/g, " ")}`; }
    else if (!/\b(how many|count|number of)\b/.test(q)) return { error: `${t.name} has no number field like "${m[2]}".` };
  }

  // Conditions: "where status is delivered", "last 30 days"
  const filters: Filter[] = [];
  const whereRe = /\bwhere\s+([a-z0-9 ]+?)\s+(?:is|equals|=)\s+([a-z0-9 ]+?)(?=\s+(?:and|by|per|top|last|in the)\b|\s*$)/g;
  for (const w of q.trim().matchAll(whereRe)) { const c = columnIn(w[1], t); if (!c) return { error: `${t.name} has no field like "${w[1]}".` }; filters.push({ id: `q${filters.length}`, column: c.name, op: "contains", value: w[2] }); }
  const days = /\b(?:in the )?last (\d+) days?\b/.exec(q);
  if (days && dateCol) filters.push({ id: "qd", column: dateCol.name, op: "last_days", value: days[1] });

  const top = /\btop (\d+)\b/.exec(q), type: VisualType = !dimension ? "kpi" : dateGrain ? "line" : "bar";
  const title = `${valueName}${dimension ? ` by ${dateGrain ?? dimension.replace(/_/g, " ")}` : ""}`;
  return { table: t.full, type, title, measures: [measure], dimension, dateGrain, filters, limit: top ? Math.min(100, Number(top[1])) : undefined, sort: dimension && !dateGrain ? "value_desc" : undefined };
}
