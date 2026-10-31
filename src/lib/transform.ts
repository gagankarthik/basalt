import type { Agg, Filter, Sort } from "./types.ts";
import { errorColumn, formulaSql, type QueryParam } from "./query.ts";
import { filterSql, lit, measureSql, q, whereSql } from "./sql.ts";
import { jsonPath } from "./nested.ts";

export type StepType = "extract" | "unnest" | "filter" | "keep" | "remove" | "rename" | "calculate" | "convert" | "fill" | "dedupe" | "group" | "join" | "sort" | "condition" | "union" | "unpivot" | "split" | "datepart" | "clean" | "rows" | "removeerrors" | "replace" | "fillnear" | "mergecols" | "extracttext" | "custom" | "pivot" | "transpose" | "merge" | "promote";
export type JoinKind = "inner" | "left" | "right" | "full" | "anti" | "right_anti";
export type Step = {
  id: string; type: StepType; name?: string; disabled?: boolean;
  filter?: Filter; filters?: Filter[]; match?: "all" | "any"; columns?: string[]; column?: string; to?: string; expr?: string; dataType?: string; format?: string; value?: string; from?: string; mode?: string; n?: string; m?: string; by?: "delimiter" | "position"; prefix?: string; rightKeys?: string[]; values?: string[]; agg?: Agg; renames?: { from: string; to: string }[];
  aggs?: { column: string; agg: Agg; as: string }[]; base?: string; how?: JoinKind; sorts?: Sort[]; cases?: { filter: Filter; then: string }[]; otherwise?: string;
};
export const DATA_TYPES = ["VARCHAR", "INTEGER", "BIGINT", "DOUBLE", "DECIMAL(18,2)", "BOOLEAN", "DATE", "TIMESTAMP", "JSON"];
export const DATE_FORMATS: [string, string][] = [["%m/%d/%Y", "MM/DD/YYYY"], ["%m/%d/%y", "MM/DD/YY"], ["%m-%d-%Y", "MM-DD-YYYY"], ["%Y-%m-%d", "YYYY-MM-DD"], ["%d/%m/%Y", "DD/MM/YYYY"], ["%d-%b-%Y", "DD-Mon-YYYY"], ["%b %d, %Y", "Mon DD, YYYY"], ["%B %d, %Y", "Month DD, YYYY"], ["%m/%d/%Y %H:%M:%S", "MM/DD/YYYY HH:MM:SS"], ["%m/%d/%Y %I:%M %p", "MM/DD/YYYY HH:MM AM"]];
export const JOIN_KINDS: [JoinKind, string][] = [["left", "Left outer"], ["right", "Right outer"], ["full", "Full outer"], ["inner", "Inner"], ["anti", "Left anti"], ["right_anti", "Right anti"]];
export const EXTRACT_MODES: [string, string][] = [["length", "Length"], ["first", "First characters"], ["last", "Last characters"], ["range", "Range"], ["before", "Text before delimiter"], ["after", "Text after delimiter"], ["between", "Text between delimiters"]];
export const CLEAN_OPTIONS: [string, string][] = [["trim", "Trim"], ["clean", "Remove non-printing characters"], ["lower", "Make lowercase"], ["upper", "Make uppercase"], ["proper", "Capitalize each word"], ["digits", "Keep digits only"], ["blank_null", "Treat blank as empty"]];
export const DATE_PARTS: [string, string][] = [["year", "Year"], ["quarter", "Quarter"], ["month", "Month"], ["week", "Week"], ["day", "Day"], ["dayofweek", "Day of week"], ["hour", "Hour"]];
const CLEAN: Record<string, (c: string) => string> = {
  clean: (c) => `regexp_replace(CAST(${c} AS VARCHAR), '[[:cntrl:]]', '', 'g')`, proper: (c) => `array_to_string(list_transform(string_split(lower(CAST(${c} AS VARCHAR)), ' '), lambda w: upper(w[1:1]) || w[2:]), ' ')`,
  trim: (c) => `trim(${c})`, lower: (c) => `lower(${c})`, upper: (c) => `upper(${c})`,
  digits: (c) => `regexp_replace(CAST(${c} AS VARCHAR), '[^0-9]', '', 'g')`, blank_null: (c) => `nullif(trim(${c}), '')`,
};
export const STEP_LABELS: Record<StepType, string> = { extract: "Extract a JSON field", unnest: "Turn an array into rows", union: "Stack another table", unpivot: "Turn columns into rows", split: "Split a column", datepart: "Get part of a date", clean: "Clean text", filter: "Filter rows", keep: "Keep columns", remove: "Remove columns", rename: "Rename a column", calculate: "Add a calculated column", condition: "Add an if/then column", convert: "Change a column type", fill: "Fill empty values", dedupe: "Remove duplicates", group: "Group and summarize", join: "Join another table", sort: "Sort rows", rows: "Keep top, bottom or a range", removeerrors: "Remove errors", replace: "Replace values", fillnear: "Fill down or up", mergecols: "Merge columns", extracttext: "Extract text", custom: "Add a custom column", pivot: "Pivot", transpose: "Transpose", merge: "Merge queries", promote: "Use first row as headers" };
/** What the editor offers. calculate (raw SQL) and join (two kinds only) remain so existing models still compile. */
export const ADD_STEPS: StepType[] = ["keep", "remove", "rename", "filter", "rows", "dedupe", "removeerrors", "sort", "convert", "replace", "fill", "fillnear", "split", "mergecols", "extracttext", "clean", "datepart", "custom", "condition", "group", "pivot", "unpivot", "transpose", "merge", "union", "promote", "extract", "unnest"];

