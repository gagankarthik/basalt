"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import DataTable from "@/components/DataTable";
import { Icon } from "@/components/icons";
import { ErrorState, GoLink, LoadingTable, Empty, NoResults, PageHead, Sel, StatusBadge, Tabs } from "@/components/ui";
import { call, when } from "@/lib/client";
import type { LogMessage, Run, StreamStat } from "@/lib/types";

type Res = { unique_id: string; status: string; message?: string; execution_time: number; failures?: number };
type Msg = LogMessage & { n: number };
const rowCheck = (s: StreamStat) => (s.status !== "ok" ? "Failed" : s.sourceRows === s.copyRows ? "Match" : "Different");
const messageText = (m: LogMessage) => (m.type === "RECORD" ? `${m.records?.toLocaleString("en-US")} records` : m.type === "STATE" ? JSON.stringify(m.state) : m.type === "CATALOG" ? `${(m.catalog as { streams: unknown[] }).streams.length} streams discovered` : m.message ?? "");

const Json = ({ v }: { v: unknown }) => <pre className="code" style={{ maxHeight: 460 }}>{JSON.stringify(v, null, 2)}</pre>;

function RunDetail({ run: item }: { run: Run }) {
  const tabs: string[] = item.kind === "sync" ? ["Tables", "Protocol messages", "OpenLineage events"] : item.kind === "models" ? ["Results", "manifest.json", "run_results.json", "OpenLineage events"] : ["OpenLineage events"];
  const [tab, setTab] = useState(tabs[0]);
  const [full, setFull] = useState<Run | null>(null), [failed, setFailed] = useState("");
  const load = () => { call<Run>(`/api/runs?id=${item.id}`).then((r) => { setFull(r); setFailed(""); }, (e) => setFailed(e.message)); };
  // The list refreshes every 10 seconds: a running run reloads with it, a finished one only once
  const version = item.status === "running" ? item : item.endedAt;
  useEffect(load, [item.id, version]);
  const run = full ?? item;
  const messages: Msg[] = (run.messages ?? []).map((m, n) => ({ ...m, n }));
  const results = (run.artifacts?.run_results as { results?: Res[] } | undefined)?.results ?? [];
  return (
    <>
      <PageHead title={run.name}><StatusBadge s={run.status} /></PageHead>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="body">
        {run.summary && <p>{run.summary}</p>}
        {tab !== "Tables" && !full ? (failed ? <ErrorState title="This run's details couldn't load" retry={load}>{failed}</ErrorState> : <LoadingTable label="Loading run details" />) : <>
        {tab === "Tables" && <DataTable<StreamStat> id="run-tables" rows={run.streams ?? []} rowKey={(s) => s.name} selectable={false} exportable exportName="run-tables" searchPlaceholder="Search tables"
          filters={[{ id: "status", label: "Status", value: (s) => s.status }, { id: "check", label: "Row check", value: rowCheck }, { id: "held", label: "Held back", value: (s) => (s.heldBack.length ? "Yes" : "No") }]}
          columns={[
            { id: "table", header: "Table", width: 200, hideable: false, sortValue: (s) => s.name, searchValue: (s) => s.name, cell: (s) => s.name },
            { id: "status", header: "Status", width: 110, sortValue: (s) => s.status, cell: (s) => <StatusBadge s={s.status} /> },
            { id: "read", header: "Rows read", width: 110, align: "end", sortValue: (s) => s.read, cell: (s) => s.read.toLocaleString("en-US") },
            { id: "source", header: "Rows in source", width: 130, align: "end", sortValue: (s) => s.sourceRows ?? 0, cell: (s) => s.sourceRows?.toLocaleString("en-US") },
            { id: "copy", header: "Rows in copy", width: 120, align: "end", sortValue: (s) => s.copyRows ?? 0, cell: (s) => s.copyRows?.toLocaleString("en-US") },
            { id: "check", header: "Row check", width: 190, wrap: true, sortValue: rowCheck, cell: (s) => (s.status !== "ok" ? <span className="err small">{s.error}</span> : s.sourceRows === s.copyRows ? <span className="badge good"><Icon name="check" size={12} />Match</span> : <span className="badge warn"><Icon name="warn" size={12} />Off by {Math.abs((s.sourceRows ?? 0) - (s.copyRows ?? 0)).toLocaleString("en-US")}</span>) },
            { id: "held", header: "Held back", width: 200, sortValue: (s) => s.heldBack.join(", "), searchValue: (s) => s.heldBack.join(" "), cell: (s) => <span className="mono small">{s.heldBack.join(", ")}</span> },
          ]} />}
        {tab === "Protocol messages" && <><p className="muted small">Each sync follows the check, discover, read and state steps of the Airbyte protocol. Record messages are grouped by table.</p>
          <DataTable<Msg> id="run-messages" rows={messages} rowKey={(m) => String(m.n)} selectable={false} exportable exportName="run-messages" searchPlaceholder="Search messages" defaultPageSize={50}
            filters={[{ id: "type", label: "Type", value: (m) => m.type }, { id: "stream", label: "Table", value: (m) => m.stream }, { id: "level", label: "Level", value: (m) => m.level }]}
            columns={[
              { id: "time", header: "Time", width: 120, sortValue: (m) => m.n, exportValue: (m) => m.at, cell: (m) => <span className="num small">{new Date(m.at).toLocaleTimeString("en-US")}</span> },
              { id: "type", header: "Type", width: 110, sortValue: (m) => m.type, cell: (m) => <span className={`badge ${m.level === "ERROR" ? "bad" : m.level === "WARN" ? "warn" : m.type === "STATE" ? "info" : ""}`}>{m.type}</span> },
              { id: "stream", header: "Table", width: 180, sortValue: (m) => m.stream ?? "", searchValue: (m) => m.stream ?? "", cell: (m) => <span className="mono small">{m.stream}</span> },
              { id: "message", header: "Message", width: 520, wrap: true, sortValue: messageText, searchValue: messageText, exportValue: messageText, cell: (m) => <span className="small">{messageText(m)}</span> },
            ]} /></>}
        {tab === "OpenLineage events" && (run.artifacts?.openlineage ? <Json v={run.artifacts.openlineage} /> : <Empty icon="refresh" title="No events for this run">This kind of run doesn&apos;t record OpenLineage events.</Empty>)}
        {tab === "Results" && <DataTable<Res> id="run-results" rows={results} rowKey={(r) => r.unique_id} selectable={false} exportable exportName="run-results" searchPlaceholder="Search steps" defaultPageSize={50}
          filters={[{ id: "status", label: "Status", value: (r) => r.status }, { id: "kind", label: "Step", value: (r) => (r.unique_id.startsWith("test.") ? "Data check" : "Model") }]}
          columns={[
            { id: "step", header: "Step", width: 380, hideable: false, sortValue: (r) => r.unique_id, searchValue: (r) => r.unique_id, cell: (r) => <span className="mono small">{r.unique_id}</span> },
            { id: "status", header: "Status", width: 110, sortValue: (r) => r.status, cell: (r) => <StatusBadge s={r.status} /> },
            { id: "seconds", header: "Seconds", width: 100, align: "end", sortValue: (r) => r.execution_time, cell: (r) => r.execution_time.toFixed(3) },
            { id: "message", header: "Message", width: 420, wrap: true, sortValue: (r) => r.message ?? "", searchValue: (r) => r.message ?? "", cell: (r) => <span className="small">{r.message}</span> },
          ]} />}
        {tab === "manifest.json" && <Json v={run.artifacts?.manifest} />}
        {tab === "run_results.json" && <Json v={run.artifacts?.run_results} />}
        </>}
      </div>
    </>
  );
}

