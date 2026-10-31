"use client";
import { useState } from "react";
import { Btn, Empty, Field, Modal, Sel, Sk, Tabs, toast } from "./ui";
import { Icon } from "./icons";
import { ModelDiagram } from "./ModelDiagram";
import { call, columnsOf, fmt, refreshTables, sql, uid, useApp, useQuery, useSem, useTables } from "@/lib/client";
import { refsOf, topoSort } from "@/lib/graph";
import { calcModelName, dateCheckSql, dateProblem, DATE_TABLE, generatedModels, calcTableFull, isModelled, kpiStatus, metricModelSql, modelProblems, relationshipCheckSql, relationshipProblems, withGenerated, type RelCheck, type Sem, type SemanticModel, type SemHierarchy, type SemPerspective, type SemRel, type SemTable } from "@/lib/semantic";
import { kindOf, measureSql, table as tableSql } from "@/lib/sql";
import type { Metric, Widget } from "@/lib/types";

const FORMATS: [string, string][] = [["", "Default"], ["number", "Number"], ["currency", "Currency"], ["compact", "Compact currency"], ["percent", "Percent"]];
const CATEGORIES = ["", "City", "State", "Country", "Postal code", "Latitude", "Longitude", "URL", "Image URL", "Year", "Month"];
const EMPTY: SemanticModel = { tables: [], relationships: [] };
const prettyTable = (full: string) => full.split(".").pop()!.replace(/^(fct|fact|dim|stg)_/, "").replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());

function TableSheet({ t, onClose, save, remove, sem }: { t: SemTable; onClose: () => void; save: (t: SemTable) => void; remove: () => void; sem?: Sem }) {
  const tables = useTables(), [d, setD] = useState(t), [calc, setCalc] = useState({ name: "", dax: "" }), [dateErr, setDateErr] = useState("");
  const cols = columnsOf(tables, `analytics.${calcModelName(t.full)}`).length && t.calc?.length ? columnsOf(tables, `analytics.${calcModelName(t.full)}`) : columnsOf(tables, t.full);
  const set = (c: string, p: Partial<NonNullable<SemTable["columns"]>[string]>) => setD({ ...d, columns: { ...d.columns, [c]: { ...d.columns?.[c], ...p } } });
  const mark = async (c: string) => { if (!c) { setD({ ...d, dateColumn: undefined }); setDateErr(""); return; } const r = (await sql(dateCheckSql(t.full, c))).rows[0], bad = dateProblem({ rows: Number(r.rows), filled: Number(r.filled), days: Number(r.days), span: Number(r.span) }); setDateErr(bad ?? ""); if (!bad) setD({ ...d, dateColumn: c }); };
  return <Modal full title={d.label || t.full} onClose={onClose} foot={<><Btn variant="danger" onClick={remove}>Remove from model</Btn><div className="grow" /><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={!d.label.trim()} onClick={() => save(d)}>Save table</Btn></>}>
    <div className="form-row"><Field label="Name"><input className="input" value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} /></Field><Field label="Warehouse table"><input className="input mono" disabled value={t.full} /></Field></div>
    <div className="form-row">
      <Field label="Date column" error={dateErr || undefined}><Sel options={[["", "Not a date table"], ...cols.filter((c) => kindOf(c.type) === "date").map((c): [string, string] => [c.name, c.name])]} value={d.dateColumn ?? ""} onChange={(v) => void mark(v)} /></Field>
      <label className="check" style={{ alignSelf: "end", height: 36 }}><input type="checkbox" checked={!!d.hidden} onChange={(e) => setD({ ...d, hidden: e.target.checked })} />Hide this table from report fields</label>
    </div>
    <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Column</th><th>Type</th><th>Name</th><th>Format</th><th>Data category</th><th>Folder</th><th>Hidden</th></tr></thead><tbody>{cols.map((c) => { const m = d.columns?.[c.name]; return <tr key={c.name}>
      <td className="mono small">{c.name}</td><td className="small muted">{c.type}</td>
      <td><input className="input" aria-label={`Name of ${c.name}`} value={m?.label ?? ""} placeholder={c.name} onChange={(e) => set(c.name, { label: e.target.value || undefined })} /></td>
      <td><Sel aria-label={`Format of ${c.name}`} options={FORMATS} value={m?.format ?? ""} onChange={(v) => set(c.name, { format: (v || undefined) as Widget["format"] })} /></td>
      <td><Sel aria-label={`Category of ${c.name}`} options={CATEGORIES.map((x): [string, string] => [x, x || "None"])} value={m?.category ?? ""} onChange={(v) => set(c.name, { category: v || undefined })} /></td>
      <td><input className="input" aria-label={`Folder of ${c.name}`} value={m?.folder ?? ""} onChange={(e) => set(c.name, { folder: e.target.value || undefined })} /></td>
      <td><input type="checkbox" aria-label={`Hide ${c.name}`} checked={!!m?.hidden} onChange={(e) => set(c.name, { hidden: e.target.checked })} /></td>
    </tr>; })}</tbody></table></div>
    <h3>Calculated columns</h3>
    {d.calc?.map((k) => <div key={k.name} className="rp-line small"><span className="mono">{k.name} = {k.dax}</span><Btn icon="x" variant="ghost" aria-label={`Remove ${k.name}`} onClick={() => setD({ ...d, calc: d.calc!.filter((x) => x !== k) })} /></div>)}
    <div className="form-row"><input className="input" aria-label="Column name" placeholder="Name" value={calc.name} onChange={(e) => setCalc({ ...calc, name: e.target.value.replace(/\W/g, "_") })} /><input className="input mono" aria-label="Column DAX" placeholder="RELATED(Customers[region])" value={calc.dax} onChange={(e) => setCalc({ ...calc, dax: e.target.value })} /><Btn icon="plus" disabled={!calc.name || !calc.dax.trim() || !sem} onClick={() => { setD({ ...d, calc: [...(d.calc ?? []), calc] }); setCalc({ name: "", dax: "" }); }}>Add column</Btn></div>
  </Modal>;
}