/** Header names are data, so they're read once when the step is added and stored. Blank or repeated names keep the column unique. */
export function promoteRenames(columns: string[], row: Record<string, unknown>) {
  const seen = new Set<string>();
  return columns.map((from) => {
    const base = String(row[from] ?? "").trim() || from;
    let to = base, n = 2;
    while (seen.has(to.toLowerCase())) to = `${base}_${n++}`;
    seen.add(to.toLowerCase());
    return { from, to };
  }).filter((r) => r.from !== r.to);
}

/** "model:name" or "source:connection.table", as stored on a step-based model. */
export function baseRef(base: string) {
  const [kind, rest = ""] = base.split(":");
  if (!/^[\w.]+$/.test(rest)) throw new Error("Choose a table to start from.");
  if (kind === "model") return `{{ ref('${rest}') }}`;
  const i = rest.indexOf(".");
  return `{{ source('${rest.slice(0, i)}', '${rest.slice(i + 1)}') }}`;
}
const cols = (l: string[] = []) => l.filter(Boolean).map(q).join(", ");
const NUMBER = /^-?\d+(\.\d+)?$/, COUNT = /^\d+$/, AGGS = new Set<string>(["sum", "avg", "count", "count_distinct", "min", "max", "median"]);
const value = (v = "") => (NUMBER.test(v) ? v : lit(v));
const txt = (c: string) => `CAST(${q(c)} AS VARCHAR)`;
const before = (t: string, d: string) => `CASE WHEN strpos(${t}, ${d}) > 0 THEN left(${t}, strpos(${t}, ${d}) - 1) END`;
const after = (t: string, d: string) => `CASE WHEN strpos(${t}, ${d}) > 0 THEN substr(${t}, strpos(${t}, ${d}) + length(${d})) END`;

function extractSql(s: Step): string | null {
  const t = txt(s.column!), n = s.n ?? "", m = s.m ?? "", d = lit(s.value ?? ""), d2 = lit(s.from ?? "");
  switch (s.mode) {
    case "length": return `length(${t})`;
    case "first": return COUNT.test(n) ? `left(${t}, ${n})` : null;
    case "last": return COUNT.test(n) ? `right(${t}, ${n})` : null;
    case "range": return COUNT.test(n) && COUNT.test(m) ? `substr(${t}, ${n}, ${m})` : null;
    case "before": return s.value ? before(t, d) : null;
    case "after": return s.value ? after(t, d) : null;
    case "between": return s.value && s.from ? before(after(t, d), d2) : null;
  }
  return null;
}

