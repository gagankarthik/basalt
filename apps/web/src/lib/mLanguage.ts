import type { Agg } from "./types.ts";
import type { Filter, FilterOp } from "./types.ts";
import type { JoinKind, Step } from "./transform.ts";

/**
 * A working part of Power Query's M language: the steps of a query as text, both ways. M isn't run here. It's read into the same applied steps the
 * editor already builds, so both forms always mean the same thing. Anything outside this part is refused by name, never skipped.
 */
export class MError extends Error { line: number; constructor(message: string, line: number) { super(`Line ${line}: ${message}`); this.line = line; } }

type Tok = { t: "id" | "str" | "num" | "sym" | "end"; v: string; line: number };
const SYMS = ["<=", ">=", "<>", "!=", "=", "<", ">", "(", ")", "{", "}", "[", "]", ",", "+", "-", "*", "/", "&", "_"];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1;
  const str = (start: number) => {
    let v = "";
    for (let k = start; k < src.length; k++) {
      if (src[k] === "\n") line++;
      if (src[k] !== '"') { v += src[k]; continue; }
      if (src[k + 1] === '"') { v += '"'; k++; continue; }
      i = k + 1;
      return v;
    }
    throw new MError("A piece of text never ends. Add the closing quote.", line);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith("//", i)) { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (src.startsWith("/*", i)) { const e = src.indexOf("*/", i); if (e < 0) throw new MError("A comment never ends.", line); line += src.slice(i, e).split("\n").length - 1; i = e + 2; continue; }
    if (src.startsWith('#"', i)) { const l = line; out.push({ t: "id", v: str(i + 2), line: l }); continue; }
    if (c === '"') { const l = line; out.push({ t: "str", v: str(i + 1), line: l }); continue; }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i, i + 40));
    if (num) { out.push({ t: "num", v: num[0], line }); i += num[0].length; continue; }
    const id = /^#?[A-Za-z][\w.]*/.exec(src.slice(i, i + 200));
    if (id) { out.push({ t: "id", v: id[0], line }); i += id[0].length; continue; }
    const sym = SYMS.find((s) => src.startsWith(s, i));
    if (!sym) throw new MError(`Basalt's M doesn't use "${c}".`, line);
    out.push({ t: "sym", v: sym, line }); i += sym.length;
  }
  out.push({ t: "end", v: "", line });
  return out;
}

const TYPES: Record<string, string> = { text: "VARCHAR", "Text.Type": "VARCHAR", "Int64.Type": "BIGINT", number: "DOUBLE", "Number.Type": "DOUBLE", "Currency.Type": "DECIMAL(18,2)", date: "DATE", "Date.Type": "DATE", datetime: "TIMESTAMP", "DateTime.Type": "TIMESTAMP", logical: "BOOLEAN", "Logical.Type": "BOOLEAN" };
const TYPE_NAMES: Record<string, string> = { VARCHAR: "type text", BIGINT: "Int64.Type", INTEGER: "Int64.Type", DOUBLE: "type number", "DECIMAL(18,2)": "Currency.Type", DATE: "type date", TIMESTAMP: "type datetime", BOOLEAN: "type logical" };
const CLEANS: Record<string, string> = { "Text.Upper": "upper", "Text.Lower": "lower", "Text.Trim": "trim", "Text.Clean": "clean", "Text.Proper": "proper" };
const AGG_FNS: Record<string, NonNullable<Step["aggs"]>[number]["agg"]> = { "List.Sum": "sum", "List.Average": "avg", "List.Min": "min", "List.Max": "max", "List.Median": "median" };
const FORMULA_FNS: Record<string, string> = { "Text.Upper": "UPPER", "Text.Lower": "LOWER", "Text.Trim": "TRIM", "Text.Length": "LEN", "Text.Start": "LEFT", "Text.End": "RIGHT", "Number.Round": "ROUND", "Number.Abs": "ABS", "Number.RoundUp": "CEILING", "Number.RoundDown": "FLOOR", "Number.Power": "POWER", "Number.Sqrt": "SQRT", "Number.Mod": "MOD", "Date.Year": "YEAR", "Date.Month": "MONTH", "Date.Day": "DAY", "Text.Replace": "SUBSTITUTE" };
const COMPARE: Record<string, FilterOp> = { "=": "eq", "<>": "neq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };
const text = (s: string) => `"${s.replace(/"/g, '""')}"`;
const name = (s: string) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(s) ? s : `#${text(s)}`);

