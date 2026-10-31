/**
 * The semantic model: tables, relationships, hierarchies and measures over the warehouse, and a DAX compiler that runs on them.
 *
 * Every aggregate becomes its own subquery under an explicit filter context, as DAX evaluates it. Filters reach an aggregate's table along the
 * relationships: many-to-one hops are LEFT JOINs, which can't add rows because every compiled query checks the one side is unique, and every other
 * hop (both directions, many-to-many) is an IN, which can't add rows at all. So no path can inflate a SUM. Anything else is refused by name.
 * Dashboards with no model never reach this file: they keep using dax.ts.
 */
import { DaxError, lex, SCALAR } from "./dax.ts";
import { filterSql, kindOf, lit, q, table as tableSql } from "./sql.ts";
import type { Column, Config, Filter, Measure, Metric, Model, Widget } from "./types.ts";

export type SemColumn = { label?: string; hidden?: boolean; format?: Widget["format"]; category?: string; folder?: string };
export type SemCalc = { name: string; dax: string };
export type SemTable = { full: string; label: string; hidden?: boolean; columns?: Record<string, SemColumn>; dateColumn?: string; calc?: SemCalc[]; x?: number; y?: number };
/** "from" is the many side and "to" the one side. Filters always flow to -> from; both adds from -> to. */
export type SemRel = { id: string; from: string; fromCol: string; to: string; toCol: string; kind?: "one" | "many"; active?: boolean; both?: boolean };
export type SemHierarchy = { id: string; table: string; name: string; levels: string[] };
export type SemPerspective = { id: string; name: string; tables: string[]; measures: string[] };
export type Stage = "raw" | "staging" | "analytics" | "model" | "other";
export type SemanticModel = { tables: SemTable[]; relationships: SemRel[]; hierarchies?: SemHierarchy[]; perspectives?: SemPerspective[]; calcTables?: { id: string; name: string; dax: string }[]; autoDate?: { sources: { table: string; column: string }[] }; viewerStages?: Partial<Record<Stage, boolean>> };
export type Sem = { model: SemanticModel; schema: Record<string, Column[]>; metrics: Metric[] };

const fail = (m: string): never => { throw new DaxError(m); };
const parts = (full: string) => full.split(".");
const lastOf = (full: string) => parts(full).pop()!;
const slug = (s: string) => s.replace(/\W+/g, "_").toLowerCase();
export const DATE_TABLE = "analytics.date_table";
export const calcModelName = (full: string) => `calc_${slug(lastOf(full))}`;
const calcFull = (full: string) => `analytics.${calcModelName(full)}`;
export const calcTableFull = (name: string) => `analytics.calctbl_${slug(name)}`;
export const isModelled = (m?: SemanticModel) => !!m?.tables.length;
export const fieldOf = (t: string, c: string) => `${t}[${c}]`;
export const parseField = (f: string) => { const m = /^(.*)\[(.*)\]$/.exec(f); return m ? { table: m[1], column: m[2] } : null; };
export const fieldLabel = (sem: Sem | undefined, f: string) => { const p = parseField(f); if (!p) return f; const t = sem?.model.tables.find((x) => x.full === p.table); return t?.columns?.[p.column]?.label || p.column.replace(/_/g, " "); };
/** What a report author sees: visible tables and columns, with friendly names, narrowed by a perspective. */
export function fieldsOf(sem: Sem, perspective?: string) {
  const p = sem.model.perspectives?.find((x) => x.id === perspective);
  return sem.model.tables.filter((t) => !t.hidden && (!p || p.tables.includes(t.full))).flatMap((t) => {
    const gen = t.calc?.length ? sem.schema[calcFull(t.full)] : undefined;
    return (gen ?? sem.schema[t.full] ?? []).filter((c) => !t.columns?.[c.name]?.hidden).map((c) => ({ field: fieldOf(t.full, c.name), name: fieldOf(t.full, c.name), type: c.type, label: [t.label, t.columns?.[c.name]?.folder, t.columns?.[c.name]?.label || c.name].filter(Boolean).join(" / "), format: t.columns?.[c.name]?.format }));
  });
}
export const measuresOf = (sem: Sem, perspective?: string) => { const p = sem.model.perspectives?.find((x) => x.id === perspective); return sem.metrics.filter((m) => !p || p.measures.includes(m.name)); };
export const semanticOf = (model: SemanticModel | undefined, tables: { full: string; columns: Column[] }[] | null | undefined, metrics: Metric[]): Sem | undefined => (model && isModelled(model) && tables ? { model, metrics, schema: Object.fromEntries(tables.map((t) => [t.full, t.columns])) } : undefined);

/* ---- Data layers ---- */
export const STAGES: [Stage, string][] = [["raw", "Raw"], ["staging", "Staging"], ["analytics", "Analytics"], ["model", "Model"], ["other", "Other"]];
export function stageOf(schema: string, name: string, models: Pick<Model, "name" | "generated">[] = []): Stage {
  if (/^raw_/.test(schema) || schema === "sample") return "raw";
  if (schema !== "analytics") return "other";
  if (models.some((m) => m.name === name && m.generated)) return "model";
  return /^(stg|staging)_/.test(name) ? "staging" : "analytics";
}
export const viewerMayRead = (m: SemanticModel | undefined, s: Stage) => m?.viewerStages?.[s] !== false;

