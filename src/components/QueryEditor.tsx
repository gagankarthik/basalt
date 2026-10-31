"use client";
import { useEffect, useMemo, useState } from "react";
import { ResultGrid } from "./DataGrid";
import { FilterEditor } from "./FilterEditor";
import { Btn, Field, LoadingTable, Modal, Sel, Tabs, toast } from "./ui";
import { sql, uid, useApp, type TableInfo } from "@/lib/client";
import { compileModel, makeCtx } from "@/lib/dbt-compile";
import { distributionSql, formulaSql, qualitySql, readQuality, type ColumnQuality, type QueryParam } from "@/lib/query";
import { q } from "@/lib/sql";
import { ADD_STEPS, CLEAN_OPTIONS, compileSteps, DATA_TYPES, DATE_FORMATS, DATE_PARTS, EXTRACT_MODES, JOIN_KINDS, promoteRenames, STEP_LABELS, walkSteps, type JoinKind, type Step, type StepType } from "@/lib/transform";
import type { Agg, Column, Filter, Model, Project, Result } from "@/lib/types";

const AGGS: [Agg, string][] = [["sum", "Sum"], ["avg", "Average"], ["count", "Count"], ["count_distinct", "Unique count"], ["min", "Lowest"], ["max", "Highest"], ["median", "Median"]];
const SOURCE = "source", PREVIEW_ROWS = 100, PIVOT_VALUES = 100, TRANSPOSE_ROWS = 200;
const list = (s: string) => s.split(",").map((x) => x.trim());
const pct = (n: number, total: number) => (total ? `${((n / total) * 100).toFixed(n === total || n === 0 ? 0 : 1)}%` : "0%");
const label = (s: Step) => s.name || STEP_LABELS[s.type];

/** Tables a model can read: other models, plus synced tables. */
export function baseOptions(models: Model[], self: string, tables: TableInfo[] | null): [string, string][] {
  return [
    ...models.filter((m) => m.name !== self).map((m): [string, string] => [`model:${m.name}`, `Model: ${m.name}`]),
    ...(tables ?? []).filter((t) => t.schema.startsWith("raw_")).map((t): [string, string] => [`source:${t.schema.slice(4)}.${t.name}`, `Synced: ${t.schema.slice(4)}.${t.name}`]),
  ];
}
const tableOf = (base?: string) => { if (!base) return ""; const [k, r] = base.split(":"); return k === "model" ? `analytics.${r}` : `raw_${r}`; };
const describe = async (body: string) => (await sql(`SELECT * FROM (${body}) LIMIT 0`)).columns;

function Checks({ label: title, options, value, onChange, disabled }: { label: string; options: string[]; value: string[]; onChange: (v: string[]) => void; disabled: boolean }) {
  const all = [...options, ...value.filter((v) => !options.includes(v))];
  return <Field label={title}><div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", maxHeight: 112, overflow: "auto" }}>
    {all.map((c) => <label key={c} className="check small mono"><input type="checkbox" disabled={disabled} checked={value.includes(c)} onChange={(e) => onChange(e.target.checked ? [...value, c] : value.filter((x) => x !== c))} />{c}</label>)}
    {!all.length && <span className="muted small">No columns</span>}
  </div></Field>;
}