class Reader {
  toks: Tok[]; at = 0;
  constructor(toks: Tok[]) { this.toks = toks; }
  get peek() { return this.toks[this.at]; }
  next() { return this.toks[this.at++]; }
  is(v: string) { const p = this.peek; return (p.t === "sym" || p.t === "id") && p.v === v; }
  take(v: string) { if (this.is(v)) { this.at++; return true; } return false; }
  need(v: string) { if (!this.take(v)) this.fail(`Expected ${v === "in" ? "the word in" : `"${v}"`}${this.peek.t === "end" ? ", but the query ended" : `, but found ${this.peek.v || "the end"}`}.`); }
  fail(msg: string): never { throw new MError(msg, this.peek.line); }
  str() { const p = this.next(); if (p.t !== "str") { this.at--; this.fail("Expected text in double quotes here."); } return p.v; }
  num() { const neg = this.take("-"), p = this.next(); if (p.t !== "num") { this.at--; this.fail("Expected a number here."); } return (neg ? "-" : "") + p.v; }
  ident() { const p = this.next(); if (p.t !== "id") { this.at--; this.fail("Expected a name here."); } return p.v; }
  /** {a, b, c} */
  list<T>(item: () => T) { this.need("{"); const out: T[] = []; if (!this.take("}")) { do out.push(item()); while (this.take(",")); this.need("}"); } return out; }
  column() { this.need("["); const p = this.next(); if (p.t !== "id" && p.t !== "str") { this.at--; this.fail("Expected a column name inside [ ]."); } let v = p.v; while (!this.is("]") && this.peek.t !== "end") v += ` ${this.next().v}`; this.need("]"); return v; }
}

/** A row condition: a list of comparisons joined by all ands or all ors. */
function condition(r: Reader, id: () => string) {
  const one = (): Filter => {
    if (r.peek.t === "id" && /^Text\.(Contains|StartsWith)$/.test(r.peek.v)) {
      const fn = r.ident(); r.need("("); const column = r.column(); r.need(","); const value = r.str(); r.need(")");
      return { id: id(), column, op: fn === "Text.Contains" ? "contains" : "starts", value };
    }
    if (!r.is("[")) r.fail("A row filter compares a column, such as [Amount] > 10, or uses Text.Contains or Text.StartsWith.");
    const column = r.column(), sym = r.next();
    const op = sym.t === "sym" ? COMPARE[sym.v] : undefined;
    if (!op) { r.at--; r.fail("Expected a comparison such as =, <>, > or <."); }
    if (r.take("null")) { if (op !== "eq" && op !== "neq") r.fail("A column can only be = null or <> null."); return { id: id(), column, op: op === "eq" ? "empty" : "not_empty" }; }
    const p = r.peek;
    if (p.t === "str") return { id: id(), column, op, value: r.str() };
    if (p.t === "id" && (p.v === "true" || p.v === "false")) return { id: id(), column, op, value: r.next().v };
    if (p.t === "id" && p.v === "#date") { r.next(); r.need("("); const y = r.num(); r.need(","); const m = r.num(); r.need(","); const d = r.num(); r.need(")"); return { id: id(), column, op, value: `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` }; }
    return { id: id(), column, op, value: r.num() };
  };
  const filters = [one()];
  let match: "all" | "any" | undefined;
  while (r.is("and") || r.is("or")) {
    const here: "all" | "any" = r.next().v === "and" ? "all" : "any";
    if (match && match !== here) r.fail("A filter step can use and or or, but not both. Split it into two steps.");
    match = here; filters.push(one());
  }
  return { filters, match: match ?? "all" as const };
}