/* ---- Parser ---- */
type N = { k: "num" | "str"; v: string } | { k: "col"; t?: string; c: string } | { k: "name"; v: string } | { k: "call"; f: string; a: N[] } | { k: "bin"; o: string; l: N; r: N } | { k: "neg" | "not"; x: N } | { k: "in"; x: N; list: N[] } | { k: "vars"; vars: [string, N][]; body: N } | { k: "empty" };
const LEVELS = [["||"], ["&&"], ["=", "==", "<>", "<", ">", "<=", ">="], ["&"], ["+", "-"], ["*", "/"], ["^"]];
function parse(src: string): N {
  const toks = lex(src.replace(/^\s*(?!VAR\b)(?:[A-Za-z_][\w ]*|\[[^\]]*\])\s*:?=\s*(?=[A-Za-z'[(\d"-])/i, ""));
  let p = 0;
  const op = (v: string) => toks[p]?.t === "op" && toks[p].v === v;
  const word = (v: string) => toks[p]?.t === "id" && toks[p].v.toUpperCase() === v;
  const take = (v: string) => { if (!op(v)) fail(`Expected "${v}" in this measure.`); p++; };
  const expr = (): N => {
    if (!word("VAR")) return level(0);
    const vars: [string, N][] = [];
    while (word("VAR")) { p++; const n = toks[p++]; if (n?.t !== "id") fail("VAR needs a name."); take("="); vars.push([n.v, expr()]); }
    if (!word("RETURN")) fail("VAR needs a RETURN."); p++;
    return { k: "vars", vars, body: expr() };
  };
  const level = (n: number): N => {
    if (n === LEVELS.length) return unary();
    let l = level(n + 1);
    for (;;) {
      if (n === 2 && word("IN")) { p++; take("{"); const list: N[] = []; do { list.push(level(3)); } while (op(",") && ++p); take("}"); l = { k: "in", x: l, list }; continue; }
      if (toks[p]?.t !== "op" || !LEVELS[n].includes(toks[p].v)) return l;
      const o = toks[p++].v; l = { k: "bin", o: o === "==" ? "=" : o, l, r: level(n + 1) };
    }
  };
  const unary = (): N => { if (op("-")) { p++; return { k: "neg", x: unary() }; } if (word("NOT") && !(toks[p + 1]?.t === "op" && toks[p + 1].v === "(")) { p++; return { k: "not", x: unary() }; } return atom(); };
  const atom = (): N => {
    const t = toks[p++];
    if (!t) return fail("This measure ends too early.");
    if (t.t === "num" || t.t === "str") return { k: t.t, v: t.v };
    if (t.t === "col") return { k: "col", t: t.table, c: t.v };
    if (t.t === "op" && t.v === "(") { const x = expr(); take(")"); return x; }
    if (t.t !== "id") return fail(`"${t.v}" is out of place.`);
    if (!op("(")) return { k: "name", v: t.v };
    p++; const a: N[] = [];
    if (!op(")")) do { a.push(op(",") || op(")") ? { k: "empty" } : expr()); } while (op(",") && ++p);
    take(")");
    return { k: "call", f: t.v.toUpperCase(), a };
  };
  const out = expr();
  if (p < toks.length) fail(`"${toks[p].v}" is out of place.`);
  return out;
}

/* ---- Compiler ---- */
type V = { s: string; t?: "n" | "s" | "d" | "b" };
type Scan = { joins: string[]; by: Map<string, string> };
type Pred = { t: string; cols: string[] | "*"; group?: boolean; rowOf?: string; cond: (a: string, s: Scan) => string };
/** A row source. table is set when its rows are that model table's rows; cols holds the columns it kept from model tables; names the ones it added. */
type Src = { alias: string; table?: string; scan: Scan; where: string[]; from: () => string; cols: Map<string, string>; names: Map<string, V>; extra?: string[] };
type Env = { fc: Pred[]; rows: Src[]; vars: Map<string, { v?: V; table?: (e: Env) => Src }>; rels: SemRel[]; depth: number };

const AGG: Record<string, string> = { SUM: "SUM", AVERAGE: "AVG", MIN: "MIN", MAX: "MAX", MEDIAN: "MEDIAN", COUNT: "COUNT", COUNTA: "COUNT", PRODUCT: "PRODUCT", STDEV: "STDDEV_SAMP", "STDEV.S": "STDDEV_SAMP", "STDEV.P": "STDDEV_POP", VAR: "VAR_SAMP", "VAR.S": "VAR_SAMP", "VAR.P": "VAR_POP" };
const ITER: Record<string, string> = { SUMX: "SUM", AVERAGEX: "AVG", MINX: "MIN", MAXX: "MAX", COUNTX: "COUNT", COUNTAX: "COUNT", MEDIANX: "MEDIAN", PRODUCTX: "PRODUCT", "STDEVX.S": "STDDEV_SAMP", "STDEVX.P": "STDDEV_POP", "VARX.S": "VAR_SAMP", "VARX.P": "VAR_POP" };
const TABLE_FNS = new Set(["FILTER", "ALL", "ALLSELECTED", "VALUES", "DISTINCT", "RELATEDTABLE", "CALCULATETABLE", "TOPN", "ADDCOLUMNS", "SELECTCOLUMNS", "SUMMARIZE"]);
const SHIFTS = ["SAMEPERIODLASTYEAR", "DATEADD", "PARALLELPERIOD", "PREVIOUSDAY", "PREVIOUSMONTH", "PREVIOUSQUARTER", "PREVIOUSYEAR", "NEXTDAY", "NEXTMONTH", "NEXTQUARTER", "NEXTYEAR", "DATESYTD", "DATESQTD", "DATESMTD", "DATESBETWEEN"];
const TOTALS: Record<string, string> = { TOTALYTD: "DATESYTD", TOTALQTD: "DATESQTD", TOTALMTD: "DATESMTD" };
const REMOVERS = new Set(["ALL", "REMOVEFILTERS", "ALLEXCEPT", "ALLSELECTED"]);
const SUPPORTED = ["CALCULATE", "CALCULATETABLE", "FILTER", "ALL", "ALLSELECTED", "ALLEXCEPT", "REMOVEFILTERS", "KEEPFILTERS", "USERELATIONSHIP", "CROSSFILTER", "RELATED", "RELATEDTABLE", "ADDCOLUMNS", "SELECTCOLUMNS", "SUMMARIZE", "TOPN", "VALUES", "DISTINCT", "RANKX", "EARLIER", "SELECTEDVALUE", "HASONEVALUE", "ISFILTERED", "COUNTROWS", "COUNTBLANK", "DISTINCTCOUNT", "DISTINCTCOUNTNOBLANK", "CONCATENATEX", "DIVIDE", "IF", "SWITCH", "DATEDIFF", ...Object.keys(TOTALS), ...SHIFTS, ...Object.keys(AGG), ...Object.keys(ITER)];
export const MODEL_DAX_FUNCTIONS = [...new Set([...SUPPORTED, ...Object.keys(SCALAR)])];
const loose = (s: string) => s.toLowerCase().replace(/^(fct|fact|dim|stg|vw)_/, "").replace(/[^a-z0-9]/g, "").replace(/s$/, "");
const distinctEq = (a: string, b: string) => `${a} IS NOT DISTINCT FROM ${b}`;
const whereOf = (w: string[]) => (w.length ? ` WHERE ${w.map((x) => `(${x})`).join(" AND ")}` : "");
const key = (t: string, c: string) => `${t}\0${c}`;
const unkey = (k: string) => k.split("\0") as [string, string];

type Opts = { building?: string; extra?: string[]; ref?: (full: string) => string };
function compiler(sem: Sem, opts: Opts = {}) {
  let n = 0;
  const al = (p = "a") => `${p}${++n}`;
  const guards = new Map<string, string>();
  const tables = sem.model.tables, baseRels: SemRel[] = sem.model.relationships.map((r) => ({ ...r, kind: r.kind ?? "one", active: r.active !== false }));
  const metaOf = (t: string) => tables.find((x) => x.full === t) ?? fail(`${t} isn't a table in this model.`);
  // Generated tables replace their source once built. While building one, it reads its source and later tables read what's being built
  const physical = (t: string) => { const m = metaOf(t); if (!m.calc?.length || t === opts.building) return t; return opts.building || sem.schema[calcFull(t)] ? calcFull(t) : t; };
  const ref = (t: string) => (opts.ref ?? tableSql)(physical(t));
  const colsOf = (t: string) => { const m = metaOf(t), built = sem.schema[physical(t)]; if (opts.building && t !== opts.building && m.calc?.length) return [...(sem.schema[t] ?? []).map((c) => c.name), ...m.calc.map((c) => c.name)]; return (built ?? sem.schema[t] ?? fail(`${t} doesn't exist in the warehouse yet. Build the model first.`)).map((c) => c.name); };
  const typeOf = (t: string, c: string): V["t"] => { const type = (sem.schema[physical(t)] ?? sem.schema[t])?.find((x) => x.name === c)?.type; if (!type) return undefined; const k = kindOf(type); return k === "number" ? "n" : k === "date" ? "d" : k === "bool" ? "b" : k === "text" ? "s" : undefined; };

  /** Exact id, then label, then short name, then the loose form, so Orders reads fct_orders. A tie is refused rather than guessed. */
  const tableNamed = (name: string): string => {
    const low = name.toLowerCase();
    for (const test of [(t: SemTable) => t.full.toLowerCase() === low, (t: SemTable) => t.label.toLowerCase() === low, (t: SemTable) => lastOf(t.full).toLowerCase() === low, (t: SemTable) => loose(lastOf(t.full)) === loose(name) || loose(t.label) === loose(name)]) {
      const hit = tables.filter(test);
      if (hit.length > 1) return fail(`${name} could mean ${hit.map((t) => t.label).join(" or ")}. Use the full table name.`);
      if (hit.length) return hit[0].full;
    }
    return fail(`${name} isn't a table in this model. Add it under Model first.`);
  };
  const columnNamed = (t: string, c: string, extra: string[] = []): string | undefined => [...colsOf(t), ...extra].find((x) => x.toLowerCase() === c.toLowerCase());
  const asCol = (x: N | undefined, what: string): { t: string; c: string } => {
    if (x?.k !== "col" || !x.t) return fail(`${what} needs a column with its table, such as Orders[amount].`);
    const t = tableNamed(x.t), c = columnNamed(t, x.c);
    if (!c) return fail(`${x.t} has no column ${x.c}. ${metaOf(t).calc?.some((k) => k.name === x.c) ? "Build the model first." : ""}`.trim());
    return { t, c };
  };

  /* Relationships */
  const other = (r: SemRel, t: string) => (r.from === t ? r.to : r.from);
  const flowsInto = (e: Env, t: string) => e.rels.filter((r) => r.active && (r.from === t || (r.to === t && r.both)));
  const hasUp = (e: Env, t: string, seen: Set<string>): boolean => e.fc.some((p) => p.t === t) || flowsInto(e, t).some((r) => { const o = other(r, t); return !seen.has(o) && hasUp(e, o, new Set([...seen, o])); });
  const checkPaths = (e: Env, home: string) => {
    const count = new Map<string, number>();
    const walk = (t: string, seen: Set<string>) => { count.set(t, (count.get(t) ?? 0) + 1); for (const r of flowsInto(e, t)) { const o = other(r, t); if (!seen.has(o)) walk(o, new Set([...seen, o])); } };
    walk(home, new Set([home]));
    for (const [t, c] of count) if (c > 1 && e.fc.some((p) => p.t === t)) fail(`A filter on ${metaOf(t).label} can reach ${metaOf(home).label} by more than one path. Make one relationship inactive or single direction.`);
  };
  const join = (s: Scan, a: string, r: SemRel) => {
    const k = `${a}|${r.id}`; let j = s.by.get(k);
    if (!j) {
      j = al("j"); s.by.set(k, j);
      s.joins.push(`LEFT JOIN ${ref(r.to)} ${j} ON ${j}.${q(r.toCol)} = ${a}.${q(r.fromCol)}`);
      guards.set(r.id, `(SELECT CASE WHEN COUNT(${q(r.toCol)}) <> COUNT(DISTINCT ${q(r.toCol)}) THEN error(${lit(`${metaOf(r.to).label}[${r.toCol}] has duplicate values, so it can't be the one side of this relationship. Fix the data or change the relationship to many-to-many.`)}) ELSE TRUE END FROM ${ref(r.to)})`);
    }
    return j;
  };
  const conds = (e: Env, t: string, a: string, s: Scan, seen = new Set([t])): string[] => {
    const out = e.fc.filter((p) => p.t === t).map((p) => p.cond(a, s));
    for (const r of flowsInto(e, t)) {
      const o = other(r, t), next = new Set([...seen, o]);
      if (seen.has(o) || !hasUp(e, o, next)) continue;
      if (r.from === t && r.kind === "one") { out.push(...conds(e, o, join(s, a, r), s, next)); continue; }
      // Against the one-to-many direction, or many-to-many: a row counts once however many matches it has, and has no blank row
      const b = al("b"), sub: Scan = { joins: [], by: new Map() }, c = conds(e, o, b, sub, next), [mine, theirs] = r.from === t ? [r.fromCol, r.toCol] : [r.toCol, r.fromCol];
      out.push(`${a}.${q(mine)} IN (SELECT ${b}.${q(theirs)} FROM ${ref(o)} ${b} ${sub.joins.join(" ")}${whereOf(c)})`);
    }
    return out;
  };
  /** The unknown member: a one-side table gains a blank row when many-side rows match nothing, as the docs define for regular relationships. */
  const withBlank = (e: Env, t: string, seen: string[] = [t]): string => {
    const into = e.rels.filter((r) => r.to === t && r.kind === "one" && r.active && !seen.includes(r.from));
    if (!into.length) return ref(t);
    // Blank rows chain: a sale with no customer also has no customer's region
    const col = into[0].toCol, some = into.map((r) => `EXISTS (SELECT 1 FROM ${withBlank(e, r.from, [...seen, r.from])} f WHERE NOT EXISTS (SELECT 1 FROM ${ref(t)} o WHERE o.${q(r.toCol)} = f.${q(r.fromCol)}))`).join(" OR ");
    return `(SELECT * FROM ${ref(t)} UNION ALL BY NAME SELECT NULL AS ${q(col)} WHERE ${some})`;
  };
  const scan = (e: Env, t: string, blank = false): Src => {
    checkPaths(e, t);
    const alias = al(), s: Scan = { joins: [], by: new Map() }, where = conds(e, t, alias, s);
    return { alias, table: t, scan: s, where, cols: new Map(), names: new Map(), from: () => `${blank ? withBlank(e, t) : ref(t)} ${alias} ${s.joins.join(" ")}` };
  };
  const select = (src: Src, list: string, tail = "") => `SELECT ${list} FROM ${src.from()}${whereOf(src.where)}${tail}`;
  const rowsIn = (e: Env, src: Src): Env => ({ ...e, rows: [...e.rows, src] });
  const fakeRow = (t: string, a: string, s: Scan): Src => ({ alias: a, table: t, scan: s, where: [], from: () => "", cols: new Map(), names: new Map() });

  /** New distinct source of columns, keeping which model column each came from. */
  const distinct = (e: Env, t: string, cs: string[], blank: boolean): Src => {
    const s = scan(e, t, blank), b = al("v"), list = cs.map((c, i) => `${s.alias}.${q(c)} AS c${i}`).join(", ");
    return { alias: b, scan: { joins: [], by: new Map() }, where: [], names: new Map(), cols: new Map(cs.map((c, i) => [key(t, c), `${b}.c${i}`])), from: () => `(${select(s, `DISTINCT ${list}`)}) ${b}` };
  };
  /** Wraps a source in a subquery, adding columns or a row limit, and keeps it readable by the same names. */
  const wrap = (src: Src, adds: [string, V][], tail: string, keep = true): Src => {
    const b = al("w"), s: Scan = { joins: [], by: new Map() }, list: string[] = [], cols = new Map<string, string>(), names = new Map<string, V>();
    if (src.table && keep) list.push(`${src.alias}.*`);
    if (keep) { [...src.cols].forEach(([k, x], i) => { list.push(`${x} AS k${i}`); cols.set(k, `${b}.k${i}`); }); [...src.names].forEach(([k, v], i) => { list.push(`${v.s} AS m${i}`); names.set(k, { ...v, s: `${b}.m${i}` }); }); }
    adds.forEach(([name, v], i) => { list.push(`(${v.s}) AS x${i}`); names.set(name, { ...v, s: `${b}.x${i}` }); });
    return { alias: b, table: keep ? src.table : undefined, scan: s, where: [], cols, names, extra: src.extra, from: () => `(${select(src, list.join(", "), tail)}) ${b} ${s.joins.join(" ")}` };
  };

  /* Context */
  const rowEq = (t: string, row: string): Pred["cond"] => {
    const k = baseRels.find((r) => r.to === t && r.kind === "one")?.toCol, keys = k ? [k] : colsOf(t);
    return (a) => keys.map((c) => distinctEq(`${a}.${q(c)}`, `${row}.${q(c)}`)).join(" AND ");
  };
  /** Each row becomes a filter: its table's other filters are overridden, as they are in DAX. */
  const transition = (e: Env): Pred[] => {
    let fc = e.fc;
    for (const r of e.rows) {
      if (r.table) { const t = r.table; fc = [...fc.filter((p) => p.t !== t), { t, cols: "*", rowOf: r.alias, cond: rowEq(t, r.alias) }]; }
      for (const [k, x] of r.cols) { const [t, c] = unkey(k); fc = [...fc.filter((p) => !(p.t === t && p.cols !== "*" && p.cols.includes(c))), { t, cols: [c], cond: (a) => distinctEq(`${a}.${q(c)}`, x) }]; }
    }
    return fc;
  };
  const expanded = (t: string, rels: SemRel[]): Set<string> => { const out = new Set([t]); for (let grew = true; grew;) { grew = false; for (const r of rels) if (r.kind === "one" && out.has(r.from) && !out.has(r.to)) { out.add(r.to); grew = true; } } return out; };
  // A row's filter covers every column, so removing one column leaves the rest
  const explode = (p: Pred): Pred[] => (p.rowOf ? colsOf(p.t).map((c) => ({ t: p.t, cols: [c], cond: (a: string) => distinctEq(`${a}.${q(c)}`, `${p.rowOf}.${q(c)}`) })) : [p]);
  const dropCol = (fc: Pred[], t: string, c: string) => fc.flatMap(explode0(t)).filter((p) => !(p.t === t && (p.cols === "*" || p.cols.includes(c))));
  const explode0 = (t: string) => (p: Pred) => (p.t === t ? explode(p) : [p]);

  const refsIn = (x: N, f: (n: N) => void) => { f(x); if (x.k === "call" && x.f === "EARLIER") return; for (const v of Object.values(x)) if (Array.isArray(v)) v.forEach((y) => { if (Array.isArray(y)) refsIn(y[1] as N, f); else refsIn(y as N, f); }); else if (v && typeof v === "object" && "k" in v) refsIn(v as N, f); };

  const relBetween = (a: N | undefined, b: N | undefined, fn: string) => {
    const x = asCol(a, fn), y = asCol(b, fn), is = (r: SemRel, p: typeof x, o: typeof x) => r.from === p.t && r.fromCol === p.c && r.to === o.t && r.toCol === o.c;
    const r = baseRels.find((r) => is(r, x, y) || is(r, y, x));
    return r ? { r, x } : fail(`Add a relationship from ${a && a.k === "col" ? `${a.t}[${a.c}]` : ""} to ${b && b.k === "col" ? `${b.t}[${b.c}]` : ""} under Model first.`);
  };

  /** Time intelligence as a date filter on the marked date table. The dates are the ones in context around CALCULATE. */
  const dateFilter = (n: Extract<N, { k: "call" }>, e: Env): { t: string; pred: Pred } => {
    const { t, c } = asCol(n.a[0], n.f);
    if (metaOf(t).dateColumn !== c) return fail(`${n.f} needs the column marked as the date table's date, and ${metaOf(t).label}[${c}] isn't. Mark a date table under Model.`);
    // These functions read their column through CALCULATETABLE, so an iterator's row narrows the dates
    e = { ...e, fc: transition(e) };
    const set = (fn: (d: string) => string) => { const s = scan(e, t); return `(${select(s, fn(`${s.alias}.${q(c)}`))})`; };
    const lo = set((d) => `MIN(${d})`), hi = set((d) => `MAX(${d})`), trunc = (u: string, x: string) => `DATE_TRUNC('${u.toLowerCase()}', ${x})`, plus = (x: string, k: number, u: string) => `${x} + INTERVAL (${k}) ${u}`;
    const unit = (x: N | undefined) => { const u = x?.k === "name" ? x.v.toUpperCase() : ""; return ["YEAR", "QUARTER", "MONTH", "DAY"].includes(u) ? u : fail(`${n.f} needs YEAR, QUARTER, MONTH or DAY.`); };
    const count = (x: N | undefined) => { if (x?.k === "num") return Number(x.v); if (x?.k === "neg" && x.x.k === "num") return -Number(x.x.v); return fail(`${n.f} needs a whole number of periods.`); };
    const shift = (k: number, u: string): Pred["cond"] => (a) => {
      const s = scan(e, t), d = `${s.alias}.${q(c)}`, to = plus(d, k, u), col = `${a}.${q(c)}`;
      // A month-end date reaches the end of the target month, so all of February moves to all of March
      return `EXISTS (${select({ ...s, where: [...s.where, u === "DAY" ? `${col} = ${to}` : `${col} = ${to} OR (${d} = LAST_DAY(${d}) AND ${col} > ${to} AND LAST_DAY(${col}) = LAST_DAY(${to}))`] }, "1")})`;
    };
    const span = (from: string, to: string, inclusive = false): Pred["cond"] => (a) => `${a}.${q(c)} >= ${from} AND ${a}.${q(c)} ${inclusive ? "<=" : "<"} ${to}`;
    const pred = (cond: Pred["cond"]): { t: string; pred: Pred } => ({ t, pred: { t, cols: "*", cond } });
    const m = /^(PREVIOUS|NEXT)(DAY|MONTH|QUARTER|YEAR)$/.exec(n.f);
    if (m) return m[1] === "NEXT" ? pred(span(plus(trunc(m[2], hi), 1, m[2]), plus(trunc(m[2], hi), 2, m[2]))) : pred(span(plus(trunc(m[2], lo), -1, m[2]), trunc(m[2], lo)));
    switch (n.f) {
      case "SAMEPERIODLASTYEAR": return pred(shift(-1, "YEAR"));
      case "DATEADD": return pred(shift(count(n.a[1]), unit(n.a[2])));
      case "PARALLELPERIOD": { const k = count(n.a[1]), u = unit(n.a[2]); return pred(span(plus(trunc(u, lo), k, u), plus(trunc(u, hi), k + 1, u))); }
      case "DATESYTD": case "DATESQTD": case "DATESMTD": { if (n.a[1]) fail(`${n.f} with a year-end date isn't supported.`); const u = { DATESYTD: "YEAR", DATESQTD: "QUARTER", DATESMTD: "MONTH" }[n.f]!; return pred(span(trunc(u, hi), hi, true)); }
      case "DATESBETWEEN": { if (n.a.length !== 3 || n.a[1].k === "empty" || n.a[2].k === "empty") fail("DATESBETWEEN needs a start and an end."); return pred(span(val(n.a[1], e).s, val(n.a[2], e).s, true)); }
    }
    return fail(`${n.f} isn't supported.`);
  };

  /** Applies CALCULATE's arguments in DAX's order: context transition, relationship changes, removals, then filters read in the outer context. */
  const calcEnv = (args: N[], e: Env): Env => {
    let fc = transition(e), rels = e.rels;
    const call = (a: N) => (a.k === "call" ? a : null);
    for (const a of args) {
      const f = call(a); if (!f) continue;
      if (f.f === "USERELATIONSHIP") { const { r } = relBetween(f.a[0], f.a[1], f.f); rels = rels.map((x) => (x.id === r.id ? { ...x, active: true } : (x.from === r.from && x.to === r.to) || (x.from === r.to && x.to === r.from) ? { ...x, active: false } : x)); }
      if (f.f === "CROSSFILTER") {
        const { r, x } = relBetween(f.a[0], f.a[1], f.f), mode = f.a[2]?.k === "name" ? f.a[2].v.toUpperCase() : "", leftIsMany = x.t === r.from;
        if (mode === "ONEWAY_LEFTFILTERSRIGHT" ? leftIsMany : mode === "ONEWAY_RIGHTFILTERSLEFT" ? !leftIsMany : false) fail("CROSSFILTER can't make a filter run only from the many side to the one side.");
        if (!["NONE", "BOTH", "ONEWAY", "ONEWAY_LEFTFILTERSRIGHT", "ONEWAY_RIGHTFILTERSLEFT"].includes(mode)) fail("CROSSFILTER needs None, Both or OneWay.");
        rels = rels.map((y) => (y.id === r.id ? (mode === "NONE" ? { ...y, active: false } : { ...y, both: mode === "BOTH" }) : y));
      }
    }
    const inner = { ...e, rels };
    for (const a of args) {
      const f = call(a); if (!f || !REMOVERS.has(f.f)) continue;
      if (f.f === "ALLSELECTED" && e.rows.length) fail("ALLSELECTED inside an iterator isn't supported.");
      const colArg = f.a[0]?.k === "col";
      if (!f.a.length) { fc = f.f === "ALLSELECTED" ? fc.filter((p) => !p.group) : []; continue; }
      if (f.f === "ALLEXCEPT") {
        const t = f.a[0].k === "name" ? tableNamed(f.a[0].v) : fail("ALLEXCEPT starts with a table."), keep = f.a.slice(1).map((x) => asCol(x, "ALLEXCEPT")), wide = expanded(t, rels);
        fc = fc.flatMap(explode).filter((p) => !wide.has(p.t) || (p.cols !== "*" && p.cols.every((c) => keep.some((k) => k.t === p.t && k.c === c))));
        continue;
      }
      if (colArg) for (const x of f.a) { const { t, c } = asCol(x, f.f); fc = f.f === "ALLSELECTED" ? fc.filter((p) => !(p.group && p.t === t && p.cols !== "*" && p.cols.includes(c))) : dropCol(fc, t, c); }
      else { if (f.a.length > 1 || f.a[0].k !== "name") fail(`${f.f} takes a table or columns of one table.`); const wide = expanded(tableNamed((f.a[0] as Extract<N, { k: "name" }>).v), rels); fc = fc.filter((p) => !wide.has(p.t) || (f.f === "ALLSELECTED" && !p.group)); }
    }
    for (const a of args) {
      const f = call(a);
      if (f && (REMOVERS.has(f.f) || f.f === "USERELATIONSHIP" || f.f === "CROSSFILTER")) continue;
      const keep = f?.f === "KEEPFILTERS", arg = keep ? f.a[0] : a;
      fc = filterArg(arg, e, fc, inner, keep);
    }
    return { ...e, fc, rels };
  };
  const filterArg = (a: N, e: Env, fc: Pred[], inner: Env, keep: boolean): Pred[] => {
    if (a.k === "name") return fail(`A whole table as a CALCULATE filter isn't supported. Use FILTER(${a.v}, ...).`);
    const f = a.k === "call" ? a : null;
    if (f && SHIFTS.includes(f.f)) { const d = dateFilter(f, inner); return [...(keep ? fc : fc.filter((p) => p.t !== d.t)), d.pred]; }
    if (f?.f === "FILTER") {
      const t0 = f.a[0], all = t0.k === "call" && t0.f === "ALL" && t0.a.length === 1 && t0.a[0].k === "name";
      if (t0.k === "name" || all) {
        const t = tableNamed(t0.k === "name" ? t0.v : ((t0 as Extract<N, { k: "call" }>).a[0] as Extract<N, { k: "name" }>).v), wide = expanded(t, e.rels), body = f.a[1];
        if (!body) fail("FILTER needs a condition.");
        const cond: Pred["cond"] = (x, s) => val(body, rowsIn(e, fakeRow(t, x, s))).s;
        return [...(all && !keep ? fc.filter((p) => !wide.has(p.t)) : fc), { t, cols: "*", cond }];
      }
    }
    if (f && TABLE_FNS.has(f.f)) {
      const src = tableExpr(f, e);
      if (src.table) { const t = src.table, eq = rowEq(t, src.alias); return [...fc, { t, cols: "*", cond: (x) => `EXISTS (${select({ ...src, where: [...src.where, eq(x, src.scan)] }, "1")})` }]; }
      const byT = [...src.cols].map(([k, sql]) => ({ ...splitKey(k), sql })), t = byT[0]?.t;
      if (!t || byT.some((x) => x.t !== t) || src.names.size && !byT.length) return fail("A table filter over columns from more than one table isn't supported.");
      let out = fc; if (!keep) for (const x of byT) out = dropCol(out, t, x.c);
      return [...out, { t, cols: byT.map((x) => x.c), cond: (x) => `EXISTS (${select({ ...src, where: [...src.where, ...byT.map((b) => distinctEq(b.sql, `${x}.${q(b.c)}`))] }, "1")})` }];
    }
    // A plain condition: every column from one table, and nothing that needs its own filter context
    const used: { t: string; c: string }[] = [];
    refsIn(a, (x) => {
      if (x.k === "col") { if (!x.t) fail(`[${x.c}] in a CALCULATE filter isn't supported. Put the value in a VAR first.`); used.push(asCol(x, "A filter")); }
      if (x.k === "call" && (AGG[x.f] || ITER[x.f] || x.f === "CALCULATE" || x.f === "COUNTROWS" || x.f === "DISTINCTCOUNT")) fail(`${x.f} in a CALCULATE filter isn't supported. Put the value in a VAR first.`);
    });
    const t = used[0]?.t;
    if (!t) return fail("A CALCULATE filter needs a column to filter.");
    if (used.some((u) => u.t !== t)) return fail("One CALCULATE filter across two tables isn't supported. Use one filter per table.");
    let out = fc; if (!keep) for (const u of used) out = dropCol(out, u.t, u.c);
    return [...out, { t, cols: [...new Set(used.map((u) => u.c))], cond: (x, s) => val(a, rowsIn(e, fakeRow(t, x, s))).s }];
  };
  const splitKey = (k: string) => { const [t, c] = unkey(k); return { t, c }; };

  /* Tables */
  const tableExpr = (x: N, e: Env): Src => {
    if (x.k === "name") { const v = e.vars.get(x.v); if (v?.table) return v.table(e); if (v) fail(`${x.v} is a value, not a table.`); return scan(e, tableNamed(x.v)); }
    if (x.k !== "call") return fail("This needs a table here.");
    const a = x.a, noRows = (fn: string) => { if (e.rows.length) fail(`${fn} inside an iterator isn't supported.`); };
    const colsArgs = () => { const cs = a.map((y) => asCol(y, x.f)), t = cs[0].t; if (cs.some((c) => c.t !== t)) fail(`${x.f} over columns of two tables isn't supported.`); return { t, cs: cs.map((c) => c.c) }; };
    switch (x.f) {
      case "FILTER": { const s = tableExpr(a[0], e); if (!a[1]) fail("FILTER needs a condition."); s.where = [...s.where, val(a[1], rowsIn(e, s)).s]; return s; }
      case "ALL": { if (!a.length) fail("ALL() as a table isn't supported."); const clear = { ...e, fc: [] }; if (a[0].k === "name") return scan(clear, tableNamed(a[0].v), true); const { t, cs } = colsArgs(); return distinct(clear, t, cs, true); }
      case "ALLSELECTED": { noRows(x.f); const outer = { ...e, fc: e.fc.filter((p) => !p.group) }; if (a[0]?.k === "name") return scan(outer, tableNamed(a[0].v), true); if (!a.length) fail("ALLSELECTED() as a table isn't supported."); const { t, cs } = colsArgs(); return distinct(outer, t, cs, true); }
      case "VALUES": case "DISTINCT": { const blank = x.f === "VALUES"; const a0 = a[0]; if (a0?.k === "name") { if (!blank) fail("DISTINCT of a whole table isn't supported."); return scan(e, tableNamed(a0.v), true); } if (a.length !== 1) fail(`${x.f} needs one column.`); const { t, cs } = colsArgs(); return distinct(e, t, cs, blank); }
      case "RELATEDTABLE": { if (!e.rows.length) fail("RELATEDTABLE needs a row, inside an iterator or a calculated column."); const a0 = a[0]; if (a0?.k !== "name") return fail("RELATEDTABLE needs a table."); return scan({ ...e, fc: transition(e) }, tableNamed(a0.v)); }
      case "CALCULATETABLE": return tableExpr(a[0], calcEnv(a.slice(1), e));
      case "TOPN": {
        const k = a[0]?.k === "num" && /^[1-9]\d*$/.test(a[0].v) ? a[0].v : fail("TOPN needs a whole number above zero."), s = tableExpr(a[1], e);
        if (!a[2]) fail("TOPN needs something to order by."); if (a.length > 4) fail("TOPN with more than one order isn't supported.");
        const d = a[3]?.k === "name" ? a[3].v.toUpperCase() : a[3]?.k === "num" ? (a[3].v === "1" ? "ASC" : "DESC") : "DESC";
        if (!["ASC", "DESC"].includes(d)) fail("TOPN's order must be ASC or DESC.");
        const ord = val(a[2], rowsIn(e, s)).s;
        return wrap(s, [], ` QUALIFY RANK() OVER (ORDER BY ${ord} ${d} NULLS ${d === "ASC" ? "FIRST" : "LAST"}) <= ${k}`);
      }
      case "ADDCOLUMNS": case "SELECTCOLUMNS": {
        const s = tableExpr(a[0], e), adds: [string, V][] = [];
        for (let i = 1; i < a.length; i += 2) { const name = a[i], body = a[i + 1]; if (name?.k !== "str" || !body) fail(`${x.f} takes names with their values.`); adds.push([(name as { v: string }).v, val(body, rowsIn(e, s))]); }
        return wrap(s, adds, "", x.f === "ADDCOLUMNS");
      }
      case "SUMMARIZE": return summarize(a, e);
    }
    return fail(`${x.f} as a table isn't supported in a model. Supported: ${[...TABLE_FNS].join(", ")}.`);
  };
  const summarize = (a: N[], e: Env): Src => {
    const base = tableExpr(a[0], e);
    if (!base.table) fail("SUMMARIZE needs a table, or FILTER of a table.");
    const list: string[] = [], g = al("g"), cols = new Map<string, string>(); let i = 1;
    for (; a[i]?.k === "col"; i++) { const { t, c } = asCol(a[i], "SUMMARIZE"), sql = t === base.table ? `${base.alias}.${q(c)}` : forward(base, t, c, e); list.push(`${sql} AS c${list.length}`); cols.set(key(t, c), `${g}.c${list.length - 1}`); }
    if (!list.length) fail("SUMMARIZE needs a column to group by.");
    const body = () => `(${select(base, `DISTINCT ${list.join(", ")}`)}) ${g}`, grp: Src = { alias: g, scan: { joins: [], by: new Map() }, where: [], names: new Map(), cols, from: body };
    const adds: [string, V][] = [];
    if (i < a.length) {
      // The added values see the group and whatever narrowed the table
      const within = a[0].k === "name" ? transition(rowsIn(e, grp)) : filterArg(a[0], e, transition(rowsIn(e, grp)), e, true), ctx = { ...rowsIn(e, grp), fc: within };
      for (; i < a.length; i += 2) { const name = a[i], x = a[i + 1]; if (name?.k !== "str" || !x) fail("SUMMARIZE takes columns, then names with their values."); adds.push([(name as { v: string }).v, val(x, ctx)]); }
    }
    return adds.length ? wrap(grp, adds, "") : grp;
  };
  /** Follows active many-to-one relationships from a row to a related table. Many-to-many has no RELATED, as in Power BI. */
  const forward = (src: Src, t: string, c: string, e: Env): string => {
    const walk = (at: string, alias: string, seen: Set<string>): string | null => {
      for (const r of e.rels) {
        if (r.from !== at || !r.active || seen.has(r.to)) continue;
        if (r.kind === "many" && r.to === t) fail(`RELATED can't cross the many-to-many relationship to ${metaOf(t).label}. Use RELATEDTABLE or a measure.`);
        if (r.kind !== "one") continue;
        if (r.to === t) return `${join(src.scan, alias, r)}.${q(c)}`;
        const mark = new Set([...seen, r.to]), probe = reaches(r.to, t, e, mark);
        if (probe) return walk(r.to, join(src.scan, alias, r), mark);
      }
      return null;
    };
    return walk(src.table!, src.alias, new Set([src.table!])) ?? fail(`RELATED needs an active many-to-one path from ${metaOf(src.table!).label} to ${metaOf(t).label}.`);
  };
  const reaches = (from: string, to: string, e: Env, seen: Set<string>): boolean => e.rels.some((r) => r.from === from && r.active && r.kind === "one" && !seen.has(r.to) && (r.to === to || reaches(r.to, to, e, new Set([...seen, r.to]))));

  /* Values */
  const rowCol = (rows: Src[], t: string, c: string, what?: string): V => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.table === t) return { s: `${r.alias}.${q(c)}`, t: typeOf(t, c) };
      const x = r.cols.get(key(t, c)); if (x) return { s: x, t: typeOf(t, c) };
    }
    return fail(what ?? `${metaOf(t).label}[${c}] needs an aggregate here, such as SUM, or a row from an iterator.`);
  };
  const metricBody = (m: Metric, name: string): N => {
    if (m.measure.dax?.trim()) return parse(m.measure.dax);
    if (m.measure.expr?.trim()) return fail(`${name} is written in SQL, which a DAX measure can't reuse. Rewrite it in DAX.`);
    return measureNode(m.measure, m.table);
  };
  const measureRef = (name: string, e: Env): V | null => {
    const m = sem.metrics.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!m) return null;
    if (e.depth > 12) return fail("Measures refer to each other too deeply.");
    return { s: `(${val(metricBody(m, name), { ...e, fc: transition(e), rows: [], vars: new Map(), depth: e.depth + 1 }).s})`, t: undefined };
  };
  const aggOver = (src: Src, fn: string, x: string) => {
    if (fn === "DISTINCT") return `(${select(src, `NULLIF(COUNT(DISTINCT ${x}) + CASE WHEN COUNT(*) > COUNT(${x}) THEN 1 ELSE 0 END, 0)`)})`;
    if (fn === "DISTINCTNB") return `(${select(src, `NULLIF(COUNT(DISTINCT ${x}), 0)`)})`;
    return `(${select(src, fn === "COUNT" ? `NULLIF(COUNT(${x}), 0)` : `${fn}(${x})`)})`;
  };
  const num = (s: string) => `COALESCE(${s}, 0)`;
  const cmp = (o: string, l: V, r: V): V => {
    const t = l.t ?? r.t, sqlOp = o;
    // A blank equals 0 and "", and sorts below everything, as it does in DAX. Text comparisons ignore case
    if (t === "n") return { s: `${num(l.s)} ${sqlOp} ${num(r.s)}`, t: "b" };
    if (t === "s") return { s: `LOWER(COALESCE(${l.s}, '')) ${sqlOp} LOWER(COALESCE(${r.s}, ''))`, t: "b" };
    if (t === "d") { const z = (x: string) => `COALESCE(${x}, DATE '1899-12-30')`; return { s: `${z(l.s)} ${sqlOp} ${z(r.s)}`, t: "b" }; }
    return { s: o === "=" ? distinctEq(l.s, r.s) : o === "<>" ? `${l.s} IS DISTINCT FROM ${r.s}` : `${l.s} ${sqlOp} ${r.s}`, t: "b" };
  };
  const val = (x: N, e: Env): V => {
    switch (x.k) {
      case "num": return { s: x.v, t: "n" };
      case "str": return { s: lit(x.v), t: "s" };
      case "empty": return fail("A value is missing.");
      case "neg": return { s: `-(${val(x.x, e).s})`, t: "n" };
      case "not": return { s: `NOT COALESCE(${val(x.x, e).s}, FALSE)`, t: "b" };
      case "vars": { const vars = new Map(e.vars); for (const [k, b] of x.vars) { const env = { ...e, vars: new Map(vars) }; if (isTable(b)) vars.set(k, { table: () => tableExpr(b, env) }); else vars.set(k, { v: val(b, env) }); } return val(x.body, { ...e, vars }); }
      case "in": { const l = val(x.x, e), vs = x.list.map((y) => val(y, e)); return { s: l.t === "s" || vs.some((v) => v.t === "s") ? `LOWER(${l.s}) IN (${vs.map((v) => `LOWER(${v.s})`).join(", ")})` : `${l.s} IN (${vs.map((v) => v.s).join(", ")})`, t: "b" }; }
      case "name": { const v = e.vars.get(x.v); if (v?.v) return v.v; if (v) return fail(`${x.v} is a table, not a value.`); const u = x.v.toUpperCase(); if (u === "TRUE" || u === "FALSE") return { s: u, t: "b" }; return fail(`${x.v} isn't something a measure can use.`); }
      case "col": return colVal(x, e);
      case "bin": return bin(x, e);
      case "call": return callVal(x, e);
    }
  };
  const colVal = (x: Extract<N, { k: "col" }>, e: Env): V => {
    if (!x.t) {
      for (let i = e.rows.length - 1; i >= 0; i--) { const v = [...e.rows[i].names].find(([k]) => k.toLowerCase() === x.c.toLowerCase())?.[1]; if (v) return v; }
      const m = measureRef(x.c, e); if (m) return m;
      for (let i = e.rows.length - 1; i >= 0; i--) { const r = e.rows[i], own = r.table && columnNamed(r.table, x.c, r.extra); if (own) return { s: `${r.alias}.${q(own)}`, t: typeOf(r.table!, own) }; }
      return fail(`[${x.c}] isn't a measure in this model, or a column of the current row.`);
    }
    const t = tableNamed(x.t), c = columnNamed(t, x.c, e.rows.findLast((r) => r.table === t)?.extra);
    if (!c) { const m = measureRef(x.c, e); if (m) return m; return fail(`${x.t} has no column ${x.c}.${metaOf(t).calc?.some((k) => k.name === x.c) ? " Build the model first." : ""}`); }
    return rowCol(e.rows, t, c);
  };
  const bin = (x: Extract<N, { k: "bin" }>, e: Env): V => {
    const l = val(x.l, e), r = val(x.r, e);
    switch (x.o) {
      case "&&": return { s: `(${l.s}) AND (${r.s})`, t: "b" };
      case "||": return { s: `(${l.s}) OR (${r.s})`, t: "b" };
      case "&": return { s: `COALESCE(CAST(${l.s} AS VARCHAR), '') || COALESCE(CAST(${r.s} AS VARCHAR), '')`, t: "s" };
      case "^": return { s: `POWER(${l.s}, ${r.s})`, t: "n" };
      case "/": return { s: `(${l.s}) / NULLIF(${r.s}, 0)`, t: "n" };
      case "*": return { s: `(${l.s}) * (${r.s})`, t: "n" };
      case "+": case "-": if (l.t === "d" || r.t === "d") return { s: `(${l.s}) ${x.o} (${r.s})`, t: "d" }; return { s: `CASE WHEN (${l.s}) IS NULL AND (${r.s}) IS NULL THEN NULL ELSE ${num(l.s)} ${x.o} ${num(r.s)} END`, t: "n" }; // A blank counts as 0 unless both are blank
    }
    return cmp(x.o, l, r);
  };
  const isTable = (x: N): boolean => { if (x.k === "call") return TABLE_FNS.has(x.f); if (x.k !== "name") return false; try { tableNamed(x.v); return true; } catch { return false; } };
  const callVal = (x: Extract<N, { k: "call" }>, e: Env): V => {
    const a = x.a, f = x.f;
    if (AGG[f] || f === "DISTINCTCOUNT" || f === "DISTINCTCOUNTNOBLANK") {
      if (a.length === 2 && (f === "MIN" || f === "MAX")) return { s: `${f === "MIN" ? "LEAST" : "GREATEST"}(${num(val(a[0], e).s)}, ${num(val(a[1], e).s)})`, t: "n" };
      if (a.length !== 1) return fail(`${f} needs one column.`);
      const col = a[0].k === "col" && !a[0].t && e.rows.length ? (() => { const r = e.rows.at(-1)!; const c0 = a[0] as { c: string }; return r.table ? { t: r.table, c: columnNamed(r.table, c0.c) ?? fail(`${f}([${c0.c}]) needs a column.`) } : fail(`${f} needs a column with its table.`); })() : asCol(a[0], f);
      const s = scan(e, col.t), xs = `${s.alias}.${q(col.c)}`;
      return { s: aggOver(s, f === "DISTINCTCOUNT" ? "DISTINCT" : f === "DISTINCTCOUNTNOBLANK" ? "DISTINCTNB" : AGG[f], xs), t: ["MIN", "MAX"].includes(f) ? typeOf(col.t, col.c) : "n" };
    }
    if (ITER[f]) {
      if (a.length !== 2) return fail(`${f} needs a table and a value.`);
      const s = tableExpr(a[0], e), v = val(a[1], rowsIn(e, s));
      return { s: aggOver(s, ITER[f], v.s), t: f.startsWith("MIN") || f.startsWith("MAX") ? v.t : "n" };
    }
    switch (f) {
      case "COUNTROWS": { const s = a[0] ? tableExpr(a[0], e) : fail("COUNTROWS needs a table."); return { s: aggOver(s, "COUNT", "*"), t: "n" }; }
      case "COUNTBLANK": { const { t, c } = asCol(a[0], f), s = scan(e, t), xs = `${s.alias}.${q(c)}`; return { s: `(${select(s, `NULLIF(COUNT(*) FILTER (WHERE ${xs} IS NULL${typeOf(t, c) === "s" ? ` OR ${xs} = ''` : ""}), 0)`)})`, t: "n" }; }
      case "CALCULATE": { if (!a.length) fail("CALCULATE needs a value."); const v = val(a[0], calcEnv(a.slice(1), e)); return { ...v, s: `(${v.s})` }; }
      case "TOTALYTD": case "TOTALQTD": case "TOTALMTD": {
        if (a.length < 2) fail(`${f} needs a value and a date column.`);
        if (a[2]?.k === "str") fail(`${f} with a year-end date isn't supported.`);
        const args: N[] = [{ k: "call", f: TOTALS[f], a: [a[1]] }, ...a.slice(2)];
        return { s: `(${val(a[0], calcEnv(args, e)).s})` };
      }
      case "EARLIER": {
        const lvl = a[1]?.k === "num" ? Number(a[1].v) : 1, { t, c } = asCol(a[0], f);
        if (!(lvl >= 1)) fail("EARLIER needs a level of 1 or more.");
        return rowCol(e.rows.slice(0, -lvl), t, c, "EARLIER needs an outer row, from an iterator around this one.");
      }
      case "RELATED": {
        const { t, c } = asCol(a[0], f);
        for (let i = e.rows.length - 1; i >= 0; i--) { const r = e.rows[i]; if (r.table === t) return { s: `${r.alias}.${q(c)}`, t: typeOf(t, c) }; if (r.table) return { s: forward(r, t, c, e), t: typeOf(t, c) }; }
        return fail("RELATED needs a row, inside an iterator or a calculated column.");
      }
      case "SELECTEDVALUE": case "HASONEVALUE": {
        const { t, c } = asCol(a[0], f), s = distinct(e, t, [c], true), xs = `${s.alias}.c0`;
        if (f === "HASONEVALUE") return { s: `(${select(s, "COUNT(*) = 1")})`, t: "b" };
        const one = `(${select(s, `CASE WHEN COUNT(*) = 1 THEN ANY_VALUE(${xs}) END`)})`;
        return { s: a[1] ? `COALESCE(${one}, ${val(a[1], e).s})` : one, t: typeOf(t, c) };
      }
      case "ISFILTERED": { const { t, c } = asCol(a[0], f); return { s: e.fc.some((p) => p.t === t && p.cols !== "*" && p.cols.includes(c)) ? "TRUE" : "FALSE", t: "b" }; }
      case "RANKX": {
        const s = tableExpr(a[0], e), inner = val(a[1], rowsIn(e, s)), me = a[2] && a[2].k !== "empty" ? val(a[2], e) : val(a[1], e), dirN = a[3], dir = dirN?.k === "name" ? dirN.v.toUpperCase() : dirN?.k === "num" ? (dirN.v === "1" ? "ASC" : "DESC") : "DESC", ties = a[4]?.k === "name" ? a[4].v.toUpperCase() : "SKIP";
        if (!["ASC", "DESC"].includes(dir) || !["SKIP", "DENSE"].includes(ties)) fail("RANKX takes ASC or DESC, then SKIP or DENSE.");
        const beats = `${num(inner.s)} ${dir === "DESC" ? ">" : "<"} ${num(me.s)}`;
        return { s: `(${select({ ...s, where: [...s.where, beats] }, ties === "DENSE" ? `COUNT(DISTINCT ${num(inner.s)}) + 1` : "COUNT(*) + 1")})`, t: "n" };
      }
      case "CONCATENATEX": { const s = tableExpr(a[0], e), v = val(a[1], rowsIn(e, s)), sep = a[2] ? val(a[2], e).s : "''"; if (a.length > 3) fail("CONCATENATEX with an order isn't supported."); return { s: `(${select(s, `STRING_AGG(CAST(${v.s} AS VARCHAR), ${sep} ORDER BY ${v.s})`)})`, t: "s" }; }
      case "DIVIDE": { if (a.length < 2 || a.length > 3) fail("DIVIDE needs two or three values."); const l = val(a[0], e).s, r = val(a[1], e).s; return { s: a[2] ? `CASE WHEN COALESCE(${r}, 0) = 0 THEN ${val(a[2], e).s} ELSE (${l}) / (${r}) END` : `(${l}) / NULLIF(${r}, 0)`, t: "n" }; }
      case "IF": { if (a.length < 2 || a.length > 3) fail("IF needs a condition and one or two values."); const yes = val(a[1], e), no = a[2] ? val(a[2], e) : undefined; return { s: `CASE WHEN ${val(a[0], e).s} THEN ${yes.s}${no ? ` ELSE ${no.s}` : ""} END`, t: yes.t ?? no?.t }; }
      case "SWITCH": { if (a.length < 3) fail("SWITCH needs a value and at least one match."); const first = val(a[0], e); let s = "CASE"; const isTrue = first.s === "TRUE"; for (let i = 1; i + 1 < a.length; i += 2) s += ` WHEN ${isTrue ? val(a[i], e).s : cmp("=", first, val(a[i], e)).s} THEN ${val(a[i + 1], e).s}`; return { s: `${s}${a.length % 2 === 0 ? ` ELSE ${val(a[a.length - 1], e).s}` : ""} END` }; }
      case "DATEDIFF": { const u = a[2]?.k === "name" ? a[2].v.toLowerCase() : ""; if (!["year", "quarter", "month", "week", "day", "hour", "minute", "second"].includes(u)) fail("DATEDIFF needs a unit, such as DAY."); return { s: `DATE_DIFF('${u}', ${val(a[0], e).s}, ${val(a[1], e).s})`, t: "n" }; }
      case "TRUE": case "FALSE": return { s: f, t: "b" };
      case "BLANK": return { s: "NULL" };
    }
    if (SCALAR[f]) return { s: SCALAR[f](a.map((y) => val(y, e).s)), t: ["YEAR", "MONTH", "DAY", "QUARTER", "ABS", "ROUND", "INT", "LEN"].includes(f) ? "n" : undefined };
    if (TABLE_FNS.has(f)) return fail(`${f} returns a table. Use it inside an iterator, COUNTROWS or CALCULATE.`);
    if (SHIFTS.includes(f) || f === "USERELATIONSHIP" || f === "CROSSFILTER" || f === "KEEPFILTERS" || REMOVERS.has(f)) return fail(`${f} only works as a CALCULATE filter.`);
    return fail(`${f} isn't supported in a model. Supported: ${MODEL_DAX_FUNCTIONS.join(", ")}.`);
  };
  const base = (): Env => ({ fc: [], rows: [], vars: new Map(), rels: baseRels, depth: 0 });
  const guardSql = () => [...guards.values()];
  return { val, base, tableExpr, scan, conds, select, al, tableNamed, asCol, guardSql, ref, rowsIn, withBlank, colsOf, typeOf, metaOf, baseRels };
}
const measureNode = (m: Measure, home: string): N => {
  if (m.column === "*") return { k: "call", f: "COUNTROWS", a: [{ k: "name", v: home }] };
  const p = parseField(m.column), col: N = { k: "col", t: p?.table ?? home, c: p?.column ?? m.column };
  return { k: "call", f: ({ sum: "SUM", avg: "AVERAGE", count: "COUNT", count_distinct: "DISTINCTCOUNTNOBLANK", median: "MEDIAN", min: "MIN", max: "MAX" } as const)[m.agg], a: [col] };
};