function Quality({ body, tracked }: { body: string; tracked: string }) {
  const [rows, setRows] = useState<ColumnQuality[] | null>(null), [error, setError] = useState(""), [pick, setPick] = useState(""), [dist, setDist] = useState<{ column: string; rows: { value: unknown; n: unknown }[] } | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const cols = await describe(tracked), r = await sql(qualitySql(tracked, cols));
        if (live) { setRows(readQuality(r.rows[0], cols)); setError(""); }
      } catch (e) { if (live) setError((e as Error).message); }
    })();
    return () => { live = false; };
  }, [tracked]);
  useEffect(() => {
    if (!pick) return;
    let live = true;
    sql(distributionSql(body, pick)).then((r) => { if (live) setDist({ column: pick, rows: r.rows as { value: unknown; n: unknown }[] }); }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [pick, body]);
  if (error) return <div className="banner bad" role="alert" style={{ margin: 12 }}><span className="mono small">{error}</span></div>;
  if (!rows) return <LoadingTable rows={5} label="Profiling columns" />;
  const top = Math.max(1, ...(dist?.rows ?? []).map((r) => Number(r.n)));
  return <div className="body" style={{ gap: 12 }}>
    <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Column</th><th>Type</th><th>Valid</th><th>Error</th><th>Empty</th><th>Unique</th></tr></thead><tbody>
      {rows.map((c) => <tr key={c.name}><td className="mono small"><button type="button" className="link" onClick={() => setPick(c.name)}>{c.name}</button></td><td className="mono small">{c.type}</td><td>{pct(c.valid, c.total)}</td><td style={c.error ? { color: "var(--bad)" } : undefined}>{pct(c.error, c.total)}</td><td>{pct(c.empty, c.total)}</td><td>{c.distinct.toLocaleString("en-US")}</td></tr>)}
    </tbody></table></div>
    {dist && dist.column === pick && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>{pick}</th><th>Rows</th><th style={{ width: "50%" }}>Distribution</th></tr></thead><tbody>
      {dist.rows.map((r, i) => <tr key={i}><td className="small">{r.value == null ? <span className="muted">Empty</span> : String(r.value)}</td><td>{Number(r.n).toLocaleString("en-US")}</td><td><div style={{ height: 10, width: `${(Number(r.n) / top) * 100}%`, background: "var(--accent)" }} /></td></tr>)}
    </tbody></table></div>}
  </div>;
}

const ctxOf = (models: Model[], project: Project | undefined) => { try { return makeCtx(models, project); } catch { return makeCtx(models); } };

export function QueryEditor({ m, models, tables, set, disabled }: { m: Model; models: Model[]; tables: TableInfo[] | null; set: (p: Partial<Model>) => void; disabled: boolean }) {
  const { patch, config } = useApp(), project = config?.project;
  const options = useMemo(() => baseOptions(models, m.name, tables), [models, m.name, tables]);
  const ctx = useMemo(() => ctxOf(models, project), [models, project]);
  const steps = useMemo(() => m.steps ?? [], [m.steps]), params = useMemo(() => m.params ?? [], [m.params]), base = m.base ?? "";
  const [sel, setSel] = useState(""), [view, setView] = useState("Preview"), [paramsOpen, setParamsOpen] = useState(false);
  const [preview, setPreview] = useState<{ body: string; rows?: number; result?: Result; error?: string } | null>(null), [known, setKnown] = useState<Column[]>([]);
  const found = steps.findIndex((s) => s.id === sel), idx = sel === SOURCE ? -1 : found >= 0 ? found : steps.length - 1, cur = steps[idx];

  // Through the build's own compiler, so an ephemeral input is inlined and its templates expanded
  const compiled = (upTo: number, track = false) => (base ? compileModel({ ...m, kind: "steps", sql: compileSteps(base, steps.slice(0, upTo + 1), { params, track }) }, ctx) : "");
  let problem = "", body = "", inputBody = "", tracked = "";
  try { body = compiled(idx); inputBody = compiled(idx - 1); tracked = compiled(idx, true); } catch (e) { problem = (e as Error).message; }
  const skipped = useMemo(() => { try { return base ? new Set(walkSteps(base, steps, { params }).skipped) : new Set<string>(); } catch { return new Set<string>(); } }, [base, steps, params]);

  useEffect(() => {
    if (!body) return;
    let live = true;
    // Typing shouldn't run a query per keystroke
    const t = setTimeout(async () => {
      try {
        const [count, result] = await Promise.all([sql(`SELECT count(*) AS n FROM (${body})`), sql(`SELECT * FROM (${body}) LIMIT ${PREVIEW_ROWS}`, PREVIEW_ROWS)]);
        if (live) setPreview({ body, rows: Number(count.rows[0].n), result });
      } catch (e) { if (live) setPreview({ body, error: (e as Error).message }); }
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [body]);
  // A step's choices come from the columns just before it
  useEffect(() => {
    if (!inputBody) return;
    let live = true;
    describe(inputBody).then((c) => { if (live) setKnown(c); }).catch(() => { if (live) setKnown([]); });
    return () => { live = false; };
  }, [inputBody]);

  const names = known.map((c) => c.name);
  const write = (b: string, s: Step[], p: QueryParam[] = params) => set({ base: b, steps: s, params: p, ...(b ? { sql: compileSteps(b, s, { params: p }) } : {}) });
  const up = (id: string, p: Partial<Step>) => write(base, steps.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const move = (i: number, d: number) => { const n = [...steps], j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; write(base, n); };
  const insert = (s: Step) => { const n = [...steps]; n.splice(idx + 1, 0, s); write(base, n); setSel(s.id); };
  const add = async (type: StepType) => {
    const id = uid(), s: Step = { id, type };
    if (type === "convert") s.dataType = "VARCHAR";
    if (type === "condition") s.cases = [{ filter: { id: uid(), column: "", op: "eq", value: "" }, then: "" }];
    if (type === "group") s.aggs = [{ column: "*", agg: "count", as: "rows" }];
    if (type === "merge") { s.how = "left"; s.columns = [""]; s.rightKeys = [""]; s.prefix = "right_"; }
    if (type === "sort") s.sorts = [{ column: "", dir: "asc" }];
    if (type === "rows") { s.mode = "top"; s.n = "100"; }
    if (type === "extracttext") s.mode = "first";
    if (type === "pivot") s.agg = "sum";
    try {
      if (type === "dedupe") s.columns = (await describe(compiled(idx))).map((c) => c.name);
      // These two take their column names from the data, so read them now
      if (type === "promote" || type === "transpose") {
        const before = compiled(idx), cols = (await describe(before)).map((c) => c.name);
        if (type === "promote") s.renames = promoteRenames(cols, (await sql(`SELECT * FROM (${before}) LIMIT 1`)).rows[0] ?? {});
        else {
          const n = Number((await sql(`SELECT count(*) AS n FROM (${before})`)).rows[0].n);
          if (n > TRANSPOSE_ROWS || n < 1) { toast(`Transpose needs 1 to ${TRANSPOSE_ROWS} rows. This step has ${n.toLocaleString("en-US")}.`, true); return; }
          s.columns = cols; s.n = String(n);
        }
      }
      insert(s);
    } catch (e) { toast((e as Error).message, true); }
  };
  const readPivot = async (s: Step) => {
    if (!s.column) return;
    try {
      const r = await sql(`SELECT DISTINCT CAST(${q(s.column)} AS VARCHAR) AS v FROM (${inputBody}) WHERE ${q(s.column)} IS NOT NULL ORDER BY 1 LIMIT ${PIVOT_VALUES + 1}`);
      if (r.rows.length > PIVOT_VALUES) toast(`That column has more than ${PIVOT_VALUES} values. Using the first ${PIVOT_VALUES}.`, true);
      up(s.id, { values: r.rows.slice(0, PIVOT_VALUES).map((x) => String(x.v)) });
    } catch (e) { toast((e as Error).message, true); }
  };
  const freeName = (root: string) => { let n = root, i = 2; while (models.some((x) => x.name === n)) n = `${root}_${i++}`; return n; };
  const addCopy = (p: Partial<Model>, name: string) => { patch((c) => ({ ...c, models: [...c.models, { ...m, id: uid(), ...p, name }] })); toast(`Created ${name}`); };
  const duplicate = () => addCopy({}, freeName(`${m.name}_copy`));
  const reference = () => { const b = `model:${m.name}`; addCopy({ base: b, steps: [], params: [], tests: [], sql: compileSteps(b, []), materialized: "view" }, freeName(`${m.name}_ref`)); };

  const inp = (s: Step, key: "to" | "value" | "from" | "n" | "m" | "prefix" | "otherwise", title: string, cls = "input mono") => <Field label={title}><input disabled={disabled} className={cls} value={(s[key] as string) ?? ""} onChange={(e) => up(s.id, { [key]: e.target.value })} /></Field>;
  const col = (s: Step, title = "Column", key: "column" | "from" = "column") => <Field label={title}><Sel disabled={disabled} options={[["", "Choose"], ...[...names, ...(s[key] && !names.includes(s[key]!) ? [s[key]!] : [])].map((c): [string, string] => [c, c])]} value={s[key] ?? ""} onChange={(v) => up(s.id, { [key]: v })} /></Field>;
  const many = (s: Step, title: string) => <Checks label={title} options={names} value={s.columns ?? []} disabled={disabled} onChange={(v) => up(s.id, { columns: v })} />;
  const mode = (s: Step, title: string, opts: [string, string][], fallback: string) => <Field label={title}><Sel disabled={disabled} options={opts} value={s.mode ?? fallback} onChange={(v) => up(s.id, { mode: v })} /></Field>;
  const table = (s: Step, title: string) => <Field label={title}><Sel disabled={disabled} options={[["", "Choose a table"], ...options]} value={s.base ?? ""} onChange={(v) => up(s.id, { base: v })} /></Field>;

  const form = (s: Step) => {
    const otherCols = tables?.find((t) => t.full === tableOf(s.base))?.columns.map((c) => c.name) ?? [];
    switch (s.type) {
      case "keep": return many(s, "Columns to keep");
      case "remove": return many(s, "Columns to remove");
      case "dedupe": return many(s, "A row is a duplicate when these match");
      case "removeerrors": return many(s, "Columns to check, or none for all");
      case "rename": return <div className="form-row">{col(s)}{inp(s, "to", "New name")}</div>;
      case "filter": return <FilterEditor columns={known} filters={s.filters ?? (s.filter ? [s.filter] : [])} match={s.match ?? "all"} onMatch={(v) => up(s.id, { match: v })} onChange={(f: Filter[]) => up(s.id, { filters: f, filter: undefined })} />;
      case "rows": return <div className="form-row">{mode(s, "Keep", [["top", "Top rows"], ["bottom", "Bottom rows"], ["range", "A range"]], "top")}{inp(s, "n", s.mode === "range" ? "First row" : "Rows")}{s.mode === "range" && inp(s, "m", "Rows")}</div>;
      case "sort": return <>{(s.sorts ?? []).map((o, k) => <div className="form-row" key={k}><Field label="Column"><Sel disabled={disabled} options={[["", "Choose"], ...names.map((c): [string, string] => [c, c])]} value={o.column} onChange={(v) => up(s.id, { sorts: s.sorts!.map((x, y) => (y === k ? { ...x, column: v } : x)) })} /></Field><Field label="Order"><Sel disabled={disabled} options={[["asc", "Ascending"], ["desc", "Descending"]]} value={o.dir} onChange={(v) => up(s.id, { sorts: s.sorts!.map((x, y) => (y === k ? { ...x, dir: v as "asc" } : x)) })} /></Field></div>)}{!disabled && <div><Btn icon="plus" onClick={() => up(s.id, { sorts: [...(s.sorts ?? []), { column: "", dir: "asc" }] })}>Add sort</Btn></div>}</>;
      case "convert": {
        const dated = s.dataType === "DATE" || s.dataType === "TIMESTAMP", numeric = /INT|DOUBLE|DECIMAL/.test(s.dataType ?? "");
        return <div className="form-row">{col(s)}<Field label="New type"><Sel disabled={disabled} options={DATA_TYPES} value={s.dataType ?? "VARCHAR"} onChange={(v) => up(s.id, { dataType: v, format: undefined })} /></Field>
          {dated && <Field label="Format"><Sel disabled={disabled} options={[["", "ISO, as stored"], ...DATE_FORMATS]} value={s.format ?? ""} onChange={(v) => up(s.id, { format: v || undefined })} /></Field>}
          {numeric && <Field label="Format"><Sel disabled={disabled} options={[["", "Plain number"], ["us_number", "$1,234.50"]]} value={s.format ?? ""} onChange={(v) => up(s.id, { format: v || undefined })} /></Field>}</div>;
      }
      case "replace": return <div className="form-row">{col(s)}{mode(s, "Match", [["exact", "Whole value"], ["contains", "Within text"]], "exact")}{inp(s, "from", "Find", "input")}{inp(s, "value", "Replace with", "input")}</div>;
      case "fill": return <div className="form-row">{col(s)}{inp(s, "value", "Value to use", "input")}</div>;
      case "fillnear": return <div className="form-row">{col(s)}{mode(s, "Direction", [["down", "Down"], ["up", "Up"]], "down")}</div>;
      case "split": return <div className="form-row">{col(s)}<Field label="Split by"><Sel disabled={disabled} options={[["delimiter", "Delimiter"], ["position", "Character position"]]} value={s.by ?? "delimiter"} onChange={(v) => up(s.id, { by: v as Step["by"], value: "" })} /></Field>{inp(s, "value", s.by === "position" ? "Split after characters" : "Delimiter")}<Field label="New columns"><input disabled={disabled} className="input mono" placeholder="first, second" value={(s.columns ?? []).join(", ")} onChange={(e) => up(s.id, { columns: list(e.target.value) })} /></Field></div>;
      case "mergecols": return <>{many(s, "Columns to merge")}<div className="form-row">{inp(s, "value", "Separator", "input")}{inp(s, "to", "New column")}</div></>;
      case "extracttext": return <div className="form-row">{col(s)}{mode(s, "Extract", EXTRACT_MODES, "first")}
        {["first", "last"].includes(s.mode ?? "first") && inp(s, "n", "Characters")}
        {s.mode === "range" && <>{inp(s, "n", "First character")}{inp(s, "m", "Characters")}</>}
        {["before", "after", "between"].includes(s.mode ?? "") && inp(s, "value", s.mode === "between" ? "Start delimiter" : "Delimiter")}
        {s.mode === "between" && inp(s, "from", "End delimiter")}
        {inp(s, "to", "New column")}</div>;
      case "clean": return <div className="form-row">{col(s)}<Field label="Clean by"><Sel disabled={disabled} options={[["", "Choose"], ...CLEAN_OPTIONS]} value={s.value ?? ""} onChange={(v) => up(s.id, { value: v })} /></Field></div>;
      case "datepart": return <div className="form-row">{col(s, "Date column")}<Field label="Part"><Sel disabled={disabled} options={[["", "Choose"], ...DATE_PARTS]} value={s.value ?? ""} onChange={(v) => up(s.id, { value: v })} /></Field>{inp(s, "to", "New column")}</div>;
      case "custom": {
        let error: string | undefined;
        try { if (s.expr) formulaSql(s.expr, params); } catch (e) { error = (e as Error).message; }
        return <div className="form-row">{inp(s, "to", "New column")}<Field label="Formula" error={error}><input disabled={disabled} className="input mono" placeholder={'IF({amount} > 100, "Large", "Small")'} value={s.expr ?? ""} onChange={(e) => up(s.id, { expr: e.target.value })} /></Field></div>;
      }
      case "calculate": return <div className="form-row">{inp(s, "to", "New column")}<Field label="SQL expression"><input disabled={disabled} className="input mono" value={s.expr ?? ""} onChange={(e) => up(s.id, { expr: e.target.value })} /></Field></div>;
      case "condition": return <>
        {inp(s, "to", "New column")}
        {(s.cases ?? []).map((c, k) => { const set2 = (p: Partial<Filter>, then?: string) => up(s.id, { cases: s.cases!.map((x, y) => (y === k ? { filter: { ...x.filter, ...p }, then: then ?? x.then } : x)) }); return <div key={k} className="form-row">
          <Field label={k ? "Otherwise if" : "If"}><Sel disabled={disabled} options={[["", "Choose"], ...names.map((n): [string, string] => [n, n])]} value={c.filter.column} onChange={(v) => set2({ column: v })} /></Field>
          <Field label="Condition"><Sel disabled={disabled} options={[["eq", "is"], ["neq", "is not"], ["contains", "contains"], ["gt", "is above"], ["gte", "is at least"], ["lt", "is below"], ["lte", "is at most"], ["empty", "is empty"], ["not_empty", "is not empty"]]} value={c.filter.op} onChange={(v) => set2({ op: v as Filter["op"] })} /></Field>
          <Field label="Value"><input disabled={disabled} className="input" value={c.filter.value ?? ""} onChange={(e) => set2({ value: e.target.value })} /></Field>
          <Field label="Then use"><input disabled={disabled} className="input" value={c.then} onChange={(e) => set2({}, e.target.value)} /></Field>
        </div>; })}
        {!disabled && <div><Btn icon="plus" onClick={() => up(s.id, { cases: [...(s.cases ?? []), { filter: { id: uid(), column: "", op: "eq", value: "" }, then: "" }] })}>Add condition</Btn></div>}
        {inp(s, "otherwise", "Otherwise use", "input")}
      </>;
      case "group": return <>{many(s, "Group by")}
        {(s.aggs ?? []).map((a, k) => { const set2 = (p: Partial<typeof a>) => up(s.id, { aggs: s.aggs!.map((x, y) => (y === k ? { ...x, ...p } : x)) }); return <div key={k} className="form-row"><Field label="Calculate"><Sel disabled={disabled} options={AGGS} value={a.agg} onChange={(v) => set2({ agg: v as Agg })} /></Field><Field label="Of column"><Sel disabled={disabled} options={[["*", "All rows"], ...names.map((n): [string, string] => [n, n])]} value={a.column} onChange={(v) => set2({ column: v })} /></Field><Field label="Name the result"><input disabled={disabled} className="input mono" value={a.as} onChange={(e) => set2({ as: e.target.value })} /></Field>{!disabled && <Btn icon="x" variant="ghost" aria-label="Remove calculation" onClick={() => up(s.id, { aggs: s.aggs!.filter((_, y) => y !== k) })} />}</div>; })}
        {!disabled && <div><Btn icon="plus" onClick={() => up(s.id, { aggs: [...(s.aggs ?? []), { column: "*", agg: "count", as: "" }] })}>Add calculation</Btn></div>}</>;
      case "pivot": return <><div className="form-row">{col(s, "Column to spread")}{col(s, "Values from", "from")}<Field label="Calculate"><Sel disabled={disabled} options={AGGS} value={s.agg ?? "sum"} onChange={(v) => up(s.id, { agg: v as Agg })} /></Field></div>
        <div className="form-row"><Field label="New columns"><input disabled={disabled} className="input mono" value={(s.values ?? []).join(", ")} onChange={(e) => up(s.id, { values: list(e.target.value) })} /></Field>{!disabled && <div style={{ alignSelf: "end" }}><Btn disabled={!s.column} onClick={() => readPivot(s)}>Read values</Btn></div>}</div></>;
      case "unpivot": return <>{many(s, "Columns to unpivot")}<div className="form-row">{inp(s, "to", "Name column")}{inp(s, "value", "Value column")}</div></>;
      case "transpose": return <p className="small muted">{s.columns?.length ?? 0} columns and {s.n} rows, read when this step was added.</p>;
      case "promote": return <p className="small muted">{(s.renames ?? []).map((r) => `${r.from} to ${r.to}`).join(", ") || "No names change."}</p>;
      case "merge": {
        const left = s.columns ?? [""], right = s.rightKeys ?? [""];
        return <><div className="form-row">{table(s, "Merge with")}<Field label="Join kind"><Sel disabled={disabled} options={JOIN_KINDS} value={s.how ?? "left"} onChange={(v) => up(s.id, { how: v as JoinKind })} /></Field>{inp(s, "prefix", "Prefix for its columns")}</div>
          {left.map((l, k) => <div className="form-row" key={k}>
            <Field label="This query"><Sel disabled={disabled} options={[["", "Choose"], ...names.map((n): [string, string] => [n, n])]} value={l} onChange={(v) => up(s.id, { columns: left.map((x, y) => (y === k ? v : x)) })} /></Field>
            <Field label="Other table">{otherCols.length ? <Sel disabled={disabled} options={[["", "Choose"], ...otherCols.map((n): [string, string] => [n, n])]} value={right[k] ?? ""} onChange={(v) => up(s.id, { rightKeys: left.map((_, y) => (y === k ? v : right[y] ?? "")) })} /> : <input disabled={disabled} className="input mono" value={right[k] ?? ""} onChange={(e) => up(s.id, { rightKeys: left.map((_, y) => (y === k ? e.target.value : right[y] ?? "")) })} />}</Field>
          </div>)}
          {!disabled && <div><Btn icon="plus" onClick={() => up(s.id, { columns: [...left, ""], rightKeys: [...right, ""] })}>Add key</Btn></div>}</>;
      }
      case "union": return table(s, "Table to append");
      case "join": return <div className="form-row">{table(s, "Table")}<Field label="Rows without a match"><Sel disabled={disabled} options={[["left", "Keep them"], ["inner", "Drop them"]]} value={s.how ?? "left"} onChange={(v) => up(s.id, { how: v as JoinKind })} /></Field>{many(s, "Match on")}</div>;
      case "extract": return <div className="form-row">{col(s, "JSON column")}{inp(s, "value", "Path")}{inp(s, "to", "New column")}<Field label="Type"><Sel disabled={disabled} options={DATA_TYPES} value={s.dataType ?? "VARCHAR"} onChange={(v) => up(s.id, { dataType: v })} /></Field></div>;
      case "unnest": return <div className="form-row">{col(s, "Array column")}<Field label="Items as"><Sel disabled={disabled} options={DATA_TYPES} value={s.dataType ?? "JSON"} onChange={(v) => up(s.id, { dataType: v })} /></Field></div>;
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="toolbar">
        <Sel aria-label="Source" disabled={disabled} options={[["", "Choose a table"], ...options]} value={base} onChange={(v) => write(v, steps)} />
        {!disabled && <Sel aria-label="Add a step" disabled={!base} options={[["", "Add a step"], ...ADD_STEPS.map((t): [string, string] => [t, STEP_LABELS[t]])]} value="" onChange={(v) => { if (v) void add(v as StepType); }} />}
        <div className="grow" />
        <Btn onClick={() => setParamsOpen(true)}>Parameters{params.length ? ` (${params.length})` : ""}</Btn>
        {!disabled && <><Btn icon="link" onClick={reference}>Reference</Btn><Btn icon="copy" onClick={duplicate}>Duplicate</Btn></>}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "300px minmax(0, 1fr)" }}>
        <aside aria-label="Applied steps" style={{ borderRight: "1px solid var(--line)", overflow: "auto" }}>
          <h3 style={{ padding: "8px 12px" }}>Applied steps</h3>
          <button type="button" aria-current={idx < 0 || undefined} onClick={() => setSel(SOURCE)} style={{ display: "block", width: "100%", minHeight: 36, padding: "0 12px", textAlign: "left", border: 0, cursor: "pointer", background: idx < 0 ? "var(--accent-soft)" : "none" }}>Source</button>
          {steps.map((s, i) => {
            const on = i === idx, off = !!s.disabled, bad = skipped.has(s.id) && !off;
            return <div key={s.id} style={{ display: "flex", alignItems: "center", background: on ? "var(--accent-soft)" : undefined }}>
              <button type="button" aria-current={on || undefined} onClick={() => setSel(s.id)} title={bad ? "Not finished, so it's skipped" : undefined} style={{ flex: 1, minWidth: 0, minHeight: 36, padding: "0 12px", textAlign: "left", background: "none", border: 0, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: off ? "line-through" : undefined, color: off ? "var(--ink-3)" : bad ? "var(--bad)" : undefined }}>{label(s)}</button>
              {!disabled && <><Btn icon="eye" variant="ghost" aria-pressed={!off} aria-label={`${off ? "Turn on" : "Turn off"} ${label(s)}`} onClick={() => up(s.id, { disabled: !off })} /><Btn icon="chevDown" variant="ghost" style={{ transform: "rotate(180deg)" }} aria-label={`Move ${label(s)} up`} onClick={() => move(i, -1)} /><Btn icon="chevDown" variant="ghost" aria-label={`Move ${label(s)} down`} onClick={() => move(i, 1)} /><Btn icon="x" variant="ghost" aria-label={`Delete ${label(s)}`} onClick={() => write(base, steps.filter((x) => x.id !== s.id))} /></>}
            </div>;
          })}
        </aside>
        <section style={{ minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, overflow: "auto" }}>
          {cur && <div className="body" style={{ gap: 8, borderBottom: "1px solid var(--line)", flex: "none", maxHeight: "45%", overflow: "auto" }}>
            <div className="form-row"><Field label="Step name"><input disabled={disabled} className="input" value={cur.name ?? ""} placeholder={STEP_LABELS[cur.type]} onChange={(e) => up(cur.id, { name: e.target.value || undefined })} /></Field></div>
            {skipped.has(cur.id) && !cur.disabled && <div className="banner info" role="status">This step isn&apos;t finished, so it&apos;s skipped.</div>}
            {form(cur)}
          </div>}
          <Tabs tabs={["Preview", "Columns", "SQL"]} value={view} onChange={setView} />
          {!base ? <p className="muted small" style={{ padding: 12 }}>Choose a table.</p> : problem ? <div className="banner bad" role="alert" style={{ margin: 12 }}><span>This query can&apos;t be previewed: {problem}</span></div> : <>
            {view === "Preview" && (!preview || preview.body !== body ? <LoadingTable rows={5} label="Running to this step" /> : preview.error ? <div className="banner bad" role="alert" style={{ margin: 12 }}><span className="mono small">{preview.error}</span></div> : <div style={{ flex: 1, minHeight: 240, display: "flex", flexDirection: "column" }}><p className="small muted" style={{ padding: "6px 12px" }}>{preview.rows?.toLocaleString("en-US")} rows, first {Math.min(preview.rows ?? 0, PREVIEW_ROWS).toLocaleString("en-US")} shown</p><div className="fill" style={{ flex: 1, minHeight: 200 }}>{preview.result && <ResultGrid result={preview.result} />}</div></div>)}
            {view === "Columns" && <Quality key={tracked} body={body} tracked={tracked} />}
            {view === "SQL" && <div className="body"><pre className="code">{body}</pre></div>}
          </>}
        </section>
      </div>
      {paramsOpen && <Modal sheet title="Parameters" onClose={() => setParamsOpen(false)} foot={<Btn onClick={() => setParamsOpen(false)}>Done</Btn>}>
        {params.map((p, i) => <div className="form-row" key={i}>
          <Field label="Name"><input disabled={disabled} className="input mono" value={p.name} onChange={(e) => write(base, steps, params.map((x, y) => (y === i ? { ...x, name: e.target.value.replace(/\W/g, "") } : x)))} /></Field>
          <Field label="Value"><input disabled={disabled} className="input" value={p.value} onChange={(e) => write(base, steps, params.map((x, y) => (y === i ? { ...x, value: e.target.value } : x)))} /></Field>
          {!disabled && <div style={{ alignSelf: "end" }}><Btn icon="x" variant="ghost" aria-label={`Delete ${p.name}`} onClick={() => write(base, steps, params.filter((_, y) => y !== i))} /></div>}
        </div>)}
        {!params.length && <p className="muted small">No parameters.</p>}
        {!disabled && <div><Btn icon="plus" onClick={() => write(base, steps, [...params, { name: `param${params.length + 1}`, value: "" }])}>Add parameter</Btn></div>}
      </Modal>}
    </div>
  );
}
