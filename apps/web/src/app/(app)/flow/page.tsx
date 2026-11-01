"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { FlowGraph, type FlowNode } from "@/components/Lineage";
import { Icon, Logo, type BrandName, type IconName } from "@/components/icons";
import { Btn, Empty, ErrorState, Field, GoLink, LoadingTable, PageHead, Sel, Spinner, StatusBadge, Tabs, toast } from "@/components/ui";
import { call, refreshTables, took, useApp, when } from "@/lib/client";
import { lineage } from "@/lib/graph";
import type { Connection, Pipeline, Run } from "@/lib/types";

type Scheduled = { id: string; table: string; format: string; connectionId: string; path?: string; every: number; lastAt?: string; lastError?: string };
type Result = { unique_id: string; status: string; message?: string | null };
type Row = [string, ReactNode];
type Look = Pick<FlowNode, "status" | "statusIcon" | "tone">;
const EVERY: [string, string][] = [["0", "Manual only"], ["15", "Every 15 minutes"], ["60", "Every hour"], ["360", "Every 6 hours"], ["1440", "Every day"]];
const label = (mins: number) => EVERY.find(([v]) => Number(v) === mins)?.[1] ?? `Every ${mins} minutes`;
// Same logos as the connections page
const LOGOS: Partial<Record<Connection["type"], BrandName>> = { s3: "s3", gcs: "gcs", azure: "azure", bigquery: "bigquery", snowflake: "snowflake", postgres: "postgres", mysql: "mysql" };
const connGlyph = (c?: Connection, fallback: IconName = "db") => { const l = c && LOGOS[c.type]; return l ? <Logo name={l} size={20} /> : <Icon name={c?.type === "file" ? "file" : fallback} size={20} />; };
const glyph = (name: IconName) => <Icon name={name} size={20} />;
const waiting = (status: string): Look => ({ status, statusIcon: "clock" });
const LOOK: Record<string, Look> = {
  succeeded: { status: "Succeeded", statusIcon: "check", tone: "good" }, ok: { status: "Synced", statusIcon: "check", tone: "good" }, success: { status: "Built", statusIcon: "check", tone: "good" },
  partial: { status: "Partly failed", statusIcon: "warn", tone: "warn" }, failed: { status: "Failed", statusIcon: "warn", tone: "bad" }, error: { status: "Failed", statusIcon: "warn", tone: "bad" },
  running: { status: "Running", statusIcon: "refresh", tone: "info" }, skipped: { status: "Skipped", statusIcon: "info" },
};
const resultsOf = (r: Run) => (r.artifacts?.run_results as { results?: Result[] } | undefined)?.results ?? [];

