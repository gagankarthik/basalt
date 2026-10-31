"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import DataTable from "@/components/DataTable";
import { Icon } from "@/components/icons";
import { Btn, Empty, Field, GoLink, Modal, PageHead, SectionHead, Sel, Spinner, StatusBadge, LoadingTable, toast } from "@/components/ui";
import { call, refreshTables, useApp, when } from "@/lib/client";
import type { Pipeline, Run, StreamCfg, SyncMode } from "@/lib/types";

const MODES: [SyncMode, string][] = [["full_refresh", "Full refresh: replace the copy"], ["incremental_append", "Incremental: add new rows"], ["incremental_dedupe", "Incremental: add and update by key"]];
const SCHEDULES: [string, string][] = [["0", "Manual only"], ["15", "Every 15 minutes"], ["60", "Every hour"], ["360", "Every 6 hours"], ["1440", "Every day"]];
type StreamRow = { name: string; s: StreamCfg; i?: Info["streams"][number]; cols: string[]; pii: { name: string }[]; open: { name: string }[] };
type Info = { streams: { name: string; primaryKey?: string; rowCount?: number; columns: { name: string; type: string; pii: string | null }[] }[] };

type Cdc = { enabledAt?: string; lastAt?: string; lastLsn?: string; applied?: number; skipped?: string[]; lastError?: string };

