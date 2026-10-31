"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { Empty, ErrorState, FlowStrip, GoLink, LoadingTable, PageHead, SectionHead, StatusBadge, Sk } from "@/components/ui";
import { call, took, useApp, useTables, when } from "@/lib/client";
import type { Run } from "@/lib/types";

export default function Home() {
  const config = useApp((s) => s.config)!, tables = useTables(), router = useRouter();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [recents, setRecents] = useState<{ href: string; label: string; icon: IconName }[]>([]);
  const [failed, setFailed] = useState("");
  const loadRuns = () => { setFailed(""); call<Run[]>("/api/runs").then(setRuns, (e) => setFailed(e.message)); };
  useEffect(() => { loadRuns(); try { setRecents(JSON.parse(localStorage.getItem("basalt-recents") ?? "[]")); } catch { /* storage may be blocked */ } }, []);

  const lastSync = (id: string) => runs?.find((r) => r.kind === "sync" && r.refId === id);
  const held = config.pipelines.flatMap((p) => lastSync(p.id)?.streams?.flatMap((s) => s.heldBack) ?? []);
  const failing = (runs ?? []).filter((r, i, all) => all.findIndex((x) => x.refId === r.refId && x.kind === r.kind) === i && (r.status === "failed" || r.status === "partial"));
  const mismatched = config.pipelines.flatMap((p) => lastSync(p.id)?.streams?.filter((s) => s.sourceRows !== undefined && s.status === "ok" && s.sourceRows !== s.copyRows) ?? []);
  const widgets = config.dashboards.reduce((a, d) => a + d.widgets.length, 0);
  const allClear = runs && !held.length && !failing.length && !mismatched.length;

  return (
    <>
      <PageHead title="Home" />
      <div className="body home">
        <FlowStrip steps={[
          { label: "Connect", value: config.connections.length, sub: config.connections.length === 1 ? "source" : "sources", href: "/connections", icon: "plug", todo: !config.connections.length },
          { label: "Copy", value: tables ? tables.length : <Sk w={36} h={24} />, sub: "tables in the warehouse", href: "/catalog", icon: "catalog", todo: tables?.length === 0 },
          { label: "Transform", value: config.models.length, sub: config.models.length === 1 ? "model" : "models", href: "/models", icon: "model", todo: !config.models.length },
          { label: "Share", value: config.dashboards.length, sub: `dashboards, ${widgets} visuals`, href: "/dashboards", icon: "chart", todo: !config.dashboards.length },
        ]} />

        <div className="home-grid">
          <div className="home-main">
            <section>
              <SectionHead title="Data freshness"><GoLink href="/pipelines">All pipelines</GoLink></SectionHead>
              {failed ? <ErrorState title="Pipelines couldn't load" retry={loadRuns}>{failed}</ErrorState> : !runs ? <LoadingTable rows={3} cols={4} label="Loading pipelines" /> : !config.pipelines.length ? (
                <Empty compact icon="plug" title="Connect your first source" editor action={<Link className="btn primary" href="/connections">Add a connection</Link>}>Basalt copies your data with a read-only login and masks personal data before it&apos;s stored.</Empty>
              ) : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Pipeline</th><th>Status</th><th className="hide-sm r">Tables</th><th>Last sync</th></tr></thead><tbody>
                {config.pipelines.map((p) => { const r = lastSync(p.id); return <tr key={p.id} className="click" onClick={() => router.push(`/pipelines?p=${p.id}`)}><td><b className="cell-strong">{p.name}</b></td><td>{r ? <StatusBadge s={r.status} /> : <span className="muted">Not synced</span>}</td><td className="hide-sm r">{p.streams.filter((s) => s.enabled).length}</td><td>{r ? when(r.startedAt) : ""}</td></tr>; })}
              </tbody></table></div>}
            </section>

            <section>
              <SectionHead title="Recent runs"><GoLink href="/runs">All runs</GoLink></SectionHead>
              {failed ? null : !runs ? <LoadingTable rows={5} cols={4} label="Loading runs" /> : !runs.length ? <Empty compact icon="refresh" title="No runs yet" editor action={config.pipelines.length > 0 && <Link className="btn primary" href="/pipelines">Run a sync</Link>}>Syncs and model builds appear here after they run.</Empty> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Job</th><th>Status</th><th className="hide-sm">Result</th><th>Started</th><th className="hide-sm">Took</th></tr></thead><tbody>
                {runs.slice(0, 6).map((r) => <tr key={r.id} className="click" onClick={() => router.push(`/runs?r=${r.id}`)}><td>{r.name}</td><td><StatusBadge s={r.status} /></td><td className="hide-sm muted">{r.summary}</td><td>{when(r.startedAt)}</td><td className="hide-sm num">{took(r.startedAt, r.endedAt)}</td></tr>)}
              </tbody></table></div>}
            </section>
          </div>

          <aside className="home-side">
            <section className="side-panel">
              <h2>Needs attention</h2>
              {failed ? <p className="muted small">This couldn&apos;t be checked right now.</p> : !runs ? <Sk h={40} /> : allClear ? <p className="side-clear"><Icon name="check" />Nothing needs you right now.</p> : <ul className="side-list">
                {held.length > 0 && <li><Link href="/personal-data"><Icon name="shield" style={{ color: "var(--warn)" }} /><span><b>{held.length} personal data column{held.length > 1 ? "s" : ""} held back</b><small>Choose a rule to copy {held.length > 1 ? "them" : "it"}</small></span></Link></li>}
                {failing.map((r) => <li key={r.id}><Link href={`/runs?r=${r.id}`}><Icon name="warn" style={{ color: "var(--bad)" }} /><span><b>{r.name}</b><small>{r.summary}</small></span></Link></li>)}
                {mismatched.length > 0 && <li><Link href="/runs"><Icon name="warn" style={{ color: "var(--warn)" }} /><span><b>Row counts differ</b><small>{mismatched.map((s) => s.name).join(", ")}</small></span></Link></li>}
              </ul>}
            </section>

            {recents.length > 0 && <section className="side-panel">
              <h2>Recently opened</h2>
              <ul className="side-list">{recents.slice(0, 5).map((r) => <li key={r.href}><Link href={r.href}><Icon name={r.icon} /><span>{r.label}</span></Link></li>)}</ul>
            </section>}
          </aside>
        </div>
      </div>
    </>
  );
}