export type ModelQuery = { groups: { as: string; field: string; grain?: string }[]; measures: { as: string; measure: Measure }[]; filters?: Filter[]; home: string; tail?: string };

/** One visual's SQL. Groups come from their own tables, combine across tables as DAX does, and each measure is worked out for each combination. Rows with nothing to show are dropped. */
export function modelSql(sem: Sem, query: ModelQuery): string {
  const c = compiler(sem), e = c.base();
  const home = c.tableNamed(query.home);
  for (const f of query.filters ?? []) {
    const list = f.group ? (query.filters ?? []).filter((x) => x.group === f.group) : [f];
    if (f.group && list[0] !== f) continue; // A group is one filter, joined by OR
    const fields = list.map((x) => ({ x, p: parseField(x.column) ?? fail(`The filter on ${x.column} isn't a model field.`) }));
    const col = fields.map(({ x, p }) => { if (x.op === "in_query") fail("A filter through a dashboard relationship can't run on a model visual."); const t = c.tableNamed(p.table); return { x, t, c: c.asCol({ k: "col", t, c: p.column }, "A filter").c }; });
    if (col.some((y) => y.t !== col[0].t)) fail("A filter group across two tables isn't supported.");
    e.fc.push({ t: col[0].t, cols: col.map((y) => y.c), cond: (a) => { const w = col.map((y) => filterSql(y.x, `${a}.${q(y.c)}`)).filter(Boolean); return w.length ? `(${w.join(" OR ")})` : "TRUE"; } });
  }
  // Each table's groups read that table's real combinations, under the filters that reach it
  const byTable = new Map<string, { as: string; c: string; grain?: string }[]>();
  for (const g of query.groups) { const p = parseField(g.field) ?? fail(`${g.field} isn't a model field.`), { t, c: col } = c.asCol({ k: "col", t: p.table, c: p.column }, "A field"); byTable.set(t, [...(byTable.get(t) ?? []), { as: g.as, c: col, grain: g.grain }]); }
  const expr = (a: string, g: { c: string; grain?: string }) => (g.grain ? `DATE_TRUNC('${g.grain}', ${a}.${q(g.c)})::DATE` : `${a}.${q(g.c)}`);
  const domains: string[] = [], out: string[] = [], groupPreds: typeof e.fc = [];
  for (const [t, gs] of byTable) {
    const s = c.scan(e, t, true), d = c.al("d");
    domains.push(`(${c.select(s, `DISTINCT ${gs.map((g) => `${expr(s.alias, g)} AS ${q(g.as)}`).join(", ")}`)}) ${d}`);
    for (const g of gs) { out.push(`${d}.${q(g.as)} AS ${q(g.as)}`); groupPreds.push({ t, cols: [g.c], group: true, cond: (a) => distinctEq(expr(a, g), `${d}.${q(g.as)}`) }); }
  }
  const env = { ...e, fc: [...e.fc, ...groupPreds] };
  const ms = query.measures.map((m) => { const node = m.measure.dax?.trim() ? parse(m.measure.dax) : m.measure.expr?.trim() ? fail("A model visual takes DAX measures, not SQL ones.") : measureNode(m.measure, home); return { as: m.as, s: c.val(node, env).s }; });
  const inner = `SELECT ${[...out, ...ms.map((m) => `${m.s} AS ${q(m.as)}`)].join(", ")}${domains.length ? ` FROM ${domains.join(", ")}` : ""}`;
  const keepRow = domains.length && ms.length ? `(${ms.map((m) => `${q(m.as)} IS NOT NULL`).join(" OR ")})` : "";
  const where = whereOf([...c.guardSql(), keepRow].filter(Boolean));
  return `SELECT * FROM (${inner}) r${where}${query.tail ? ` ${query.tail}` : ""}`;
}

