"use client";
import { useState } from "react";
import { Chart } from "@/components/Chart";
import { Icon } from "@/components/icons";
import { ModelEditor } from "@/components/ModelEditor";
import { Btn, Empty, Field, Modal, PageHead, Sel, Sk, Tabs } from "@/components/ui";
import { columnsOf, fmt, uid, useApp, useQuery, useSem, useTables, useNewHandler } from "@/lib/client";
import { metricModelSql, type Sem } from "@/lib/semantic";
import { kindOf, measureSql, q, table } from "@/lib/sql";
import type { Agg, Metric, Widget } from "@/lib/types";

/** A metric written in DAX runs on the model, so it can cross relationships. */
const modelText = (sem: Sem | undefined, m: Metric, month?: string) => { if (!m.measure.dax || !sem) return null; try { return metricModelSql(sem, m, month); } catch { return null; } };
function MetricRow({ m, on, onClick }: { m: Metric; on: boolean; onClick: () => void }) {
  const s = useApp((x) => x.config!.settings);
  const sem = useSem();
  const { data, error } = useQuery(modelText(sem, m) ?? `SELECT ${measureSql(m.measure)} AS v FROM ${table(m.table)}`);
  return <tr className={`click ${on ? "on" : ""}`} onClick={onClick}><td><b>{m.name}</b><div className="small muted">{m.description}</div></td><td className="r"><b>{error ? <span className="err small">Unavailable</span> : data ? fmt(data.rows[0].v, m.format, s.locale, s.currency) : <Sk w={60} />}</b></td><td className="hide-sm">{m.owner}</td><td className="hide-sm small">{m.table}</td></tr>;
}
function Trend({ m }: { m: Metric }) {
  const sem = useSem();
  const text = (m.dateColumn && modelText(sem, m, `${m.table}[${m.dateColumn}]`)) || m.dateColumn ? (m.dateColumn && modelText(sem, m, `${m.table}[${m.dateColumn}]`)) || `SELECT date_trunc('month', ${q(m.dateColumn)})::DATE AS d, ${measureSql(m.measure)} AS m0 FROM ${table(m.table)} GROUP BY 1 ORDER BY 1` : null;
  const { data, error } = useQuery(text);
  const w: Widget = { id: m.id, title: m.name, type: "area", x: 0, y: 0, w: 1, h: 1, table: m.table, measures: [m.measure], filters: [], format: m.format, dimension: m.dateColumn, dateGrain: "month" };
  if (!m.dateColumn) return <p className="muted">Add a date column to see this metric over time.</p>;
  if (error) return <div className="banner bad"><Icon name="warn" />{error}</div>;
  return <div style={{ height: 280 }}>{data ? <Chart w={w} result={data} /> : <Sk h="100%" />}</div>;
}