function Runs() {
  const pre = useSearchParams().get("r");
  const [runs, setRuns] = useState<Run[] | null>(null), [sel, setSel] = useState<string | null>(pre), [kind, setKind] = useState("all"), [status, setStatus] = useState("all");
  const [failed, setFailed] = useState("");
  const fetchRuns = () => { call<Run[]>("/api/runs").then((r) => { setRuns(r); setFailed(""); }, (e) => setFailed(e.message)); };
  useEffect(() => { const t = fetchRuns; t(); const i = setInterval(t, 10000); return () => clearInterval(i); }, []);
  const list = (runs ?? []).filter((r) => (kind === "all" || r.kind === kind) && (status === "all" || r.status === status));
  const run = runs?.find((r) => r.id === sel);
  if (run) return <><div className="toolbar"><GoLink back href="/runs" onClick={() => setSel(null)}>All runs</GoLink></div><RunDetail key={run.id} run={run} /></>;
  return <>
    <PageHead title="Run history" />
    <div className="toolbar"><Sel aria-label="Filter by type" options={[["all", "All jobs"], ["sync", "Syncs"], ["models", "Models"], ["flow", "Flows"], ["export", "Exports"]]} value={kind} onChange={setKind} /><Sel aria-label="Filter by status" options={[["all", "Any status"], ["succeeded", "Succeeded"], ["partial", "Partly failed"], ["failed", "Failed"], ["running", "Running"]]} value={status} onChange={setStatus} /></div>
    <div className="body">{failed && runs === null ? <ErrorState title="Run history couldn't load" retry={fetchRuns}>{failed}</ErrorState> : runs === null ? <LoadingTable label="Loading runs" /> : !runs.length ? <Empty icon="refresh" title="No runs yet" editor action={<Link className="btn primary" href="/pipelines">Run a sync</Link>}>Runs appear here after a sync or a model build.</Empty> : !list.length ? <NoResults what="runs" onClear={() => { setKind("all"); setStatus("all"); }} /> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Run</th><th>Type</th><th>Status</th><th>Started</th><th>Summary</th></tr></thead><tbody>{list.map((r) => <tr key={r.id} className="run-row" onClick={() => setSel(r.id)}><td><button type="button" className="plain-link cell-strong" onClick={() => setSel(r.id)}>{r.name}</button></td><td>{r.kind === "sync" ? "Sync" : r.kind === "flow" ? "Flow" : r.kind === "export" ? "Export" : "Models"}</td><td><StatusBadge s={r.status} /></td><td>{when(r.startedAt)}</td><td className="small">{r.summary}</td></tr>)}</tbody></table></div>}</div>
  </>;
}
export default function Page() { return <Suspense><Runs /></Suspense>; }
