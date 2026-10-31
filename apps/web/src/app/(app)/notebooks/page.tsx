"use client";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { python as pythonLang } from "@codemirror/lang-python";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { Chart } from "@/components/Chart";
import { ResultGrid } from "@/components/DataGrid";
import { Icon } from "@/components/icons";
import { Btn, Confirm, Empty, Field, Modal, MoreMenu, PageHead, PermissionDenied, Sel, Spinner, Split, Tabs, toast } from "@/components/ui";
import { call, refreshTables, sql, uid, useApp, useIsDark, useNewHandler, useTables } from "@/lib/client";
import { templateCells, TEMPLATES } from "@/lib/analysisTemplates";
import { cellName, runCells, type Notebook, type NotebookCell } from "@/lib/notebook";
import type { Result, VisualType, Widget } from "@/lib/types";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });
const KINDS: [NotebookCell["kind"], string][] = [["sql", "SQL"], ["python", "Python"], ["text", "Text"]];
const SCHEDULES: [string, string][] = [["0", "Manual only"], ["15", "Every 15 minutes"], ["60", "Every hour"], ["360", "Every 6 hours"], ["1440", "Every day"]];
const CHARTS: [VisualType, string][] = [["column", "Column"], ["bar", "Bar"], ["line", "Line"], ["area", "Area"], ["donut", "Donut"]];
type Output = { result?: Result & { log?: string }; error?: string; running?: boolean };

function CellChart({ result }: { result: Result }) {
  const [vis, setVis] = useState<VisualType>("column");
  const y = result.columns.find((c) => c.kind === "number")?.name, x = (result.columns.find((c) => c.kind !== "number") ?? result.columns[0])?.name;
  if (!x || !y) return <p className="muted small">A chart needs at least one column of numbers.</p>;
  const w: Widget = { id: "c", title: "Result", type: vis, x: 0, y: 0, w: 1, h: 1, table: "", measures: [{ column: y, agg: "sum", label: y }], filters: [], showLegend: false };
  return <div className="nb-chart"><Field label="Chart"><Sel options={CHARTS} value={vis} onChange={(v) => setVis(v as VisualType)} /></Field><div className="nb-chart-box"><Chart w={w} result={{ ...result, rows: result.rows.slice(0, 500).map((r) => ({ d: r[x], m0: r[y] })) }} /></div></div>;
}

function CellOutput({ out }: { out: Output }) {
  const [tab, setTab] = useState<"Table" | "Chart">("Table");
  if (out.running) return <p className="small muted nb-out"><Spinner /> Running</p>;
  if (out.error) return <div className="banner bad nb-out" role="alert"><Icon name="warn" /><span>{out.error}</span></div>;
  if (!out.result) return null;
  const r = out.result;
  return <div className="nb-out">
    {r.log && <pre className="code">{r.log}</pre>}
    {r.columns.length > 0 ? <>
      <Tabs tabs={["Table", "Chart"]} value={tab} onChange={setTab} />
      {tab === "Table" ? <div className="nb-table"><ResultGrid result={r} plain /></div> : <CellChart result={r} />}
      <p className="small muted">{r.rows.length.toLocaleString("en-US")} rows{r.truncated ? " shown, more available" : ""} in {r.ms} ms</p>
    </> : !r.log && <p className="small muted">Finished with nothing to show. Call display(rows) to show rows from Python.</p>}
  </div>;
}

/** Says which Python cells will use, and how to get one, before anyone hits an error. */
function PythonStatus() {
  const [python, setPython] = useState<string | null | undefined>(undefined);
  useEffect(() => { call<{ python: string | null }>("/api/notebooks").then((r) => setPython(r.python), () => setPython(undefined)); }, []);
  if (python === undefined) return null;
  return python
    ? <p className="small muted">Python cells run with {python} on this server.</p>
    : <div className="banner warn"><Icon name="warn" /><span>Python isn&apos;t installed on this server, so Python cells can&apos;t run. SQL cells still work. Install Python 3 from <a className="link" href="https://www.python.org/downloads/" target="_blank" rel="noreferrer">python.org</a>, then restart Basalt.</span></div>;
}

