/**
 * Compiles DAX measures to SQL for DuckDB. Filter context becomes FILTER clauses, time intelligence becomes window frames over the visual's
 * date groups, and iterators become aggregates over row expressions. Anything else is refused by name rather than guessed at.
 */
export class DaxError extends Error {}
const fail = (m: string): never => { throw new DaxError(m); };
const qid = (s: string) => `"${s.replace(/"/g, '""')}"`;
const str = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** What the visual is grouped by, which is what time intelligence and ALL need to know. */
export type DaxContext = { from: string; where?: string; table?: string; dim?: { column: string; expr: string }; groups?: string[]; measures?: Record<string, string>; relationships?: { fromTable: string; fromCol: string; toTable: string; toCol: string }[]; fullTable?: string };

type T = { t: "num" | "str" | "col" | "id" | "op"; v: string; table?: string };
export function lex(src: string): T[] {
  const out: T[] = []; let i = 0, table: string | undefined;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) { let j = i + 1; while (/[\d.]/.test(src[j] ?? "")) j++; out.push({ t: "num", v: src.slice(i, j) }); i = j; continue; }
    if (c === '"') { let j = i + 1, s = ""; for (;;) { if (j >= src.length) fail("A piece of text is missing its closing quote."); if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += src[j++]; } out.push({ t: "str", v: s }); i = j + 1; continue; }
    if (c === "[") { const j = src.indexOf("]", i); if (j < 0) fail("A column is missing its closing ]."); out.push({ t: "col", v: src.slice(i + 1, j), table }); table = undefined; i = j + 1; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) fail("A table name is missing its closing quote."); const name = src.slice(i + 1, j); i = j + 1; if (src[i] === "[") table = name; else out.push({ t: "id", v: name, table: name }); continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (/[\w.]/.test(src[j] ?? "")) j++; const word = src.slice(i, j); if (src[j] === "[") { table = word; i = j; } else { out.push({ t: "id", v: word }); i = j; } continue; }
    const two = src.slice(i, i + 2);
    if ([">=", "<=", "<>", "&&", "||"].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/=<>(),&{}^".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    fail(`"${c}" isn't allowed in a measure.`);
  }
  return out;
}

