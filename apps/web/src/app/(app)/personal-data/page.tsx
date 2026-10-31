"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import DataTable from "@/components/DataTable";
import { Icon } from "@/components/icons";
import { Empty, PageHead, Sel, Sk, toast } from "@/components/ui";
import { call, useApp } from "@/lib/client";
import { RULE_LABELS } from "@/lib/pii";
import type { Pipeline, Rule } from "@/lib/types";

type Col = { name: string; type: string; pii: string | null; suggested: Rule | null };
type Info = { streams: { name: string; columns: Col[] }[] };

type Row = { stream: string; c: Col; rule?: Rule };

function Section({ p, focus }: { p: Pipeline; focus?: string | null }) {
  const { patch, can, config } = useApp();
  const [info, setInfo] = useState<Info | null>(null), [err, setErr] = useState("");
  useEffect(() => { call<Info>(`/api/connections?inspect=${p.connectionId}`).then(setInfo, (e) => setErr(e.message)); }, [p.connectionId]);
  const conn = config!.connections.find((c) => c.id === p.connectionId);
  const setRule = (stream: string, col: string, rule: Rule) => {
    patch((c) => ({ ...c, pipelines: c.pipelines.map((x) => {
      if (x.id !== p.id) return x;
      const has = x.streams.some((s) => s.name === stream);
      const streams = has ? x.streams : [...x.streams, { name: stream, enabled: false, mode: "full_refresh" as const, rules: {} }];
      return { ...x, streams: streams.map((s) => (s.name === stream ? { ...s, rules: { ...s.rules, [col]: rule } } : s)) };
    }) }));
    toast(`${stream}.${col}: ${RULE_LABELS[rule]}. This applies from the next sync.`);
  };
  const rows: Row[] = (info?.streams ?? []).flatMap((s) => s.columns.filter((c) => c.pii).map((c) => ({ stream: s.name, c, rule: p.streams.find((x) => x.name === s.name)?.rules[c.name] })));
  return (
    <section>
      <h2 style={{ marginBottom: 8 }}>{conn?.name}</h2>
      {err && <div className="banner bad"><Icon name="warn" />{err}</div>}
      {!info && !err ? <Sk h={120} /> : <DataTable<Row> id="personal-data" rows={rows} rowKey={(r) => `${r.stream}.${r.c.name}`} selectable={false} searchPlaceholder="Search columns" empty={<Empty compact icon="shield" title="No personal data found">The scan found no personal data in this source.</Empty>} initialFilters={focus ? { table: [focus] } : undefined}
        filters={[{ id: "status", label: "Status", value: (r) => (r.rule ? "Rule set" : "Held back") }, { id: "table", label: "Table", value: (r) => r.stream }, { id: "found", label: "Found", value: (r) => r.c.pii }]}
        columns={[
          { id: "table", header: "Table", width: 190, sortValue: (r) => r.stream, searchValue: (r) => r.stream, cell: (r) => r.stream },
          { id: "column", header: "Column", width: 200, hideable: false, sortValue: (r) => r.c.name, searchValue: (r) => r.c.name, cell: (r) => r.c.name },
          { id: "found", header: "Found", width: 170, sortValue: (r) => r.c.pii, searchValue: (r) => r.c.pii ?? "", cell: (r) => r.c.pii },
          { id: "status", header: "Status", width: 130, sortValue: (r) => (r.rule ? 1 : 0), cell: (r) => (r.rule ? <span className="badge dot good">Rule set</span> : <span className="badge dot warn">Held back</span>) },
          { id: "rule", header: "Rule", width: 320, hideable: false, cell: (r) => <Sel disabled={!can("editor")} aria-label={`Rule for ${r.stream}.${r.c.name}`} options={[...(r.rule ? [] : [["", r.c.suggested ? `Choose a rule (suggested: ${RULE_LABELS[r.c.suggested]})` : "Choose a rule"] as [string, string]]), ...Object.entries(RULE_LABELS)]} value={r.rule ?? ""} onChange={(v) => v && setRule(r.stream, r.c.name, v as Rule)} /> },
        ]} />}
    </section>
  );
}

function PersonalData() {
  const config = useApp((s) => s.config)!, pre = useSearchParams();
  return (
    <>
      <PageHead title="Personal data" />
      <div className="body">
        <div className="banner info"><Icon name="info" /><span>The scan can miss personal data, such as a name inside a free-text notes column. Review your columns before relying on it. Changing a rule affects new syncs; run a full refresh to rewrite data that&apos;s already copied.</span></div>
        {!config.pipelines.length ? <Empty icon="shield" title="Nothing to scan yet" editor action={<Link className="btn primary" href="/connections">Add a connection</Link>}>Add a connection and Basalt scans it for personal data.</Empty> : config.pipelines.map((p) => <Section key={p.id} p={p} focus={pre.get("p") === p.id ? pre.get("s") : null} />)}
      </div>
    </>
  );
}
export default function Page() { return <Suspense><PersonalData /></Suspense>; }