function RelSheet({ r, model, onClose, save, remove }: { r: SemRel; model: SemanticModel; onClose: () => void; save: (r: SemRel) => void; remove?: () => void }) {
  const tables = useTables(), sem = useSem(), [d, setD] = useState(r), [check, setCheck] = useState<RelCheck | null>(null), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const tableOpts = model.tables.map((t): [string, string] => [t.full, t.label]), colOpts = (t: string) => columnsOf(tables, t).map((c): [string, string] => [c.name, c.name]);
  const validate = async () => { if (!sem) return; setBusy(true); setErr(""); try { const row = (await sql(relationshipCheckSql(sem, d))).rows[0]; setCheck(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as RelCheck); } catch (e) { setErr((e as Error).message); } setBusy(false); };
  const ready = d.from && d.to && d.fromCol && d.toCol && d.from !== d.to, p = check && relationshipProblems(d, check);
  return <Modal sheet title="Relationship" onClose={onClose} foot={<>{remove && <Btn variant="danger" onClick={remove}>Delete</Btn>}<div className="grow" /><Btn onClick={onClose}>Cancel</Btn><Btn disabled={!ready || busy} onClick={validate}>Validate</Btn><Btn variant="primary" disabled={!ready || !!p?.blocking.length} onClick={() => save(d)}>Save</Btn></>}>
    <div className="form-row"><Field label="Many side"><Sel options={[["", "Choose a table"], ...tableOpts]} value={d.from} onChange={(v) => { setD({ ...d, from: v, fromCol: "" }); setCheck(null); }} /></Field><Field label="Column"><Sel options={[["", "Choose a column"], ...colOpts(d.from)]} value={d.fromCol} onChange={(v) => { setD({ ...d, fromCol: v }); setCheck(null); }} /></Field></div>
    <div className="form-row"><Field label={d.kind === "many" ? "Other side" : "One side"}><Sel options={[["", "Choose a table"], ...tableOpts]} value={d.to} onChange={(v) => { setD({ ...d, to: v, toCol: "" }); setCheck(null); }} /></Field><Field label="Column"><Sel options={[["", "Choose a column"], ...colOpts(d.to)]} value={d.toCol} onChange={(v) => { setD({ ...d, toCol: v }); setCheck(null); }} /></Field></div>
    <div className="form-row"><Field label="Cardinality"><Sel options={[["one", "Many to one"], ["many", "Many to many"]]} value={d.kind ?? "one"} onChange={(v) => { setD({ ...d, kind: v as SemRel["kind"] }); }} /></Field><Field label="Filter direction"><Sel options={[["single", "Single"], ["both", "Both"]]} value={d.both ? "both" : "single"} onChange={(v) => setD({ ...d, both: v === "both" })} /></Field></div>
    <label className="check"><input type="checkbox" checked={d.active !== false} onChange={(e) => setD({ ...d, active: e.target.checked })} />Active</label>
    {err && <div className="banner bad"><Icon name="warn" />{err}</div>}
    {check && <dl className="kv"><dt>Rows on the many side</dt><dd>{fmt(check.fromRows)}</dd><dt>Rows with no match</dt><dd>{fmt(check.orphanRows)}</dd><dt>Blank keys</dt><dd>{fmt(check.fromBlank)}</dd><dt>Rows on the other side</dt><dd>{fmt(check.toRows)}</dd><dt>Repeated keys there</dt><dd>{fmt(check.duplicateKeys)}</dd></dl>}
    {p?.blocking.map((x) => <div key={x} className="banner bad"><Icon name="warn" />{x}</div>)}
    {p?.notes.map((x) => <div key={x} className="banner warn"><Icon name="info" />{x}</div>)}
    {p && !p.blocking.length && !p.notes.length && <div className="banner info"><Icon name="check" />Every key matches.</div>}
  </Modal>;
}