const AGG: Record<string, string> = { SUM: "SUM", AVERAGE: "AVG", AVERAGEA: "AVG", MIN: "MIN", MINA: "MIN", MAX: "MAX", MAXA: "MAX", MEDIAN: "MEDIAN", COUNT: "COUNT", COUNTA: "COUNT", PRODUCT: "PRODUCT", DISTINCTCOUNT: "COUNT DISTINCT", DISTINCTCOUNTNOBLANK: "COUNT DISTINCT", STDEV: "STDDEV_SAMP", "STDEV.S": "STDDEV_SAMP", "STDEV.P": "STDDEV_POP", VAR: "VAR_SAMP", "VAR.S": "VAR_SAMP", "VAR.P": "VAR_POP" };
const ITER: Record<string, string> = { SUMX: "SUM", AVERAGEX: "AVG", MINX: "MIN", MAXX: "MAX", COUNTX: "COUNT", COUNTAX: "COUNT", MEDIANX: "MEDIAN", PRODUCTX: "PRODUCT", "STDEVX.S": "STDDEV_SAMP", "STDEVX.P": "STDDEV_POP", "VARX.S": "VAR_SAMP", "VARX.P": "VAR_POP" };
export const SCALAR: Record<string, (a: string[]) => string> = {
  ABS: (a) => `ABS(${a[0]})`, ROUND: (a) => `ROUND(${a[0]}, ${a[1] ?? 0})`, ROUNDUP: (a) => `CEIL((${a[0]}) * POWER(10, ${a[1] ?? 0})) / POWER(10, ${a[1] ?? 0})`, ROUNDDOWN: (a) => `TRUNC((${a[0]}) * POWER(10, ${a[1] ?? 0})) / POWER(10, ${a[1] ?? 0})`, TRUNC: (a) => `TRUNC(${a[0]})`, INT: (a) => `FLOOR(${a[0]})`, SQRT: (a) => `SQRT(${a[0]})`, POWER: (a) => `POWER(${a[0]}, ${a[1]})`, MOD: (a) => `(${a[0]}) % (${a[1]})`, EXP: (a) => `EXP(${a[0]})`, LN: (a) => `LN(${a[0]})`, LOG10: (a) => `LOG10(${a[0]})`, LOG: (a) => (a[1] ? `LOG(${a[0]}) / LOG(${a[1]})` : `LOG10(${a[0]})`), SIGN: (a) => `SIGN(${a[0]})`, PI: () => "PI()", CEILING: (a) => `CEIL((${a[0]}) / (${a[1] ?? 1})) * (${a[1] ?? 1})`, FLOOR: (a) => `FLOOR((${a[0]}) / (${a[1] ?? 1})) * (${a[1] ?? 1})`,
  AND: (a) => `(${a.join(" AND ")})`, OR: (a) => `(${a.join(" OR ")})`, NOT: (a) => `NOT (${a[0]})`, ISBLANK: (a) => `(${a[0]}) IS NULL`, COALESCE: (a) => `COALESCE(${a.join(", ")})`, BLANK: () => "NULL", TRUE: () => "TRUE", FALSE: () => "FALSE", IFERROR: (a) => `COALESCE(TRY(${a[0]}), ${a[1]})`, ISERROR: (a) => `TRY(${a[0]}) IS NULL`, ISNUMBER: (a) => `TRY_CAST(${a[0]} AS DOUBLE) IS NOT NULL`,
  CONCATENATE: (a) => `CONCAT(${a[0]}, ${a[1]})`, LEFT: (a) => `LEFT(${a[0]}, ${a[1] ?? 1})`, RIGHT: (a) => `RIGHT(${a[0]}, ${a[1] ?? 1})`, MID: (a) => `SUBSTR(${a[0]}, ${a[1]}, ${a[2]})`, LEN: (a) => `LENGTH(${a[0]})`, UPPER: (a) => `UPPER(${a[0]})`, LOWER: (a) => `LOWER(${a[0]})`, TRIM: (a) => `TRIM(${a[0]})`, SUBSTITUTE: (a) => `REPLACE(${a[0]}, ${a[1]}, ${a[2]})`, CONTAINSSTRING: (a) => `CONTAINS(LOWER(${a[0]}), LOWER(${a[1]}))`, CONTAINSSTRINGEXACT: (a) => `CONTAINS(${a[0]}, ${a[1]})`, VALUE: (a) => `CAST(${a[0]} AS DOUBLE)`,
  YEAR: (a) => `YEAR(${a[0]})`, MONTH: (a) => `MONTH(${a[0]})`, DAY: (a) => `DAY(${a[0]})`, HOUR: (a) => `HOUR(${a[0]})`, MINUTE: (a) => `MINUTE(${a[0]})`, QUARTER: (a) => `QUARTER(${a[0]})`, WEEKDAY: (a) => `DAYOFWEEK(${a[0]}) + 1`, WEEKNUM: (a) => `WEEK(${a[0]})`, TODAY: () => "CURRENT_DATE", NOW: () => "NOW()", UTCNOW: () => "NOW()", UTCTODAY: () => "CURRENT_DATE", DATE: (a) => `MAKE_DATE(CAST(${a[0]} AS INT), CAST(${a[1]} AS INT), CAST(${a[2]} AS INT))`, EOMONTH: (a) => `LAST_DAY(CAST(${a[0]} AS DATE) + INTERVAL (${a[1] ?? 0}) MONTH)`, EDATE: (a) => `CAST(${a[0]} AS DATE) + INTERVAL (${a[1]}) MONTH`,
};
const TIME = ["SAMEPERIODLASTYEAR", "DATEADD", "PARALLELPERIOD", "PREVIOUSDAY", "PREVIOUSMONTH", "PREVIOUSQUARTER", "PREVIOUSYEAR", "NEXTDAY", "NEXTMONTH", "NEXTQUARTER", "NEXTYEAR", "DATESYTD", "DATESQTD", "DATESMTD"];
const TOTALS: Record<string, string> = { TOTALYTD: "year", TOTALQTD: "quarter", TOTALMTD: "month" };
const UNITS: Record<string, string> = { YEAR: "YEAR", QUARTER: "QUARTER", MONTH: "MONTH", DAY: "DAY" };
const REFUSED = ["SUMMARIZE", "SUMMARIZECOLUMNS", "ADDCOLUMNS", "SELECTCOLUMNS", "TOPN", "USERELATIONSHIP", "CROSSFILTER", "EARLIER", "EARLIEST", "CROSSJOIN", "GENERATE", "UNION", "INTERSECT", "EXCEPT", "ROW", "DATATABLE", "CALCULATETABLE", "RELATEDTABLE", "TREATAS", "PATH", "LOOKUPVALUE"];
const WINDOW_OF: Record<string, string> = { SUM: "SUM", COUNT: "SUM", MIN: "MIN", MAX: "MAX" };
const USABLE_IN: Record<string, string> = { SUMMARIZE: `as the table of an iterator or COUNTROWS, such as SUMX(SUMMARIZE(Orders, Orders[city], "Total", SUM(Orders[amount])), [Total])`, TOPN: "as the table of an iterator, COUNTROWS or a CALCULATE filter, such as CALCULATE(SUM(Orders[amount]), TOPN(3, VALUES(Orders[city]), SUM(Orders[amount])))", USERELATIONSHIP: "as a CALCULATE filter", EARLIER: "in an iterator nested inside another iterator over this visual's table" };
const ROW_ONLY = new Set([...Object.keys(SCALAR), "DIVIDE", "IF", "SWITCH", "DATEDIFF", "EARLIER"]);
const AGG_ONLY = new Set([...ROW_ONLY, ...Object.keys(AGG), ...Object.keys(ITER), "COUNTROWS", "COUNTBLANK"].filter((x) => x !== "EARLIER"));
const FORMATS: Record<string, string> = { "0": "%.0f", "0.0": "%.1f", "0.00": "%.2f", "0%": "%.0f%%", "0.0%": "%.1f%%", "0.00%": "%.2f%%" };
export const DAX_FUNCTIONS = [...Object.keys(AGG), ...Object.keys(ITER), "COUNTROWS", "COUNTBLANK", "CALCULATE", "FILTER", "ALL", "ALLSELECTED", "ALLEXCEPT", "REMOVEFILTERS", "KEEPFILTERS", "VALUES", "DISTINCT", "RELATED", "RANKX", "HASONEVALUE", "SELECTEDVALUE", "CONCATENATEX", "DIVIDE", "IF", "SWITCH", "FORMAT", "DATEDIFF", "SUMMARIZE", "TOPN", "USERELATIONSHIP", "EARLIER", "VAR/RETURN", "TOTALYTD", "TOTALQTD", "TOTALMTD", ...TIME, ...Object.keys(SCALAR)].filter((x, i, a) => a.indexOf(x) === i);

type Env = { where: string[]; over?: string; shift?: { kind: "shift"; n: number; unit: string; col: string } | { kind: "to"; unit: string; col: string }; ignoreAll?: boolean; rowCtx: boolean; vars: Map<string, string>; base?: string[]; top?: boolean; row?: string[]; earlier?: boolean; only?: Set<string>; cols?: Record<string, string>; rel?: { col: string; table: string; on: string; short: string } };
/** A table argument: grouped when it has keys, otherwise plain rows of the visual's table. */
type Tbl = { keys: string[]; cols: Record<string, string>; where: string[]; top?: { n: number; order: string; dir: string } };
const last = (t: string) => t.split(".").pop()!.toLowerCase();
const loose = (s: string) => s.toLowerCase().replace(/^(fct|fact|dim|stg|vw)_/, "").replace(/[^a-z0-9]/g, "").replace(/s$/, "");
/** Exact name, or the visual's table without its model prefix, spacing or plural: Orders reads fct_orders. A related table with that short name makes it ambiguous. */
const sameTable = (t: string, ctx: DaxContext) => { const q = last(t), name = last(ctx.fullTable!); if (q === name) return true; if (q.replace(/[^a-z0-9]/g, "").replace(/s$/, "") !== loose(name)) return false; return !ctx.relationships?.some((r) => [r.fromTable, r.toTable].some((x) => x !== ctx.fullTable && loose(last(x)) === loose(q))); };
const unwhere = (w?: string) => w?.replace(/^\s*WHERE\s+/i, "") ?? "";
const whereOf = (a: (string | undefined)[]) => { const w = a.filter(Boolean).map((x) => `(${x})`); return w.length ? `WHERE ${w.join(" AND ")}` : ""; };
const copy = (e: Env, p: Partial<Env>): Env => ({ ...e, ...p, where: p.where ?? e.where });

