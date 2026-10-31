import { q } from "./sql.ts";
import type { Sort } from "./types.ts";

export type WindowFn = "row_number" | "rank" | "dense_rank" | "lag" | "lead" | "change" | "pct_change" | "running_sum" | "running_avg" | "moving_avg" | "pct_total";
export const WINDOW_FNS: [WindowFn, string][] = [["rank", "Rank, ties share a rank"], ["dense_rank", "Rank with no gaps"], ["row_number", "Row number"], ["lag", "Previous value"], ["lead", "Next value"], ["change", "Change from previous"], ["pct_change", "% change from previous"], ["running_sum", "Running total"], ["running_avg", "Running average"], ["moving_avg", "Moving average"], ["pct_total", "% of total"]];
const NO_COLUMN = new Set<WindowFn>(["row_number", "rank", "dense_rank"]);
const NO_ORDER = new Set<WindowFn>(["pct_total"]);
/** The ones that step back or forward by a count of rows, so the form only asks when it matters. */
export const windowNeedsCount = (fn: string) => ["lag", "lead", "change", "pct_change", "moving_avg"].includes(fn);
export const windowNeedsColumn = (fn: string) => !NO_COLUMN.has(fn as WindowFn);
export const windowNeedsOrder = (fn: string) => !NO_ORDER.has(fn as WindowFn);
export const orderBySql = (sorts: Sort[] = []) => { const o = sorts.filter((s) => s.column).map((s) => `${q(s.column)} ${s.dir === "desc" ? "DESC" : "ASC"}`); return o.length ? `ORDER BY ${o.join(", ")}` : ""; };

/**
 * A value worked out across rows: rank, previous value, running total and so on, within each group if any.
 * Returns null while the step is half filled in. Text columns holding numbers are read as numbers, and one that isn't a number counts as empty rather than failing the build.
 */
export function windowSql(s: { mode?: string; column?: string; columns?: string[]; sorts?: Sort[]; n?: string }): string | null {
  const fn = s.mode as WindowFn;
  if (!WINDOW_FNS.some(([f]) => f === fn)) return null;
  if (windowNeedsColumn(fn) && !s.column) return null;
  const order = orderBySql(s.sorts);
  if (windowNeedsOrder(fn) && !order) return null;
  const count = /^[1-9]\d{0,3}$/.test(s.n ?? "") ? Number(s.n) : fn === "moving_avg" ? 3 : 1;
  const parts = (s.columns ?? []).filter(Boolean), by = parts.length ? `PARTITION BY ${parts.map(q).join(", ")}` : "";
  const over = `OVER (${[by, order].filter(Boolean).join(" ")})`, c = s.column ? q(s.column) : "", num = `TRY_CAST(${c} AS DOUBLE)`;
  const frame = (rows: string) => `OVER (${[by, order, rows].filter(Boolean).join(" ")})`;
  const prior = `lag(${num}, ${count}) ${over}`;
  switch (fn) {
    case "row_number": return `row_number() ${over}`;
    case "rank": return `rank() ${over}`;
    case "dense_rank": return `dense_rank() ${over}`;
    case "lag": return `lag(${c}, ${count}) ${over}`;
    case "lead": return `lead(${c}, ${count}) ${over}`;
    case "change": return `${num} - ${prior}`;
    case "pct_change": return `(${num} - ${prior}) * 100.0 / nullif(${prior}, 0)`;
    case "running_sum": return `sum(${num}) ${frame("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW")}`;
    case "running_avg": return `avg(${num}) ${frame("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW")}`;
    case "moving_avg": return `avg(${num}) ${frame(`ROWS BETWEEN ${count - 1} PRECEDING AND CURRENT ROW`)}`;
    case "pct_total": return `${num} * 100.0 / nullif(sum(${num}) OVER (${by}), 0)`;
  }
}
