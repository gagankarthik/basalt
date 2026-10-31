"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { Icon } from "@/components/icons";
import { Btn, Empty, Field, Modal, Sel, Spinner, Split, SplitToggle, StatusBadge, Tabs, toast, Upload } from "@/components/ui";
import { call, useApp, useIsDark, when } from "@/lib/client";
import type { ContractColumn, Exposure, FreshnessRule, Model, ModelTest, Project, SourceDef } from "@/lib/types";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });
const NAME = /^[A-Za-z_]\w*$/;

/** The options dbt adds to a check. */
export function TestOptions({ t, up, disabled }: { t: ModelTest; up: (p: Partial<ModelTest>) => void; disabled: boolean }) {
  return <>
    <Sel disabled={disabled} aria-label="Severity" options={[["error", "Severity: error"], ["warn", "Severity: warn"]]} value={t.severity ?? "error"} onChange={(v) => up({ severity: v as ModelTest["severity"] })} />
    {(t.severity ?? "error") === "error" && <input disabled={disabled} className="input mono" aria-label="Fail if" placeholder="Fail if, such as > 10" style={{ width: 150 }} value={t.errorIf ?? ""} onChange={(e) => up({ errorIf: e.target.value || undefined })} />}
    <input disabled={disabled} className="input mono" aria-label="Warn if" placeholder="Warn if, such as > 0" style={{ width: 150 }} value={t.warnIf ?? ""} onChange={(e) => up({ warnIf: e.target.value || undefined })} />
    <input disabled={disabled} className="input mono" aria-label="Only rows where" placeholder="Only rows where" style={{ width: 160 }} value={t.where ?? ""} onChange={(e) => up({ where: e.target.value || undefined })} />
    <label className="check small"><input type="checkbox" disabled={disabled} checked={!!t.storeFailures} onChange={(e) => up({ storeFailures: e.target.checked })} />Store failures</label>
  </>;
}