/** A custom column's expression, written out in the formula language the editor already uses. */
function formula(r: Reader): string {
  const atom = (): string => {
    const p = r.peek;
    if (r.is("[")) return `{${r.column()}}`;
    if (r.take("(")) { const e = compare(); r.need(")"); return `(${e})`; }
    if (r.take("-")) return `-${atom()}`;
    if (p.t === "str") return text(r.str());
    if (p.t === "num") return r.next().v;
    if (r.take("if")) { const c = compare(); r.need("then"); const a = compare(); r.need("else"); const b = compare(); return `IF(${c}, ${a}, ${b})`; }
    if (r.take("null")) return `COALESCE("")`;
    if (p.t === "id" && (p.v === "true" || p.v === "false")) return r.next().v;
    if (p.t === "id") {
      const fn = r.ident(), mapped = FORMULA_FNS[fn] ?? (/^[A-Z_]+$/.test(fn) ? fn : null);
      if (!mapped) { r.at--; r.fail(`Basalt's M doesn't have ${fn} yet.`); }
      r.need("("); const args: string[] = [];
      if (!r.take(")")) { do args.push(compare()); while (r.take(",")); r.need(")"); }
      return `${mapped}(${args.join(", ")})`;
    }
    return r.fail("Expected a value here.");
  };
  const chain = (next: () => string, ops: string[]) => () => { let e = next(); while (r.peek.t === "sym" && ops.includes(r.peek.v)) { const o = r.next().v; e += ` ${o} ${next()}`; } return e; };
  const mul = chain(atom, ["*", "/"]);
  const add = (): string => { let e = mul(); while (r.peek.t === "sym" && ["+", "-", "&"].includes(r.peek.v)) { const o = r.next().v, b = mul(); e = o === "&" ? `CONCATENATE(${e}, ${b})` : `${e} ${o} ${b}`; } return e; };
  const compare = (): string => { const a = add(); if (r.peek.t === "sym" && r.peek.v in COMPARE) { const o = r.next().v; return `${a} ${o === "<>" ? "!=" : o} ${add()}`; } return a; };
  return compare();
}

const SUPPORTED = "Table.Unpivot, Table.UnpivotOtherColumns, Table.Pivot, Table.FillDown, Table.FillUp, Table.NestedJoin, Table.ExpandTableColumn, Table.Combine, Table.SelectColumns, Table.RemoveColumns, Table.RenameColumns, Table.SelectRows, Table.Sort, Table.Distinct, Table.TransformColumnTypes, Table.TransformColumns, Table.AddColumn, Table.ReplaceValue, Table.Group, Table.FirstN, Table.LastN and Table.Range";

const JOINS: Record<string, JoinKind> = { "JoinKind.Inner": "inner", "JoinKind.LeftOuter": "left", "JoinKind.RightOuter": "right", "JoinKind.FullOuter": "full", "JoinKind.LeftAnti": "anti", "JoinKind.RightAnti": "right_anti" };
const PIVOT_AGGS: Record<string, Agg> = { "List.Sum": "sum", "List.Average": "avg", "List.Count": "count", "List.Min": "min", "List.Max": "max", "List.Median": "median" };
const PIVOT_M = Object.fromEntries(Object.entries(PIVOT_AGGS).map(([k, v]) => [v, k]));
const JOIN_M = Object.fromEntries(Object.entries(JOINS).map(([k, v]) => [v, k]));
/** Other tables named in the query, and a join still waiting for Power Query's second half, which picks its columns. */
type Ctx = { tables: Map<string, string>; pending: { column: string; step: Step; stepName: string } | null };
const otherTable = (r: Reader, ctx: Ctx) => { const n = r.ident(), base = ctx.tables.get(n); if (!base) r.fail(`${n} isn't a table in this query. Add ${n} = Basalt.Table("model:name") first.`); return base!; };