/** A model visual as SQL in the shape every chart already reads: d, s, m0 and so on. A refusal reaches the tile as its error. */
export function modelWidgetSql(w: Widget, extra: Filter[] = []): string | null {
  const sem = w.semantic;
  try {
    if (!sem) return `SELECT error(${lit("This visual reads the semantic model, which isn't available here.")}) AS m0`;
    if (w.type === "text" || !w.table) return null;
    const filters = [...w.filters, ...extra];
    const dim = w.dimension;
    if (w.type === "slicer") return dim ? `SELECT DISTINCT CAST(value AS VARCHAR) AS value FROM (${modelSql(sem, { home: w.table, groups: [{ as: "value", field: dim }], measures: [] })}) r WHERE value IS NOT NULL ORDER BY 1 LIMIT 200` : null;
    const single = w.type === "kpi" || w.type === "gauge" || !dim;
    const groups = single ? [] : [{ as: "d", field: dim!, grain: w.dateGrain }, ...(w.series ? [{ as: "s", field: w.series }] : [])];
    const measures = [...w.measures.map((m, i) => ({ as: `m${i}`, measure: m })), ...(dim && w.type !== "kpi" ? (w.tips ?? []).map((m, i) => ({ as: `t${i}`, measure: m })) : [])];
    if (!measures.length && !groups.length) return null;
    const tail = single ? "" : `${w.dateGrain || w.sort === "label" || w.calc || w.type === "matrix" || !measures.length ? "ORDER BY 1" : w.sort === "value_asc" ? `ORDER BY "m0" ASC` : `ORDER BY "m0" DESC`}${w.dateGrain ? "" : ` LIMIT ${w.type === "matrix" ? 5000 : w.series ? 400 : w.limit ?? 50}`}`;
    return modelSql(sem, { home: w.table, groups, measures, filters, tail });
  } catch (x) {
    if (x instanceof DaxError) return `SELECT error(${lit(x.message)}) AS m0`;
    throw x;
  }
}
/** Whether a measure compiles here: the message is what the visual's editor shows. */
export function checkDax(sem: Sem, dax: string, home: string): string | null {
  try { modelSql(sem, { home, groups: [], measures: [{ as: "m", measure: { column: "*", agg: "count", dax } }] }); return null; } catch (x) { if (x instanceof DaxError) return x.message; throw x; }
}
export function metricModelSql(sem: Sem, m: Metric, month?: string): string {
  return modelSql(sem, { home: m.table, groups: month ? [{ as: "d", field: month, grain: "month" }] : [], measures: [{ as: month ? "m0" : "v", measure: m.measure }], tail: month ? "ORDER BY 1" : undefined });
}

