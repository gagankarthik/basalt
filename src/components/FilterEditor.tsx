"use client";
import { useMemo, useState } from "react";
import { Btn, Pop, Sel, Sk } from "./ui";
import { Icon } from "./icons";
import { fmt, uid, useQuery } from "@/lib/client";
import { parseField } from "@/lib/semantic";
import { kindOf, q, table as tableSql } from "@/lib/sql";
import type { Column, Filter, FilterOp } from "@/lib/types";

const TEXT: [FilterOp, string][] = [["in", "is any of"], ["not_in", "is none of"], ["contains", "contains"], ["not_contains", "doesn't contain"], ["eq", "is exactly"], ["starts", "starts with"], ["empty", "is empty"], ["not_empty", "is not empty"]];
const NUM: [FilterOp, string][] = [["between", "is between"], ["gte", "is at least"], ["lte", "is at most"], ["gt", "is above"], ["lt", "is below"], ["eq", "equals"], ["in", "is any of"], ["empty", "is empty"], ["not_empty", "is not empty"]];
const DATE: [FilterOp, string][] = [["last_days", "in the last"], ["between", "is between"], ["gte", "on or after"], ["lte", "on or before"], ["empty", "is empty"], ["not_empty", "is not empty"]];
const BOOL: [FilterOp, string][] = [["in", "is any of"], ["empty", "is empty"]];
export const opsFor = (type: string) => { const k = kindOf(type); return k === "number" ? NUM : k === "date" ? DATE : k === "bool" ? BOOL : TEXT; };
const inputType = (type: string, op: FilterOp) => (op === "last_days" ? "number" : kindOf(type) === "number" ? "number" : kindOf(type) === "date" ? "date" : "text");
const isMulti = (op: FilterOp) => op === "in" || op === "not_in";

/** Searchable checklist of a column's real values, most common first, with a count beside each. */
export function ValuePicker({ table, column, values, onChange }: { table: string; column: string; values: string[]; onChange: (v: string[]) => void }) {
  const [find, setFind] = useState(""), field = parseField(column);
  if (field) { table = field.table; column = field.column; }
  const { data, loading, error } = useQuery(`SELECT CAST(${q(column)} AS VARCHAR) AS v, count(*) AS n FROM ${tableSql(table)} WHERE ${q(column)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 500`);
  const shown = useMemo(() => (data?.rows ?? []).filter((r) => String(r.v).toLowerCase().includes(find.toLowerCase())), [data, find]);
  const toggle = (v: string) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  return (
    <div className="vp">
      <input className="input" type="search" autoFocus placeholder="Search values" aria-label={`Search values of ${column}`} value={find} onChange={(e) => setFind(e.target.value)} />
      <div className="vp-actions"><button type="button" className="link small" onClick={() => onChange([...new Set([...values, ...shown.map((r) => String(r.v))])])}>Select all shown</button><button type="button" className="link small" disabled={!values.length} onClick={() => onChange([])}>Clear</button><span className="faint small">{values.length} selected</span></div>
      <div className="vp-list">
        {loading && !data && <Sk h={80} />}
        {error && <p className="err small">{error}</p>}
        {shown.map((r) => { const v = String(r.v); return <label key={v} className="vp-item"><input type="checkbox" checked={values.includes(v)} onChange={() => toggle(v)} /><span>{v}</span><small>{fmt(r.n)}</small></label>; })}
        {data && !shown.length && <p className="muted small" style={{ padding: 8 }}>No values match.</p>}
        {data?.rows.length === 500 && <p className="faint small" style={{ padding: 8 }}>Showing the 500 most common values.</p>}
      </div>
    </div>
  );
}

/** Compact chip that opens the picker: "Status Any", "Status Paid +2". */
export function FilterChip({ table, column, label, filter, onChange }: { table: string; column: string; label: string; filter?: Filter; onChange: (values: string[]) => void }) {
  const values = filter?.values ?? [];
  return (
    <Pop width={280} trigger={(_, t) => <button type="button" className={`fchip ${values.length ? "on" : ""}`} aria-label={`Filter by ${label}`} onClick={t}><span>{label}</span><b>{values[0] ?? "Any"}{values.length > 1 && <i> +{values.length - 1}</i>}</b><Icon name="chevDown" size={13} /></button>}>
      <ValuePicker table={table} column={column} values={values} onChange={onChange} />
    </Pop>
  );
}

