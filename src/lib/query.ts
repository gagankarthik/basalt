import { parseFormula, FormulaError } from "./formula.ts";
import { lit, q } from "./sql.ts";

/** Hidden boolean beside a converted column: true where a value couldn't convert, since TRY_CAST alone can't tell that from an empty value. */
export const errorColumn = (c: string) => `__error__${c}`;
export type QueryParam = { name: string; value: string };

type Node = ReturnType<typeof parseFormula>;
const text = (s: string) => `CAST(${s} AS VARCHAR)`;
const UNITS = new Set(["year", "quarter", "month", "week", "day", "hour", "minute", "second"]);
// Only these reach SQL. [fewest args, most args, builder]
const FNS: Record<string, [number, number, (a: string[]) => string]> = {
  IF: [2, 3, ([c, a, b]) => `CASE WHEN ${c} THEN ${a}${b ? ` ELSE ${b}` : ""} END`],
  AND: [1, 20, (a) => `(${a.join(" AND ")})`], OR: [1, 20, (a) => `(${a.join(" OR ")})`], NOT: [1, 1, ([a]) => `(NOT ${a})`],
  ISBLANK: [1, 1, ([a]) => `(${a} IS NULL OR ${text(a)} = '')`], COALESCE: [1, 20, (a) => `coalesce(${a.join(", ")})`],
  UPPER: [1, 1, ([a]) => `upper(${text(a)})`], LOWER: [1, 1, ([a]) => `lower(${text(a)})`], TRIM: [1, 1, ([a]) => `trim(${text(a)})`], LEN: [1, 1, ([a]) => `length(${text(a)})`],
  LEFT: [2, 2, ([a, n]) => `left(${text(a)}, ${n})`], RIGHT: [2, 2, ([a, n]) => `right(${text(a)}, ${n})`], MID: [3, 3, ([a, s, n]) => `substr(${text(a)}, ${s}, ${n})`],
  CONCATENATE: [1, 20, (a) => `concat(${a.join(", ")})`], SUBSTITUTE: [3, 3, ([a, f, t]) => `replace(${text(a)}, ${f}, ${t})`],
  ABS: [1, 1, ([a]) => `abs(${a})`], ROUND: [1, 2, ([a, p]) => `round(${a}, ${p ?? 0})`], CEILING: [1, 1, ([a]) => `ceil(${a})`], FLOOR: [1, 1, ([a]) => `floor(${a})`], INT: [1, 1, ([a]) => `floor(${a})`],
  POWER: [2, 2, ([a, b]) => `pow(${a}, ${b})`], SQRT: [1, 1, ([a]) => `sqrt(${a})`], MOD: [2, 2, ([a, b]) => `(${a} % ${b})`], MIN: [2, 20, (a) => `least(${a.join(", ")})`], MAX: [2, 20, (a) => `greatest(${a.join(", ")})`],
  VALUE: [1, 1, ([a]) => `TRY_CAST(${a} AS DOUBLE)`], TEXT: [1, 1, ([a]) => text(a)],
  YEAR: [1, 1, ([a]) => `year(TRY_CAST(${a} AS TIMESTAMP))`], MONTH: [1, 1, ([a]) => `month(TRY_CAST(${a} AS TIMESTAMP))`], DAY: [1, 1, ([a]) => `day(TRY_CAST(${a} AS TIMESTAMP))`],
  TODAY: [0, 0, () => "current_date"], NOW: [0, 0, () => "now()"],
};
export const CUSTOM_FUNCTIONS = [...Object.keys(FNS), "DATETIME_DIFF", "PARAM"].sort();

/** Compiles the same formula syntax as bases into SQL. A column is {name}; anything not listed above is refused, so it can't carry SQL. */
export function formulaSql(src: string, params: QueryParam[] = []): string {
  const go = (n: Node): string => {
    switch (n.k) {
      case "lit":
        if (typeof n.v === "number") { if (!Number.isFinite(n.v)) throw new FormulaError("That number isn't valid."); return String(n.v); }
        return lit(String(n.v));
      case "field": return q(n.name);
      case "neg": return `(-${go(n.v)})`;
      case "op": {
        const l = go(n.l), r = go(n.r);
        if (n.op === "&") return `concat(${l}, ${r})`;
        if (n.op === "/") return `(${l} / nullif(${r}, 0))`;
        return `(${l} ${n.op === "!=" ? "<>" : n.op} ${r})`;
      }
      case "call": {
        const first = n.args[0], str = first?.k === "lit" && typeof first.v === "string" ? first.v : null;
        if (n.name === "PARAM") {
          const p = params.find((x) => x.name === str);
          if (!p) throw new FormulaError(`There's no parameter called ${str ?? ""}.`);
          return /^-?\d+(\.\d+)?$/.test(p.value) ? p.value : lit(p.value);
        }
        if (n.name === "DATETIME_DIFF") {
          const u = n.args[2];
          if (n.args.length !== 3 || u.k !== "lit" || !UNITS.has(String(u.v))) throw new FormulaError(`DATETIME_DIFF needs two dates and a unit: ${[...UNITS].join(", ")}.`);
          return `date_diff(${lit(String(u.v))}, TRY_CAST(${go(n.args[1])} AS TIMESTAMP), TRY_CAST(${go(n.args[0])} AS TIMESTAMP))`;
        }
        const f = Object.hasOwn(FNS, n.name) ? FNS[n.name] : null;
        if (!f) throw new FormulaError(`${n.name} isn't available here.`);
        if (n.args.length < f[0] || n.args.length > f[1]) throw new FormulaError(`${n.name} has the wrong number of values.`);
        return f[2](n.args.map(go));
      }
    }
  };
  return go(parseFormula(src));
}

export type ColumnQuality = { name: string; type: string; total: number; valid: number; error: number; empty: number; distinct: number };
const visible = <T extends { name: string }>(cols: T[]) => cols.filter((c) => !c.name.startsWith("__error__"));

/** One scan for every column. `body` must be compiled with tracking on, so its error columns are in `cols`. */
export function qualitySql(body: string, cols: { name: string }[]) {
  const has = new Set(cols.map((c) => c.name));
  const parts = visible(cols).flatMap((c, i) => {
    const x = q(c.name), err = errorColumn(c.name);
    return [`count(*) FILTER (WHERE ${x} IS NULL OR ${text(x)} = '') AS e${i}`, `${has.has(err) ? `count(*) FILTER (WHERE ${q(err)})` : "0"} AS x${i}`, `count(DISTINCT ${text(x)}) AS d${i}`];
  });
  return `SELECT ${["count(*) AS total", ...parts].join(", ")} FROM (${body})`;
}
export function readQuality(row: Record<string, unknown>, cols: { name: string; type: string }[]): ColumnQuality[] {
  const total = Number(row.total);
  return visible(cols).map((c, i) => {
    // A failed conversion leaves an empty cell, and it should count once, as an error
    const error = Number(row[`x${i}`]), empty = Number(row[`e${i}`]) - error;
    return { name: c.name, type: c.type, total, error, empty, valid: total - error - empty, distinct: Number(row[`d${i}`]) };
  });
}
export const distributionSql = (body: string, column: string, top = 10) => `SELECT ${text(q(column))} AS value, count(*) AS n FROM (${body}) GROUP BY 1 ORDER BY 2 DESC, 1 NULLS LAST LIMIT ${Math.trunc(top)}`;
