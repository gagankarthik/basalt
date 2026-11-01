"use client";
import dynamic from "next/dynamic";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { python as pythonLang } from "@codemirror/lang-python";
import { Lineage } from "@/components/Lineage";
import { baseOptions, QueryEditor } from "@/components/QueryEditor";
import { ResultGrid } from "@/components/DataGrid";
import { Icon } from "@/components/icons";
import { Btn, Confirm, Empty, Field, GrowUp, Modal, MoreMenu, PageHead, Pop, Sel, Spinner, StatusBadge, Tabs, toast, Split, SplitToggle } from "@/components/ui";
import { call, refreshTables, sql, uid, useApp, useIsDark, useTables, when, useNewHandler } from "@/lib/client";
import { refsOf, sourcesOf, syncPythonInputs } from "@/lib/graph";
import { compileModel, effectiveOf, makeCtx } from "@/lib/dbt-compile";
import { ModelSettings, ProjectPanel, SeedEditor, TestOptions } from "@/components/DbtProject";
import type { Model, ModelTest, Result, Run } from "@/lib/types";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });
const NAME = /^[a-z][a-z0-9_]*$/;
const PY_TEMPLATE = `def transform(tables):
    """tables holds each input as a list of dictionaries, one per row.
    Return a list of dictionaries, or a pandas DataFrame, to create this model."""
    rows = next(iter(tables.values()), [])
    return rows
`;
const KINDS: [NonNullable<Model["kind"]>, string][] = [["sql", "SQL"], ["steps", "Query editor"], ["python", "Python"], ["seed", "Seed (CSV)"]];
const inputSql = (base: string) => { const [k, r] = base.split(":"); if (k === "model") return `{{ ref('${r}') }}`; const i = r.indexOf("."); return `{{ source('${r.slice(0, i)}', '${r.slice(i + 1)}') }}`; };