export function FilterEditor({ columns, filters, onChange, match, onMatch, table, labelOf = (c) => c }: { columns: Column[]; filters: Filter[]; onChange: (f: Filter[]) => void; match?: "all" | "any"; onMatch?: (m: "all" | "any") => void; table?: string; labelOf?: (c: string) => string }) {
  const set = (id: string, p: Partial<Filter>) => onChange(filters.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const typeOf = (c: string) => columns.find((x) => x.name === c)?.type ?? "VARCHAR";
  const firstOp = (c: string): FilterOp => { const o = opsFor(typeOf(c))[0][0]; return isMulti(o) && !table ? "contains" : o; };
  const options = columns.map((c): [string, string] => [c.name, labelOf(c.name)]);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {onMatch && filters.length > 1 && <div className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}>Show rows matching <Sel aria-label="Match all or any" options={[["all", "all of these"], ["any", "any of these"]]} value={match ?? "all"} onChange={(v) => onMatch(v as "all" | "any")} /></div>}
      {filters.map((f, idx) => {
        const prev = filters[idx - 1], grouped = !!f.group;
        const toggleGroup = () => {
          if (grouped) { set(f.id, { group: undefined }); return; }
          const g = prev?.group ?? uid();
          onChange(filters.map((x) => (x.id === f.id || x.id === prev?.id ? { ...x, group: g } : x)));
        };
        const t = typeOf(f.column), ops = opsFor(t).filter(([o]) => table || !isMulti(o)), noValue = f.op === "empty" || f.op === "not_empty", multi = isMulti(f.op);
        return (
          <div key={f.id} className={grouped ? "f-grouped" : ""} style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
            <Sel aria-label="Field" style={{ width: 150 }} options={options} value={f.column} onChange={(v) => set(f.id, { column: v, op: firstOp(v), value: "", value2: "", values: [] })} />
            <Sel aria-label="Condition" style={{ width: 130 }} options={ops} value={f.op} onChange={(v) => set(f.id, { op: v as FilterOp })} />
            {multi && table && <Pop width={280} trigger={(_, o) => <Btn onClick={o}>{f.values?.length ? `${f.values.length} selected` : "Choose values"}<Icon name="chevDown" size={13} /></Btn>}><ValuePicker table={table} column={f.column} values={f.values ?? []} onChange={(v) => set(f.id, { values: v })} /></Pop>}
            {!noValue && !multi && <input className="input" aria-label="Value" style={{ width: f.op === "last_days" ? 70 : 130 }} type={inputType(t, f.op)} value={f.value ?? ""} onChange={(e) => set(f.id, { value: e.target.value })} />}
            {f.op === "last_days" && <>{[7, 30, 90].map((d) => <button key={d} type="button" className={`fchip ${f.value === String(d) ? "on" : ""}`} onClick={() => set(f.id, { value: String(d) })}>{d} days</button>)}</>}
            {f.op === "between" && <input className="input" aria-label="Second value" style={{ width: 120 }} type={inputType(t, f.op)} value={f.value2 ?? ""} onChange={(e) => set(f.id, { value2: e.target.value })} />}
            {onMatch && idx > 0 && <button type="button" className="link small" onClick={toggleGroup}>{grouped ? "Ungroup" : "Group with above"}</button>}
            <Btn icon="x" variant="ghost" aria-label="Remove filter" onClick={() => onChange(filters.filter((x) => x.id !== f.id))} />
          </div>
        );
      })}
      {!filters.length && <p className="muted small">No filters. All rows are shown.</p>}
      <div><Btn icon="plus" disabled={!columns.length} onClick={() => { const c = columns[0]; onChange([...filters, { id: uid(), column: c.name, op: firstOp(c.name), value: "", values: [] }]); }}>Add filter</Btn></div>
    </div>
  );
}