function stepsFrom(fn: string, r: Reader, id: () => string, label: string | undefined, ctx: Ctx): Step[] {
  const base = { name: label };
  const mk = (s: Omit<Step, "id" | "name">, i = 0): Step => ({ id: id(), ...base, ...(i ? { name: label ? `${label} ${i + 1}` : undefined } : {}), ...s });
  switch (fn) {
    case "Table.SelectColumns": return [mk({ type: "keep", columns: r.list(() => r.str()) })];
    case "Table.RemoveColumns": return [mk({ type: "remove", columns: r.list(() => r.str()) })];
    case "Table.RenameColumns": return r.list(() => { r.need("{"); const a = r.str(); r.need(","); const b = r.str(); r.need("}"); return [a, b]; }).map(([column, to], i) => mk({ type: "rename", column, to }, i));
    case "Table.SelectRows": { r.need("each"); const { filters, match } = condition(r, id); return [mk({ type: "filter", filters, match })]; }
    case "Table.Sort": return [mk({ type: "sort", sorts: r.list(() => { if (r.peek.t === "str") return { column: r.str(), dir: "asc" as const }; r.need("{"); const column = r.str(); r.need(","); const o = r.ident(); if (o !== "Order.Ascending" && o !== "Order.Descending") r.fail("A sort order is Order.Ascending or Order.Descending."); r.need("}"); return { column, dir: o === "Order.Descending" ? "desc" as const : "asc" as const }; }) })];
    case "Table.Distinct": { if (!r.is("{")) r.fail("Table.Distinct needs the columns to compare, such as {\"Id\"}."); return [mk({ type: "dedupe", columns: r.list(() => r.str()) })]; }
    case "Table.TransformColumnTypes": return r.list(() => { r.need("{"); const column = r.str(); r.need(","); r.take("type"); const t = r.ident(); r.need("}"); if (!TYPES[t]) r.fail(`Basalt can't convert to the type ${t}.`); return { column, t }; }).map(({ column, t }, i) => mk({ type: "convert", column, dataType: TYPES[t] }, i));
    case "Table.TransformColumns": return r.list(() => { r.need("{"); const column = r.str(); r.need(","); const f = r.ident(); r.need("}"); if (!CLEANS[f]) r.fail(`Table.TransformColumns here can use ${Object.keys(CLEANS).join(", ")}, not ${f}.`); return { column, f }; }).map(({ column, f }, i) => mk({ type: "clean", column, value: CLEANS[f] }, i));
    case "Table.AddColumn": { const to = r.str(); r.need(","); r.need("each"); const expr = formula(r); if (r.take(",")) { r.take("type"); r.ident(); } return [mk({ type: "custom", to, expr })]; }
    case "Table.ReplaceValue": {
      const from = r.str(); r.need(","); const value = r.str(); r.need(",");
      const how = r.ident(); if (how !== "Replacer.ReplaceText" && how !== "Replacer.ReplaceValue") r.fail("Use Replacer.ReplaceText or Replacer.ReplaceValue.");
      r.need(",");
      return r.list(() => r.str()).map((column, i) => mk({ type: "replace", column, from, value, mode: how === "Replacer.ReplaceText" ? "contains" : "whole" }, i));
    }
    case "Table.Group": {
      const columns = r.is("{") ? r.list(() => r.str()) : [r.str()]; r.need(",");
      const aggs = r.list(() => {
        r.need("{"); const as = r.str(); r.need(","); r.need("each"); const f = r.ident(); r.need("(");
        let out: NonNullable<Step["aggs"]>[number];
        if (f === "Table.RowCount") { r.need("_"); out = { as, column: "*", agg: "count" }; }
        else if (f === "List.Count") { const d = r.ident(); if (d !== "List.Distinct") r.fail("List.Count here counts List.Distinct([Column])."); r.need("("); const column = r.column(); r.need(")"); out = { as, column, agg: "count_distinct" }; }
        else if (AGG_FNS[f]) out = { as, column: r.column(), agg: AGG_FNS[f] };
        else r.fail(`Table.Group here can use Table.RowCount, List.Count(List.Distinct()), ${Object.keys(AGG_FNS).join(", ")}, not ${f}.`);
        r.need(")"); if (r.take(",")) { r.take("type"); r.ident(); } r.need("}");
        return out;
      });
      return [mk({ type: "group", columns, aggs })];
    }
    case "Table.NestedJoin": {
      const columns = r.list(() => r.str()); r.need(",");
      const base = otherTable(r, ctx); r.need(",");
      const rightKeys = r.list(() => r.str()); r.need(",");
      const column = r.str(); r.need(",");
      const kind = r.ident(), how = JOINS[kind];
      if (!how) r.fail(`A join kind is one of ${Object.keys(JOINS).join(", ")}, not ${kind}.`);
      if (columns.length !== rightKeys.length || !columns.length) r.fail("A join needs the same number of key columns on both sides.");
      const step = mk({ type: "merge", columns, rightKeys, base, how });
      ctx.pending = { column, step, stepName: label ?? "" };
      return [step];
    }
    case "Table.ExpandTableColumn": {
      const p = ctx.pending, column = r.str(); r.need(",");
      if (!p || p.column !== column) r.fail(`${column} isn't a join's result column here. Table.ExpandTableColumn comes straight after its Table.NestedJoin.`);
      if (p!.step.how === "anti" || p!.step.how === "right_anti") r.fail("An anti join has no columns to expand. Use Table.RemoveColumns on its result column instead.");
      const from = r.list(() => r.str());
      const to = r.take(",") ? r.list(() => r.str()) : from;
      if (from.length !== to.length || !from.length) r.fail("List the same number of columns and new names.");
      p!.step.expand = from.map((f, i) => ({ from: f, to: to[i] }));
      ctx.pending = null;
      return [];
    }
    case "Table.Unpivot": case "Table.UnpivotOtherColumns": {
      const columns = r.list(() => r.str()); r.need(","); const to = r.str(); r.need(","); const value = r.str();
      return [mk({ type: "unpivot", columns, to, value, ...(fn === "Table.UnpivotOtherColumns" ? { mode: "others" } : {}) })];
    }
    case "Table.Pivot": {
      // Power Query usually writes List.Distinct here, but the columns of a built model have to be known before it runs
      if (!r.is("{")) r.fail("Table.Pivot needs its new columns listed, such as {\"Oslo\", \"Rome\"}.");
      const values = r.list(() => r.str()); r.need(","); const column = r.str(); r.need(","); const from = r.str();
      if (!r.take(",")) r.fail("Table.Pivot needs a way to combine values, such as List.Sum.");
      const f = r.ident(), agg = Object.hasOwn(PIVOT_AGGS, f) ? PIVOT_AGGS[f] : r.fail(`Table.Pivot can use ${Object.keys(PIVOT_AGGS).join(", ")}, not ${f}.`);
      return [mk({ type: "pivot", values, column, from, agg })];
    }
    case "Table.FillDown": case "Table.FillUp": return r.list(() => r.str()).map((column, i) => mk({ type: "fillnear", column, mode: fn === "Table.FillUp" ? "up" : "down" }, i));
    case "Table.FirstN": return [mk({ type: "rows", mode: "top", n: r.num() })];
    case "Table.LastN": return [mk({ type: "rows", mode: "bottom", n: r.num() })];
    case "Table.Range": { const off = r.num(); r.need(","); return [mk({ type: "rows", mode: "range", n: String(Number(off) + 1), m: r.num() })]; }
  }
  r.at--;
  return r.fail(`Basalt's M doesn't have ${fn} yet. It has ${SUPPORTED}.`);
}

