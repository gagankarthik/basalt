"use client";
import Link from "next/link";
import { Lineage } from "@/components/Lineage";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ResultGrid } from "@/components/DataGrid";
import DataTable from "@/components/DataTable";
import { Icon } from "@/components/icons";
import { Btn, Empty, Modal, NoResults, PageHead, Sk, Tabs, Split } from "@/components/ui";
import { ExportDialog } from "@/components/CloudDialogs";
import { fmt, useApp, useQuery, useTables } from "@/lib/client";
import { refsOf, sourcesOf } from "@/lib/graph";
import { stageOf, STAGES, viewerMayRead, type Stage } from "@/lib/semantic";
import { table } from "@/lib/sql";

const stageRank = (schema: string, list: { schema: string; name: string }[], models: { name: string; generated?: boolean }[]) => { const t = list.find((x) => x.schema === schema)!; return STAGES.findIndex(([id]) => id === stageOf(t.schema, t.name, models)); };
type ColRow = { name: string; type: string; rule?: string; empty: number | null; unique: number | null; min: string; max: string; avg: number | null };

function Detail({ full, onOpen }: { full: string; onOpen: (table: string) => void }) {
  const tables = useTables(), config = useApp((s) => s.config)!, can = useApp((s) => s.can), [exporting, setExporting] = useState(false);
  const [tab, setTab] = useState("Columns");
  const t = tables?.find((x) => x.full === full);
  const count = useQuery(`SELECT count(*) n FROM ${table(full)}`, [full]);
  const profile = useQuery(tab === "Columns" ? `SUMMARIZE SELECT * FROM ${table(full)}` : null, [full, tab]);
  const preview = useQuery(tab === "Preview" ? `SELECT * FROM ${table(full)} LIMIT 200` : null, [full, tab]);
  if (!t) return null;
  const model = t.schema === "analytics" ? config.models.find((m) => m.name === t.name) : undefined;
  const pipeline = config.pipelines.find((p) => { const c = config.connections.find((x) => x.id === p.connectionId); return c && t.schema === `raw_${c.slug}`; });
  const rules = pipeline?.streams.find((s) => s.name === t.name)?.rules ?? {};
  const upstream = model ? [...refsOf(model.sql), ...sourcesOf(model.sql)] : [];
  const downstream = config.models.filter((m) => (t.schema === "analytics" ? refsOf(m.sql).includes(t.name) : sourcesOf(m.sql).includes(full))).map((m) => m.name);
  const usedDash = config.dashboards.filter((d) => d.widgets.some((w) => w.table === full));
  const prof = new Map((profile.data?.rows ?? []).map((r) => [String(r.column_name), r]));
  const num = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  const colRows: ColRow[] = t.columns.map((c) => { const x = prof.get(c.name), r = rules[c.name]; return { name: c.name, type: c.type, rule: r && r !== "keep" ? r : undefined, empty: num(x?.null_percentage), unique: num(x?.approx_unique), min: String(x?.min ?? ""), max: String(x?.max ?? ""), avg: num(x?.avg) }; });
  return (
    <>
      {exporting && <ExportDialog table={full} onClose={() => setExporting(false)} />}
      <PageHead title={full}><Link className="btn" href={`/explore?table=${encodeURIComponent(full)}`}>Open in data views</Link>{can("editor") && <Btn icon="upload" variant="primary" onClick={() => setExporting(true)}>Export</Btn>}</PageHead>
      <dl className="detail-row"><div><dt>Layer</dt><dd>{STAGES.find(([id]) => id === stageOf(t.schema, t.name, config.models))?.[1]}</dd></div><div><dt>Type</dt><dd>{t.type === "VIEW" ? "View" : "Table"}</dd></div><div><dt>Rows</dt><dd className="num">{count.data ? fmt(count.data.rows[0].n) : "Counting"}</dd></div><div><dt>Viewers</dt><dd>{viewerMayRead(config.semantic, stageOf(t.schema, t.name, config.models)) ? "Can read" : "Closed"}</dd></div><div><dt>In model</dt><dd>{config.semantic?.tables.some((x) => x.full === full) ? "Yes" : "No"}</dd></div></dl>
      <Tabs tabs={["Columns", "Preview", "Lineage"]} value={tab} onChange={setTab} />
      {tab === "Columns" && <div className="body"><DataTable<ColRow> id="catalog-columns" rows={colRows} rowKey={(c) => c.name} selectable={false} searchPlaceholder="Search columns" defaultPageSize={50}
        filters={[{ id: "type", label: "Type", value: (c) => c.type }, { id: "protection", label: "Protection", value: (c) => c.rule ?? "None" }, { id: "empty", label: "Empty values", value: (c) => (c.empty == null ? null : c.empty > 0 ? "Has empty values" : "None empty") }]}
        columns={[
          { id: "name", header: "Column", width: 240, hideable: false, sticky: true, sortValue: (c) => c.name, searchValue: (c) => c.name, cell: (c) => <b className="cell-strong">{c.name}</b> },
          { id: "type", header: "Type", width: 150, sortValue: (c) => c.type, searchValue: (c) => c.type, cell: (c) => <span className="small muted">{c.type}</span> },
          { id: "protection", header: "Protection", width: 130, sortValue: (c) => c.rule ?? "", cell: (c) => (c.rule ? <span className="badge warn"><Icon name="shield" size={12} />{c.rule}</span> : null) },
          { id: "empty", header: "Empty", width: 90, align: "end", sortValue: (c) => c.empty, cell: (c) => (c.empty != null ? `${c.empty.toFixed(1)}%` : <Sk w={40} />) },
          { id: "unique", header: "Unique (approx.)", width: 140, align: "end", sortValue: (c) => c.unique, cell: (c) => (c.unique != null ? fmt(c.unique) : "") },
          { id: "min", header: "Lowest", width: 190, sortValue: (c) => c.min, cell: (c) => <span className="small">{c.min}</span> },
          { id: "max", header: "Highest", width: 190, sortValue: (c) => c.max, cell: (c) => <span className="small">{c.max}</span> },
          { id: "avg", header: "Average", width: 120, align: "end", sortValue: (c) => c.avg, cell: (c) => (c.avg != null ? fmt(c.avg) : "") },
        ]} />{profile.error && <div className="banner warn"><Icon name="warn" />{profile.error}</div>}</div>}
      {tab === "Preview" && (preview.data ? <div className="fill" style={{ minHeight: 320 }}><ResultGrid result={preview.data} /></div> : preview.error ? <div className="banner bad" style={{ margin: 16 }}>{preview.error}</div> : <div className="body"><Sk h={200} /></div>)}
      {tab === "Lineage" && <div className="body">
        <Lineage focus models={config.models} selected={t.schema === "analytics" ? t.name : full} onPick={(n) => onOpen(n.includes(".") ? n : `analytics.${n}`)} />
        <dl className="kv">
        <dt>Comes from</dt><dd className="mono small">{pipeline ? `Pipeline: ${pipeline.name}` : upstream.join(", ") || "Not tracked"}</dd>
        <dt>Used by models</dt><dd className="mono small">{downstream.join(", ") || "None"}</dd>
        <dt>Used by dashboards</dt><dd>{usedDash.length ? usedDash.map((d, i) => <span key={d.id}>{i > 0 && ", "}<Link className="link" href={`/dashboards/${d.id}`}>{d.name}</Link></span>) : "None"}</dd>
      </dl><p className="small muted">The full graph is on the Lineage tab in <Link className="link" href="/models">Models</Link>.</p></div>}
    </>
  );
}