export default function Metrics() {
  const { config, patch, can, user } = useApp(), tables = useTables();
  const [sel, setSel] = useState<string | undefined>(config!.metrics[0]?.id), [edit, setEdit] = useState<Metric | null>(null), [view, setView] = useState("Metrics");
  const metric = config!.metrics.find((x) => x.id === sel);
  const cols = edit ? columnsOf(tables, edit.table) : [];
  const newMetric = () => setEdit({ id: uid(), name: "", description: "", table: tables?.[0]?.full ?? "", measure: { column: "*", agg: "count" }, format: "number", owner: user!.name });
  useNewHandler("metric", newMetric);
  const save = () => { patch((c) => ({ ...c, metrics: c.metrics.some((x) => x.id === edit!.id) ? c.metrics.map((x) => (x.id === edit!.id ? edit! : x)) : [...c.metrics, edit!] })); setSel(edit!.id); setEdit(null); };
  return (
    <>
      <PageHead title="Metrics">{can("editor") && view === "Metrics" && config!.metrics.length > 0 && <><Btn icon="edit" disabled={!metric} onClick={() => setEdit(metric!)}>Edit</Btn><Btn icon="plus" variant="primary" onClick={newMetric}>New metric</Btn></>}</PageHead>
      <Tabs tabs={["Metrics", "Model"]} value={view} onChange={setView} />
      {view === "Model" ? <ModelEditor onEditMetric={setEdit} /> : <div className="body">
        {!config!.metrics.length ? <Empty icon="metric" title="No metrics yet" editor action={<Btn icon="plus" variant="primary" onClick={newMetric}>New metric</Btn>}>Define the numbers your company agrees on, such as revenue or active customers.</Empty> : <>
          <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Metric</th><th className="r">Current value</th><th className="hide-sm">Owner</th><th className="hide-sm">Source</th></tr></thead><tbody>{config!.metrics.map((m) => <MetricRow key={m.id} m={m} on={m.id === sel} onClick={() => setSel(m.id)} />)}</tbody></table></div>
          {metric && <section><h2 style={{ marginBottom: 8 }}>{metric.name} by month</h2><Trend key={metric.id} m={metric} /><h3 style={{ margin: "12px 0 4px" }}>Definition</h3><pre className="code">{metric.measure.dax ?? `SELECT ${measureSql(metric.measure)}\nFROM ${metric.table}`}</pre></section>}
        </>}
      </div>}
      {edit && <Modal sheet title={config!.metrics.some((x) => x.id === edit.id) ? "Edit metric" : "New metric"} onClose={() => setEdit(null)} foot={<>{config!.metrics.some((x) => x.id === edit.id) && <Btn variant="danger" onClick={() => { patch((c) => ({ ...c, metrics: c.metrics.filter((x) => x.id !== edit.id) })); setEdit(null); setSel(undefined); }}>Delete metric</Btn>}<div className="grow" /><Btn onClick={() => setEdit(null)}>Cancel</Btn><Btn variant="primary" disabled={!edit.name || !edit.table} onClick={save}>Save metric</Btn></>}>
        <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        <Field label="Description"><input className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
        <Field label="Table"><Sel options={(tables ?? []).map((t) => t.full)} value={edit.table} onChange={(v) => setEdit({ ...edit, table: v, measure: { column: "*", agg: "count" }, dateColumn: undefined })} /></Field>
        <div className="form-row">
          <Field label="Calculate"><Sel options={[["count", "Count"], ["count_distinct", "Unique count"], ["sum", "Sum"], ["avg", "Average"], ["median", "Median"], ["min", "Lowest"], ["max", "Highest"], ["dax", "DAX"]]} value={edit.measure.dax != null ? "dax" : edit.measure.agg} onChange={(v) => setEdit({ ...edit, measure: v === "dax" ? { ...edit.measure, dax: edit.measure.dax ?? "" } : { ...edit.measure, dax: undefined, agg: v as Agg } })} /></Field>
          <Field label="Of column"><Sel options={[["*", "All rows"], ...cols.map((c): [string, string] => [c.name, c.name])]} value={edit.measure.column} onChange={(v) => setEdit({ ...edit, measure: { ...edit.measure, column: v } })} /></Field>
        </div>
        <div className="form-row">
          <Field label="Date column"><Sel options={[["", "None"], ...cols.filter((c) => kindOf(c.type) === "date").map((c): [string, string] => [c.name, c.name])]} value={edit.dateColumn ?? ""} onChange={(v) => setEdit({ ...edit, dateColumn: v || undefined })} /></Field>
          <Field label="Format"><Sel options={[["number", "Number"], ["currency", "Currency"], ["compact", "Compact currency ($1.2M)"], ["percent", "Percent"]]} value={edit.format ?? "number"} onChange={(v) => setEdit({ ...edit, format: v as Metric["format"] })} /></Field>
        </div>
        {edit.measure.dax != null && <Field label="DAX"><input className="input mono" value={edit.measure.dax} placeholder="SUM(Orders[amount])" onChange={(e) => setEdit({ ...edit, measure: { ...edit.measure, dax: e.target.value } })} /></Field>}
        <div className="form-row">
          <Field label="Display folder"><input className="input" value={edit.folder ?? ""} onChange={(e) => setEdit({ ...edit, folder: e.target.value || undefined })} /></Field>
          <Field label="KPI target"><input className="input" type="number" value={edit.kpi?.target ?? ""} onChange={(e) => setEdit({ ...edit, kpi: e.target.value === "" ? undefined : { target: Number(e.target.value), higher: edit.kpi?.higher ?? true } })} /></Field>
          {edit.kpi && <Field label="Better when"><Sel options={[["high", "Higher"], ["low", "Lower"]]} value={edit.kpi.higher ? "high" : "low"} onChange={(v) => setEdit({ ...edit, kpi: { ...edit.kpi!, higher: v === "high" } })} /></Field>}
        </div>
        <Field label="Owner"><input className="input" value={edit.owner} onChange={(e) => setEdit({ ...edit, owner: e.target.value })} /></Field>
      </Modal>}
    </>
  );
}