/** Reads a query written in M into a starting table and steps. */
export function parseM(src: string, newId: () => string): { base: string; steps: Step[] } {
  const r = new Reader(tokenize(src));
  r.need("let");
  const seen = new Set<string>(), steps: Step[] = [], ctx: Ctx = { tables: new Map(), pending: null };
  let base = "", tail = "", firstTable = "";
  do {
    const stepName = r.ident();
    if (seen.has(stepName)) r.fail(`There are two steps called ${stepName}.`);
    seen.add(stepName);
    r.need("=");
    const line = r.peek.line, fn = r.ident();
    r.need("(");
    if (fn === "Basalt.Table") {
      const b = r.str();
      if (!/^(model|source):[\w.]+$/.test(b)) throw new MError("Basalt.Table needs a name such as \"model:orders\" or \"source:shop.orders\".", line);
      ctx.tables.set(stepName, b);
      firstTable ||= stepName;
    } else {
      if (!firstTable) throw new MError(`A query starts from Basalt.Table("model:name") or Basalt.Table("source:connection.table"). Basalt can't read ${fn}, so connect that source first and start from its table.`, line);
      // A join's second half is the only thing that can use its result column
      const pending = ctx.pending;
      const from = (prev: string) => {
        if (tail) { if (prev !== tail) throw new MError(`${stepName} starts from ${prev}, but a query here runs in order, so it must start from ${tail}.`, line); return; }
        if (!ctx.tables.has(prev)) throw new MError(`${stepName} starts from ${prev}, but a query here runs in order, so it must start from ${firstTable}.`, line);
        base = ctx.tables.get(prev)!;
      };
      if (fn === "Table.Combine") {
        if (pending) throw new MError(`Finish the join with Table.ExpandTableColumn before ${stepName}.`, line);
        const names = r.list(() => r.ident());
        if (names.length < 2) throw new MError("Table.Combine needs at least two tables.", line);
        from(names[0]);
        for (const n of names.slice(1)) { const b = ctx.tables.get(n); if (!b) throw new MError(`${n} isn't a table in this query. Add ${n} = Basalt.Table("model:name") first.`, line); steps.push({ id: newId(), type: "union", base: b, name: stepName }); }
      } else {
        const prev = r.ident();
        from(prev);
        r.need(",");
        if (pending && fn === "Table.RemoveColumns" && (pending.step.how === "anti" || pending.step.how === "right_anti")) {
          const cols = r.list(() => r.str());
          if (cols.length !== 1 || cols[0] !== pending.column) throw new MError(`After an anti join, remove only its result column, ${pending.column}.`, line);
          ctx.pending = null;
        } else {
          if (pending && fn !== "Table.ExpandTableColumn") throw new MError(`Finish the join with Table.ExpandTableColumn before ${stepName}.`, line);
          steps.push(...stepsFrom(fn, r, newId, stepName, ctx));
        }
      }
      tail = stepName;
    }
    r.need(")");
  } while (r.take(","));
  r.need("in");
  if (ctx.pending) r.fail(`Finish the join: add Table.ExpandTableColumn for ${ctx.pending.column}.`);
  if (!firstTable) r.fail("A query needs a table to start from.");
  const end = tail || firstTable, last = r.ident();
  if (!tail) base = ctx.tables.get(firstTable)!;
  if (last !== end) r.fail(`The query must end with its last step, ${end}.`);
  if (r.peek.t !== "end") r.fail(`There's more after the end of the query: ${r.peek.v}.`);
  return { base, steps };
}