function convertSql(s: Step) {
  const c = q(s.column!), text = txt(s.column!), type = s.dataType!;
  if ((type === "DATE" || type === "TIMESTAMP") && DATE_FORMATS.some(([f]) => f === s.format)) return `CAST(TRY_STRPTIME(${text}, ${lit(s.format!)}) AS ${type})`;
  // Removes US thousands separators and currency signs, so 1,234.50 and $5 convert
  if (s.format === "us_number") return `TRY_CAST(regexp_replace(${text}, '[$,\\s]', '', 'g') AS ${type})`;
  return `TRY_CAST(${c} AS ${type})`;
}

type Ctx = { errs: Set<string>; track: boolean; params?: QueryParam[] };

function stepSql(s: Step, from: string, ctx: Ctx): string | null {
  const { errs, track } = ctx, err = (c: string) => q(errorColumn(c));
  const dropErrs = () => { const l = [...errs].map(err); errs.clear(); return l; };
  switch (s.type) {
    case "extract": {
      const path = jsonPath(s.value ?? ""), type = s.dataType || "VARCHAR";
      if (!s.column || !s.to || !path || !DATA_TYPES.includes(type)) return null;
      // TRY: text that isn't JSON in one row must leave that row empty, not fail the build
      const read = (fn: string) => `TRY(${fn}(${q(s.column!)}, ${lit(path)}))`;
      const expr = type === "JSON" ? read("json_extract") : type === "VARCHAR" ? read("json_extract_string") : `TRY_CAST(${read("json_extract_string")} AS ${type})`;
      return `SELECT *, ${expr} AS ${q(s.to)} FROM ${from}`;
    }
    case "unnest": {
      const type = s.dataType || "JSON";
      if (!s.column || !DATA_TYPES.includes(type)) return null;
      const item = type === "JSON" ? "__item" : `TRY_CAST(json_extract_string(__item, '$') AS ${type})`;
      const list = `TRY_CAST(TRY_CAST(${q(s.column)} AS JSON) AS JSON[])`;
      // One empty item keeps a row whose array is empty or missing, and items stay in their order, which a lateral join doesn't promise
      return `SELECT * EXCLUDE (__item) REPLACE (${item} AS ${q(s.column)}) FROM (SELECT *, unnest(CASE WHEN len(${list}) > 0 THEN ${list} ELSE [NULL::JSON] END) AS __item FROM ${from})`;
    }
    case "filter": {
      const list = s.filters ?? (s.filter ? [s.filter] : []);
      if (list.some((f) => f.op === "in_query")) return null; // raw SQL, never offered for a step
      const w = whereSql(list, s.match ?? "all");
      return w ? `SELECT * FROM ${from} ${w}` : null;
    }
    case "keep": {
      if (!s.columns?.length) return null;
      const kept = s.columns.filter((c) => errs.has(c));
      errs.clear(); kept.forEach((c) => errs.add(c));
      return `SELECT ${[cols(s.columns), ...kept.map(err)].join(", ")} FROM ${from}`;
    }
    case "remove": {
      if (!s.columns?.length) return null;
      const gone = s.columns.filter((c) => errs.has(c));
      gone.forEach((c) => errs.delete(c));
      return `SELECT * EXCLUDE (${[cols(s.columns), ...gone.map(err)].join(", ")}) FROM ${from}`;
    }
    case "rename": {
      if (!s.column || !s.to) return null;
      const side = errs.delete(s.column);
      if (side) errs.add(s.to);
      return `SELECT * RENAME (${q(s.column)} AS ${q(s.to)}${side ? `, ${err(s.column)} AS ${err(s.to)}` : ""}) FROM ${from}`;
    }
    case "calculate": return s.to && s.expr ? `SELECT *, (${s.expr}) AS ${q(s.to)} FROM ${from}` : null;
    case "custom": {
      if (!s.to || !s.expr) return null;
      try { return `SELECT *, ${formulaSql(s.expr, ctx.params)} AS ${q(s.to)} FROM ${from}`; } catch { return null; }
    }
    case "condition": {
      const when = (s.cases ?? []).map((c) => { const w = c.filter.op === "in_query" ? null : filterSql(c.filter); return w ? `WHEN ${w} THEN ${value(c.then)}` : ""; }).filter(Boolean);
      return s.to && when.length ? `SELECT *, CASE ${when.join(" ")} ELSE ${s.otherwise ? value(s.otherwise) : "NULL"} END AS ${q(s.to)} FROM ${from}` : null;
    }
    case "convert": {
      if (!s.column || !DATA_TYPES.includes(s.dataType ?? "")) return null;
      const out = convertSql(s), c = q(s.column);
      if (!track) return `SELECT * REPLACE (${out} AS ${c}) FROM ${from}`;
      const failed = `(nullif(trim(${txt(s.column)}), '') IS NOT NULL AND ${out} IS NULL)`, had = errs.has(s.column);
      errs.add(s.column);
      return had ? `SELECT * REPLACE (${out} AS ${c}, (${failed} OR coalesce(${err(s.column)}, false)) AS ${err(s.column)}) FROM ${from}` : `SELECT * REPLACE (${out} AS ${c}), ${failed} AS ${err(s.column)} FROM ${from}`;
    }
    case "removeerrors": {
      const pick = (s.columns?.length ? s.columns : [...errs]).filter((c) => errs.has(c));
      return pick.length ? `SELECT * FROM ${from} WHERE ${pick.map((c) => `NOT coalesce(${err(c)}, false)`).join(" AND ")}` : null;
    }
    case "fill": return s.column ? `SELECT * REPLACE (coalesce(${q(s.column)}, ${value(s.value)}) AS ${q(s.column)}) FROM ${from}` : null;
    case "fillnear": {
      if (!s.column) return null;
      const c = q(s.column);
      return `SELECT * REPLACE (${s.mode === "up" ? `first_value(${c} IGNORE NULLS) OVER (ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)` : `last_value(${c} IGNORE NULLS) OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`} AS ${c}) FROM ${from}`;
    }
    case "replace": {
      if (!s.column || !s.from) return null;
      const t = txt(s.column), to = lit(s.value ?? "");
      return `SELECT * REPLACE (${s.mode === "contains" ? `replace(${t}, ${lit(s.from)}, ${to})` : `CASE WHEN ${t} = ${lit(s.from)} THEN ${to} ELSE ${t} END`} AS ${q(s.column)}) FROM ${from}`;
    }
    case "rows": {
      const n = s.n ?? "", m = s.m ?? "";
      if (s.mode === "range") return COUNT.test(n) && Number(n) > 0 && COUNT.test(m) ? `SELECT * FROM ${from} LIMIT ${m} OFFSET ${Number(n) - 1}` : null;
      if (!COUNT.test(n)) return null;
      return s.mode === "bottom" ? `SELECT * FROM ${from} QUALIFY row_number() OVER () > count(*) OVER () - ${n}` : `SELECT * FROM ${from} LIMIT ${n}`;
    }
    case "dedupe": return s.columns?.length ? `SELECT * FROM ${from} QUALIFY row_number() OVER (PARTITION BY ${cols(s.columns)}) = 1` : null;
    case "group": {
      const a = (s.aggs ?? []).filter((x) => x.as && x.column && AGGS.has(x.agg)).map((x) => `${measureSql({ column: x.column, agg: x.agg })} AS ${q(x.as)}`);
      if (!a.length) return null;
      errs.clear();
      return s.columns?.length ? `SELECT ${cols(s.columns)}, ${a.join(", ")} FROM ${from} GROUP BY ${cols(s.columns)}` : `SELECT ${a.join(", ")} FROM ${from}`;
    }
    case "pivot": {
      if (!s.column || !s.from || !s.values?.length || !AGGS.has(s.agg ?? "")) return null;
      const skip = [q(s.column), q(s.from), ...dropErrs()];
      return `SELECT * EXCLUDE (${skip.join(", ")}), ${s.values.map((v) => `${measureSql({ column: s.from!, agg: s.agg! })} FILTER (WHERE ${txt(s.column!)} = ${lit(v)}) AS ${q(v)}`).join(", ")} FROM ${from} GROUP BY ALL`;
    }
    case "transpose": {
      const n = Number(s.n);
      if (!s.columns?.length || !Number.isInteger(n) || n < 1 || n > 200) return null;
      errs.clear();
      const names = `[${s.columns.map(lit).join(", ")}]`;
      const out = Array.from({ length: n }, (_, i) => `max(v) FILTER (WHERE rn = ${i + 1}) AS ${q(`Column${i + 1}`)}`);
      return `SELECT name AS "Column", ${out.join(", ")} FROM (SELECT rn, unnest(names) AS name, unnest(vals) AS v FROM (SELECT row_number() OVER () AS rn, ${names} AS names, [${s.columns.map(txt).join(", ")}] AS vals FROM ${from})) GROUP BY name ORDER BY list_position(${names}, name)`;
    }
    case "clean": { const f = Object.hasOwn(CLEAN, s.value ?? "") ? CLEAN[s.value!] : null; return s.column && f ? `SELECT * REPLACE (${f(q(s.column))} AS ${q(s.column)}) FROM ${from}` : null; }
    case "split": {
      const out = (s.columns ?? []).filter(Boolean);
      if (!s.column || !s.value || !out.length) return null;
      if (s.by === "position") {
        // "3,7" splits after characters 3 and 7
        const cuts = s.value.split(",").map((x) => x.trim());
        if (!cuts.every((x) => COUNT.test(x))) return null;
        const at = [0, ...cuts.map(Number)];
        if (at.some((x, i) => i > 0 && x <= at[i - 1])) return null;
        return `SELECT *, ${out.slice(0, at.length).map((n, i) => `substr(${txt(s.column!)}, ${at[i] + 1}${i + 1 < at.length ? `, ${at[i + 1] - at[i]}` : ""}) AS ${q(n)}`).join(", ")} FROM ${from}`;
      }
      return `SELECT *, ${out.map((n, i) => `string_split(CAST(${q(s.column!)} AS VARCHAR), ${lit(s.value!)})[${i + 1}] AS ${q(n)}`).join(", ")} FROM ${from}`;
    }
    case "mergecols": return s.columns?.length && s.to ? `SELECT *, concat_ws(${lit(s.value ?? "")}, ${s.columns.map(txt).join(", ")}) AS ${q(s.to)} FROM ${from}` : null;
    case "extracttext": { if (!s.column || !s.to) return null; const e = extractSql(s); return e ? `SELECT *, ${e} AS ${q(s.to)} FROM ${from}` : null; }
    case "datepart": return s.column && s.to && DATE_PARTS.some(([p]) => p === s.value) ? `SELECT *, date_part('${s.value}', TRY_CAST(${q(s.column)} AS TIMESTAMP)) AS ${q(s.to)} FROM ${from}` : null;
    case "union": return s.base ? `SELECT * FROM ${from} UNION ALL BY NAME SELECT * FROM ${baseRef(s.base)}` : null;
    case "unpivot": {
      if (!s.columns?.length || !s.to || !s.value) return null;
      const skip = dropErrs();
      return `SELECT * FROM (UNPIVOT ${skip.length ? `(SELECT * EXCLUDE (${skip.join(", ")}) FROM ${from})` : from} ON ${cols(s.columns)} INTO NAME ${q(s.to)} VALUE ${q(s.value)})`;
    }
    case "join": return s.base && s.columns?.length ? `SELECT * FROM ${from} ${s.how === "inner" ? "INNER" : "LEFT"} JOIN ${baseRef(s.base)} USING (${cols(s.columns)})` : null;
    case "merge": {
      const left = (s.columns ?? []).filter(Boolean), right = s.rightKeys ?? [], prefix = s.prefix ?? "right_";
      if (!s.base || !left.length || left.length !== right.length || right.some((k) => !k) || !/^\w*$/.test(prefix)) return null;
      const on = left.map((k, i) => `l.${q(k)} = r.${q(right[i])}`).join(" AND "), other = baseRef(s.base);
      if (s.how === "anti") return `SELECT l.* FROM ${from} AS l ANTI JOIN ${other} AS r ON ${on}`;
      if (s.how === "right_anti") { errs.clear(); return `SELECT r.* FROM ${other} AS r ANTI JOIN ${from} AS l ON ${on}`; }
      const kind = s.how === "inner" ? "INNER" : s.how === "right" ? "RIGHT" : s.how === "full" ? "FULL" : "LEFT";
      // The prefix stops the two sides' column names colliding. \0 is DuckDB's "the matched name".
      return `SELECT l.*, COLUMNS(r.*) AS ${lit(`${prefix}\\0`)} FROM ${from} AS l ${kind} JOIN ${other} AS r ON ${on}`;
    }
    case "sort": { const o = (s.sorts ?? []).filter((x) => x.column); return o.length ? `SELECT * FROM ${from} ORDER BY ${o.map((x) => `${q(x.column)} ${x.dir === "desc" ? "DESC" : "ASC"}`).join(", ")}` : null; }
    case "promote": {
      const list = (s.renames ?? []).flatMap((r) => {
        const side = errs.delete(r.from);
        if (side) errs.add(r.to);
        return [`${q(r.from)} AS ${q(r.to)}`, ...(side ? [`${err(r.from)} AS ${err(r.to)}`] : [])];
      });
      return `SELECT * ${list.length ? `RENAME (${list.join(", ")}) ` : ""}FROM ${from} OFFSET 1`;
    }
  }
}