function Editor({ n, set, onDelete }: { n: Notebook; set: (next: Partial<Notebook>) => void; onDelete: () => void }) {
  const can = useApp((s) => s.can), dark = useIsDark(), admin = can("admin");
  const [outs, setOuts] = useState<Record<string, Output>>({}), [busy, setBusy] = useState(false), session = useRef(uid());
  const cells = n.cells, setCells = (next: NotebookCell[]) => set({ cells: next });
  const put = (id: string, o: Output) => setOuts((x) => ({ ...x, [id]: o }));
  const earlierFor = (i: number) => Object.fromEntries(cells.slice(0, i).flatMap((c, k): [string, Result][] => { const r = outs[c.id]?.result; return r ? [[cellName(k), r]] : []; }));
  const exec = async (c: NotebookCell, earlier: Record<string, Result>): Promise<Result> => {
    put(c.id, { running: true });
    try {
      const result = c.kind === "python" ? await call<Result & { log: string }>("/api/notebooks", { json: { action: "python", code: c.source, earlier, session: session.current } }) : await sql(c.source, 20000);
      put(c.id, { result });
      if (c.kind === "sql" && /^\s*(create|drop|alter)/i.test(c.source)) await refreshTables();
      return result;
    } catch (e) { put(c.id, { error: (e as Error).message }); throw e; }
  };
  const runOne = (i: number) => exec(cells[i], earlierFor(i)).catch(() => {});
  const restart = async () => { const old = session.current; session.current = uid(); setOuts({}); if (admin) await call("/api/notebooks", { json: { action: "restart", session: old } }).catch(() => {}); };
  // Run all starts clean, so a result never depends on what was run by hand before
  const runAll = async () => { setBusy(true); await restart(); await runCells(cells, exec); setBusy(false); };
  const add = (at: number, kind: NotebookCell["kind"]) => setCells([...cells.slice(0, at), { id: uid(), kind, source: "" }, ...cells.slice(at)]);
  const move = (i: number, by: number) => { const next = [...cells], [c] = next.splice(i, 1); next.splice(i + by, 0, c); setCells(next); };
  const adders = (at: number) => <div className="nb-add">{KINDS.filter(([k]) => k !== "python" || admin).map(([k, l]) => <Btn key={k} icon="plus" variant="ghost" onClick={() => add(at, k)}>{l}</Btn>)}</div>;
  return <>
    <PageHead title={n.name}>
      <Sel aria-label="Schedule" options={SCHEDULES} value={String(n.every ?? 0)} onChange={(v) => set({ every: Number(v) || undefined })} />
      <Btn icon="play" variant="primary" disabled={busy || !cells.length || (!admin && cells.some((c) => c.kind === "python"))} onClick={runAll}>{busy ? "Running" : "Run all"}</Btn>
      <MoreMenu width={220}>{(close) => <><button onClick={() => { close(); void restart().then(() => toast("Python variables cleared")); }}><Icon name="refresh" />Clear variables and results</button><button onClick={() => { close(); onDelete(); }}><Icon name="trash" />Delete notebook</button></>}</MoreMenu>
    </PageHead>
    <div className="body nb">
      <PythonStatus />
      <Field label="Name"><input className="input" value={n.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      {adders(0)}
      {cells.map((c, i) => {
        const locked = c.kind === "python" && !admin;
        return <section key={c.id} className="nb-cell" aria-label={`Cell ${i + 1}`}>
          <header><b className="mono small">{cellName(i)}</b><Sel aria-label={`Type of cell ${i + 1}`} disabled={locked} options={KINDS.filter(([k]) => k !== "python" || admin || c.kind === "python")} value={c.kind} onChange={(v) => setCells(cells.map((x) => (x.id === c.id ? { ...x, kind: v as NotebookCell["kind"] } : x)))} />
            <span className="grow" />
            <Btn icon="chevUp" variant="ghost" aria-label={`Move cell ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} />
            <Btn icon="chevDown" variant="ghost" aria-label={`Move cell ${i + 1} down`} disabled={i === cells.length - 1} onClick={() => move(i, 1)} />
            <Btn icon="trash" variant="ghost" aria-label={`Delete cell ${i + 1}`} disabled={locked} onClick={() => setCells(cells.filter((x) => x.id !== c.id))} />
            {c.kind !== "text" && <Btn icon="play" disabled={locked || !c.source.trim() || outs[c.id]?.running} onClick={() => runOne(i)}>Run</Btn>}
          </header>
          {c.kind === "text"
            ? <textarea className="input" rows={3} aria-label={`Text of cell ${i + 1}`} placeholder="Explain what this notebook does" value={c.source} onChange={(e) => setCells(cells.map((x) => (x.id === c.id ? { ...x, source: e.target.value } : x)))} />
            : <div className="nb-code"><CodeMirror value={c.source} readOnly={locked} theme={dark ? "dark" : "light"} extensions={[c.kind === "python" ? pythonLang() : sqlLang()]} placeholder={c.kind === "python" ? "rows = results[\"cell1\"]\ndisplay(rows)" : "SELECT * FROM analytics.fct_orders LIMIT 100"} onChange={(v) => setCells(cells.map((x) => (x.id === c.id ? { ...x, source: v } : x)))} /></div>}
          {locked && <p className="small muted">Only admins can edit or run Python.</p>}
          {outs[c.id] && <CellOutput out={outs[c.id]} />}
        </section>;
      })}
      {cells.length > 0 && adders(cells.length)}
    </div>
  </>;
}

/** Starts empty, or from a standard analysis once its table and columns are chosen. */
function NewNotebook({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, cells: NotebookCell[]) => void }) {
  const tables = useTables() ?? [], [name, setName] = useState(""), [tpl, setTpl] = useState(""), [p, setP] = useState<Record<string, string>>({});
  const t = TEMPLATES.find((x) => x.id === tpl), tableNames = tables.map((x): [string, string] => [x.full, x.full]);
  const columnsOf = (full?: string) => (tables.find((x) => x.full === full)?.columns ?? []).map((c): [string, string] => [c.name, c.name]);
  const ready = !t || (!!p.table && t.fields.every((f) => !!p[f.key]));
  // The second table's columns belong to that table, in the one template that compares two
  const sourceOf = (key: string) => (key === "date2" || key === "value2" ? p.table2 : p.table);
  const create = () => { if (ready) onCreate(name.trim() || t?.name || "Untitled notebook", (t && templateCells(t.id, p, uid)) || [{ id: uid(), kind: "sql", source: "" }]); };
  return <Modal title="New notebook" onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={!ready} onClick={create}>Create</Btn></>}>
    <Field label="Start from" hint={t?.note}><Sel options={[["", "Empty notebook"], ...TEMPLATES.map((x): [string, string] => [x.id, x.name])]} value={tpl} onChange={(v) => { setTpl(v); setP({}); }} /></Field>
    <Field label="Name"><input className="input" autoFocus placeholder={t?.name ?? "Untitled notebook"} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} /></Field>
    {t && <Field label="Table"><Sel options={[["", "Choose a table"], ...tableNames]} value={p.table ?? ""} onChange={(v) => setP({ table: v })} /></Field>}
    {t && p.table && t.fields.map((f) => <Field key={f.key} label={f.label} hint={f.hint}><Sel options={[["", f.table ? "Choose a table" : "Choose a column"], ...(f.table ? tableNames : columnsOf(sourceOf(f.key)))]} value={p[f.key] ?? ""} onChange={(v) => setP({ ...p, [f.key]: v })} /></Field>)}
  </Modal>;
}

function Notebooks() {
  const { config, patch, can, user } = useApp(), pre = useSearchParams();
  const list = config?.notebooks ?? [], [sel, setSel] = useState(pre.get("n")), [naming, setNaming] = useState(false), [del, setDel] = useState<Notebook | null>(null);
  useNewHandler("notebook", () => setNaming(true));
  if (!can("editor")) return <><PageHead title="Notebooks" /><PermissionDenied title="Notebooks are for editors and admins" /></>;
  const current = list.find((x) => x.id === sel) ?? list[0];
  const save = (id: string, p: Partial<Notebook>) => patch((c) => ({ ...c, notebooks: (c.notebooks ?? []).map((x) => (x.id === id ? { ...x, ...p, updatedAt: new Date().toISOString() } : x)) }));
  const create = (name: string, cells: NotebookCell[]) => { const id = uid(); patch((c) => ({ ...c, notebooks: [...(c.notebooks ?? []), { id, name, owner: user!.name, updatedAt: new Date().toISOString(), cells }] })); setSel(id); setNaming(false); };
  const dialog = naming && <NewNotebook onClose={() => setNaming(false)} onCreate={create} />;
  if (!current) return <><PageHead title="Notebooks" /><div className="body"><Empty icon="notebook" title="No notebooks yet" editor action={<Btn variant="primary" icon="plus" onClick={() => setNaming(true)}>New notebook</Btn>}>Mix SQL, Python and notes on one page, or start from a standard analysis such as cohort retention or an A/B test.</Empty></div>{dialog}</>;
  return <div className="fill">
    <Split id="notebooks" label="Notebooks" width={240}>
      <aside className="tree">{list.map((x) => <button key={x.id} className={x.id === current.id ? "on" : ""} onClick={() => setSel(x.id)}><Icon name="notebook" size={16} />{x.name}</button>)}<button onClick={() => setNaming(true)}><Icon name="plus" size={16} />New notebook</button></aside>
      <section style={{ flex: 1, minWidth: 0, overflow: "auto" }}><Editor key={current.id} n={current} set={(p) => save(current.id, p)} onDelete={() => setDel(current)} /></section>
    </Split>
    {dialog}
    {del && <Confirm title={`Delete ${del.name}?`} action="Delete notebook" body="Its cells and schedule are removed. Tables it created stay in the warehouse." onYes={() => { patch((c) => ({ ...c, notebooks: (c.notebooks ?? []).filter((x) => x.id !== del.id) })); setSel(null); setDel(null); toast("Notebook deleted"); }} onClose={() => setDel(null)} />}
  </div>;
}

export default function Page() { return <Suspense><Notebooks /></Suspense>; }