/** One measure's row: its live value and, with a target, its KPI state. */
function MeasureRow({ m, sem, onEdit }: { m: Metric; sem?: Sem; onEdit: () => void }) {
  const s = useApp((x) => x.config!.settings);
  const text = (() => { if (!m.measure.dax) return `SELECT ${measureSql(m.measure)} AS v FROM ${tableSql(m.table)}`; if (!sem) return null; try { return metricModelSql(sem, m); } catch { return null; } })();
  const { data, error } = useQuery(text), v = data?.rows[0]?.v == null ? null : Number(data.rows[0].v), status = kpiStatus(v, m.kpi?.target ?? null, m.kpi?.higher ?? true);
  return <tr className="click" onClick={onEdit}><td><b>{m.name}</b></td><td className="small muted">{m.folder}</td><td className="mono small">{m.measure.dax ?? `${m.measure.agg}(${m.measure.column})`}</td><td className="r">{error || !text ? <span className="err small">Unavailable</span> : data ? fmt(v, m.format, s.locale, s.currency) : <Sk w={50} />}</td><td className="r">{m.kpi ? fmt(m.kpi.target, m.format, s.locale, s.currency) : ""}</td><td>{status && <span className={`badge ${status === "good" ? "good" : "bad"}`}>{status === "good" ? "On target" : "Off target"}</span>}</td></tr>;
}