/* ---- Generated models ---- */
const refFor = (names: Set<string>) => (full: string) => {
  const [s, n] = parts(full);
  if (s === "analytics" && names.has(n)) return `{{ ref('${n}') }}`;
  if (s.startsWith("raw_")) return `{{ source('${s.slice(4)}', '${n}') }}`;
  return tableSql(full);
};
export function calcColumnsSql(sem: Sem, t: SemTable, modelNames: Set<string>): string {
  if (!t.calc?.length) return fail("This table has no calculated columns.");
  const c = compiler(sem, { building: t.full, ref: refFor(modelNames) });
  let from = c.ref(t.full); const done: string[] = [];
  for (const k of t.calc) {
    if (c.colsOf(t.full).includes(k.name)) fail(`${t.label} already has a column named ${k.name}.`);
    const a = c.al("r"), s: Scan = { joins: [], by: new Map() }, row: Src = { alias: a, table: t.full, scan: s, where: [], from: () => "", cols: new Map(), names: new Map(), extra: [...done] };
    const v = c.val(parse(k.dax), c.rowsIn(c.base(), row)).s;
    from = `(SELECT ${a}.*, ${v} AS ${q(k.name)} FROM ${from} ${a} ${s.joins.join(" ")})`;
    done.push(k.name);
  }
  return `SELECT * FROM ${from} g${whereOf(c.guardSql())}`;
}
export function calcTableSql(sem: Sem, dax: string, modelNames: Set<string>): string {
  const c = compiler(sem, { ref: refFor(modelNames), building: "\0" }), src = c.tableExpr(parse(dax), c.base());
  const list = [...(src.table ? [`${src.alias}.*`] : []), ...[...src.cols].map(([k, x]) => `${x} AS ${q(unkey(k)[1])}`), ...[...src.names].map(([k, v]) => `${v.s} AS ${q(k)}`)];
  return `SELECT ${list.join(", ")} FROM ${src.from()}${whereOf([...src.where, ...c.guardSql()])}`;
}
export function dateTableSql(sources: { table: string; column: string }[], modelNames: Set<string>): string {
  if (!sources.length) return fail("Choose a date column for the date table.");
  const r = refFor(modelNames), bound = (fn: string) => `${fn}(${sources.map((s) => `(SELECT ${fn === "LEAST" ? "MIN" : "MAX"}(${q(s.column)}) FROM ${r(s.table)})`).join(", ")})`;
  return `SELECT d::DATE AS "date", YEAR(d) AS "year", QUARTER(d) AS "quarter", MONTH(d) AS "month", MONTHNAME(d) AS "month_name", DAY(d) AS "day", DAYOFWEEK(d) AS "weekday" FROM generate_series(DATE_TRUNC('year', ${bound("LEAST")})::DATE, (DATE_TRUNC('year', ${bound("GREATEST")}) + INTERVAL 1 YEAR - INTERVAL 1 DAY)::DATE, INTERVAL 1 DAY) AS g(d)`;
}
const genModel = (name: string, description: string, sql: string): Model => ({ id: `generated-${name}`, name, description, materialized: "table", sql, tests: [], owner: "Semantic model", generated: true });
/** The warehouse models the semantic model needs, or what stops each one. A hand-written model is never replaced. */
export function generatedModels(sem: Sem, existing: Model[]): { models: Model[]; errors: string[] } {
  const hand = existing.filter((m) => !m.generated), names = new Set(hand.map((m) => m.name)), m = sem.model, out: Model[] = [], errors: string[] = [];
  const wanted = [...(m.autoDate ? [lastOf(DATE_TABLE)] : []), ...m.tables.filter((t) => t.calc?.length).map((t) => calcModelName(t.full)), ...(m.calcTables ?? []).map((t) => lastOf(calcTableFull(t.name)))];
  for (const n of wanted) { if (names.has(n)) errors.push(`A model named ${n} already exists, so the semantic model can't use that name.`); }
  wanted.forEach((n) => names.add(n));
  const add = (name: string, desc: string, build: () => string) => { try { out.push(genModel(name, desc, build())); } catch (x) { if (!(x instanceof DaxError)) throw x; errors.push(`${desc}: ${x.message}`); } };
  if (m.autoDate) add(lastOf(DATE_TABLE), "Date table", () => dateTableSql(m.autoDate!.sources, names));
  for (const t of m.tables) if (t.calc?.length) add(calcModelName(t.full), `Calculated columns of ${t.label}`, () => calcColumnsSql(sem, t, names));
  for (const t of m.calcTables ?? []) add(lastOf(calcTableFull(t.name)), `Calculated table ${t.name}`, () => calcTableSql(sem, t.dax, names));
  return { models: out, errors };
}
export const withGenerated = <C extends Pick<Config, "models">>(config: C, models: Model[]): C => ({ ...config, models: [...config.models.filter((m) => !m.generated), ...models] });