/** Who can read each layer of the warehouse, from the rules that actually run. */
function Layers({ onClose }: { onClose: () => void }) {
  const tables = useTables(), config = useApp((s) => s.config)!, patch = useApp((s) => s.patch), admin = useApp((s) => s.can)("admin");
  const rows = STAGES.map(([id, name]) => { const list = (tables ?? []).filter((t) => stageOf(t.schema, t.name, config.models) === id); return { id, name, list, schemas: [...new Set(list.map((t) => t.schema))] }; }).filter((r) => r.list.length || r.id !== "other");
  const toggle = (s: Stage, on: boolean) => patch((c) => ({ ...c, semantic: { tables: [], relationships: [], ...c.semantic, viewerStages: { ...c.semantic?.viewerStages, [s]: on } } }));
  return <Modal full title="Data layers" onClose={onClose}>
    <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Layer</th><th>Schemas</th><th className="r">Tables</th><th>Admins and editors</th><th>Viewers</th></tr></thead><tbody>{rows.map((r) => { const open = viewerMayRead(config.semantic, r.id); return <tr key={r.id}><td><b>{r.name}</b></td><td className="mono small">{r.schemas.join(", ")}</td><td className="r">{r.list.length}</td><td>Read and change</td><td><label className="check"><input type="checkbox" aria-label={`Viewers can read ${r.name}`} disabled={!admin} checked={open} onChange={(e) => toggle(r.id, e.target.checked)} />{open ? "Read, within their row rules and revoked tables" : "No access"}</label></td></tr>; })}</tbody></table></div>
  </Modal>;
}