/** A value that is exactly @name takes that parameter's value. */
const withParams = <T,>(x: T, params: QueryParam[]): T => {
  if (typeof x === "string") { const p = x[0] === "@" ? params.find((v) => v.name === x.slice(1)) : undefined; return (p ? p.value : x) as T; }
  if (Array.isArray(x)) return x.map((v) => withParams(v, params)) as T;
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, withParams(v, params)])) as T;
  return x;
};
// compileSql rewrites any {{ ref(...) }} it finds, even inside quotes, so typed text must never carry one. calculate is the one raw SQL step.
const smuggles = (s: Step) => s.type !== "calculate" && JSON.stringify(s).includes("{{");

export type CompileOptions = { params?: QueryParam[]; track?: boolean };
/** Each finished step becomes one named CTE, so a half-filled step is skipped and the compiled SQL stays readable. */
export function walkSteps(base: string, steps: Step[], opts: CompileOptions = {}) {
  const params = opts.params ?? [], live = steps.filter((s) => !s.disabled);
  const ctx: Ctx = { errs: new Set(), track: !!opts.track || live.some((s) => s.type === "removeerrors"), params };
  const parts = [`base AS (\n  SELECT * FROM ${baseRef(base)}\n)`], skipped: string[] = [];
  let prev = "base", n = 0;
  for (const raw of live) {
    const s = withParams(raw, params);
    const body = smuggles(s) ? null : stepSql(s, prev, ctx);
    if (!body) { skipped.push(s.id); continue; }
    const name = `step_${++n}_${s.type}`;
    parts.push(`${name} AS (\n  ${body}\n)`);
    prev = name;
  }
  const hidden = !opts.track && ctx.errs.size ? `EXCLUDE (${[...ctx.errs].map((c) => q(errorColumn(c))).join(", ")}) ` : "";
  return { sql: `WITH ${parts.join(",\n")}\nSELECT * ${hidden}FROM ${prev}`, skipped };
}
export const compileSteps = (base: string, steps: Step[], opts?: CompileOptions) => walkSteps(base, steps, opts).sql;