/* ---- Validation ---- */
export type RelCheck = { fromRows: number; fromBlank: number; orphanRows: number; orphanKeys: number; toRows: number; toBlank: number; duplicateKeys: number };
const physicalOf = (sem: Sem, full: string) => { const t = sem.model.tables.find((x) => x.full === full); return t?.calc?.length && sem.schema[calcFull(full)] ? calcFull(full) : full; };
export function relationshipCheckSql(sem: Sem, r: SemRel): string {
  const f = tableSql(physicalOf(sem, r.from)), t = tableSql(physicalOf(sem, r.to)), fc = q(r.fromCol), tc = q(r.toCol);
  return `SELECT (SELECT COUNT(*) FROM ${f}) AS "fromRows", (SELECT COUNT(*) FROM ${f} WHERE ${fc} IS NULL) AS "fromBlank", (SELECT COUNT(*) FROM ${f} x WHERE x.${fc} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${t} y WHERE y.${tc} = x.${fc})) AS "orphanRows", (SELECT COUNT(DISTINCT x.${fc}) FROM ${f} x WHERE x.${fc} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${t} y WHERE y.${tc} = x.${fc})) AS "orphanKeys", (SELECT COUNT(*) FROM ${t}) AS "toRows", (SELECT COUNT(*) FROM ${t} WHERE ${tc} IS NULL) AS "toBlank", (SELECT COUNT(*) FROM (SELECT ${tc} FROM ${t} WHERE ${tc} IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1)) AS "duplicateKeys"`;
}
/** What's wrong for the relationship as defined. Orphans are allowed but reported: they show as a blank row, as in Power BI. */
export function relationshipProblems(r: SemRel, c: RelCheck): { blocking: string[]; notes: string[] } {
  const blocking: string[] = [], notes: string[] = [];
  if ((r.kind ?? "one") === "one" && c.duplicateKeys > 0) blocking.push(`${c.duplicateKeys} values repeat on the one side, so this has to be many-to-many or the data fixed.`);
  if ((r.kind ?? "one") === "one" && c.toBlank > 0) notes.push(`${c.toBlank} blank keys on the one side.`);
  if (c.orphanRows > 0) notes.push(`${c.orphanRows} rows (${c.orphanKeys} keys) have no match${(r.kind ?? "one") === "one" ? " and show under a blank value" : " and are left out when grouped"}.`);
  if (c.fromBlank > 0) notes.push(`${c.fromBlank} rows have a blank key.`);
  return { blocking, notes };
}
/** Two active paths between tables would make a filter's route a guess. */
export function modelProblems(m: SemanticModel): string[] {
  const out: string[] = [], label = (t: string) => m.tables.find((x) => x.full === t)?.label ?? t, rels = m.relationships.filter((r) => r.active !== false);
  for (const r of m.relationships) { if (!m.tables.some((t) => t.full === r.from) || !m.tables.some((t) => t.full === r.to)) out.push("A relationship points at a table that's no longer in the model."); if (r.from === r.to) out.push(`${label(r.from)} can't relate to itself.`); }
  const walk = (t: string, seen: Set<string>, into: Map<string, number>) => { for (const r of rels) { const o = r.from === t ? r.to : r.to === t && r.both ? r.from : null; if (!o || seen.has(o)) continue; into.set(o, (into.get(o) ?? 0) + 1); walk(o, new Set([...seen, o]), into); } };
  // Filters run against this walk, from the table being read back toward whatever filters it
  for (const t of m.tables) { const into = new Map<string, number>(); walk(t.full, new Set([t.full]), into); for (const [o, n] of into) if (n > 1) out.push(`More than one active path connects ${label(o)} to ${label(t.full)}. Make one inactive or single direction.`); }
  return [...new Set(out)];
}
export function dateCheckSql(full: string, col: string): string {
  const c = q(col);
  return `SELECT COUNT(*) AS "rows", COUNT(${c}) AS "filled", COUNT(DISTINCT ${c}) AS "days", DATE_DIFF('day', MIN(${c})::DATE, MAX(${c})::DATE) + 1 AS "span" FROM ${tableSql(full)}`;
}
export function dateProblem(r: { rows: number; filled: number; days: number; span: number }): string | null {
  if (!r.rows) return "This table has no rows.";
  if (r.filled < r.rows) return "The date column has blanks.";
  if (r.days < r.rows) return "The date column has repeated dates.";
  if (r.days !== r.span) return `The dates have gaps: ${r.days} dates across ${r.span} days.`;
  return null;
}
export const kpiStatus = (v: number | null, target: number | null, higher = true): "good" | "bad" | null => (v == null || target == null ? null : (higher ? v >= target : v <= target) ? "good" : "bad");