function TestsEditor({ m, set, disabled }: { m: Model; set: (t: ModelTest[]) => void; disabled: boolean }) {
  const up = (i: number, p: Partial<ModelTest>) => set(m.tests.map((t, k) => (k === i ? { ...t, ...p } : t)));
  return <div style={{ display: "grid", gap: 6 }}>
    {m.tests.map((t, i) => <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      <Sel disabled={disabled} aria-label="Check type" options={[["not_null", "Never empty"], ["unique", "Unique"], ["accepted_values", "Allowed values"], ["relationships", "Exists in another model"], ["range", "Within a range"], ["row_count", "Has at least this many rows"], ["freshness", "Updated recently"], ["custom", "Custom SQL finds no rows"], ["generic", "Test macro"]]} value={t.type} onChange={(v) => up(i, { type: v as ModelTest["type"] })} />
      <input disabled={disabled} className="input" aria-label="Column" placeholder="Column" style={{ width: 150 }} value={t.column} onChange={(e) => up(i, { column: e.target.value })} />
      {t.type === "accepted_values" && <input disabled={disabled} className="input" aria-label="Allowed values" placeholder="Comma-separated values" style={{ flex: 1, minWidth: 180 }} value={(t.values ?? []).join(", ")} onChange={(e) => up(i, { values: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />}
      {t.type === "relationships" && <><input disabled={disabled} className="input" aria-label="Other model" placeholder="Other model" value={t.to ?? ""} onChange={(e) => up(i, { to: e.target.value })} /><input disabled={disabled} className="input" aria-label="Other column" placeholder="Other column" value={t.field ?? ""} onChange={(e) => up(i, { field: e.target.value })} /></>}
      {t.type === "range" && <><input disabled={disabled} className="input" type="number" aria-label="Lowest allowed" placeholder="Lowest" style={{ width: 100 }} value={t.min ?? ""} onChange={(e) => up(i, { min: e.target.value === "" ? undefined : Number(e.target.value) })} /><input disabled={disabled} className="input" type="number" aria-label="Highest allowed" placeholder="Highest" style={{ width: 100 }} value={t.max ?? ""} onChange={(e) => up(i, { max: e.target.value === "" ? undefined : Number(e.target.value) })} /></>}
      {t.type === "row_count" && <input disabled={disabled} className="input" type="number" aria-label="Fewest rows" placeholder="Rows" style={{ width: 100 }} value={t.min ?? ""} onChange={(e) => up(i, { min: Number(e.target.value) })} />}
      {t.type === "freshness" && <input disabled={disabled} className="input" type="number" aria-label="Hours allowed" placeholder="Hours" style={{ width: 100 }} value={t.hours ?? ""} onChange={(e) => up(i, { hours: Number(e.target.value) })} />}
      {t.type === "custom" && <input disabled={disabled} className="input mono" aria-label="SQL that finds bad rows" placeholder="SELECT * FROM {{ ref('orders') }} WHERE amount < 0" style={{ flex: 1, minWidth: 260 }} value={t.sql ?? ""} onChange={(e) => up(i, { sql: e.target.value })} />}
      {t.type === "generic" && <input disabled={disabled} className="input mono" aria-label="Test macro name" placeholder="Macro name" style={{ width: 150 }} value={t.macro ?? ""} onChange={(e) => up(i, { macro: e.target.value })} />}
      <TestOptions t={t} up={(p) => up(i, p)} disabled={disabled} />
      <label className="check small" title="Models that depend on this one won't build if this check fails"><input type="checkbox" disabled={disabled} checked={!!t.block} onChange={(e) => up(i, { block: e.target.checked })} />Blocking</label>
      {!disabled && <Btn icon="x" variant="ghost" aria-label="Remove check" onClick={() => set(m.tests.filter((_, k) => k !== i))} />}
    </div>)}
    {!m.tests.length && <p className="muted small">No checks on this model. A check that fails is reported on the run but doesn&apos;t remove the data.</p>}
    {!disabled && <div><Btn icon="plus" onClick={() => set([...m.tests, { type: "not_null", column: "" }])}>Add check</Btn></div>}
  </div>;
}

function Models() {
  const { config, patch, can } = useApp(), pre = useSearchParams(), tables = useTables();
  const models = config!.models;
  const [sel, setSel] = useState<string | undefined>(pre.get("m") ?? models[0]?.id), [tab, setTab] = useState("SQL"), [busy, setBusy] = useState(false), [lastRun, setLastRun] = useState<Run | null>(null), [preview, setPreview] = useState<Result | null>(null), [err, setErr] = useState(""), [adding, setAdding] = useState(false), [name, setName] = useState(""), [kind, setKind] = useState<NonNullable<Model["kind"]>>("sql"), [del, setDel] = useState(false);
  useNewHandler("model", () => { setName(""); setKind("sql"); setAdding(true); });
  const m = models.find((x) => x.id === sel);
  const [selecting, setSelecting] = useState(false), [select, setSelect] = useState(""), [exclude, setExclude] = useState("");
  const compile = (x: Model) => compileModel(effectiveOf(x, makeCtx(models, config!.project)), makeCtx(models, config!.project));
  const compiledText = () => { try { return compile(m!); } catch (e) { return (e as Error).message; } };
  const editable = can("editor"), cmTheme = useIsDark() ? "dark" : "light";
  useEffect(() => { call<Run[]>("/api/runs").then((r) => { const last = r.find((x) => x.kind === "models"); return last ? call<Run>(`/api/runs?id=${last.id}`) : null; }).then(setLastRun).catch(() => {}); }, []);
  useEffect(() => { setPreview(null); setErr(""); }, [sel]);
  const up = (p: Partial<Model>) => patch((c) => ({ ...c, models: c.models.map((x) => (x.id === sel ? { ...x, ...p } : x)) }));
  const build = async (only?: string, fullRefresh = false, withDown = false, selection?: { select: string; exclude: string }) => {
    setBusy(true);
    await new Promise((r) => setTimeout(r, 500)); // let the debounced config save land first
    try { const r = await call<Run>("/api/runs", { json: { kind: "models", only, fullRefresh, downstream: withDown, ...selection } }); setLastRun(r); toast(r.summary ?? "Done", r.status !== "succeeded"); await refreshTables(); } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };
  const runPreview = async () => { setErr(""); try { setPreview(await sql(`SELECT * FROM (\n${compile(m!)}\n) LIMIT 200`)); } catch (e) { setErr((e as Error).message); } };
  type Res = { unique_id: string; status: string; message?: string; execution_time: number };
  const results = (lastRun?.artifacts?.run_results as { results?: Res[] } | undefined)?.results ?? [];
  const mine = results.filter((r) => m && (r.unique_id.endsWith(`.basalt.${m.name}`) || r.unique_id.includes(`_${m.name}_`)));
  const statusOf = (n: string) => results.find((r) => r.unique_id.endsWith(`.basalt.${n}`) && !r.unique_id.startsWith("test."))?.status;
  const complete = sourcesOf;
  const completions = useMemo(() => [sqlLang({ upperCaseKeywords: true })], []);
  const pyExt = useMemo(() => [pythonLang()], []);
  const mk = m?.kind ?? "sql";
  const downstream = m ? models.filter((x) => refsOf(x.sql).includes(m.name)).map((x) => x.name) : [];

  return (
    <>
      <PageHead title="Models">
        {lastRun && <span className="small muted hide-sm" title={lastRun.summary}>Last build {when(lastRun.startedAt)}</span>}
        {editable && models.length > 0 && <><Btn icon="plus" onClick={() => { setName(""); setKind("sql"); setAdding(true); }}>New model</Btn><span className="split-btn"><Btn variant="primary" icon={busy ? undefined : "play"} disabled={busy} onClick={() => build()}>{busy ? <><Spinner />Building</> : "Build all"}</Btn><Pop align="right" width={280} trigger={(_, t) => <Btn variant="primary" icon="chevDown" aria-label="More build options" disabled={busy} onClick={t} />}>{(close) => <div className="menu">
          {m && <button onClick={() => { close(); build(m.name); }}><Icon name="play" />Build {m.name}</button>}
          {m && downstream.length > 0 && <button onClick={() => { close(); build(m.name, false, true); }}><Icon name="lineage" />Build with {downstream.length} downstream</button>}
          {m?.materialized === "incremental" && <button onClick={() => { close(); build(m.name, true); }}><Icon name="refresh" />Rebuild in full</button>}
          <button onClick={() => { close(); setSelecting(true); }}><Icon name="filter" />Build selection</button>
        </div>}</Pop></span></>}
      </PageHead>
      <Tabs tabs={[...(m ? [["SQL", mk === "steps" ? "Query" : mk === "python" ? "Python" : mk === "seed" ? "CSV" : "SQL"] as [string, string], "Preview", "Checks", ...(mk === "python" ? [] : ["Settings"]), "Documentation"] : [["SQL", "Models"] as [string, string]]), "Lineage", ...(editable ? ["Project"] : [])]} value={tab} onChange={setTab} />
      {tab === "Project" ? <ProjectPanel models={models} /> : tab === "Lineage" ? <div className="body"><Lineage models={models} selected={m?.name} onPick={(n) => { setSel(models.find((x) => x.name === n)?.id); setTab("SQL"); }} /></div> : (
        !models.length ? <Empty icon="model" title="Create your first model" editor action={<Btn variant="primary" icon="plus" onClick={() => { setName(""); setKind("sql"); setAdding(true); }}>New model</Btn>}>Write SQL or Python, or build steps without code. Basalt builds them in dependency order and runs your checks.</Empty> : <Split id="models" width={240} label="Models">
          <aside className="tree">{models.map((x) => <button key={x.id} className={x.id === sel ? "on" : ""} onClick={() => setSel(x.id)}><Icon name={x.kind === "python" ? "code" : x.kind === "steps" ? "flow" : x.materialized === "view" || x.materialized === "ephemeral" ? "eye" : "table"} size={14} /><span>{x.name}</span>{statusOf(x.name) && statusOf(x.name) !== "success" && <span style={{ marginLeft: "auto" }}><StatusBadge s={statusOf(x.name)!} /></span>}</button>)}</aside>
          <section>
            {!m ? <Empty icon="model" title="Choose a model">Pick a model from the list to see and edit it.</Empty> : <>
              <div className="toolbar">
                <SplitToggle />
                <b>{m.name}</b>
                <span className="badge">{KINDS.find(([k]) => k === mk)?.[1]}</span>
                {mk !== "python" && mk !== "seed" && <Sel disabled={!editable} aria-label="Materialization" options={[["view", "Build as view"], ["table", "Build as table"], ["incremental", "Build incrementally"], ["snapshot", "Keep history (snapshot)"], ["ephemeral", "Ephemeral (not stored)"]]} value={m.materialized} onChange={(v) => up({ materialized: v as Model["materialized"] })} />}
                {m.materialized === "incremental" && <input disabled={!editable} className="input" type="number" min={0} style={{ width: 150 }} aria-label="Days to read again for late rows" title="Rows that arrive late carry an older date than what's already loaded. Reads this many days back on each build. Needs a unique key." placeholder="Late rows: days" value={m.lookbackDays ?? ""} onChange={(e) => up({ lookbackDays: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })} />}
                {(m.materialized === "incremental" || m.materialized === "snapshot") && <input disabled={!editable} className="input mono" style={{ width: 130 }} aria-label="Unique key column" placeholder={m.materialized === "snapshot" ? "Unique key" : "Unique key (optional)"} value={m.uniqueKey ?? ""} onChange={(e) => up({ uniqueKey: e.target.value.trim() || undefined })} />}
                {m.materialized === "incremental" && <input disabled={!editable} className="input mono" style={{ width: 130 }} aria-label="Cursor column" placeholder="Cursor column" value={m.cursor ?? ""} onChange={(e) => up({ cursor: e.target.value.trim() || undefined })} />}
                <div className="grow" />
                {editable && <MoreMenu label="Model actions">{(close) => <button onClick={() => { close(); setDel(true); }}><Icon name="trash" />Delete {m.name}</button>}</MoreMenu>}
              </div>
              {err && <div className="banner bad" style={{ margin: 12 }}><Icon name="warn" /><span className="mono">{err}</span></div>}
              {tab === "SQL" && mk === "seed" && <SeedEditor m={m} set={up} disabled={!editable} />}
              {tab === "Settings" && <ModelSettings m={m} set={up} disabled={!editable} admin={can("admin")} />}
              {tab === "SQL" && mk === "steps" && <QueryEditor key={m.id} m={m} models={models} tables={tables} set={up} disabled={!editable} />}
              {tab === "SQL" && mk === "python" && <div className="fill" style={{ minHeight: 360 }}>
                <div className="body" style={{ paddingBottom: 12, gap: 8 }}>
                  {!can("admin") && <div className="banner info"><Icon name="info" />Only admins can change Python code, because it runs directly on this server.</div>}
                  <details><summary style={{ cursor: "pointer", fontWeight: 500 }}>Input tables ({refsOf(m.sql).length + sourcesOf(m.sql).length})</summary>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 2, marginTop: 6, maxHeight: 190, overflow: "auto" }}>{baseOptions(models, m.name, tables).map(([v, l]) => { const ref = inputSql(v), on = m.sql.includes(ref); return <label key={v} className="check small"><input type="checkbox" disabled={!can("admin")} checked={on} onChange={(e) => up({ sql: e.target.checked ? `${m.sql}${ref}\n` : m.sql.replace(`${ref}\n`, "") })} />{l}</label>; })}</div></details>
                  <p className="small muted">Input tables already have personal data masked. Print output appears in the build result.</p>
                </div>
                <div style={{ flex: 1, minHeight: 240, overflow: "auto", borderTop: "1px solid var(--line)" }}><CodeMirror value={m.python ?? ""} readOnly={!can("admin")} onChange={(v) => up({ python: v, sql: syncPythonInputs(v, m.sql) })} extensions={pyExt} theme={cmTheme} style={{ height: "100%" }} height="100%" /></div>
              </div>}
              {tab === "SQL" && mk === "sql" && <div style={{ flex: 1, minHeight: 120, overflow: "auto" }}><CodeMirror value={m.sql} readOnly={!editable || (!!m.jinja && !can("admin"))} onChange={(v) => up({ sql: v })} extensions={completions} theme={cmTheme} style={{ height: "100%" }} height="100%" /></div>}
              {tab === "SQL" && mk !== "python" && mk !== "seed" && <details className="fold"><summary>Compiled SQL</summary><GrowUp id="compiled-sql" label="Compiled SQL" reserve={430}><pre className="code">{compiledText()}</pre></GrowUp></details>}
              {tab === "Preview" && <>{mk === "python" || mk === "seed" ? null : preview ? <><div className="toolbar"><Btn icon="refresh" onClick={runPreview}>Run preview again</Btn></div><div className="fill" style={{ minHeight: 280 }}><ResultGrid result={preview} /></div></> : <Empty icon="model" title="Preview this model" action={<Btn variant="primary" onClick={runPreview}>Run preview</Btn>}>Shows the first 200 rows without building anything.</Empty>}
                <details className="fold" open={mk === "python" || mk === "seed"}><summary>Last build result</summary><div className="tbl-wrap" style={{ marginTop: 8 }}><table className="tbl"><thead><tr><th>Step</th><th>Status</th><th>Message</th></tr></thead><tbody>{mine.map((r) => <tr key={r.unique_id}><td className="mono small">{r.unique_id}</td><td><StatusBadge s={r.status} /></td><td className="small" style={{ overflowWrap: "anywhere" }}>{r.message}</td></tr>)}{!mine.length && <tr><td colSpan={3} className="none">This model hasn&apos;t been built yet.</td></tr>}</tbody></table></div></details></>}
              {tab === "Checks" && <div className="body"><TestsEditor m={m} disabled={!editable} set={(t) => up({ tests: t })} /></div>}
              {tab === "Documentation" && <div className="body" style={{ maxWidth: 720 }}>
                <Field label="Description"><textarea disabled={!editable} className="input" rows={3} value={m.description} onChange={(e) => up({ description: e.target.value })} /></Field>
                <Field label="Owner"><input disabled={!editable} className="input" value={m.owner} onChange={(e) => up({ owner: e.target.value })} /></Field>
                <dl className="kv"><dt>Reads from</dt><dd className="mono small">{[...refsOf(m.sql), ...complete(m.sql)].join(", ") || "Nothing yet"}</dd><dt>Used by</dt><dd className="mono small">{downstream.join(", ") || "No other models"}</dd></dl>
                <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Column</th><th>Description</th></tr></thead><tbody>{(tables?.find((t) => t.full === `analytics.${m.name}`)?.columns ?? []).map((c) => <tr key={c.name}><td className="mono small">{c.name}</td><td><input disabled={!editable} aria-label={`Description of ${c.name}`} className="input" value={m.columnDocs?.[c.name] ?? ""} onChange={(e) => up({ columnDocs: { ...m.columnDocs, [c.name]: e.target.value } })} /></td></tr>)}{!tables?.some((t) => t.full === `analytics.${m.name}`) && <tr><td colSpan={2} className="none">Build this model to see columns.</td></tr>}</tbody></table></div>
              </div>}
            </>}
          </section>
        </Split>
      )}
      {adding && <Modal sheet title="New model" onClose={() => setAdding(false)} foot={<><Btn onClick={() => setAdding(false)}>Cancel</Btn><Btn variant="primary" disabled={!NAME.test(name) || models.some((x) => x.name === name)} onClick={() => { const id = uid(); patch((c) => ({ ...c, models: [...c.models, { id, name, description: "", kind, materialized: kind === "python" || kind === "seed" ? "table" : "view", sql: kind === "seed" || kind === "python" ? "" : "SELECT 1 AS id", tests: [], owner: useApp.getState().user!.name, ...(kind === "python" ? { python: PY_TEMPLATE } : {}), ...(kind === "steps" ? { steps: [] } : {}), ...(kind === "seed" ? { csv: "" } : {}) }] })); setSel(id); setAdding(false); setTab("SQL"); }}>Create model</Btn></>}>
        <Field label="Model name" hint="Lowercase letters, numbers and underscores, such as stg_customers" error={name && !NAME.test(name) ? "Start with a letter and use only lowercase letters, numbers and underscores." : models.some((x) => x.name === name) ? "A model with this name already exists." : undefined}><input className="input mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Build it with" hint={kind === "python" ? "Python runs directly on this server, so only admins can create it." : kind === "seed" ? "A small table you keep here as CSV." : kind === "steps" ? "Filter, join, group and calculate without writing code." : "One SELECT statement. Use {{ ref('model') }} and {{ source('connection', 'table') }}."}><Sel options={KINDS.filter(([k]) => k !== "python" || can("admin"))} value={kind} onChange={(v) => setKind(v as NonNullable<Model["kind"]>)} /></Field>
      </Modal>}
      {selecting && <Modal sheet title="Build selection" onClose={() => setSelecting(false)} foot={<><Btn onClick={() => setSelecting(false)}>Cancel</Btn><Btn variant="primary" icon="play" disabled={!select.trim() && !exclude.trim()} onClick={() => { setSelecting(false); setTab("SQL"); build(undefined, false, false, { select, exclude }); }}>Build</Btn></>}>
        <Field label="Select" hint="Such as +orders, orders+, 2+orders, @orders, tag:daily, source:app+, a b for either, a,b for both"><input className="input mono" autoFocus value={select} onChange={(e) => setSelect(e.target.value)} /></Field>
        <Field label="Exclude"><input className="input mono" value={exclude} onChange={(e) => setExclude(e.target.value)} /></Field>
      </Modal>}
      {del && m && <Confirm title={`Delete ${m.name}?`} action="Delete model" body={downstream.length ? `These models use it and will fail to build: ${downstream.join(", ")}.` : "This removes the definition. The built table stays in the warehouse until you drop it."} onYes={() => { patch((c) => ({ ...c, models: c.models.filter((x) => x.id !== m.id) })); setSel(models.find((x) => x.id !== m.id)?.id); }} onClose={() => setDel(false)} />}
    </>
  );
}
export default function Page() { return <Suspense><Models /></Suspense>; }