/** Tags, incremental and snapshot options, hooks and the contract for one model. */
export function ModelSettings({ m, set, disabled, admin }: { m: Model; set: (p: Partial<Model>) => void; disabled: boolean; admin: boolean }) {
  const contract = m.contract ?? [], upC = (i: number, p: Partial<ContractColumn>) => set({ contract: contract.map((c, k) => (k === i ? { ...c, ...p } : c)) });
  return <div className="body" style={{ maxWidth: 820 }}>
    <Field label="Tags"><input disabled={disabled} className="input" value={(m.tags ?? []).join(", ")} onChange={(e) => set({ tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></Field>
    {m.materialized === "incremental" && <>
      <Field label="Incremental strategy"><Sel disabled={disabled} options={[["", "Cursor column only"], ["merge", "merge"], ["delete+insert", "delete+insert"], ["append", "append"]]} value={m.incrementalStrategy ?? ""} onChange={(v) => set({ incrementalStrategy: (v || undefined) as Model["incrementalStrategy"] })} /></Field>
      <Field label="On schema change"><Sel disabled={disabled} options={["ignore", "append_new_columns", "sync_all_columns", "fail"]} value={m.onSchemaChange ?? "ignore"} onChange={(v) => set({ onSchemaChange: v === "ignore" ? undefined : v as Model["onSchemaChange"] })} /></Field>
    </>}
    {m.materialized === "snapshot" && <>
      <Field label="Snapshot strategy"><Sel disabled={disabled} options={[["", "Compare every column (_valid_from, _valid_to)"], ["timestamp", "timestamp"], ["check", "check"]]} value={m.snapshotStrategy ?? ""} onChange={(v) => set({ snapshotStrategy: (v || undefined) as Model["snapshotStrategy"] })} /></Field>
      {m.snapshotStrategy && <Field label="Updated at column"><input disabled={disabled} className="input mono" value={m.updatedAt ?? ""} onChange={(e) => set({ updatedAt: e.target.value.trim() || undefined })} /></Field>}
      {m.snapshotStrategy === "check" && <Field label="Check columns"><input disabled={disabled} className="input mono" placeholder="all" value={m.checkCols ?? ""} onChange={(e) => set({ checkCols: e.target.value || undefined })} /></Field>}
      {m.snapshotStrategy && <Field label="Rows removed from the source"><Sel disabled={disabled} options={[["ignore", "Leave as current"], ["invalidate", "Close the row"]]} value={m.hardDeletes ?? "ignore"} onChange={(v) => set({ hardDeletes: v === "ignore" ? undefined : "invalidate" })} /></Field>}
    </>}
    <Field label="Before build, one statement per line"><textarea disabled={disabled} className="input mono" rows={2} value={(m.preHook ?? []).join("\n")} onChange={(e) => set({ preHook: e.target.value ? e.target.value.split("\n") : undefined })} /></Field>
    <Field label="After build, one statement per line"><textarea disabled={disabled} className="input mono" rows={2} value={(m.postHook ?? []).join("\n")} onChange={(e) => set({ postHook: e.target.value ? e.target.value.split("\n") : undefined })} /></Field>
    {admin && m.kind !== "seed" && <label className="check small"><input type="checkbox" checked={!!m.jinja} onChange={(e) => set({ jinja: e.target.checked || undefined })} />Full Jinja through dbt (admins only)</label>}
    {m.materialized !== "snapshot" && m.materialized !== "ephemeral" && m.kind !== "seed" && <>
      <div className="section-title">Contract</div>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Column</th><th>Data type</th><th>Not null</th><th>Unique</th><th>Primary key</th><th /></tr></thead><tbody>
        {contract.map((c, i) => <tr key={i}>
          <td><input disabled={disabled} aria-label="Column" className="input mono" value={c.name} onChange={(e) => upC(i, { name: e.target.value })} /></td>
          <td><input disabled={disabled} aria-label="Data type" className="input mono" value={c.type} onChange={(e) => upC(i, { type: e.target.value })} /></td>
          <td><input disabled={disabled} aria-label="Not null" type="checkbox" checked={!!c.notNull} onChange={(e) => upC(i, { notNull: e.target.checked })} /></td>
          <td><input disabled={disabled} aria-label="Unique" type="checkbox" checked={!!c.unique} onChange={(e) => upC(i, { unique: e.target.checked })} /></td>
          <td><input disabled={disabled} aria-label="Primary key" type="checkbox" checked={!!c.primaryKey} onChange={(e) => upC(i, { primaryKey: e.target.checked })} /></td>
          <td>{!disabled && <Btn icon="x" variant="ghost" aria-label={`Remove ${c.name}`} onClick={() => { const n = contract.filter((_, k) => k !== i); set({ contract: n.length ? n : undefined }); }} />}</td>
        </tr>)}
        {!contract.length && <tr><td colSpan={6} className="none">No contract on this model.</td></tr>}
      </tbody></table></div>
      {!disabled && <div><Btn icon="plus" onClick={() => set({ contract: [...contract, { name: "", type: "" }] })}>Add column</Btn></div>}
    </>}
  </div>;
}

export function SeedEditor({ m, set, disabled }: { m: Model; set: (p: Partial<Model>) => void; disabled: boolean }) {
  const load = async (f?: File) => { if (!f) return; if (f.size > 1000000) { toast("A seed can be up to 1 MB. Use a file import for larger data.", true); return; } set({ csv: await f.text() }); };
  return <div className="body" style={{ flex: 1 }}>
    {!disabled && <div><Upload label="Load a CSV file" accept=".csv,text/csv" onFiles={(f) => load(f[0])} /></div>}
    <textarea disabled={disabled} aria-label="CSV data" className="input mono" style={{ minHeight: 320, flex: 1 }} value={m.csv ?? ""} onChange={(e) => set({ csv: e.target.value })} />
  </div>;
}

/* ---- project-wide ---- */
type Docs = { engine: string; manifest: { nodes: Record<string, DocNode>; sources: Record<string, DocNode>; exposures: Record<string, DocNode>; parent_map: Record<string, string[]>; child_map: Record<string, string[]> }; catalog: { nodes: Record<string, { columns: Record<string, { name: string; type: string }> }>; sources: Record<string, { columns: Record<string, { name: string; type: string }> }> } };
type DocNode = { unique_id: string; name: string; resource_type?: string; description?: string; tags?: string[]; config?: Record<string, unknown>; compiled_code?: string | null; columns?: Record<string, { name: string; description?: string; data_type?: string | null }>; meta?: { owner?: string }; owner?: { name?: string } };
type Fresh = { results?: { unique_id: string; status: string; max_loaded_at?: string; max_loaded_at_time_ago_in_s?: number | null }[]; checkedAt?: string };
const ruleText = (r?: FreshnessRule) => (r ? `${r.count} ${r.period}${r.count === 1 ? "" : "s"}` : "None");
const download = (name: string, data: unknown) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" })); a.download = name; a.click(); URL.revokeObjectURL(a.href); };

function RuleInput({ label, value, set }: { label: string; value?: FreshnessRule; set: (r?: FreshnessRule) => void }) {
  return <Field label={label}><div style={{ display: "flex", gap: 6 }}>
    <input className="input" type="number" min={1} aria-label={`${label} count`} value={value?.count ?? ""} onChange={(e) => set(e.target.value ? { count: Math.max(1, Number(e.target.value)), period: value?.period ?? "hour" } : undefined)} />
    <Sel aria-label={`${label} period`} options={["minute", "hour", "day"]} value={value?.period ?? "hour"} onChange={(v) => value && set({ ...value, period: v as FreshnessRule["period"] })} />
  </div></Field>;
}

export function ProjectPanel({ models }: { models: Model[] }) {
  const { config, patch, can } = useApp();
  const project: Project = useMemo(() => config!.project ?? {}, [config]), editable = can("editor"), admin = can("admin");
  const save = (p: Partial<Project>) => patch((c) => ({ ...c, project: { ...c.project, ...p } }));
  const [tab, setTab] = useState("Variables"), [engine, setEngine] = useState<{ dbt: string | null; configured: boolean; freshness: Fresh | null } | null>(null), [busy, setBusy] = useState(false), [fresh, setFresh] = useState<Fresh | null>(null), [docs, setDocs] = useState<Docs | null>(null), [node, setNode] = useState(""), [addSource, setAddSource] = useState<SourceDef | null>(null), [addExp, setAddExp] = useState<Exposure | null>(null), [varName, setVarName] = useState("");
  useEffect(() => { call<{ dbt: string | null; configured: boolean; freshness: Fresh | null }>("/api/dbt").then((e) => { setEngine(e); setFresh(e.freshness); }).catch(() => {}); }, []);
  const sqlExt = useMemo(() => [sqlLang({ upperCaseKeywords: true })], []), theme = useIsDark() ? "dark" : "light";
  const vars = project.vars ?? {}, sources = project.sources ?? [], exposures = project.exposures ?? [];
  const checkFresh = async () => { setBusy(true); try { const r = await call<Fresh>("/api/dbt", { json: { kind: "freshness" } }); setFresh({ ...r, checkedAt: new Date().toISOString() }); } catch (e) { toast((e as Error).message, true); } setBusy(false); };
  const genDocs = async () => { setBusy(true); try { const r = await call<Docs>("/api/dbt", { json: { kind: "docs" } }); setDocs(r); setNode(Object.keys(r.manifest.nodes).find((k) => !k.startsWith("test.")) ?? ""); } catch (e) { toast((e as Error).message, true); } setBusy(false); };
  const allNodes = docs ? { ...docs.manifest.nodes, ...docs.manifest.sources, ...docs.manifest.exposures } : {};
  const cur = allNodes[node], curCols = docs ? (docs.catalog.nodes[node] ?? docs.catalog.sources[node])?.columns ?? {} : {};
  const columnRows = cur ? [...new Set([...Object.keys(curCols), ...Object.keys(cur.columns ?? {})])] : [];
  const addVar = () => { save({ vars: { ...vars, [varName]: "" } }); setVarName(""); };
  const statusOf = (s: SourceDef) => fresh?.results?.find((r) => r.unique_id === `source.basalt.${s.source}.${s.table}`);

  return <>
    <div className="toolbar">
      <span className="small muted">Engine</span><b className="small">{engine?.dbt ? `dbt ${engine.dbt}` : "Built-in"}</b>
    </div>
    {engine?.configured && !engine.dbt && <div className="banner bad" style={{ margin: 12 }}><Icon name="warn" />dbt couldn&apos;t start, so the built-in builder is doing the work. Contact your administrator.</div>}
    <Tabs tabs={["Variables", "Macros", "Sources", "Exposures", "Docs"]} value={tab} onChange={setTab} />
    {tab === "Variables" && <div className="body" style={{ maxWidth: 760 }}>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Value</th><th /></tr></thead><tbody>
        {Object.entries(vars).map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td><input disabled={!editable} aria-label={`Value of ${k}`} className="input mono" value={typeof v === "string" ? v : JSON.stringify(v)} onChange={(e) => { let next: unknown = e.target.value; try { next = JSON.parse(e.target.value); } catch { /* plain text */ } save({ vars: { ...vars, [k]: next } }); }} /></td><td>{editable && <Btn icon="x" variant="ghost" aria-label={`Remove ${k}`} onClick={() => { const n = { ...vars }; delete n[k]; save({ vars: n }); }} />}</td></tr>)}
        {!Object.keys(vars).length && <tr><td colSpan={3} className="none">No variables yet.</td></tr>}
      </tbody></table></div>
      {editable && <div style={{ display: "flex", gap: 6 }}><input className="input mono" aria-label="New variable name" placeholder="Variable name" value={varName} onChange={(e) => setVarName(e.target.value)} /><Btn icon="plus" disabled={!NAME.test(varName) || varName in vars} onClick={addVar}>Add variable</Btn></div>}
    </div>}
    {tab === "Macros" && <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 320 }}>
      <div style={{ flex: 1, minHeight: 280, overflow: "auto" }}><CodeMirror aria-label="Macros" value={project.macros ?? ""} readOnly={!editable} onChange={(v) => save({ macros: v })} extensions={sqlExt} theme={theme} style={{ height: "100%" }} height="100%" placeholder="{% macro cents(column) %}({{ column }} * 100){% endmacro %}" /></div>
      {admin && engine?.dbt && <><div className="section-title" style={{ padding: "8px 12px" }}>Full Jinja macros, used by dbt only</div><div style={{ flex: 1, minHeight: 200, overflow: "auto", borderTop: "1px solid var(--line)" }}><CodeMirror aria-label="Full Jinja macros" value={project.dbtMacros ?? ""} onChange={(v) => save({ dbtMacros: v })} extensions={sqlExt} theme={theme} style={{ height: "100%" }} height="100%" /></div></>}
    </div>}
    {tab === "Sources" && <div className="body">
      <div className="toolbar" style={{ padding: 0 }}>
        {editable && <Btn icon="plus" onClick={() => setAddSource({ source: config!.connections[0]?.slug ?? "", table: "" })}>Add source</Btn>}
        <div className="grow" />
        {fresh?.checkedAt && <span className="small muted">Checked {when(fresh.checkedAt)}</span>}
        {editable && <Btn disabled={busy || !sources.some((s) => s.warnAfter || s.errorAfter)} onClick={checkFresh}>{busy ? <><Spinner />Checking</> : "Check freshness"}</Btn>}
      </div>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Source</th><th>Loaded at</th><th>Warn after</th><th>Error after</th><th>Latest data</th><th>Status</th><th /></tr></thead><tbody>
        {sources.map((s, i) => { const r = statusOf(s); return <tr key={`${s.source}.${s.table}`}><td className="mono small">{s.source}.{s.table}</td><td className="mono small">{s.loadedAtField || "_basalt_synced_at"}</td><td>{ruleText(s.warnAfter)}</td><td>{ruleText(s.errorAfter)}</td><td className="small">{r?.max_loaded_at ?? ""}</td><td>{r && <StatusBadge s={r.status} />}</td><td>{editable && <Btn icon="trash" variant="ghost" aria-label={`Remove ${s.table}`} onClick={() => save({ sources: sources.filter((_, k) => k !== i) })} />}</td></tr>; })}
        {!sources.length && <tr><td colSpan={7} className="none">No sources defined yet.</td></tr>}
      </tbody></table></div>
    </div>}
    {tab === "Exposures" && <div className="body">
      {editable && <div><Btn icon="plus" onClick={() => setAddExp({ name: "", type: "dashboard", ownerName: "", dependsOn: [] })}>Add exposure</Btn></div>}
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Type</th><th>Owner</th><th>Maturity</th><th>Depends on</th><th /></tr></thead><tbody>
        {exposures.map((x, i) => <tr key={x.name}><td className="mono small">{x.url ? <a className="link" href={x.url} target="_blank" rel="noreferrer noopener">{x.name}</a> : x.name}</td><td>{x.type}</td><td>{x.ownerName}</td><td>{x.maturity ?? ""}</td><td className="mono small">{x.dependsOn.join(", ")}</td><td>{editable && <Btn icon="trash" variant="ghost" aria-label={`Remove ${x.name}`} onClick={() => save({ exposures: exposures.filter((_, k) => k !== i) })} />}</td></tr>)}
        {!exposures.length && <tr><td colSpan={6} className="none">No exposures defined yet.</td></tr>}
      </tbody></table></div>
    </div>}
    {tab === "Docs" && (!docs ? <Empty icon="info" title="Generate the project docs" action={<Btn variant="primary" disabled={busy} onClick={genDocs}>{busy ? <><Spinner />Generating</> : "Generate docs"}</Btn>}>Lists every model, source and exposure with its columns and what it depends on.</Empty> : <Split id="dbt-docs" width={260} label="Nodes">
      <aside className="tree" aria-label="Nodes">{[["Models", docs.manifest.nodes], ["Sources", docs.manifest.sources], ["Exposures", docs.manifest.exposures]].map(([label, group]) => <div key={label as string}><div className="section-title">{label as string}</div>{Object.values(group as Record<string, DocNode>).filter((n) => n.resource_type !== "test").map((n) => <button type="button" key={n.unique_id} className={n.unique_id === node ? "on" : ""} onClick={() => setNode(n.unique_id)}><span className="mono">{n.name}</span></button>)}</div>)}</aside>
      <section>
        <div className="toolbar"><SplitToggle /><span className="badge">{docs.engine}</span><div className="grow" /><Btn disabled={busy} onClick={genDocs}>Regenerate</Btn><Btn icon="download" onClick={() => download("manifest.json", docs.manifest)}>manifest.json</Btn><Btn icon="download" onClick={() => download("catalog.json", docs.catalog)}>catalog.json</Btn></div>
        {cur && <div className="body">
          <h2 className="mono">{cur.name}</h2>
          {cur.description && <p>{cur.description}</p>}
          <dl className="kv"><dt>Type</dt><dd>{cur.resource_type ?? "source"}{cur.config?.materialized ? `, ${String(cur.config.materialized)}` : ""}</dd><dt>Owner</dt><dd>{cur.meta?.owner || cur.owner?.name || "None"}</dd><dt>Tags</dt><dd>{cur.tags?.join(", ") || "None"}</dd><dt>Depends on</dt><dd className="mono small">{(docs.manifest.parent_map[node] ?? []).join(", ") || "Nothing"}</dd><dt>Used by</dt><dd className="mono small">{(docs.manifest.child_map[node] ?? []).join(", ") || "Nothing"}</dd></dl>
          <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Column</th><th>Type</th><th>Description</th></tr></thead><tbody>
            {columnRows.map((c) => <tr key={c}><td className="mono small">{c}</td><td className="mono small">{curCols[c]?.type ?? cur.columns?.[c]?.data_type ?? ""}</td><td>{cur.columns?.[c]?.description ?? ""}</td></tr>)}
            {!columnRows.length && <tr><td colSpan={3} className="none">Build this model to see its columns.</td></tr>}
          </tbody></table></div>
          {cur.compiled_code && <pre className="code">{cur.compiled_code}</pre>}
        </div>}
      </section>
    </Split>)}
    {addSource && <Modal sheet title="Add source" onClose={() => setAddSource(null)} foot={<><Btn onClick={() => setAddSource(null)}>Cancel</Btn><Btn variant="primary" disabled={!NAME.test(addSource.source) || !NAME.test(addSource.table) || sources.some((s) => s.source === addSource.source && s.table === addSource.table)} onClick={() => { save({ sources: [...sources, addSource] }); setAddSource(null); }}>Add source</Btn></>}>
      <Field label="Connection"><Sel options={config!.connections.map((c): [string, string] => [c.slug, c.name])} value={addSource.source} onChange={(v) => setAddSource({ ...addSource, source: v })} /></Field>
      <Field label="Table"><input autoFocus className="input mono" value={addSource.table} onChange={(e) => setAddSource({ ...addSource, table: e.target.value })} /></Field>
      <Field label="Description"><input className="input" value={addSource.description ?? ""} onChange={(e) => setAddSource({ ...addSource, description: e.target.value })} /></Field>
      <Field label="Loaded at column"><input className="input mono" placeholder="_basalt_synced_at" value={addSource.loadedAtField ?? ""} onChange={(e) => setAddSource({ ...addSource, loadedAtField: e.target.value.trim() || undefined })} /></Field>
      <RuleInput label="Warn after" value={addSource.warnAfter} set={(r) => setAddSource({ ...addSource, warnAfter: r })} />
      <RuleInput label="Error after" value={addSource.errorAfter} set={(r) => setAddSource({ ...addSource, errorAfter: r })} />
      <Field label="Only rows where"><input className="input mono" value={addSource.filter ?? ""} onChange={(e) => setAddSource({ ...addSource, filter: e.target.value || undefined })} /></Field>
    </Modal>}
    {addExp && <Modal sheet title="Add exposure" onClose={() => setAddExp(null)} foot={<><Btn onClick={() => setAddExp(null)}>Cancel</Btn><Btn variant="primary" disabled={!NAME.test(addExp.name) || !addExp.ownerName.trim() || !addExp.dependsOn.length || exposures.some((x) => x.name === addExp.name)} onClick={() => { save({ exposures: [...exposures, addExp] }); setAddExp(null); }}>Add exposure</Btn></>}>
      <Field label="Name"><input autoFocus className="input mono" value={addExp.name} onChange={(e) => setAddExp({ ...addExp, name: e.target.value })} /></Field>
      <Field label="Type"><Sel options={["dashboard", "notebook", "analysis", "ml", "application"]} value={addExp.type} onChange={(v) => setAddExp({ ...addExp, type: v as Exposure["type"] })} /></Field>
      <Field label="Owner"><input className="input" value={addExp.ownerName} onChange={(e) => setAddExp({ ...addExp, ownerName: e.target.value })} /></Field>
      <Field label="Owner email"><input className="input" type="email" value={addExp.ownerEmail ?? ""} onChange={(e) => setAddExp({ ...addExp, ownerEmail: e.target.value || undefined })} /></Field>
      <Field label="URL"><input className="input" type="url" value={addExp.url ?? ""} onChange={(e) => setAddExp({ ...addExp, url: e.target.value || undefined })} /></Field>
      <Field label="Maturity"><Sel options={[["", "Not set"], ["low", "low"], ["medium", "medium"], ["high", "high"]]} value={addExp.maturity ?? ""} onChange={(v) => setAddExp({ ...addExp, maturity: (v || undefined) as Exposure["maturity"] })} /></Field>
      <div className="field"><span className="lab">Depends on</span><div style={{ display: "grid", gap: 2, maxHeight: 200, overflow: "auto" }}>{models.map((x) => <label key={x.id} className="check small"><input type="checkbox" checked={addExp.dependsOn.includes(x.name)} onChange={(e) => setAddExp({ ...addExp, dependsOn: e.target.checked ? [...addExp.dependsOn, x.name] : addExp.dependsOn.filter((d) => d !== x.name) })} /><span className="mono">{x.name}</span></label>)}</div></div>
      <Field label="Description"><textarea className="input" rows={2} value={addExp.description ?? ""} onChange={(e) => setAddExp({ ...addExp, description: e.target.value || undefined })} /></Field>
    </Modal>}
  </>;
}