/** The Model tab of Metrics: every part of the semantic model, edited in place. */
export function ModelEditor({ onEditMetric }: { onEditMetric: (m: Metric) => void }) {
  const { config, patch, can } = useApp(), tables = useTables(), sem = useSem(), editor = can("editor");
  const model = config!.semantic ?? EMPTY, [tab, setTab] = useState("Diagram");
  const [editT, setEditT] = useState<SemTable | null>(null), [editR, setEditR] = useState<SemRel | null>(null), [adding, setAdding] = useState(false), [pick, setPick] = useState(""), [busy, setBusy] = useState(false), [errors, setErrors] = useState<string[]>([]), [results, setResults] = useState<Record<string, string>>({});
  const [h, setH] = useState({ table: "", name: "", levels: "" }), [p, setP] = useState<SemPerspective | null>(null), [ct, setCt] = useState({ name: "", dax: "" }), [dateSrc, setDateSrc] = useState("");
  const up = (fn: (m: SemanticModel) => SemanticModel) => patch((c) => ({ ...c, semantic: fn(c.semantic ?? EMPTY) }));
  const problems = modelProblems(model);
  const colsFor = (t: SemTable) => { const gen = t.calc?.length ? columnsOf(tables, `analytics.${calcModelName(t.full)}`) : []; return (gen.length ? gen : columnsOf(tables, t.full)).map((c) => c.name); };
  const saveTable = (t: SemTable) => { up((m) => ({ ...m, tables: m.tables.map((x) => (x.full === t.full ? t : x)) })); setEditT(null); };
  const saveRel = (r: SemRel) => { up((m) => ({ ...m, relationships: m.relationships.some((x) => x.id === r.id) ? m.relationships.map((x) => (x.id === r.id ? r : x)) : [...m.relationships, r] })); setEditR(null); };

  const validateAll = async () => {
    if (!sem) return; setBusy(true); const out: Record<string, string> = {};
    // One at a time, so a large model can't crowd out people's dashboards
    for (const r of model.relationships) { try { const c = Object.fromEntries(Object.entries((await sql(relationshipCheckSql(sem, r))).rows[0]).map(([k, v]) => [k, Number(v)])) as RelCheck, x = relationshipProblems(r, c); out[r.id] = [...x.blocking, ...x.notes].join(" ") || "Every key matches."; } catch (e) { out[r.id] = (e as Error).message; } }
    setResults(out); setBusy(false);
  };
  /** Saves first, because the builder reads the saved models. Other builds and reads carry on: DuckDB queues writers and doesn't block readers. */
  const build = async () => {
    const cur = useApp.getState().config!, now = semFrom(cur, tables);
    if (!now) return;
    const { models, errors: bad } = generatedModels(now, cur.models); setErrors(bad);
    if (bad.length) return;
    const next = withGenerated(cur, models); setBusy(true);
    try {
      // A cycle saved into the workspace would stop every model build, so it's caught before saving
      const order = topoSort(models, (m) => refsOf(m.sql).filter((r) => models.some((x) => x.name === r)));
      useApp.getState().patch(() => next); await useApp.getState().save();
      for (const m of order) { const run = await call<{ status: string; summary?: string }>("/api/runs", { json: { kind: "models", only: m.name } }); if (run.status !== "succeeded") throw new Error(`${m.name}: ${run.summary ?? "the build failed. See Run history."}`); }
      await refreshTables(); toast(models.length ? `Built ${models.length} generated tables` : "Nothing to build");
    } catch (e) { setErrors([(e as Error).message]); }
    setBusy(false);
  };
  const addAutoDate = () => {
    const sources = dateSrc ? [{ table: dateSrc.split("|")[0], column: dateSrc.split("|")[1] }] : [];
    if (!sources.length) return;
    up((m) => ({ ...m, autoDate: { sources: [...(m.autoDate?.sources ?? []).filter((s) => !(s.table === sources[0].table && s.column === sources[0].column)), ...sources] }, tables: m.tables.some((t) => t.full === DATE_TABLE) ? m.tables : [...m.tables, { full: DATE_TABLE, label: "Date", dateColumn: "date" }], hierarchies: m.hierarchies?.some((x) => x.table === DATE_TABLE) ? m.hierarchies : [...(m.hierarchies ?? []), { id: uid(), table: DATE_TABLE, name: "Calendar", levels: ["year", "quarter", "month", "date"] }], relationships: [...m.relationships, { id: uid(), from: sources[0].table, fromCol: sources[0].column, to: DATE_TABLE, toCol: "date", active: !m.relationships.some((r) => r.from === sources[0].table && r.to === DATE_TABLE && r.active !== false) }] }));
    setDateSrc(""); toast("Date table added. Build it to fill it.");
  };
  const dateCols = model.tables.flatMap((t) => colsFor(t).filter((c) => kindOf(columnsOf(tables, t.full).find((x) => x.name === c)?.type ?? "") === "date").map((c): [string, string] => [`${t.full}|${c}`, `${t.label} / ${c}`]));
  const available = (tables ?? []).filter((t) => !model.tables.some((x) => x.full === t.full) && !config!.models.some((m) => m.generated && t.full === `analytics.${m.name}`));

  if (!isModelled(model) && !adding) return <Empty icon="lineage" title="No model yet" editor action={<Btn variant="primary" icon="plus" onClick={() => setAdding(true)}>Add tables</Btn>}>Add the tables your reports use, then connect them with relationships.</Empty>;
  return <div className="body model-ui">
    {editor && <div className="toolbar">
      <Btn icon="plus" onClick={() => setAdding(true)}>Add table</Btn>
      <Btn icon="link" disabled={model.tables.length < 2} onClick={() => setEditR({ id: uid(), from: "", fromCol: "", to: "", toCol: "", kind: "one", active: true })}>Add relationship</Btn>
      <Btn icon="check" disabled={busy || !model.relationships.length} onClick={validateAll}>Validate</Btn>
      <Btn icon="play" disabled={busy} onClick={build}>Build generated tables</Btn>
    </div>}
    {errors.map((x) => <div key={x} className="banner bad" role="alert"><Icon name="warn" /><span style={{ overflowWrap: "anywhere" }}>{x}</span></div>)}
    {problems.map((x) => <div key={x} className="banner warn" role="status"><Icon name="warn" />{x}</div>)}
    <Tabs tabs={["Diagram", "Tables", "Relationships", "Measures", "Calculated tables"]} value={tab} onChange={setTab} />
    {tab === "Diagram" && <ModelDiagram model={model} columns={colsFor} onMove={editor ? (full, pos) => up((m) => ({ ...m, tables: m.tables.map((t) => (t.full === full ? { ...t, ...pos } : t)) })) : undefined} onTable={(t) => editor && setEditT(t)} onRel={(r) => editor && setEditR(r)} selected={editR?.id} />}
    {tab === "Tables" && <><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Warehouse table</th><th className="r">Columns</th><th>Date table</th><th>Calculated columns</th><th>Visible</th></tr></thead><tbody>{model.tables.map((t) => <tr key={t.full} className={editor ? "click" : ""} onClick={() => editor && setEditT(t)}><td><b>{t.label}</b></td><td className="mono small">{t.full}</td><td className="r">{colsFor(t).length || <span className="err small">Not built</span>}</td><td className="small">{t.dateColumn ?? ""}</td><td className="small">{t.calc?.map((k) => k.name).join(", ")}</td><td>{t.hidden ? "Hidden" : "Yes"}</td></tr>)}</tbody></table></div>
      <h3>Hierarchies</h3>
      {!!model.hierarchies?.length && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Table</th><th>Levels</th><th /></tr></thead><tbody>{model.hierarchies.map((x: SemHierarchy) => <tr key={x.id}><td><b>{x.name}</b></td><td className="small">{model.tables.find((t) => t.full === x.table)?.label ?? x.table}</td><td className="small">{x.levels.join(" > ")}</td><td className="r">{editor && <Btn icon="x" variant="ghost" aria-label={`Remove ${x.name}`} onClick={() => up((m) => ({ ...m, hierarchies: m.hierarchies!.filter((y) => y.id !== x.id) }))} />}</td></tr>)}</tbody></table></div>}
      {editor && <div className="form-row"><Sel aria-label="Table" options={[["", "Choose a table"], ...model.tables.map((t): [string, string] => [t.full, t.label])]} value={h.table} onChange={(v) => setH({ ...h, table: v })} /><input className="input" aria-label="Hierarchy name" placeholder="Name" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} /><input className="input mono" aria-label="Levels" placeholder="country, state, city" value={h.levels} onChange={(e) => setH({ ...h, levels: e.target.value })} /><Btn icon="plus" disabled={!h.table || !h.name.trim() || !h.levels.trim()} onClick={() => { up((m) => ({ ...m, hierarchies: [...(m.hierarchies ?? []), { id: uid(), table: h.table, name: h.name.trim(), levels: h.levels.split(",").map((x) => x.trim()).filter(Boolean) }] })); setH({ table: "", name: "", levels: "" }); }}>Add hierarchy</Btn></div>}
      {editor && <div className="form-row"><Sel aria-label="Date column" options={[["", "Choose a date column"], ...dateCols]} value={dateSrc} onChange={setDateSrc} /><Btn icon="plus" disabled={!dateSrc} onClick={addAutoDate}>Add auto date table</Btn></div>}
      <h3>Perspectives</h3>
      {!!model.perspectives?.length && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Name</th><th className="r">Tables</th><th className="r">Measures</th></tr></thead><tbody>{model.perspectives.map((x) => <tr key={x.id} className={editor ? "click" : ""} onClick={() => editor && setP(x)}><td><b>{x.name}</b></td><td className="r small">{x.tables.length}</td><td className="r small">{x.measures.length}</td></tr>)}</tbody></table></div>}
      {editor && <div><Btn icon="plus" onClick={() => setP({ id: uid(), name: "", tables: [], measures: [] })}>Add perspective</Btn></div>}
    </>}
    {tab === "Relationships" && (!model.relationships.length ? <Empty compact icon="link" title="No relationships yet" editor action={<Btn variant="primary" icon="link" disabled={model.tables.length < 2} onClick={() => setEditR({ id: uid(), from: "", fromCol: "", to: "", toCol: "", kind: "one", active: true })}>Add relationship</Btn>}>Add a relationship so filters on one table reach another.</Empty> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Many side</th><th>Other side</th><th>Cardinality</th><th>Direction</th><th>State</th><th>Last check</th></tr></thead><tbody>{model.relationships.map((r) => <tr key={r.id} className={editor ? "click" : ""} onClick={() => editor && setEditR(r)}><td className="mono small">{r.from}[{r.fromCol}]</td><td className="mono small">{r.to}[{r.toCol}]</td><td>{r.kind === "many" ? "Many to many" : "Many to one"}</td><td>{r.both ? "Both" : "Single"}</td><td>{r.active === false ? "Inactive" : "Active"}</td><td className="small">{results[r.id] ?? ""}</td></tr>)}</tbody></table></div>)}
    {tab === "Measures" && (!config!.metrics.length ? <Empty compact icon="metric" title="No measures yet" editor action={<Btn variant="primary" icon="plus" onClick={() => onEditMetric({ id: uid(), name: "", description: "", table: model.tables[0]?.full ?? "", measure: { column: "*", agg: "count" }, format: "number", owner: useApp.getState().user!.name })}>New metric</Btn>}>A measure is a number defined once and reused in reports.</Empty> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Measure</th><th>Folder</th><th>Definition</th><th className="r">Value</th><th className="r">Target</th><th>KPI</th></tr></thead><tbody>{[...config!.metrics].sort((a, b) => (a.folder ?? "").localeCompare(b.folder ?? "") || a.name.localeCompare(b.name)).map((m) => <MeasureRow key={m.id} m={m} sem={sem} onEdit={() => editor && onEditMetric(m)} />)}</tbody></table></div>)}
    {tab === "Calculated tables" && <>
      {!!model.calcTables?.length && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Warehouse table</th><th>Definition</th><th /></tr></thead><tbody>{model.calcTables.map((t) => <tr key={t.id}><td><b>{t.name}</b></td><td className="mono small">{calcTableFull(t.name)}</td><td className="mono small">{t.dax}</td><td className="r">{editor && <Btn icon="x" variant="ghost" aria-label={`Remove ${t.name}`} onClick={() => up((m) => ({ ...m, calcTables: m.calcTables!.filter((y) => y.id !== t.id), tables: m.tables.filter((x) => x.full !== calcTableFull(t.name)) }))} />}</td></tr>)}</tbody></table></div>}
      {editor && <div className="form-row"><input className="input" aria-label="Table name" placeholder="Name" value={ct.name} onChange={(e) => setCt({ ...ct, name: e.target.value })} /><input className="input mono" aria-label="Table DAX" placeholder={'SUMMARIZE(Orders, Customers[city], "Total", SUM(Orders[amount]))'} value={ct.dax} onChange={(e) => setCt({ ...ct, dax: e.target.value })} /><Btn icon="plus" disabled={!ct.name.trim() || !ct.dax.trim()} onClick={() => { const full = calcTableFull(ct.name); up((m) => ({ ...m, calcTables: [...(m.calcTables ?? []), { id: uid(), name: ct.name.trim(), dax: ct.dax }], tables: m.tables.some((t) => t.full === full) ? m.tables : [...m.tables, { full, label: ct.name.trim() }] })); setCt({ name: "", dax: "" }); }}>Add table</Btn></div>}
    </>}
    {editT && <TableSheet key={editT.full} t={editT} sem={sem} onClose={() => setEditT(null)} save={saveTable} remove={() => { up((m) => ({ ...m, tables: m.tables.filter((x) => x.full !== editT.full), relationships: m.relationships.filter((r) => r.from !== editT.full && r.to !== editT.full), hierarchies: m.hierarchies?.filter((x) => x.table !== editT.full) })); setEditT(null); }} />}
    {editR && <RelSheet key={editR.id} r={editR} model={model} onClose={() => setEditR(null)} save={saveRel} remove={model.relationships.some((x) => x.id === editR.id) ? () => { up((m) => ({ ...m, relationships: m.relationships.filter((x) => x.id !== editR.id) })); setEditR(null); } : undefined} />}
    {adding && <Modal sheet title="Add a table" onClose={() => setAdding(false)} foot={<><div className="grow" /><Btn onClick={() => setAdding(false)}>Cancel</Btn><Btn variant="primary" disabled={!pick} onClick={() => { up((m) => ({ ...m, tables: [...m.tables, { full: pick, label: prettyTable(pick) }] })); setPick(""); setAdding(false); }}>Add table</Btn></>}><Field label="Warehouse table"><Sel options={[["", "Choose a table"], ...available.map((t): [string, string] => [t.full, t.full])]} value={pick} onChange={setPick} /></Field></Modal>}
    {p && <Modal sheet title="Perspective" onClose={() => setP(null)} foot={<>{model.perspectives?.some((x) => x.id === p.id) && <Btn variant="danger" onClick={() => { up((m) => ({ ...m, perspectives: m.perspectives!.filter((x) => x.id !== p.id) })); setP(null); }}>Delete</Btn>}<div className="grow" /><Btn onClick={() => setP(null)}>Cancel</Btn><Btn variant="primary" disabled={!p.name.trim()} onClick={() => { up((m) => ({ ...m, perspectives: [...(m.perspectives ?? []).filter((x) => x.id !== p.id), p] })); setP(null); }}>Save</Btn></>}>
      <Field label="Name"><input className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
      <div className="field"><span className="lab">Tables</span><div className="rp-checks">{model.tables.map((t) => <label key={t.full} className="check small"><input type="checkbox" checked={p.tables.includes(t.full)} onChange={(e) => setP({ ...p, tables: e.target.checked ? [...p.tables, t.full] : p.tables.filter((x) => x !== t.full) })} />{t.label}</label>)}</div></div>
      <div className="field"><span className="lab">Measures</span><div className="rp-checks">{config!.metrics.map((m) => <label key={m.id} className="check small"><input type="checkbox" checked={p.measures.includes(m.name)} onChange={(e) => setP({ ...p, measures: e.target.checked ? [...p.measures, m.name] : p.measures.filter((x) => x !== m.name) })} />{m.name}</label>)}</div></div>
    </Modal>}
  </div>;
}
const semFrom = (c: { semantic?: SemanticModel; metrics: Metric[] }, tables: { full: string; columns: { name: string; type: string }[] }[] | null): Sem | undefined => (c.semantic && tables ? { model: c.semantic, metrics: c.metrics, schema: Object.fromEntries(tables.map((t) => [t.full, t.columns])) } : undefined);