function RealTime({ p }: { p: Pipeline }) {
  const { can, patch } = useApp();
  const [st, setSt] = useState<Cdc | undefined>(), [setup, setSetup] = useState<{ token: string; host?: string; port?: number; database?: string } | null>(null), [now, setNow] = useState(0);
  useEffect(() => { const t = () => call<Record<string, Cdc>>("/api/cdc").then((r) => { setSt(r[p.id]); setNow(Date.now()); }).catch(() => {}); void t(); const i = setInterval(t, 15000); return () => clearInterval(i); }, [p.id]);
  const start = async () => { try { setSetup(await call("/api/cdc", { method: "PUT", json: { id: p.id } })); setSt({ ...st, enabledAt: new Date().toISOString() }); } catch (e) { toast((e as Error).message, true); } };
  const live = st?.lastAt && now - Date.parse(st.lastAt) < 300000;
  return <section style={{ display: "grid", gap: 8 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <div><h2>Real-time sync</h2><p className="muted small" style={{ marginTop: 2 }}>Applies inserts, updates and deletes within seconds using PostgreSQL logical replication. Tables need a primary key that isn&apos;t masked.</p></div>
      {can("admin") && <Btn onClick={start}>{st?.enabledAt ? "Get a new worker token" : "Turn on real-time sync"}</Btn>}
    </div>
    {st?.enabledAt && <dl className="kv"><dt>Status</dt><dd><StatusBadge s={st.lastError ? "failed" : live ? "connected" : "waiting"} /></dd><dt>Last check-in</dt><dd>{st.lastAt ? when(st.lastAt) : "The worker hasn't connected yet"}</dd><dt>Changes applied</dt><dd>{(st.applied ?? 0).toLocaleString("en-US")}</dd>{st.lastLsn && <><dt>Position</dt><dd className="mono small">{st.lastLsn}</dd></>}</dl>}
    {st?.enabledAt && <label className="check"><input type="checkbox" checked={!!p.rebuildOnChange} disabled={!can("editor")} onChange={(e) => patch((c) => ({ ...c, pipelines: c.pipelines.map((x) => (x.id === p.id ? { ...x, rebuildOnChange: e.target.checked } : x)) }))} />Rebuild incremental models that read these tables, at most once a minute</label>}
    {st?.lastError && <div className="banner bad"><Icon name="warn" />{st.lastError}</div>}
    {st?.skipped?.map((x) => <div key={x} className="banner warn"><Icon name="warn" />{x}</div>)}
    {setup && <div className="banner info" style={{ display: "block" }}>
      <p style={{ marginBottom: 8 }}>Copy this now and give it to your administrator, who runs the real-time worker. The token isn&apos;t shown again. The source database needs <code>wal_level=logical</code> and a user with the REPLICATION role. Run a full sync once after the worker starts.</p>
      <code className="token-box">{`BASALT_URL=${location.origin}\nBASALT_PIPELINE=${p.id}\nBASALT_TOKEN=${setup.token}\nSOURCE_URL=postgres://USER:PASSWORD@${setup.host}:${setup.port}/${setup.database}\n./basalt-cdc`}</code>
    </div>}
  </section>;
}

function Detail({ p }: { p: Pipeline }) {
  const { patch, can, config } = useApp(), router = useRouter();
  const conn = config!.connections.find((c) => c.id === p.connectionId);
  const [info, setInfo] = useState<Info | null>(null), [err, setErr] = useState(""), [running, setRunning] = useState(false), [runs, setRuns] = useState<Run[]>([]), [settings, setSettings] = useState(false);
  const editable = can("editor");
  const loadRuns = () => call<Run[]>("/api/runs").then((r) => setRuns(r.filter((x) => x.refId === p.id))).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setInfo(null); setErr(""); void loadRuns(); call<Info>(`/api/connections?inspect=${p.connectionId}`).then(setInfo, (e) => setErr(e.message)); }, [p.id]);
  const up = (fn: (x: Pipeline) => Pipeline) => patch((c) => ({ ...c, pipelines: c.pipelines.map((x) => (x.id === p.id ? fn(x) : x)) }));
  const upS = (name: string, s: Partial<StreamCfg>) => up((x) => ({ ...x, streams: x.streams.map((y) => (y.name === name ? { ...y, ...s } : y)) }));
  const run = async () => {
    setRunning(true);
    await new Promise((r) => setTimeout(r, 500)); // let the debounced config save land first
    try { const r = await call<Run>("/api/runs", { json: { kind: "sync", id: p.id } }); toast(`${p.name}: ${r.summary}`, r.status === "failed"); await refreshTables(); } catch (e) { toast((e as Error).message, true); }
    setRunning(false); void loadRuns();
  };
  const allNames = [...new Set([...p.streams.map((s) => s.name), ...(info?.streams.map((s) => s.name) ?? [])])];
  const cfgFor = (name: string): StreamCfg => p.streams.find((s) => s.name === name) ?? { name, enabled: false, mode: "full_refresh", rules: {} };
  const ensure = (name: string, s: Partial<StreamCfg>) => {
    if (p.streams.some((x) => x.name === name)) upS(name, s);
    else up((x) => ({ ...x, streams: [...x.streams, { ...cfgFor(name), primaryKey: info?.streams.find((y) => y.name === name)?.primaryKey, ...s }] }));
  };
  const streamRows: StreamRow[] = allNames.map((name) => {
    const s = cfgFor(name), i = info?.streams.find((x) => x.name === name), pii = i?.columns.filter((c) => c.pii) ?? [];
    return { name, s, i, cols: i?.columns.map((c) => c.name) ?? [], pii, open: pii.filter((c) => !s.rules[c.name]) };
  });
  return (
    <>
      <PageHead title={p.name}>
        {config!.pipelines.length > 1 && <Sel aria-label="Choose a pipeline" options={config!.pipelines.map((x) => [x.id, x.name] as [string, string])} value={p.id} onChange={(v) => router.push(`/pipelines?p=${v}`)} />}
        {running && conn?.type === "airbyte" && can("admin") && <Btn onClick={() => call("/api/connections/airbyte", { json: { action: "cancel", connectionId: conn.id } }).catch((e) => toast((e as Error).message, true))}>Stop connector</Btn>}
        <Btn icon="settings" onClick={() => setSettings(true)}>Settings</Btn>
        {editable && (conn?.type !== "airbyte" || can("admin")) && <Btn icon={running ? undefined : "play"} variant="primary" onClick={run} disabled={running}>{running ? <><Spinner />Syncing</> : "Sync now"}</Btn>}
      </PageHead>
      <div className="body">
        {err && <div className="banner bad"><Icon name="warn" />{err}</div>}
        
        <section>
          <SectionHead title="Tables to sync" />
          {!info && !err ? <LoadingTable cols={6} label="Loading tables" /> : <DataTable<StreamRow> id="pipeline-tables" rows={streamRows} rowKey={(r) => r.name} selectable={false} searchPlaceholder="Search tables" initialSort={{ id: "table", dir: "asc" }}
            filters={[
              { id: "sync", label: "Sync", value: (r) => (r.s.enabled ? "On" : "Off") },
              { id: "mode", label: "Mode", value: (r) => r.s.mode, options: MODES.map(([value, label]) => ({ value, label: label.split(":")[0] + (value === "incremental_dedupe" ? " with updates" : "") })) },
              { id: "pii", label: "Personal data", value: (r) => (!r.pii.length ? "None found" : r.open.length ? "Held back" : "Protected") },
            ]}
            columns={[
              { id: "sync", header: "Sync", width: 70, sortValue: (r) => (r.s.enabled ? 1 : 0), exportValue: (r) => (r.s.enabled ? "On" : "Off"), cell: (r) => <input type="checkbox" disabled={!editable} aria-label={`Sync ${r.name}`} checked={r.s.enabled} onChange={(e) => ensure(r.name, { enabled: e.target.checked })} /> },
              { id: "table", header: "Table", width: 170, hideable: false, sortValue: (r) => r.name, searchValue: (r) => r.name, cell: (r) => <b className="cell-strong">{r.name}</b> },
              { id: "pii", header: "Personal data", width: 140, sortValue: (r) => r.open.length, exportValue: (r) => (!r.pii.length ? "None found" : r.open.length ? `${r.open.length} held back` : `${r.pii.length} protected`), cell: (r) => (!r.i ? "" : !r.pii.length ? <span className="faint">None found</span> : r.open.length ? <Link href={`/personal-data?p=${p.id}&s=${r.name}`} className="badge warn"><Icon name="shield" size={12} />{r.open.length} held back</Link> : <Link href={`/personal-data?p=${p.id}&s=${r.name}`} className="badge good"><Icon name="shield" size={12} />{r.pii.length} protected</Link>) },
              { id: "rows", header: "Rows in source", width: 120, align: "end", sortValue: (r) => r.i?.rowCount ?? 0, cell: (r) => r.i?.rowCount?.toLocaleString("en-US") ?? "" },
              { id: "mode", header: "Sync mode", width: 270, sortValue: (r) => r.s.mode, cell: (r) => <Sel disabled={!editable} aria-label={`Sync mode for ${r.name}`} options={MODES} value={r.s.mode} onChange={(v) => ensure(r.name, { mode: v as SyncMode })} /> },
              { id: "cursor", header: "Cursor column", width: 170, sortValue: (r) => r.s.cursor ?? "", cell: (r) => (r.s.mode !== "full_refresh" ? <Sel disabled={!editable} aria-label={`Cursor column for ${r.name}`} options={[["", "Choose a column"], ...r.cols.map((c): [string, string] => [c, c])]} value={r.s.cursor ?? ""} onChange={(v) => ensure(r.name, { cursor: v || undefined })} /> : <span className="faint">Not needed</span>) },
              { id: "key", header: "Primary key", width: 170, sortValue: (r) => r.s.primaryKey ?? "", cell: (r) => (r.s.mode === "incremental_dedupe" ? <Sel disabled={!editable} aria-label={`Primary key for ${r.name}`} options={[["", "Choose a column"], ...r.cols.map((c): [string, string] => [c, c])]} value={r.s.primaryKey ?? ""} onChange={(v) => ensure(r.name, { primaryKey: v || undefined })} /> : <span className="mono small">{r.s.primaryKey ?? ""}</span>) },
            ]} />}
          {p.streams.some((s) => s.enabled && s.mode !== "full_refresh" && !s.cursor) && <div className="banner warn" style={{ marginTop: 8 }}><Icon name="warn" />Incremental tables need a cursor column. Without one, every row is read on each sync.</div>}
          {p.streams.some((s) => s.enabled && s.mode === "incremental_dedupe" && !s.primaryKey) && <div className="banner warn" style={{ marginTop: 8 }}><Icon name="warn" />Add and update needs a primary key. Without one, updated rows are added as duplicates.</div>}
        </section>
        {conn?.type === "postgres" && <RealTime p={p} />}
        <section>
          <SectionHead title="Recent syncs"><GoLink href="/runs">Run history</GoLink></SectionHead>
          {!runs.length ? <Empty compact icon="history" title="No syncs yet" editor action={<Btn variant="primary" icon="play" disabled={running} onClick={run}>Run a sync</Btn>}>Run this pipeline to copy its tables for the first time.</Empty> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Started</th><th>Status</th><th>Result</th><th>Started by</th></tr></thead><tbody>{runs.slice(0, 5).map((r) => <tr key={r.id}><td><Link className="plain-link" href={`/runs?r=${r.id}`}>{when(r.startedAt)}</Link></td><td><StatusBadge s={r.status} /></td><td className="muted">{r.summary}</td><td>{r.actor}</td></tr>)}</tbody></table></div>}
        </section>
      </div>
      {settings && <Modal sheet title="Pipeline settings" onClose={() => setSettings(false)} foot={<Btn onClick={() => setSettings(false)}>Done</Btn>}><Field label="Schedule" hint="Runs while the Basalt server is up"><Sel disabled={!editable} options={SCHEDULES} value={String(p.schedule)} onChange={(v) => up((x) => ({ ...x, schedule: Number(v) }))} /></Field>
          <Field label="Rows deleted in the source" hint="Adds a _basalt_deleted column on tables that add and update by key, and reads every key on each sync. Rows stay in the copy, so filter them out in a model."><Sel disabled={!editable} options={[["no", "Keep them as they are"], ["yes", "Mark them as deleted"]]} value={p.trackDeletes ? "yes" : "no"} onChange={(v) => up((x) => ({ ...x, trackDeletes: v === "yes" }))} /></Field>
          <Field label="After a sync"><Sel disabled={!editable} options={[["yes", "Rebuild models"], ["no", "Do nothing"]]} value={p.runModelsAfter ? "yes" : "no"} onChange={(v) => up((x) => ({ ...x, runModelsAfter: v === "yes" }))} /></Field>
          <Field label="If a sync fails" hint="Retries wait 5 minutes"><Sel disabled={!editable} options={[["0", "Don't retry"], ["1", "Retry once"], ["3", "Retry 3 times"]]} value={String(p.retries ?? 0)} onChange={(v) => up((x) => ({ ...x, retries: Number(v) }))} /></Field>
          <Field label="Alert if data is older than"><Sel disabled={!editable} options={[["0", "Never"], ["1", "1 hour"], ["6", "6 hours"], ["24", "1 day"], ["72", "3 days"]]} value={String(p.staleHours ?? 0)} onChange={(v) => up((x) => ({ ...x, staleHours: Number(v) || undefined }))} /></Field>
          <Field label="Status"><Sel disabled={!editable} options={[["on", "Active"], ["off", "Paused"]]} value={p.paused ? "off" : "on"} onChange={(v) => up((x) => ({ ...x, paused: v === "off" }))} /></Field></Modal>}
    </>
  );
}

function Pipelines() {
  const config = useApp((s) => s.config)!;
  const sel = useSearchParams().get("p") ?? config.pipelines[0]?.id;
  const router = useRouter();
  const p = config.pipelines.find((x) => x.id === sel);
  if (!config.pipelines.length) return <><PageHead title="Pipelines" /><Empty icon="flow" title="No pipelines yet" editor action={<Link className="btn primary" href="/connections">Add a connection</Link>}>A pipeline is created for each connection you add.</Empty></>;
  return (
    p ? <Detail key={p.id} p={p} /> : <><PageHead title="Pipelines" /><Empty icon="flow" title="Choose a pipeline" action={<Sel aria-label="Choose a pipeline" options={config.pipelines.map((x) => [x.id, x.name] as [string, string])} value="" onChange={(v) => router.push(`/pipelines?p=${v}`)} />} /></>
  );
}
export default function Page() { return <Suspense><Pipelines /></Suspense>; }