function Catalog() {
  const tables = useTables(), pre = useSearchParams();
  const [sel, setSel] = useState(pre.get("t")), [find, setFind] = useState(""), [closed, setClosed] = useState<Record<string, boolean>>({});
  const list = (tables ?? []).filter((t) => t.full.toLowerCase().includes(find.toLowerCase()) || t.columns.some((c) => c.name.toLowerCase().includes(find.toLowerCase())));
  const cur = (sel && list.some((t) => t.full === sel) ? sel : list[0]?.full), models = useApp((s) => s.config)!.models, [layers, setLayers] = useState(false);
  if (tables && !tables.length) return <><PageHead title="Data catalog" /><Empty icon="catalog" title="The warehouse is empty" editor action={<Link className="btn primary" href="/pipelines">Run a sync</Link>}>Run a pipeline to copy your first tables here.</Empty></>;
  return (
    <Split id="catalog" width={240} label="Tables">
      <aside><div style={{ padding: 8 }}><input className="input" style={{ width: "100%" }} type="search" placeholder="Find a table or column" aria-label="Find a table or column" value={find} onChange={(e) => setFind(e.target.value)} /><Btn icon="db" style={{ width: "100%", marginTop: 8 }} onClick={() => setLayers(true)}>Data layers</Btn></div>
        {layers && <Layers onClose={() => setLayers(false)} />}
        <div className="tree">{!tables && <div style={{ padding: 10 }}><Sk /></div>}
          {[...new Set(list.map((t) => t.schema))].sort((a, b) => stageRank(a, list, models) - stageRank(b, list, models)).map((s) => <div key={s}><button onClick={() => setClosed({ ...closed, [s]: !closed[s] })}><Icon name={closed[s] ? "chevRight" : "chevDown"} size={12} /><span><b>{s}</b></span></button>
            {!closed[s] && list.filter((t) => t.schema === s).map((t) => <button key={t.full} className={`lvl2 ${t.full === cur ? "on" : ""}`} onClick={() => setSel(t.full)}><Icon name={t.type === "VIEW" ? "eye" : "table"} size={13} /><span>{t.name}</span></button>)}</div>)}
        </div></aside>
      <section>{cur ? <Detail key={cur} full={cur} onOpen={setSel} /> : tables ? <><PageHead title="Data catalog" /><NoResults what="tables or columns" onClear={() => setFind("")} /></> : null}</section>
    </Split>
  );
}
export default function Page() { return <Suspense><Catalog /></Suspense>; }
