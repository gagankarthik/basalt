"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { Chart } from "@/components/Chart";
import { ResultGrid } from "@/components/DataGrid";
import { Icon } from "@/components/icons";
import { Empty, Btn, Field, Modal, Pop, Sel, Spinner, Tabs, toast, Split, SplitToggle } from "@/components/ui";
import { download, refreshTables, sql, uid, useApp, useIsDark, useTables, when } from "@/lib/client";
import { q, toCsv } from "@/lib/sql";
import type { Result, VisualType, Widget } from "@/lib/types";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });
type Tab = { id: string; name: string; text: string; savedId?: string };
type Hist = { text: string; at: string; ms: number; rows: number };

export default function SqlEditor() {
  const { config, patch, user } = useApp(), tables = useTables();
  const [tabs, setTabs] = useState<Tab[]>([{ id: "t1", name: "Query 1", text: "SELECT kitchen, sum(amount) AS revenue\nFROM analytics.fct_payments\nWHERE status = 'paid'\nGROUP BY 1\nORDER BY 2 DESC;" }]);
  const [active, setActive] = useState("t1"), [running, setRunning] = useState(false), [res, setRes] = useState<Result | null>(null), [err, setErr] = useState(""), [view, setView] = useState("Results");
  const [open, setOpen] = useState<Record<string, boolean>>({ analytics: true }), [saving, setSaving] = useState(false), [saveName, setSaveName] = useState(""), [hist, setHist] = useState<Hist[]>([]);
  const [vis, setVis] = useState<VisualType>("column");
  const tab = tabs.find((t) => t.id === active)!;
  const dark = useIsDark();

  useEffect(() => { try { setHist(JSON.parse(localStorage.getItem("basalt-sql-history") ?? "[]")); } catch { /* history is a convenience */ } }, []);
  const setText = (text: string) => setTabs((ts) => ts.map((t) => (t.id === active ? { ...t, text } : t)));
  const run = async (text = tab.text, explain = false) => {
    setRunning(true); setErr("");
    try {
      const r = await sql(explain ? `EXPLAIN ${text.replace(/;\s*$/, "")}` : text, 20000);
      setRes(r); setView("Results");
      const h = [{ text, at: new Date().toISOString(), ms: r.ms, rows: r.rows.length }, ...hist].slice(0, 100);
      setHist(h); try { localStorage.setItem("basalt-sql-history", JSON.stringify(h)); } catch { /* full or blocked */ }
      if (/^\s*(create|drop|alter)/i.test(text)) await refreshTables();
    } catch (e) { setErr((e as Error).message); setRes(null); }
    setRunning(false);
  };
  const extensions = useMemo(() => {
    const schema: Record<string, string[]> = {};
    (tables ?? []).forEach((t) => { schema[t.full] = t.columns.map((c) => c.name); });
    return [sqlLang({ schema, upperCaseKeywords: true }), Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => { document.getElementById("run-sql")?.click(); return true; } }]))];
  }, [tables]);
  const newTab = (text = "", name?: string, savedId?: string) => { const id = uid(); setTabs((t) => [...t, { id, name: name ?? `Query ${t.length + 1}`, text, savedId }]); setActive(id); };
  const closeTab = (id: string) => { const rest = tabs.filter((t) => t.id !== id); if (!rest.length) return; setTabs(rest); if (active === id) setActive(rest[0].id); };
  const save = () => {
    const now = new Date().toISOString(), id = tab.savedId ?? uid(), name = saveName || tab.name;
    patch((c) => ({ ...c, queries: [...c.queries.filter((x) => x.id !== id), { id, name, sql: tab.text, owner: user!.name, updatedAt: now }] }));
    setTabs((ts) => ts.map((t) => (t.id === active ? { ...t, name, savedId: id } : t))); setSaving(false); toast("Query saved");
  };
  const numCols = res?.columns.filter((c) => c.kind === "number") ?? [], dimCol = res?.columns.find((c) => c.kind !== "number") ?? res?.columns[0];
  const [yCol, setYCol] = useState(""); const [xCol, setXCol] = useState("");
  const x = xCol && res?.columns.some((c) => c.name === xCol) ? xCol : dimCol?.name, y = yCol && numCols.some((c) => c.name === yCol) ? yCol : numCols[0]?.name;
  const chartWidget: Widget = { id: "q", title: "Result", type: vis, x: 0, y: 0, w: 1, h: 1, table: "", measures: [{ column: y ?? "", agg: "sum", label: y }], filters: [], showLegend: false };
  const chartRes: Result | null = res && x && y ? { ...res, rows: res.rows.slice(0, 500).map((r) => ({ d: r[x], m0: r[y] })) } : null;

  return (
    <Split id="sql" width={240} label="Schema">
      <aside className="tree" aria-label="Schema browser">
        <div className="section-title">Saved queries</div>
        {config!.queries.map((sq) => <button key={sq.id} onClick={() => newTab(sq.sql, sq.name, sq.id)}><Icon name="file" /><span>{sq.name}</span></button>)}
        {!config!.queries.length && <p className="faint small" style={{ padding: "0 10px" }}>Saved queries appear here.</p>}
        <div className="section-title">Tables</div>
        {[...new Set((tables ?? []).map((t) => t.schema))].map((s) => <div key={s}>
          <button onClick={() => setOpen({ ...open, [s]: !open[s] })}><Icon name={open[s] ? "chevDown" : "chevRight"} size={12} /><span><b>{s}</b></span></button>
          {open[s] && tables!.filter((t) => t.schema === s).map((t) => <div key={t.full}>
            <button className="lvl2" title={`Open ${t.full}`} onClick={() => setOpen({ ...open, [t.full]: !open[t.full] })} onDoubleClick={() => newTab(`SELECT *\nFROM ${q(t.schema)}.${q(t.name)}\nLIMIT 100;`, t.name)}><Icon name={t.type === "VIEW" ? "eye" : "table"} size={13} /><span>{t.name}</span></button>
            {open[t.full] && t.columns.map((c) => <button key={c.name} className="lvl3 small" title={c.type} onClick={() => setText(`${tab.text}${tab.text.endsWith(" ") ? "" : " "}${q(c.name)}`)}><span>{c.name}</span><span className="faint" style={{ marginLeft: "auto" }}>{c.type.toLowerCase().slice(0, 9)}</span></button>)}
          </div>)}
        </div>)}
      </aside>
      <section>
        <div className="tabs" role="tablist">
          <SplitToggle />
          {tabs.map((t) => <button key={t.id} role="tab" aria-selected={t.id === active} onClick={() => setActive(t.id)}>{t.name}{tabs.length > 1 && <span role="button" aria-label={`Close ${t.name}`} tabIndex={0} onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} onKeyDown={(e) => { if (e.key === "Enter") closeTab(t.id); }}><Icon name="x" size={12} /></span>}</button>)}
          <button aria-label="New query" onClick={() => newTab()}><Icon name="plus" size={14} /></button>
        </div>
        <div className="toolbar">
          <Btn id="run-sql" variant="primary" icon={running ? undefined : "play"} disabled={running} onClick={() => run()}>{running ? <><Spinner />Running</> : "Run"}</Btn>
          <span className="small faint hide-sm">Ctrl+Enter</span>
          <Btn onClick={() => run(tab.text, true)} disabled={running}>Explain</Btn>
          <Btn icon="save" onClick={() => { setSaveName(tab.name); setSaving(true); }}>Save</Btn>
          <Pop width={420} trigger={(_, t) => <Btn icon="history" onClick={t}>History</Btn>}>{(close) => <div className="menu" style={{ padding: 0 }}>{hist.slice(0, 30).map((h, i) => <button key={i} onClick={() => { setText(h.text); close(); }} style={{ height: "auto", padding: "5px 8px", display: "block", whiteSpace: "normal" }}><code style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.text}</code><span className="small faint">{when(h.at)}, {h.rows} rows, {h.ms} ms</span></button>)}{!hist.length && <p className="muted small" style={{ padding: 8 }}>Queries you run in this browser appear here.</p>}</div>}</Pop>
          <div className="grow" />
          {res && <Btn icon="download" onClick={() => download("query-result.csv", toCsv(res))}>Export CSV</Btn>}
        </div>
        <div style={{ height: "34%", minHeight: 140, flex: "none", borderBottom: "1px solid var(--line)", overflow: "auto" }}>
          <CodeMirror value={tab.text} onChange={setText} extensions={extensions} height="100%" style={{ height: "100%" }} theme={dark ? "dark" : "light"} aria-label="SQL editor" basicSetup={{ highlightActiveLine: false }} />
        </div>
        {err && <div className="banner bad" style={{ margin: 12, whiteSpace: "pre-wrap" }} role="alert"><Icon name="warn" /><span className="mono">{err}</span></div>}
        {!res && !err && !running && <Empty icon="code" title="Run a query to see results" action={<Btn variant="primary" icon="play" onClick={() => run()}>Run query</Btn>}>Results can be viewed as a table or a chart. Ctrl+Enter also runs it.</Empty>}
        {res && <div className="fill">
          <Tabs tabs={["Results", "Chart"]} value={view} onChange={setView} />
          {view === "Results" ? <ResultGrid result={res} /> : <div className="fill" style={{ padding: 12, minHeight: 300 }}>
            {chartRes ? <><div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <Field label="Chart"><Sel options={[["column", "Column"], ["bar", "Bar"], ["line", "Line"], ["area", "Area"], ["donut", "Donut"], ["treemap", "Treemap"]]} value={vis} onChange={(v) => setVis(v as VisualType)} /></Field>
              <Field label="Label"><Sel options={res.columns.map((c) => c.name)} value={x ?? ""} onChange={setXCol} /></Field>
              <Field label="Value"><Sel options={numCols.map((c) => c.name)} value={y ?? ""} onChange={setYCol} /></Field>
            </div><div style={{ flex: 1, minHeight: 260 }}><Chart w={chartWidget} result={chartRes} /></div></> : <p className="muted">This result needs at least one number column to chart.</p>}
          </div>}
          <div className="statusbar"><span>Ran in {res.ms} ms{res.truncated ? ", showing the first 20,000 rows" : ""}</span></div>
        </div>}
      </section>
      {saving && <Modal sheet title="Save query" onClose={() => setSaving(false)} foot={<><Btn onClick={() => setSaving(false)}>Cancel</Btn><Btn variant="primary" onClick={save}>Save query</Btn></>}><Field label="Name"><input className="input" autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)} /></Field></Modal>}
    </Split>
  );
}