/** The whole ETL path on one graph: what's extracted, how it's transformed, and where it's delivered. */
export default function Flow() {
  const { config, patch, can } = useApp(), editable = can("editor");
  const [runs, setRuns] = useState<Run[] | null>(null), [exports, setExports] = useState<Scheduled[]>([]), [err, setErr] = useState(""), [busy, setBusy] = useState(false), [sel, setSel] = useState<string | undefined>(), [tab, setTab] = useState("Run history");
  // The list leaves out build results, so the recent builds are read in full to know each model's status
  const load = () => { setErr(""); call<Run[]>("/api/runs").then(async (list) => { const full = await Promise.all(list.filter((r) => r.kind === "models").slice(0, 8).map((r) => call<Run>(`/api/runs?id=${r.id}`).catch(() => r))); setRuns(list.map((r) => full.find((x) => x.id === r.id) ?? r)); }, (e) => setErr(e.message)); if (editable) call<{ scheduled: Scheduled[] }>("/api/exports").then((r) => setExports(r.scheduled ?? [])).catch(() => {}); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);
  const cfg = config!, lastSync = (id: string) => runs?.find((r) => r.kind === "sync" && r.refId === id), lastBuild = runs?.find((r) => r.kind === "models" && r.refId === "all");
  const runAll = async () => { setBusy(true); try { const r = await call<{ summary: string; ok: boolean }>("/api/runs", { json: { kind: "flow" } }); toast(r.summary, !r.ok); await refreshTables(); load(); } catch (e) { toast((e as Error).message, true); } setBusy(false); };
  const buildFrom = async () => { if (!sel) return; setBusy(true); await new Promise((r) => setTimeout(r, 500)); try { const r = await call<Run>("/api/runs", { json: { kind: "models", only: sel, downstream: true } }); toast(r.summary ?? "Done", r.status !== "succeeded"); await refreshTables(); load(); } catch (e) { toast((e as Error).message, true); } setBusy(false); };
  const stopExport = async (x: Scheduled) => { await call("/api/exports", { method: "PUT", json: { action: "delete", id: x.id } }).catch((e) => toast((e as Error).message, true)); load(); };
  if (err) return <><PageHead title="ETL flow" /><ErrorState retry={load}>{err}</ErrorState></>;

  const conn = (id: string) => cfg.connections.find((c) => c.id === id);
  let g: ReturnType<typeof lineage> | null = null;
  try { g = lineage(cfg.models); } catch { /* shown as a banner above the graph */ }
  const graphed = new Set((g?.nodes ?? []).map((n) => n.id));
  const edges: { from: string; to: string }[] = [...(g?.edges ?? [])], nodes: FlowNode[] = [];
  const fedBy = new Map<string, { pipeline: Pipeline; stream: string }>();
  cfg.pipelines.forEach((p) => {
    const c = conn(p.connectionId), r = lastSync(p.id);
    nodes.push({ id: `p:${p.id}`, stage: "Extract", col: 0, name: p.name, glyph: connGlyph(c), ...(p.paused ? waiting("Paused") : r ? LOOK[r.status] : waiting("Not run yet")) });
    // Only tables a model reads get a node, so unused streams don't crowd the graph
    if (c) p.streams.filter((s) => s.enabled).forEach((s) => { const id = `raw_${c.slug}.${s.name.replace(/\W/g, "_")}`; if (graphed.has(id)) { fedBy.set(id, { pipeline: p, stream: s.name }); edges.push({ from: `p:${p.id}`, to: id }); } });
  });
  // Runs are newest first, so the first one that built a model holds its latest result
  const buildOf = (name: string) => { const id = `model.basalt.${name}`, run = runs?.find((x) => x.kind === "models" && resultsOf(x).some((y) => y.unique_id === id)); if (!run) return undefined; const failed = resultsOf(run).filter((y) => y.unique_id.startsWith("test.") && y.unique_id.includes(`_${name}_`) && (y.status === "fail" || y.status === "error")).length; return { run, result: resultsOf(run).find((y) => y.unique_id === id)!, failed }; };
  const building = runs?.some((r) => r.kind === "models" && r.refId === "all" && r.status === "running");
  g?.nodes.forEach((n) => {
    if (n.kind === "source") {
      const f = fedBy.get(n.id), s = f && lastSync(f.pipeline.id)?.streams?.find((x) => x.name === f.stream);
      nodes.push({ id: n.id, stage: "Raw tables", col: 1, name: n.label.split(".").pop()!, glyph: glyph("table"), ...(!f ? { status: "No pipeline", statusIcon: "warn" as const, tone: "warn" as const } : s ? LOOK[s.status] : waiting("Not synced yet")) });
    } else {
      const b = buildOf(n.id);
      nodes.push({ id: n.id, stage: "Transform", col: n.layer + 1, name: n.label, glyph: glyph("model"), ...(building ? LOOK.running : b?.failed ? { status: `Built, ${b.failed} ${b.failed === 1 ? "check" : "checks"} failed`, statusIcon: "warn" as const, tone: "warn" as const } : b ? LOOK[b.result.status] : waiting("Not built yet")) });
    }
  });
  const tableNode = (t: string) => { const id = t.startsWith("analytics.") ? t.slice(10) : t; return graphed.has(id) ? id : null; };
  const deliverCol = Math.max(0, ...(g?.nodes ?? []).map((n) => n.layer)) + 2;
  cfg.dashboards.forEach((d) => {
    const from = [...new Set(d.widgets.map((w) => tableNode(w.table)).filter((x): x is string => !!x))];
    from.forEach((id) => edges.push({ from: id, to: `d:${d.id}` }));
    const broke = from.some((id) => { const s = buildOf(id)?.result.status; return s === "error" || s === "skipped"; });
    nodes.push({ id: `d:${d.id}`, stage: "Deliver", col: deliverCol, name: d.name, glyph: glyph("chart"), ...(broke ? { status: "Upstream failed", statusIcon: "warn" as const, tone: "warn" as const } : { status: `${d.widgets.length} ${d.widgets.length === 1 ? "visual" : "visuals"}`, statusIcon: "grid" as const }) });
  });
  exports.forEach((x) => {
    const from = tableNode(x.table);
    if (from) edges.push({ from, to: `x:${x.id}` });
    nodes.push({ id: `x:${x.id}`, stage: "Deliver", col: deliverCol, name: x.table.split(".").pop()!, glyph: connGlyph(conn(x.connectionId), "upload"), ...(x.lastError ? LOOK.failed : x.lastAt ? { status: "Export sent", statusIcon: "check" as const, tone: "good" as const } : waiting("Waiting for first run")) });
  });

  const node = nodes.find((n) => n.id === sel), model = cfg.models.find((m) => m.name === node?.id);
  const stopping = exports.find((x) => `x:${x.id}` === node?.id);
  const refs = (list: string[]) => <div className="fl-refs">{list.map((id) => <button type="button" key={id} className="link" onClick={() => setSel(id)}>{nodes.find((n) => n.id === id)?.name ?? id}</button>)}</div>;
  const detail = (): { rows: Row[]; link?: [string, string]; note?: string } => {
    const status = (s?: string): Row[] => (s ? [["Status", <StatusBadge key="s" s={s} />]] : []);
    if (!node) return { rows: [["Pipelines", cfg.pipelines.length], ["Models", cfg.models.length], ["Dashboards", cfg.dashboards.length], ...(editable ? [["Scheduled exports", exports.length] as Row] : []), ["Last full build", lastBuild ? when(lastBuild.startedAt) : "Models haven't been built yet"], ...status(lastBuild?.status)], note: lastBuild?.summary };
    const p = cfg.pipelines.find((x) => `p:${x.id}` === node.id);
    if (p) { const r = lastSync(p.id); return { rows: [["Connection", conn(p.connectionId)?.name ?? "Connection removed"], ["Schedule", `${p.paused ? "Paused" : p.schedule ? label(p.schedule) : "Manual only"}${p.retries ? `, ${p.retries} retries` : ""}`], ["Tables synced", p.streams.filter((s) => s.enabled).length], ["Last run", r ? when(r.startedAt) : "Not yet"], ...status(r?.status)], link: ["Open pipeline", `/pipelines?p=${p.id}`], note: r?.summary }; }
    const dash = cfg.dashboards.find((x) => `d:${x.id}` === node.id);
    if (dash) return { rows: [["Visuals", dash.widgets.length], ["Owner", dash.owner]], link: ["All dashboards", "/dashboards"] };
    if (stopping) return { rows: [["Sent to", `${conn(stopping.connectionId)?.name ?? "Connection removed"}${stopping.path ? `: ${stopping.path}` : ""}`], ["Schedule", label(stopping.every)], ["Last run", stopping.lastAt ? when(stopping.lastAt) : "Waiting for the first run"]], note: stopping.lastError };
    if (model) { const b = buildOf(model.name); return { rows: [["Saved as", model.materialized], ["Owner", model.owner], ["Tests", b?.failed ? `${b.failed} of ${model.tests.length} failed` : model.tests.length], ["Last built", b ? when(b.run.startedAt) : "Not yet"], ...status(b?.result.status)], link: ["Open model", `/models?m=${model.id}`], note: b?.result.message ?? undefined }; }
    const f = fedBy.get(node.id), r = f && lastSync(f.pipeline.id), s = f && r?.streams?.find((x) => x.name === f.stream);
    return { rows: [["Pipeline", f ? f.pipeline.name : "No enabled pipeline syncs this table"], ["Last sync", r ? when(r.startedAt) : "Not yet"], ...status(s?.status), ...(s ? [["Rows written", s.written.toLocaleString("en-US")] as Row] : [])], note: s?.error };
  };
  const d = detail();
  const reads = node ? [...new Set(edges.filter((e) => e.to === node.id).map((e) => e.from))] : [], feeds = node ? [...new Set(edges.filter((e) => e.from === node.id).map((e) => e.to))] : [];

  return <>
    <PageHead title="ETL flow">{editable && <div className="fl-actions">
      <Field label="Build all models"><Sel aria-label="Build all models" options={EVERY} value={String(cfg.settings.buildEvery ?? 0)} onChange={(v) => patch((c) => ({ ...c, settings: { ...c.settings, buildEvery: Number(v) } }))} /></Field>
      <Btn variant="primary" icon={busy ? undefined : "play"} disabled={busy} onClick={runAll}>{busy ? <><Spinner />Running</> : "Run everything"}</Btn>
    </div>}</PageHead>
    <div className="body">
      {!cfg.pipelines.length ? <Empty icon="flow" title="Connect a source to start" editor action={<Link className="btn primary" href="/connections">Add a connection</Link>}>Your flow runs from sources, through models, to dashboards and exports.</Empty>
        : !runs ? <LoadingTable rows={4} cols={4} label="Loading the flow" /> : <>
          {!g && <div className="banner bad"><Icon name="warn" />The models can&apos;t be drawn because a model refers to something missing or models depend on each other.</div>}
          <div className="fl-main">
            <div className="fl-scroll"><FlowGraph nodes={nodes} edges={edges} selected={node?.id} onPick={setSel} /></div>
            {node && <aside className="fl-panel" aria-label="Details">
              <div className="fl-panel-head"><h2>{node.name}</h2><Btn icon="x" variant="ghost" aria-label="Clear selection" onClick={() => setSel(undefined)} /></div>
              <dl className="kv">
                {d.rows.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}
                {reads.length > 0 && <><dt>Reads from</dt><dd>{refs(reads)}</dd></>}
                {feeds.length > 0 && <><dt>Feeds</dt><dd>{refs(feeds)}</dd></>}
              </dl>
              {d.note && <p className="small muted">{d.note}</p>}
              <div className="fl-panel-foot">
                {d.link && <GoLink href={d.link[1]}>{d.link[0]}</GoLink>}
                {editable && model && <Btn disabled={busy} icon="play" onClick={buildFrom}>{`Build ${model.name} and what depends on it`}</Btn>}
                {editable && stopping && <Btn variant="danger" icon="trash" onClick={() => stopExport(stopping)}>Stop this export</Btn>}
              </div>
            </aside>}
          </div>
          <section className="fl-below">
            <div className="fl-below-head">
              <Tabs tabs={editable ? ["Run history", ["Scheduled exports", `Scheduled exports (${exports.length})`]] : ["Run history"]} value={tab} onChange={setTab} />
              <GoLink href={tab === "Run history" ? "/runs" : "/catalog"}>{tab === "Run history" ? "All runs" : "Open catalog"}</GoLink>
            </div>
            {tab === "Run history"
              ? !runs.length ? <Empty compact icon="history" title="No runs yet" editor action={<Btn variant="primary" icon="play" disabled={busy} onClick={runAll}>Run everything</Btn>}>Runs appear here after a sync or a model build.</Empty>
                : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Run</th><th>Trigger</th><th>Started</th><th>Took</th><th>Status</th></tr></thead><tbody>{runs.slice(0, 10).map((r) => <tr key={r.id}><td><Link className="plain-link" href={`/runs?r=${r.id}`}><b className="cell-strong">{r.name}</b></Link></td><td>{r.trigger === "schedule" ? "Schedule" : r.trigger === "setup" ? "Setup" : "Manual"}</td><td>{when(r.startedAt)}</td><td>{took(r.startedAt, r.endedAt)}</td><td><StatusBadge s={r.status} /></td></tr>)}</tbody></table></div>
              : !exports.length ? <Empty compact icon="upload" title="No scheduled exports" editor action={<Link className="btn primary" href="/catalog">Open the catalog</Link>}>Open a table in the catalog and choose Export.</Empty>
                : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Table</th><th>Sent to</th><th>Schedule</th><th>Last run</th><th /></tr></thead><tbody>{exports.map((x) => <tr key={x.id}><td className="mono small">{x.table}</td><td>{conn(x.connectionId)?.name ?? "Connection removed"}{x.path ? `: ${x.path}` : ""}</td><td>{label(x.every)}</td><td>{x.lastError ? <span className="err small">{x.lastError}</span> : x.lastAt ? when(x.lastAt) : "Waiting for the first run"}</td><td>{editable && <Btn icon="trash" variant="ghost" aria-label={`Stop exporting ${x.table}`} onClick={() => stopExport(x)} />}</td></tr>)}</tbody></table></div>}
          </section>
        </>}
    </div>
  </>;
}