const quoteList = (l: string[] = []) => `{${l.map(text).join(", ")}}`;
const OP_SYM: Partial<Record<FilterOp, string>> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
const literal = (v = "") => (/^-?\d+(\.\d+)?$/.test(v) || v === "true" || v === "false" ? v : /^\d{4}-\d{2}-\d{2}$/.test(v) ? `#date(${v.split("-").map(Number).join(", ")})` : text(v));
function filterM(f: Filter): string | null {
  const c = `[${f.column}]`;
  if (f.op === "empty") return `${c} = null`;
  if (f.op === "not_empty") return `${c} <> null`;
  if (f.op === "contains") return `Text.Contains(${c}, ${text(f.value ?? "")})`;
  if (f.op === "starts") return `Text.StartsWith(${c}, ${text(f.value ?? "")})`;
  const s = OP_SYM[f.op];
  return s ? `${c} ${s} ${literal(f.value)}` : null;
}
const AGG_M = Object.fromEntries(Object.entries(AGG_FNS).map(([k, v]) => [v, k]));
const CLEAN_M = Object.fromEntries(Object.entries(CLEANS).map(([k, v]) => [v, k]));

/** One step as an M call, or null when M here can't say it. */
function stepM(s: Step, prev: string, tables: Map<string, string>): string | null {
  const p = name(prev), other = name(tables.get(s.base ?? "") ?? "");
  switch (s.type) {
    case "union": return s.base ? `Table.Combine({${p}, ${other}})` : null;
    case "keep": return `Table.SelectColumns(${p}, ${quoteList(s.columns)})`;
    case "remove": return `Table.RemoveColumns(${p}, ${quoteList(s.columns)})`;
    case "rename": return `Table.RenameColumns(${p}, {{${text(s.column ?? "")}, ${text(s.to ?? "")}}})`;
    case "filter": { const list = s.filters ?? (s.filter ? [s.filter] : []), parts = list.map(filterM); return parts.length && parts.every(Boolean) ? `Table.SelectRows(${p}, each ${parts.join(s.match === "any" ? " or " : " and ")})` : null; }
    case "sort": return `Table.Sort(${p}, {${(s.sorts ?? []).map((x) => `{${text(x.column)}, Order.${x.dir === "desc" ? "Descending" : "Ascending"}}`).join(", ")}})`;
    case "dedupe": return s.sorts?.some((x) => x.column) ? null : `Table.Distinct(${p}, ${quoteList(s.columns)})`;
    case "convert": { const t = TYPE_NAMES[s.dataType ?? ""]; return t && !s.format ? `Table.TransformColumnTypes(${p}, {{${text(s.column ?? "")}, ${t}}})` : null; }
    case "clean": { const f = CLEAN_M[s.value ?? ""]; return f ? `Table.TransformColumns(${p}, {{${text(s.column ?? "")}, ${f}}})` : null; }
    case "custom": return s.expr && !/PARAM\(|@/.test(s.expr) ? `Table.AddColumn(${p}, ${text(s.to ?? "")}, each ${s.expr.replace(/\{([^}]+)\}/g, "[$1]")})` : null;
    case "replace": return `Table.ReplaceValue(${p}, ${text(s.from ?? "")}, ${text(s.value ?? "")}, Replacer.${s.mode === "contains" ? "ReplaceText" : "ReplaceValue"}, {${text(s.column ?? "")}})`;
    case "group": {
      const aggs = (s.aggs ?? []).map((a) => {
        if (a.agg === "count") return `{${text(a.as)}, each Table.RowCount(_)}`;
        if (a.agg === "count_distinct") return `{${text(a.as)}, each List.Count(List.Distinct([${a.column}]))}`;
        return AGG_M[a.agg] ? `{${text(a.as)}, each ${AGG_M[a.agg]}([${a.column}])}` : null;
      });
      return aggs.every(Boolean) ? `Table.Group(${p}, ${quoteList(s.columns)}, {${aggs.join(", ")}})` : null;
    }
    case "unpivot": return `Table.${s.mode === "others" ? "UnpivotOtherColumns" : "Unpivot"}(${p}, ${quoteList(s.columns)}, ${text(s.to ?? "")}, ${text(s.value ?? "")})`;
    case "pivot": return Object.hasOwn(PIVOT_M, s.agg ?? "") ? `Table.Pivot(${p}, ${quoteList(s.values)}, ${text(s.column ?? "")}, ${text(s.from ?? "")}, ${PIVOT_M[s.agg!]})` : null;
    case "fillnear": return `Table.Fill${s.mode === "up" ? "Up" : "Down"}(${p}, {${text(s.column ?? "")}})`;
    case "rows": return s.mode === "range" ? `Table.Range(${p}, ${Number(s.n ?? 1) - 1}, ${s.m})` : `Table.${s.mode === "bottom" ? "LastN" : "FirstN"}(${p}, ${s.n})`;
  }
  return null;
}

/** A join with chosen columns takes two M calls, as in Power Query. */
function joinM(s: Step, prev: string, stepName: string, tables: Map<string, string>) {
  if (s.type !== "merge" || !s.base || !s.how) return null;
  const column = "Joined", join = `${stepName} join`, call = `Table.NestedJoin(${name(prev)}, ${quoteList(s.columns)}, ${name(tables.get(s.base) ?? "")}, ${quoteList(s.rightKeys)}, ${text(column)}, ${JOIN_M[s.how]})`;
  if (s.how === "anti" || s.how === "right_anti") return s.how === "right_anti" ? null : [[join, call], [stepName, `Table.RemoveColumns(${name(join)}, {${text(column)}})`]];
  if (!s.expand?.length) return null;
  return [[join, call], [stepName, `Table.ExpandTableColumn(${name(join)}, ${text(column)}, ${quoteList(s.expand.map((x) => x.from))}, ${quoteList(s.expand.map((x) => x.to))})`]];
}

/** Writes a query as M. missing lists steps M here can't say, so nothing is lost by applying the text without noticing. */
export function toM(base: string, steps: Step[], labelOf: (s: Step) => string = (s) => s.type) {
  const lines = [`Source = Basalt.Table(${text(base)})`], missing: string[] = [], used = new Set(["Source"]), tables = new Map<string, string>();
  // Every other table the query reads gets a name of its own at the top
  for (const s of steps) if (s.base && !tables.has(s.base)) {
    const root = s.base.split(":")[1].split(".").pop() || "Other";
    let n = root; for (let i = 2; used.has(n); i++) n = `${root}_${i}`;
    used.add(n); tables.set(s.base, n); lines.push(`${name(n)} = Basalt.Table(${text(s.base)})`);
  }
  let prev = "Source";
  for (const s of steps) {
    const label = labelOf(s);
    let stepName = s.name || label;
    for (let n = 2; used.has(stepName); n++) stepName = `${s.name || label} ${n}`;
    const pair = s.disabled ? null : joinM(s, prev, stepName, tables);
    if (pair) { for (const [n, c] of pair) { used.add(n); lines.push(`${name(n)} = ${c}`); prev = n; } continue; }
    const call = s.disabled ? null : stepM(s, prev, tables);
    if (!call) { missing.push(label); lines.push(`// Not shown in M: ${label}`); continue; }
    used.add(stepName);
    lines.push(`${name(stepName)} = ${call}`);
    prev = stepName;
  }
  const body = lines.map((l, i) => `    ${l}${!l.startsWith("//") && lines.slice(i + 1).some((x) => !x.startsWith("//")) ? "," : ""}`).join("\n");
  return { text: `let\n${body}\nin\n    ${name(prev)}`, missing };
}