export function daxToSql(src: string, ctx?: DaxContext, depth = 0, outer?: Env): string {
  if (depth > 8) fail("Measures refer to each other too deeply.");
  const toks = lex(src.replace(/^\s*(?!VAR\b)(?:[A-Za-z_][\w ]*|\[[^\]]*\])\s*:?=\s*(?=[A-Za-z'\[(\d"-])/i, ""));
  let p = 0;
  const peek = (v: string) => toks[p]?.t === "op" && toks[p].v === v;
  const word = (v: string) => toks[p]?.t === "id" && toks[p].v.toUpperCase() === v;
  const take = (v: string) => { if (!peek(v)) fail(`Expected "${v}" in this measure.`); p++; };
  // Table names passed over while parsing, and tokens a USERELATIONSHIP filter may read from the other table. Both are checked once parsing ends
  const tables: number[] = [], viaOther = new Set<number>();
  const skipTable = () => { const t = toks[p]; if (t?.t === "id" && !(toks[p + 1]?.t === "op" && toks[p + 1].v === "(")) { tables.push(p++); return true; } return false; };
  const skipOne = () => { tables.push(p++); return ""; };
  const LEVELS = [["||"], ["&&"], ["=", "<>", "<", ">", "<=", ">="], ["&"], ["+", "-"], ["*", "/"], ["^"]];
  const SQL: Record<string, string> = { "||": "OR", "&&": "AND", "&": "||" };
  const list = (one: () => string) => { take("("); const a: string[] = []; if (!peek(")")) { do { a.push(one()); } while (peek(",") && ++p); } take(")"); return a; };

  /** An aggregate under the current context: filtered, moved in time, or lifted out of the visual's own filters. */
  const emit = (e: Env, fn: string, col: string): string => {
    if (e.top && (e.ignoreAll || e.shift || e.over != null)) fail("TOPN with ALL or time intelligence in the same CALCULATE isn't supported.");
    const f = e.where.length ? ` FILTER (WHERE ${e.where.join(" AND ")})` : "", base = fn === "COUNT DISTINCT" ? `COUNT(DISTINCT ${col})${f}` : `${fn}(${col})${f}`;
    if (e.ignoreAll) { if (!ctx) return fail("ALL needs a visual to run in."); return `(SELECT ${base} FROM ${ctx.from})`; }
    if (e.shift) return timed(e, fn, col, f);
    if (e.over != null) { const w = WINDOW_OF[fn]; if (w) return `${w}(${base}) OVER (${e.over})`; if (fn === "AVG") return `SUM(SUM(${col})${f}) OVER (${e.over}) / NULLIF(SUM(COUNT(${col})${f}) OVER (${e.over}), 0)`; return fail(`${fn} can't be combined with ALL here. Use SUM, COUNT, MIN, MAX or AVERAGE.`); }
    return base;
  };
  const timed = (e: Env, fn: string, col: string, f: string): string => {
    const s = e.shift!; if (!ctx) return fail("Time intelligence needs a visual to run in.");
    const inner = fn === "COUNT DISTINCT" ? `COUNT(DISTINCT ${col})${f}` : `${fn}(${col})${f}`;
    const unitKey = (k: string) => (k === "year" ? "YEAR" : k === "quarter" ? "QUARTER" : "MONTH");
    if (ctx.dim) {
      if (qid(ctx.dim.column) !== s.col) return fail(`This visual is grouped by ${ctx.dim.column}, so time intelligence must use that field.`);
      const parts = ctx.groups ?? [], by = (extra: string[]) => (extra.length ? `PARTITION BY ${extra.join(", ")} ` : "");
      const spec = s.kind === "to" ? `${by([...parts, `DATE_TRUNC('${s.unit.toLowerCase()}', ${ctx.dim.expr})`])}ORDER BY ${ctx.dim.expr}` : (() => { const k = `INTERVAL ${Math.abs(s.n)} ${s.unit}`, side = s.n < 0 ? "PRECEDING" : "FOLLOWING"; return `${by(parts)}ORDER BY ${ctx.dim!.expr} RANGE BETWEEN ${k} ${side} AND ${k} ${side}`; })();
      const w = WINDOW_OF[fn];
      if (w) return `${w}(${inner}) OVER (${spec})`;
      if (fn === "AVG") return `SUM(SUM(${col})${f}) OVER (${spec}) / NULLIF(SUM(COUNT(${col})${f}) OVER (${spec}), 0)`;
      return fail(`${fn} can't be moved through time here. Use SUM, COUNT, MIN, MAX or AVERAGE.`);
    }
    if (ctx.groups?.length) return fail("Time intelligence needs a date grouping on this visual, or no grouping at all.");
    // A single number: the selected dates, moved
    const where = ctx.where ?? "", first = `(SELECT MIN(${s.col}) FROM ${ctx.from} ${where})`, last = `(SELECT MAX(${s.col}) FROM ${ctx.from} ${where})`, and = where ? `${where} AND` : "WHERE";
    if (s.kind === "to") return `(SELECT ${inner} FROM ${ctx.from} ${and} ${s.col} >= DATE_TRUNC('${unitKey(s.unit.toLowerCase()).toLowerCase()}', ${last}))`;
    const iv = `INTERVAL ${Math.abs(s.n)} ${s.unit}`, sign = s.n < 0 ? "-" : "+", dateOnly = ctx.fullTable ?? ctx.from;
    return `(SELECT ${inner} FROM ${dateOnly} WHERE ${s.col} BETWEEN ${first} ${sign} ${iv} AND ${last} ${sign} ${iv})`;
  };

  /** Refuses a table other than the visual's, since that's the only one these forms read. */
  const own = (t?: string) => { if (t && ctx?.fullTable && !sameTable(t, ctx)) fail(`This visual reads ${ctx.fullTable}, so reading ${t} here isn't supported.`); };
  const tableName = (fn: string) => { const n = toks[p]; if (!skipTable()) fail(`${fn} over anything but a table name or FILTER(table, ...) isn't supported.`); own(n.v); };
  const rowsOf = (e: Env, fn: string): string[] => {
    if (!word("FILTER")) { tableName(fn); return []; }
    p++; take("("); tableName(fn); take(","); const c = level(0, copy(e, { where: [], only: ROW_ONLY })); take(")"); return [c];
  };
  const tableOf = (e: Env): Tbl => {
    if (!ctx) return fail("TOPN and SUMMARIZE need a visual to run in.");
    if (e.only) fail("TOPN and SUMMARIZE inside another table expression aren't supported.");
    if (word("TOPN")) {
      p++; take("("); const n = toks[p++]; if (n?.t !== "num" || !/^[1-9]\d*$/.test(n.v)) fail("TOPN needs a whole number above zero."); take(",");
      const t = tableOf(e); if (t.top) fail("TOPN inside TOPN isn't supported."); if (!peek(",")) fail("TOPN needs something to order by."); p++;
      const order = level(0, copy(e, { where: [], only: t.keys.length ? AGG_ONLY : ROW_ONLY, cols: t.cols })); let dir = "DESC";
      if (peek(",")) { p++; const m = String(toks[p++]?.v).toUpperCase(); if (!["ASC", "DESC", "0", "1"].includes(m)) fail("TOPN's order must be ASC or DESC."); if (m === "ASC" || m === "1") dir = "ASC"; }
      if (peek(",")) fail("TOPN with more than one order isn't supported.");
      take(")"); return { ...t, top: { n: Number(n.v), order, dir } };
    }
    if (word("SUMMARIZE")) {
      p++; take("("); const t: Tbl = { keys: [], cols: {}, where: rowsOf(e, "SUMMARIZE") };
      while (peek(",")) {
        p++; const a = toks[p++];
        if (a?.t === "col") { own(a.table); t.keys.push(qid(a.v)); continue; }
        if (a?.t !== "str") fail("SUMMARIZE takes columns, then names with their values."); take(","); t.cols[a!.v] = level(0, copy(e, { where: [], only: AGG_ONLY }));
      }
      take(")"); if (!t.keys.length) fail("SUMMARIZE needs a column to group by."); return t;
    }
    if (word("VALUES") || word("DISTINCT")) { p++; const [k] = list(() => { const c = toks[p++]; if (c?.t !== "col") fail("VALUES needs a column."); own(c!.table); return qid(c!.v); }); return { keys: [k], cols: {}, where: [] }; }
    return { keys: [], cols: {}, where: rowsOf(e, "TOPN") };
  };
  /** Ranks with ties kept, as TOPN does. Blanks sort lowest, as they do in DAX. */
  const qualify = (t: Tbl, parts: string[] = []) => (t.top ? ` QUALIFY RANK() OVER (${parts.length ? `PARTITION BY ${parts.join(", ")} ` : ""}ORDER BY ${t.top.order} ${t.top.dir} NULLS ${t.top.dir === "ASC" ? "FIRST" : "LAST"}) <= ${t.top.n}` : "");
  /** TOPN as a row filter: each of the visual's groups ranks its own rows, so it works under any grouping. ROW compares blanks as equal. */
  const topFilter = (t: Tbl, base: string[]): string => {
    const parts = [...(ctx!.dim ? [ctx!.dim.expr] : []), ...(ctx!.groups ?? [])], key = [...parts, ...(t.keys.length ? t.keys : [t.top!.order])], tuple = `ROW(${key.join(", ")}, 1)`; // the 1 because DuckDB reads a one-value ROW as plain brackets, which loses blanks
    const sub = `${tuple} IN (SELECT ${tuple} FROM ${ctx!.from} ${whereOf([unwhere(ctx!.where), ...base, ...t.where])}${t.keys.length ? ` GROUP BY ${key.join(", ")}` : ""}${qualify(t, parts)})`;
    return t.keys.length ? sub : [...t.where, sub].join(" AND ");
  };
  /** An iterator over groups, as a subquery. A visual's groups can't reach into it, so it's for single numbers. */
  const overGroups = (e: Env, fn: string, t: Tbl, body: string): string => {
    if (ctx!.dim || ctx!.groups?.length) fail("Iterating over SUMMARIZE or TOPN of VALUES isn't supported on a visual with groups. Use it on a single number.");
    if (e.shift || e.over != null || e.ignoreAll) fail("Iterating over SUMMARIZE or TOPN of VALUES with ALL or time intelligence isn't supported.");
    return `(SELECT ${fn}(__v) FROM (SELECT ${body} AS __v FROM ${ctx!.from} ${whereOf([unwhere(ctx!.where), ...e.where, ...t.where])} GROUP BY ${t.keys.join(", ")}${qualify(t)}) __t)`;
  };
  /** An iterator or COUNTROWS over a table argument, TOPN or SUMMARIZE. Past the opening bracket. */
  const iterTop = (e: Env, fn: string, hasBody: boolean): string => {
    const t = tableOf(e); let x = "*";
    if (!t.keys.length) { const env = copy(e, { where: [...e.where, topFilter(t, e.where)], top: true }); if (hasBody) { take(","); x = level(0, copy(e, { where: [], only: ROW_ONLY })); } take(")"); return emit(env, fn, x); }
    x = "1"; if (hasBody) { take(","); x = level(0, copy(e, { where: [], only: AGG_ONLY, cols: t.cols })); } take(")");
    return overGroups(e, hasBody ? fn : "COUNT", t, x);
  };
  /** An iterator over ALL or ALLSELECTED: the whole table whatever the visual's groups, or a column's values when nothing filters them. Past the opening bracket. */
  const iterAll = (e: Env, fn: string, label: string, hasBody: boolean): string => {
    if (!ctx) return fail(`${label} over ALL needs a visual to run in.`);
    const sel = word("ALLSELECTED"); p++; take("(");
    if (toks[p]?.t === "col") {
      if (sel || ctx.dim || ctx.groups?.length || unwhere(ctx.where) || e.where.length) fail(`${label} over one column of ALL or ALLSELECTED isn't supported on a visual with groups or filters.`);
      const c = toks[p++]; own(c.table); take(")"); let x = "1"; const t: Tbl = { keys: [qid(c.v)], cols: {}, where: [] };
      if (hasBody) { take(","); x = level(0, copy(e, { where: [], only: AGG_ONLY })); } take(")");
      return overGroups(e, fn, t, x);
    }
    tableName(label); take(")");
    if (e.shift || e.over != null || e.top || (sel && e.where.length)) fail(`${label} over ALL with other filters or time intelligence isn't supported.`);
    let x = "*"; if (hasBody) { take(","); x = level(0, copy(e, { where: [], only: ROW_ONLY })); } take(")");
    return `(SELECT ${fn}(${x}) FROM ${ctx.from}${sel && ctx.where ? ` ${ctx.where}` : ""})`;
  };
  /** An iterator inside another iterator: its own scan of the table under the same filters, which EARLIER reads the outer row from. */
  const inner = (e: Env, fn: string, hasBody: boolean): string => {
    if (!ctx?.fullTable) return fail("A nested iterator needs a visual to run in.");
    if (e.earlier || e.only || e.shift || e.over != null || e.ignoreAll) fail("This nested iterator isn't supported: only one level, without ALL or time intelligence around it.");
    const ie = copy(e, { where: [], row: undefined, earlier: true, only: ROW_ONLY }), filtered = word("FILTER"); let all = false, c = "", x = "*";
    if (filtered) { p++; take("("); }
    if (word("ALL")) { all = true; p++; take("("); tableName("A nested iterator"); take(")"); } else tableName("A nested iterator");
    if (filtered) { take(","); c = level(0, ie); take(")"); }
    if (hasBody) { take(","); x = level(0, ie); }
    take(")");
    const t = qid(ctx.fullTable.split(".").pop()!), same = all ? [] : [unwhere(ctx.where), ...e.row!, ...(ctx.dim ? [`${ctx.dim.expr} IS NOT DISTINCT FROM ${ctx.dim.expr.replaceAll(qid(ctx.dim.column), `${t}.${qid(ctx.dim.column)}`)}`] : []), ...(ctx.groups ?? []).map((g) => `${g} IS NOT DISTINCT FROM ${t}.${g}`)];
    return `(SELECT ${fn}(${x}) FROM ${ctx.from} __e ${whereOf([...same, c])})`;
  };
  const skipArg = () => { let d = 0; while (toks[p] && !(d === 0 && (peek(",") || peek(")")))) { if (peek("(") || peek("{")) d++; if (peek(")") || peek("}")) d--; p++; } };
  const relName = (): NonNullable<Env["rel"]> => {
    p++; take("("); const a = toks[p++]; take(","); const b = toks[p++]; take(")");
    if (a?.t !== "col" || !a.table || b?.t !== "col" || !b.table) return fail("USERELATIONSHIP needs two columns with their tables.");
    if (!ctx?.fullTable) return fail("USERELATIONSHIP needs a visual to run in.");
    if (/\bSELECT\b/i.test(ctx.where ?? "")) return fail("USERELATIONSHIP on a visual filtered through another relationship isn't supported.");
    const is = (r: NonNullable<DaxContext["relationships"]>[number], x: T, y: T) => last(r.fromTable) === x.table!.toLowerCase() && r.fromCol === x.v && last(r.toTable) === y.table!.toLowerCase() && r.toCol === y.v;
    const r = ctx.relationships?.find((r) => is(r, a, b) || is(r, b, a));
    if (!r) return fail(`Add a relationship from ${a.table}[${a.v}] to ${b.table}[${b.v}] under Model first.`);
    if (r.fromTable !== ctx.fullTable) return fail(`USERELATIONSHIP isn't supported on a visual of ${ctx.fullTable}. Use the table the relationship starts from, ${r.fromTable}.`);
    return { col: qid(r.fromCol), table: r.toTable.split(".").map(qid).join("."), on: qid(r.toCol), short: last(r.toTable) };
  };
  /** A filter that names the other table of USERELATIONSHIP reaches this table through that relationship. */
  const viaRel = (e: Env, from: number, c: string): string => {
    if (!e.rel) return c;
    const names = toks.slice(from, p).filter((x) => x.t === "col").map((x) => (x.table ?? "").toLowerCase());
    if (!names.includes(e.rel.short)) return c;
    if (names.some((n) => n !== e.rel!.short)) fail("One filter across two tables with USERELATIONSHIP isn't supported. Split it into two filters.");
    for (let i = from; i < p; i++) viaOther.add(i);
    return `${e.rel.col} IN (SELECT ${e.rel.on} FROM ${e.rel.table} WHERE ${c})`;
  };

  /** One filter argument of CALCULATE. Returns how it changes the context. */
  const filterArg = (e: Env): Partial<Env> => {
    const t = toks[p], name = t?.t === "id" ? t.v.toUpperCase() : "";
    if (name === "KEEPFILTERS") { p++; take("("); const r = filterArg(e); take(")"); return r; }
    if (name === "USERELATIONSHIP") { p++; list(() => { p++; return ""; }); return {}; }
    // Filter arguments see the context around CALCULATE, not each other
    if (name === "TOPN") { if (!ctx) return fail("TOPN needs a visual to run in."); const t = tableOf(e); return { where: [...e.where, topFilter(t, e.base ?? e.where)], top: true }; }
    if (name === "FILTER") {
      p++; take("("); const tbl = p;
      if (!skipTable()) {
        // These replace the visual's filters in DAX, where the FILTER clause below could only add to them
        if ((word("ALL") && (ctx?.dim || ctx?.groups?.length || unwhere(ctx?.where) || e.where.length)) || (word("ALLSELECTED") && (ctx?.dim || ctx?.groups?.length || e.where.length))) fail("FILTER over ALL or ALLSELECTED on a visual with groups or filters isn't supported.");
        if (word("ALL") || word("ALLSELECTED") || word("VALUES")) { p++; list(skipOne); } else level(0, copy(e, { rowCtx: true }));
      }
      take(","); const from = p, c = level(0, copy(e, { where: [], rowCtx: true })), r = viaRel(e, from, c); if (r !== c) viaOther.add(tbl); take(")"); return { where: [...e.where, r] };
    }
    if (name === "ALL" || name === "REMOVEFILTERS") {
      p++; take("("); let col: T | undefined; if (toks[p]?.t === "col") col = toks[p++]; else while (!peek(")")) { if (!toks[p]) fail(`${name} is missing a closing bracket.`); skipOne(); } take(")");
      if (!col) return { ignoreAll: true };
      const groups = ctx?.groups ?? [], others = [...(ctx?.dim ? [ctx.dim.expr] : []), ...groups].filter((g) => g !== qid(col!.v) && ctx?.dim?.column !== col!.v);
      return { over: others.length ? `PARTITION BY ${others.join(", ")}` : "" };
    }
    if (name === "ALLSELECTED") { p++; list(skipOne); return { over: "" }; }
    if (name === "ALLEXCEPT") { p++; take("("); skipTable(); const keep: string[] = []; while (peek(",")) { p++; const c = toks[p++]; if (c?.t !== "col") fail("ALLEXCEPT needs columns to keep."); keep.push(qid(c!.v)); } take(")"); const have = [...(ctx?.dim ? [qid(ctx.dim.column)] : []), ...(ctx?.groups ?? [])]; if (keep.some((k) => !have.includes(k))) fail("ALLEXCEPT can only keep fields this visual is grouped by."); return { over: keep.length ? `PARTITION BY ${keep.join(", ")}` : "" }; }
    if (TIME.includes(name)) {
      p++; take("("); const c = toks[p++]; if (c?.t !== "col") fail(`${name} needs a date column, such as Orders[date].`); const col = qid(c!.v);
      const more: T[] = []; while (peek(",")) { p++; const m = toks[p]; if (peek("-")) { p++; more.push({ t: "num", v: `-${toks[p++].v}` }); } else { more.push(m); p++; } } take(")");
      const num = (i: number) => Number(more[i]?.v), unit = (i: number) => UNITS[String(more[i]?.v).toUpperCase()] ?? fail("Use YEAR, QUARTER, MONTH or DAY.");
      switch (name) {
        case "SAMEPERIODLASTYEAR": return { shift: { kind: "shift", n: -1, unit: "YEAR", col } };
        case "DATEADD": case "PARALLELPERIOD": return Number.isFinite(num(0)) ? { shift: { kind: "shift", n: num(0), unit: unit(1), col } } : fail(`${name} needs a number of periods.`);
        case "DATESYTD": return { shift: { kind: "to", unit: "YEAR", col } }; case "DATESQTD": return { shift: { kind: "to", unit: "QUARTER", col } }; case "DATESMTD": return { shift: { kind: "to", unit: "MONTH", col } };
        default: { const m = /^(PREVIOUS|NEXT)(DAY|MONTH|QUARTER|YEAR)$/.exec(name)!; return { shift: { kind: "shift", n: m[1] === "NEXT" ? 1 : -1, unit: m[2], col } }; }
      }
    }
    const from = p, c = level(0, copy(e, { where: [], rowCtx: true }));
    return { where: [...e.where, viaRel(e, from, c)] };
  };

  const level = (n: number, e: Env): string => {
    if (n === LEVELS.length) return unary(e);
    let l = level(n + 1, e);
    while (toks[p]?.t === "op" && LEVELS[n].includes(toks[p].v) || (n === 2 && word("IN"))) {
      if (word("IN")) { p++; take("{"); const v: string[] = []; do { v.push(level(3, e)); } while (peek(",") && ++p); take("}"); l = `${l} IN (${v.join(", ")})`; continue; }
      const o = toks[p++].v, r = level(n + 1, e);
      l = o === "/" ? `(${l}) / NULLIF(${r}, 0)` : o === "^" ? `POWER(${l}, ${r})` : `${l} ${SQL[o] ?? o} ${r}`;
    }
    return l;
  };
  const unary = (e: Env): string => { if (peek("-")) { p++; return `-${unary(e)}`; } if (word("NOT") && !(toks[p + 1]?.t === "op" && toks[p + 1].v === "(")) { p++; return `NOT ${unary(e)}`; } return atom(e); };
  const atom = (e: Env): string => {
    const t = toks[p++];
    if (!t) return fail("This measure ends too early.");
    if (t.t === "num") return t.v;
    if (t.t === "str") return str(t.v);
    if (t.t === "col") {
      if (!t.table && e.cols?.[t.v] != null) return e.cols[t.v];
      if (!t.table && ctx?.measures?.[t.v] != null && e.only === ROW_ONLY) return fail(`[${t.v}] over single rows isn't supported here.`);
      // A bare [Name] can be a measure defined on the report
      if (!t.table && ctx?.measures?.[t.v] != null) return `(${daxToSql(ctx.measures[t.v], ctx, depth + 1, e)})`;
      return qid(t.v);
    }
    if (t.t === "op" && t.v === "(") { const x = level(0, e); take(")"); return `(${x})`; }
    if (t.t !== "id") return fail(`"${t.v}" is out of place.`);
    const name = t.v.toUpperCase();
    if (e.vars.has(t.v) && !peek("(")) return e.only ? fail(`${t.v} from a VAR isn't supported inside TOPN, SUMMARIZE or EARLIER.`) : e.vars.get(t.v)!;
    if (!peek("(")) { if (["TRUE", "FALSE"].includes(name)) return name; return fail(`${t.v} isn't something a measure can use.`); }
    if (e.only && !e.only.has(name)) return fail(`${t.v} isn't supported inside TOPN, SUMMARIZE or EARLIER.`);
    if (name === "EARLIER" && e.earlier) { take("("); const c = toks[p++]; if (c?.t !== "col") fail("EARLIER needs a column."); own(c!.table); if (peek(",")) fail("EARLIER with a number of levels isn't supported."); take(")"); return `${qid(ctx!.fullTable!.split(".").pop()!)}.${qid(c!.v)}`; }
    if (USABLE_IN[name]) return fail(`${t.v} isn't supported here. It only works ${USABLE_IN[name]}.`);
    if (REFUSED.includes(name)) return fail(`${t.v} returns a table or needs a full data model, which Basalt's DAX doesn't support. Try SQL or a model.`);
    if (AGG[name]) {
      const a = list(() => { if (toks[p]?.t !== "col") return level(0, copy(e, { where: [], rowCtx: true })); const c = toks[p++]; return qid(c.v); });
      if (a.length === 2 && (name === "MIN" || name === "MAX")) return `${name === "MIN" ? "LEAST" : "GREATEST"}(${a[0]}, ${a[1]})`;
      if (a.length !== 1) fail(`${name} needs one column.`);
      return emit(e, AGG[name], a[0]);
    }
    if (ITER[name]) {
      take("(");
      if (e.row) return inner(e, ITER[name], true);
      if (word("TOPN") || word("SUMMARIZE") || word("VALUES") || word("DISTINCT")) return iterTop(e, ITER[name], true);
      if (word("ALL") || word("ALLSELECTED")) return iterAll(e, ITER[name], name, true);
      let env = e;
      if (word("FILTER")) { p++; take("("); if (!skipTable()) p++; take(","); const c = level(0, copy(e, { where: [], rowCtx: true, row: e.where })); take(")"); env = copy(e, { where: [...e.where, c] }); }
      else if (!skipTable()) fail(`${name} starts with a table, such as ${name}(Orders, ...).`);
      take(","); const x = level(0, copy(e, { where: [], rowCtx: true, row: e.where })); take(")");
      return emit(env, ITER[name], x);
    }
    switch (name) {
      case "COUNTROWS": { take("("); if (e.row) return inner(e, "COUNT", false); if (word("TOPN") || word("SUMMARIZE")) return iterTop(e, "COUNT", false); if (word("ALL") || word("ALLSELECTED")) return iterAll(e, "COUNT", name, false); let env = e; if (word("FILTER")) { p++; take("("); if (!skipTable()) p++; take(","); const c = level(0, copy(e, { where: [], rowCtx: true, row: e.where })); take(")"); env = copy(e, { where: [...e.where, c] }); } else if (word("VALUES") || word("DISTINCT")) { p++; const a = list(() => { const c = toks[p++]; return `ROW(${qid(c.v)}, 1)`; }); take(")"); return emit(e, "COUNT DISTINCT", a[0]); } else while (!peek(")")) { if (!toks[p]) fail("COUNTROWS is missing a closing bracket."); skipOne(); } take(")"); return emit(env, "COUNT", "*"); }
      case "COUNTBLANK": { const [c] = list(() => { const x = toks[p++]; if (x?.t !== "col") fail("COUNTBLANK needs a column."); return qid(x!.v); }); return emit(copy(e, { where: [...e.where, `${c} IS NULL`] }), "COUNT", "*"); }
      case "CALCULATE": {
        take("(");
        const start = p; skipArg();
        let env = copy(e, { base: e.where });
        // USERELATIONSHIP changes how its sibling filters read, wherever it's written
        const args = p; while (peek(",")) { p++; if (word("USERELATIONSHIP")) env = copy(env, { rel: relName() }); else skipArg(); } p = args;
        while (peek(",")) { p++; env = copy(env, filterArg(env)); }
        take(")");
        const end = p; p = start; const body = level(0, env); p = end;
        return `(${body})`;
      }
      case "TOTALYTD": case "TOTALQTD": case "TOTALMTD": {
        take("(");
        const start = p; let d = 0;
        while (toks[p] && !(d === 0 && peek(","))) { if (peek("(")) d++; if (peek(")")) d--; p++; }
        take(","); const c = toks[p++]; if (c?.t !== "col") fail(`${name} needs a date column.`);
        let env = copy(e, { shift: { kind: "to", unit: TOTALS[name].toUpperCase(), col: qid(c!.v) } });
        while (peek(",")) { p++; env = copy(env, filterArg(env)); }
        take(")");
        const end = p; p = start; const body = level(0, env); p = end;
        return `(${body})`;
      }
      case "RELATED": {
        const [x] = [toks[p + 1]]; take("("); p++; take(")");
        if (x?.t !== "col" || !x.table) return fail("RELATED needs a column with its table, such as RELATED(Customers[city]).");
        const rel = ctx?.relationships?.find((r) => (r.toTable.split(".").pop()?.toLowerCase() === x.table!.toLowerCase() && r.fromTable === ctx.fullTable) || (r.fromTable.split(".").pop()?.toLowerCase() === x.table!.toLowerCase() && r.toTable === ctx.fullTable));
        if (!rel) return fail(`Add a relationship to ${x.table} under Model first.`);
        const here = rel.fromTable === ctx!.fullTable, [other, oc, mc] = here ? [rel.toTable, rel.toCol, rel.fromCol] : [rel.fromTable, rel.fromCol, rel.toCol];
        return `(SELECT __r.${qid(x.v)} FROM ${other.split(".").map(qid).join(".")} __r WHERE __r.${qid(oc)} = ${qid(ctx!.fullTable!.split(".").pop()!)}.${qid(mc)} LIMIT 1)`;
      }
      case "RANKX": {
        take("("); if (word("ALL") || word("ALLSELECTED") || word("VALUES")) { p++; list(skipOne); } else if (!skipTable()) fail("RANKX starts with a table or ALL(...)."); take(",");
        const x = level(0, e); let dir = "DESC";
        while (peek(",")) { p++; if (peek(",") || peek(")")) continue; const m = toks[p]; if (m?.t === "id" && ["ASC", "DESC"].includes(m.v.toUpperCase())) { dir = m.v.toUpperCase(); p++; } else if (m?.t === "num") { dir = m.v === "1" ? "ASC" : "DESC"; p++; } else level(0, e); }
        take(")");
        return `RANK() OVER (${ctx?.groups?.length && ctx.dim ? `PARTITION BY ${ctx.dim.expr} ` : ""}ORDER BY ${x} ${dir})`;
      }
      case "HASONEVALUE": { const [c] = list(() => qid(toks[p++].v)); return `COUNT(DISTINCT ${c}) = 1`; }
      case "SELECTEDVALUE": { const a = list(() => (toks[p]?.t === "col" ? qid(toks[p++].v) : level(0, e))); return `CASE WHEN COUNT(DISTINCT ${a[0]}) = 1 THEN ANY_VALUE(${a[0]}) ${a[1] ? `ELSE ${a[1]} ` : ""}END`; }
      case "CONCATENATEX": { take("("); let d = ""; if (!skipTable()) { if (word("VALUES") || word("DISTINCT")) { p++; [d] = list(() => { const c = toks[p++]; if (c?.t !== "col") fail("VALUES needs a column."); return qid(c!.v); }); } else fail("CONCATENATEX over anything but a table or VALUES isn't supported."); } take(","); const x = level(0, copy(e, { where: [], rowCtx: true })); if (d && x !== d) fail("CONCATENATEX over VALUES of one column, listing another, isn't supported."); let sep = "''"; if (peek(",")) { p++; sep = level(0, e); } while (peek(",")) { p++; level(0, e); } take(")"); return `STRING_AGG(${d ? "DISTINCT " : ""}CAST(${x} AS VARCHAR), ${sep})`; }
      case "DIVIDE": { const a = list(() => level(0, e)); if (a.length < 2 || a.length > 3) fail("DIVIDE needs two or three values."); const d = `(${a[0]}) / NULLIF(${a[1]}, 0)`; return a[2] ? `COALESCE(${d}, ${a[2]})` : d; }
      case "IF": { const a = list(() => level(0, e)); if (a.length < 2 || a.length > 3) fail("IF needs a condition and one or two values."); return `CASE WHEN ${a[0]} THEN ${a[1]}${a[2] ? ` ELSE ${a[2]}` : ""} END`; }
      case "SWITCH": { const a = list(() => level(0, e)); if (a.length < 3) fail("SWITCH needs a value and at least one match."); let s = `CASE ${a[0] === "TRUE" ? "" : a[0]}`; for (let i = 1; i + 1 < a.length; i += 2) s += ` WHEN ${a[i]} THEN ${a[i + 1]}`; return `${s}${a.length % 2 === 0 ? ` ELSE ${a[a.length - 1]}` : ""} END`; }
      case "DATEDIFF": { take("("); const a = level(0, e); take(","); const b = level(0, e); take(","); const u = toks[p++]; take(")"); const k = String(u?.v).toUpperCase(); if (!["YEAR", "QUARTER", "MONTH", "WEEK", "DAY", "HOUR", "MINUTE", "SECOND"].includes(k)) fail("DATEDIFF needs a unit, such as DAY."); return `DATE_DIFF('${k.toLowerCase()}', ${a}, ${b})`; }
      case "FORMAT": { const a = list(() => level(0, e)), f = /^'(.*)'$/.exec(a[1] ?? "")?.[1] ?? ""; if (f === "#,##0") return `FORMAT('{:,.0f}', CAST(${a[0]} AS DOUBLE))`; if (f === "#,##0.00") return `FORMAT('{:,.2f}', CAST(${a[0]} AS DOUBLE))`; if (f.endsWith("%") && FORMATS[f]) return `PRINTF('${FORMATS[f]}', CAST(${a[0]} AS DOUBLE) * 100)`; if (FORMATS[f]) return `PRINTF('${FORMATS[f]}', CAST(${a[0]} AS DOUBLE))`; return fail(`FORMAT supports ${[...Object.keys(FORMATS), "#,##0", "#,##0.00"].join(", ")}.`); }
    }
    if (SCALAR[name]) return SCALAR[name](list(() => level(0, e)));
    return fail(`${t.v} isn't supported. Supported: ${DAX_FUNCTIONS.join(", ")}.`);
  };

  // A named measure runs inside the context of whatever called it, as in DAX
  const env: Env = { ...outer, where: outer?.where ?? [], rowCtx: false, vars: new Map() };
  while (word("VAR")) { p++; const n = toks[p++]; if (n?.t !== "id") fail("VAR needs a name."); take("="); env.vars.set(n!.v, `(${level(0, env)})`); }
  if (word("RETURN")) p++;
  else if (env.vars.size) fail("VAR needs a RETURN.");
  const sql = level(0, env);
  if (p < toks.length) fail(`"${toks[p].v}" is out of place.`);
  // Every column is read from the visual's table, so naming another one would quietly read the wrong column. RELATED and USERELATIONSHIP name it on purpose
  if (ctx?.fullTable) {
    const named = (i: number, n: string) => toks[i]?.t === "id" && toks[i].v.toUpperCase() === n;
    toks.forEach((t, i) => { if (t.t === "col" && t.table && !viaOther.has(i) && !named(i - 2, "RELATED") && !named(i - 2, "USERELATIONSHIP") && !named(i - 4, "USERELATIONSHIP")) own(t.table); });
    for (const i of tables) if (toks[i]?.t === "id" && !viaOther.has(i)) own(toks[i].v);
  }
  return sql;
}
