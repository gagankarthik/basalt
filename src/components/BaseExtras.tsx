"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { Btn, Empty, Field as FormField, Modal, PermissionDenied, Sel, SuccessState, toast } from "./ui";
import { compute, summarize, viewRecords, type Base, type BaseExtension, type BaseInterface, type BaseView, type Computed, type InterfaceElement, type Op, type Rec, type Table } from "@/lib/base";
import { call, useApp, when } from "@/lib/client";

const uid = () => crypto.randomUUID();

/** Bars from each record's start date to its end date, on a shared scale. */
export function Timeline({ t, view, eng, rows, open, editable, send }: { t: Table; view: BaseView; eng: Computed; rows: Rec[]; open: (r: Rec) => void; editable: boolean; send: (o: Op, back?: Op[]) => void }) {
  const moved = useRef(false);
  const start = t.fields.find((f) => f.id === view.dateField), end = t.fields.find((f) => f.id === view.endField);
  const items = useMemo(() => rows.flatMap((r) => { const a = start && eng.value(r, start); if (!a) return []; const s = new Date(String(a)).getTime(), b = end && eng.value(r, end), e = b ? new Date(String(b)).getTime() : s; return Number.isNaN(s) ? [] : [{ r, s, e: Number.isNaN(e) || e < s ? s : e }]; }), [rows, start, end, eng]);
  if (!start) return <Empty icon="fieldDate" title="Choose a start date">Records appear as bars from their start date to their end date. Pick the dates in the toolbar.</Empty>;
  if (!items.length) return <Empty icon="fieldDate" title="No records have this date yet">Add a date to a record and it appears here.</Empty>;
  const day = 86400000, first = new Date(Math.min(...items.map((x) => x.s))), from = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1), last = new Date(Math.max(...items.map((x) => x.e))), to = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1), span = (to - from) / day, pct = (v: number) => (((v - from) / day) / span) * 100;
  const canMove = editable && start.type === "date" && (!end || end.type === "date");
  const startDrag = (ev: React.PointerEvent, r: Rec, s: number, e: number) => {
    if (!canMove) return;
    const bar = ev.currentTarget as HTMLElement, width = bar.parentElement!.getBoundingClientRect().width, x0 = ev.clientX, perDay = width / span; let days = 0;
    bar.setPointerCapture(ev.pointerId);
    const mv = (m: PointerEvent) => { days = Math.round((m.clientX - x0) / perDay); if (days) { moved.current = true; bar.style.transform = `translateX(${days * perDay}px)`; } };
    const up = () => { bar.removeEventListener("pointermove", mv); bar.removeEventListener("pointerup", up); bar.style.transform = ""; if (!days) return; const shift = (v: number) => new Date(v + days * day).toISOString().slice(0, 10), cells: Record<string, unknown> = { [start.id]: shift(s) }, old: Record<string, unknown> = { [start.id]: r.cells[start.id] ?? null }; if (end && r.cells[end.id]) { cells[end.id] = shift(e); old[end.id] = r.cells[end.id]; } send({ kind: "setCells", table: t.id, updates: [{ id: r.id, cells }] }, [{ kind: "setCells", table: t.id, updates: [{ id: r.id, cells: old }] }]); };
    bar.addEventListener("pointermove", mv); bar.addEventListener("pointerup", up);
  };
  const months: { at: number; label: string }[] = []; for (let d = new Date(from); d.getTime() < to; d.setUTCMonth(d.getUTCMonth() + 1)) months.push({ at: pct(d.getTime()), label: d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) });
  return <div className="bx-time"><div className="bx-time-in" style={{ minWidth: Math.max(800, span * 8) + 220 }}>
    <div className="bx-time-head"><span>{t.fields[0].name}</span><div>{months.map((m) => <b key={m.label} style={{ left: `${m.at}%` }}>{m.label}</b>)}</div></div>
    {items.map(({ r, s, e }) => <div className="bx-time-row" key={r.id}><button type="button" onClick={() => open(r)}>{eng.title(r)}</button><div>{months.map((m) => <i key={m.label} style={{ left: `${m.at}%` }} />)}<button type="button" className="bx-bar-item" title={`${new Date(s).toISOString().slice(0, 10)} to ${new Date(e).toISOString().slice(0, 10)}`} style={{ left: `${pct(s)}%`, width: `max(10px, ${pct(e + day) - pct(s)}%)` }} onClick={() => { if (!moved.current) open(r); moved.current = false; }} onPointerDown={(ev) => startDrag(ev, r, s, e)}><span>{eng.title(r)}</span></button></div></div>)}
  </div></div>;
}

const AGG: [string, string][] = [["count", "Number of records"], ["sum", "Sum"], ["avg", "Average"], ["min", "Lowest"], ["max", "Highest"]];
function Element({ b, e, onOpen }: { b: Base; e: InterfaceElement; onOpen: (t: Table, r: Rec) => void }) {
  const t = b.tables.find((x) => x.id === e.table);
  const eng = useMemo(() => (t ? compute(b, t) : null), [b, t]);
  if (!t || !eng) return <p className="muted small">This element&apos;s table no longer exists.</p>;
  const f = t.fields.find((x) => x.id === e.field), v = t.views.find((x) => x.id === e.view), rows = v ? viewRecords(eng, t, v) : t.records;
  if (e.type === "number") return <div className="kpi-v">{e.agg === "count" || !f ? rows.length.toLocaleString("en-US") : summarize(e.agg ?? "sum", rows.map((r) => eng.value(r, f))) || "0"}</div>;
  if (e.type === "chart") {
    if (!f) return <p className="muted small">Choose a field to group by.</p>;
    const m = t.fields.find((x) => x.id === e.measure), groups = new Map<string, Rec[]>();
    for (const r of rows) { const k = eng.display(r, f) || "Empty"; groups.set(k, [...(groups.get(k) ?? []), r]); }
    const list = [...groups].map(([name, rs]) => ({ name, n: m ? rs.reduce((a, r) => a + (Number(eng.value(r, m)) || 0), 0) : rs.length })).sort((a, z) => z.n - a.n).slice(0, 12), hi = Math.max(1, ...list.map((x) => x.n));
    return <div className="bx-bars" role="img" aria-label={`${e.title}: ${list.map((x) => `${x.name} ${x.n}`).join(", ")}`}>{list.map((x) => <div key={x.name}><span title={x.name}>{x.name}</span><i><u style={{ width: `${(x.n / hi) * 100}%` }} /></i><b>{x.n.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b></div>)}</div>;
  }
  const cols = t.fields.filter((x) => !v?.hidden.includes(x.id)).slice(0, 5);
  return <div className="tbl-wrap"><table className="tbl"><thead><tr>{cols.map((c) => <th key={c.id}>{c.name}</th>)}</tr></thead><tbody>{rows.slice(0, 50).map((r) => <tr key={r.id} className="click" onClick={() => onOpen(t, r)}>{cols.map((c) => <td key={c.id}>{eng.display(r, c)}</td>)}</tr>)}</tbody></table></div>;
}

/** Pages made from a base's data, for people who shouldn't need to see its tables. */
export function Interfaces({ base, editable, send, onClose, onOpen }: { base: Base; editable: boolean; send: (o: Op) => void; onClose: () => void; onOpen: (t: Table, r: Rec) => void }) {
  const list = base.interfaces ?? [], [sel, setSel] = useState(list[0]?.id ?? ""), [adding, setAdding] = useState(false), cur = list.find((x) => x.id === sel) ?? list[0];
  const [d, setD] = useState<InterfaceElement>({ id: uid(), type: "number", title: "", table: base.tables[0].id, agg: "count" }), [tried, setTried] = useState(false);
  const t = base.tables.find((x) => x.id === d.table);
  const create = () => { const i: BaseInterface = { id: uid(), name: `Page ${list.length + 1}`, elements: [] }; send({ kind: "saveInterface", page: i }); setSel(i.id); };
  const add = () => { setTried(true); if (!cur || !d.title.trim()) return; send({ kind: "saveInterface", page: { ...cur, elements: [...cur.elements, d] } }); setD({ id: uid(), type: "number", title: "", table: base.tables[0].id, agg: "count" }); setTried(false); setAdding(false); };
  return <Modal full title="Interfaces" onClose={onClose}>
    <div className="bx-row bx-int-bar">{list.map((i) => <Btn key={i.id} className={i.id === cur?.id ? "on" : ""} onClick={() => setSel(i.id)}>{i.name}</Btn>)}{editable && <Btn icon="plus" onClick={create}>New page</Btn>}<span className="grow" />{editable && cur && <><input className="input" aria-label="Page name" value={cur.name} onChange={(e) => send({ kind: "saveInterface", page: { ...cur, name: e.target.value } })} /><Btn icon="plus" variant="primary" onClick={() => setAdding(true)}>Add element</Btn><Btn icon="trash" variant="ghost" aria-label="Delete this page" onClick={() => { send({ kind: "deleteInterface", id: cur.id }); setSel(""); }} /></>}</div>
    {!cur ? <Empty icon="grid" title="No interface pages yet" action={editable ? <Btn variant="primary" icon="plus" onClick={create}>Create a page</Btn> : undefined}>Build simple pages with numbers, charts and lists from this base.</Empty>
      : !cur.elements.length ? <Empty icon="chart" title="This page is empty" action={editable ? <Btn variant="primary" icon="plus" onClick={() => setAdding(true)}>Add an element</Btn> : undefined}>Add a number, a chart or a list of records.</Empty>
        : <div className="bx-int">{cur.elements.map((e) => <section key={e.id} className={`bx-int-el t-${e.type}`}><header><h3>{e.title}</h3>{editable && <Btn icon="x" variant="ghost" aria-label={`Remove ${e.title}`} onClick={() => send({ kind: "saveInterface", page: { ...cur, elements: cur.elements.filter((x) => x.id !== e.id) } })} />}</header><Element b={base} e={e} onOpen={onOpen} /></section>)}</div>}
    {adding && <Modal sheet title="Add an element" onClose={() => setAdding(false)} foot={<><Btn onClick={() => setAdding(false)}>Cancel</Btn><Btn variant="primary" onClick={add}>Add element</Btn></>}>
      <FormField label="Title" error={tried && !d.title.trim() ? "Give this element a title." : undefined}><input className="input" autoFocus value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></FormField>
      <FormField label="Type"><Sel options={[["number", "Number"], ["chart", "Bar chart"], ["list", "List of records"]]} value={d.type} onChange={(v) => setD({ ...d, type: v as InterfaceElement["type"] })} /></FormField>
      <FormField label="Table"><Sel options={base.tables.map((x): [string, string] => [x.id, x.name])} value={d.table} onChange={(v) => setD({ ...d, table: v, field: undefined, measure: undefined, view: undefined })} /></FormField>
      {t && <FormField label="Use this view" hint="Its filters decide which records count."><Sel options={[["", "All records"], ...t.views.filter((v) => v.type !== "form").map((v): [string, string] => [v.id, v.name])]} value={d.view ?? ""} onChange={(v) => setD({ ...d, view: v || undefined })} /></FormField>}
      {d.type === "number" && <FormField label="Calculate"><Sel options={AGG} value={d.agg ?? "count"} onChange={(v) => setD({ ...d, agg: v })} /></FormField>}
      {d.type === "number" && d.agg !== "count" && t && <FormField label="Of field"><Sel options={[["", "Choose a field"], ...t.fields.map((f): [string, string] => [f.id, f.name])]} value={d.field ?? ""} onChange={(v) => setD({ ...d, field: v })} /></FormField>}
      {d.type === "chart" && t && <><FormField label="Group by"><Sel options={[["", "Choose a field"], ...t.fields.map((f): [string, string] => [f.id, f.name])]} value={d.field ?? ""} onChange={(v) => setD({ ...d, field: v })} /></FormField><FormField label="Bar length"><Sel options={[["", "Number of records"], ...t.fields.filter((f) => ["number", "currency", "percent", "rollup", "formula", "count", "rating", "duration"].includes(f.type)).map((f): [string, string] => [f.id, `Sum of ${f.name}`])]} value={d.measure ?? ""} onChange={(v) => setD({ ...d, measure: v || undefined })} /></FormField></>}
    </Modal>}
  </Modal>;
}

type Token = { id: string; name: string; scope: string; prefix: string; createdAt: string; createdBy: string };
/** Tokens are shown once and only a hash is kept, so a lost token is replaced rather than recovered. */
export function ApiSheet({ base, onClose }: { base: Base; onClose: () => void }) {
  const [list, setList] = useState<Token[] | null>(null), [name, setName] = useState(""), [scope, setScope] = useState("read"), [made, setMade] = useState(""), [tried, setTried] = useState(false);
  const load = () => call<{ tokens: Token[] }>("/api/bases", { json: { action: "tokens", id: base.id } }).then((r) => setList(r.tokens), (e) => toast(e.message, true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  const create = async () => { setTried(true); if (!name.trim()) return; try { const r = await call<{ token: string }>("/api/bases", { json: { action: "createToken", id: base.id, name, scope } }); setMade(r.token); setName(""); setTried(false); void load(); } catch (e) { toast((e as Error).message, true); } };
  const url = `${typeof location === "undefined" ? "" : location.origin}/api/v1/${base.id}/${encodeURIComponent(base.tables[0].name)}`;
  return <Modal sheet title="API access" onClose={onClose}>
    <p className="small muted">Read and change this base from your own tools. Records use field names, and each request can change up to 10 records. Each token can make 5 requests a second.</p>
    {made && <SuccessState title="Token created"><span className="small">Copy this now. It isn&apos;t shown again.</span></SuccessState>}
    {made && <code className="token-box">{made}</code>}
    <FormField label="Token name" error={tried && !name.trim() ? "Name this token." : undefined} hint="Such as the tool that will use it."><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></FormField>
    <FormField label="Access"><Sel options={[["read", "Read records"], ["write", "Read and change records"]]} value={scope} onChange={setScope} /></FormField>
    <div><Btn variant="primary" onClick={create}>Create token</Btn></div>
    <h3>Tokens</h3>
    {list && !list.length && <p className="small muted">No tokens yet.</p>}
    {list?.map((x) => <div className="bx-token" key={x.id}><span><b>{x.name}</b><small className="muted">{x.prefix}... {x.scope === "write" ? "Read and change" : "Read"}, created {when(x.createdAt)}</small></span><Btn icon="trash" variant="ghost" aria-label={`Revoke ${x.name}`} onClick={async () => { await call("/api/bases", { json: { action: "revokeToken", id: base.id, token: x.id } }).catch((e) => toast(e.message, true)); void load(); }} /></div>)}
    <h3>Example</h3>
    <code className="token-box">{`curl "${url}?pageSize=10" \\\n  -H "Authorization: Bearer YOUR_TOKEN"`}</code>
    <p className="small muted"><Icon name="book" size={14} style={{ verticalAlign: -2, marginRight: 4, display: "inline" }} />The full reference is in Docs, under Bases.</p>
  </Modal>;
}

export function SyncSheet({ base, onClose, onDone }: { base: Base; onClose: () => void; onDone: (table: string) => void }) {
  const [others, setOthers] = useState<{ id: string; name: string }[] | null>(null), [src, setSrc] = useState<Base | null>(null), [table, setTable] = useState(""), [view, setView] = useState(""), [err, setErr] = useState("");
  useEffect(() => { call<{ bases: { id: string; name: string }[] }>("/api/bases").then((r) => setOthers(r.bases.filter((b) => b.id !== base.id)), (e) => setErr(e.message)); }, [base.id]);
  const pick = (id: string) => { setSrc(null); setTable(""); setView(""); if (id) call<{ base: Base }>(`/api/bases?id=${id}`).then((r) => setSrc(r.base), (e) => setErr(e.message)); };
  const t = src?.tables.find((x) => x.id === table);
  const go = async () => { setErr(""); try { const r = await call<{ table: string }>("/api/bases", { json: { action: "sync", id: base.id, base: src!.id, table, view: view || undefined } }); toast("Table synced"); onDone(r.table); } catch (e) { setErr((e as Error).message); } };
  return <Modal sheet title="Sync from another base" onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={!src || !table} onClick={go}>Sync table</Btn></>}>
    <p className="small muted">Adds a read-only copy of a table here. It updates whenever the original changes. Links and formulas arrive as plain text.</p>
    {others && !others.length ? <div className="banner info"><Icon name="info" />Create another base first.</div> : <FormField label="Base"><Sel options={[["", "Choose a base"], ...(others ?? []).map((b): [string, string] => [b.id, b.name])]} value={src?.id ?? ""} onChange={pick} /></FormField>}
    {src && <FormField label="Table"><Sel options={[["", "Choose a table"], ...src.tables.filter((x) => !x.sync).map((x): [string, string] => [x.id, x.name])]} value={table} onChange={(v) => { setTable(v); setView(""); }} /></FormField>}
    {t && <FormField label="Only records in this view" hint="Optional. Its filters decide what's synced."><Sel options={[["", "All records"], ...t.views.filter((v) => v.type === "grid").map((v): [string, string] => [v.id, v.name])]} value={view} onChange={setView} /></FormField>}
    {err && <div className="banner bad" role="alert"><Icon name="warn" />{err}</div>}
  </Modal>;
}

/** Built-in tools that act on a table. Custom third-party code isn't supported, because it would run with this user's access. */
export function Extensions({ base, table, eng, editable, send, onClose }: { base: Base; table: Table; eng: Computed; editable: boolean; send: (o: Op) => void; onClose: () => void }) {
  const [tool, setTool] = useState<string>("find"), [q, setQ] = useState(""), [to, setTo] = useState(""), [field, setField] = useState(""), [rowF, setRowF] = useState(""), [colF, setColF] = useState("");
  const texts = table.fields.filter((f) => f.type === "text" || f.type === "longText" || f.type === "url" || f.type === "email" || f.type === "phone"), target = texts.filter((f) => !field || f.id === field);
  const hits = q ? table.records.flatMap((r) => target.filter((f) => String(r.cells[f.id] ?? "").toLowerCase().includes(q.toLowerCase())).map((f) => ({ r, f }))) : [];
  const replace = () => { const low = q.toLowerCase(), updates = new Map<string, Record<string, unknown>>(); for (const { r, f } of hits) { const s = String(r.cells[f.id]); let out = "", i = 0, at; while ((at = s.toLowerCase().indexOf(low, i)) >= 0) { out += s.slice(i, at) + to; i = at + low.length; } updates.set(r.id, { ...updates.get(r.id), [f.id]: out + s.slice(i) }); } send({ kind: "setCells", table: table.id, updates: [...updates].map(([id, cells]) => ({ id, cells })) }); toast(`Replaced in ${updates.size} record${updates.size === 1 ? "" : "s"}`); setQ(""); };
  const dup = table.fields.find((f) => f.id === (field || table.fields[0].id)), groups = new Map<string, Rec[]>(); if (tool === "dupes" && dup) for (const r of table.records) { const k = eng.display(r, dup).trim().toLowerCase(); if (k) groups.set(k, [...(groups.get(k) ?? []), r]); }
  const dupes = [...groups.values()].filter((g) => g.length > 1);
  const removeDupes = () => { const ids = dupes.flatMap((g) => g.slice(1).map((r) => r.id)); send({ kind: "deleteRecords", table: table.id, ids }); toast(`Deleted ${ids.length} duplicate${ids.length === 1 ? "" : "s"}, keeping the oldest of each`); };
  const rf = table.fields.find((f) => f.id === rowF), cf = table.fields.find((f) => f.id === colF), cols = cf ? [...new Set(table.records.map((r) => eng.display(r, cf) || "Empty"))].slice(0, 20) : [], rows = rf ? [...new Set(table.records.map((r) => eng.display(r, rf) || "Empty"))].slice(0, 200) : [];
  const opts = table.fields.map((f): [string, string] => [f.id, f.name]);
  return <Modal full wide title={`Extensions: ${table.name}`} onClose={onClose}>
    <div className="seg bx-tabs" role="tablist">{([["find", "Find and replace"], ["dupes", "Find duplicates"], ["pivot", "Pivot table"], ["custom", "Custom"], ...(base.extensions ?? []).map((x): [string, string] => [x.id, x.name])] as [string, string][]).map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tool === k} onClick={() => setTool(k)}>{l}</button>)}</div>
    {tool === "find" && <><div className="form-row"><FormField label="Find"><input className="input" value={q} onChange={(e) => setQ(e.target.value)} /></FormField><FormField label="Replace with"><input className="input" value={to} onChange={(e) => setTo(e.target.value)} /></FormField><FormField label="In"><Sel options={[["", "All text fields"], ...texts.map((f): [string, string] => [f.id, f.name])]} value={field} onChange={setField} /></FormField></div><div className="bx-row"><Btn variant="primary" disabled={!hits.length || !editable} onClick={replace}>Replace {hits.length || ""}</Btn>{q && <span className="small muted">{hits.length} match{hits.length === 1 ? "" : "es"}</span>}</div>{!editable && <p className="small muted">This table can&apos;t be edited here.</p>}</>}
    {tool === "dupes" && <><FormField label="Compare this field"><Sel options={opts} value={dup?.id ?? ""} onChange={setField} /></FormField>{!dupes.length ? <Empty compact icon="check" title="No duplicates found">Every value in this field is different.</Empty> : <><div className="bx-row"><Btn variant="danger" disabled={!editable} onClick={removeDupes}>Delete duplicates, keep the oldest</Btn><span className="small muted">{dupes.length} repeated value{dupes.length === 1 ? "" : "s"}</span></div><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Value</th><th>Records</th></tr></thead><tbody>{dupes.slice(0, 100).map((g) => <tr key={g[0].id}><td>{eng.display(g[0], dup!)}</td><td>{g.length}</td></tr>)}</tbody></table></div></>}</>}
    {tool === "pivot" && <><div className="form-row"><FormField label="Rows"><Sel options={[["", "Choose a field"], ...opts]} value={rowF} onChange={setRowF} /></FormField><FormField label="Columns"><Sel options={[["", "Choose a field"], ...opts]} value={colF} onChange={setColF} /></FormField></div>{rf && cf ? <div className="tbl-wrap"><table className="tbl"><thead><tr><th>{rf.name}</th>{cols.map((x) => <th key={x}>{x}</th>)}<th>Total</th></tr></thead><tbody>{rows.map((x) => { const inRow = table.records.filter((r) => (eng.display(r, rf) || "Empty") === x); return <tr key={x}><td><b className="cell-strong">{x}</b></td>{cols.map((y) => <td key={y}>{inRow.filter((r) => (eng.display(r, cf) || "Empty") === y).length || ""}</td>)}<td>{inRow.length}</td></tr>; })}</tbody></table></div> : <Empty compact icon="pivot" title="Choose rows and columns">See how many records fall into each pair of values.</Empty>}</>}
    {tool === "custom" && <CustomExtensions base={base} send={send} open={setTool} />}
    {base.extensions?.filter((x) => x.id === tool).map((x) => <ExtensionFrame key={x.id} ext={x} table={table} eng={eng} editable={editable} send={send} />)}
  </Modal>;
}

const EXT_TEMPLATE = `<h3>Records</h3>
<div id="n">Loading</div>
<script>
  // Ask Basalt for this table's records. updateRecord needs "Can change records" turned on.
  basalt.getRecords().then((rows) => { document.getElementById("n").textContent = rows.length + " records"; });
</script>`;
function CustomExtensions({ base, send, open }: { base: Base; send: (o: Op) => void; open: (id: string) => void }) {
  const isAdmin = useApp((s) => s.can)("admin"), [d, setD] = useState({ name: "", code: EXT_TEMPLATE, canWrite: false }), [tried, setTried] = useState(false);
  if (!isAdmin) return <PermissionDenied title="Only admins can add custom extensions">Ask an admin to add one.</PermissionDenied>;
  return <div className="bx-auto">
    <p className="small muted">Write HTML and JavaScript that runs in a locked frame. It can&apos;t reach this site or your session, and it can only read the open table and, if you allow it, change its records. Its web requests are blocked, but the code can still send its frame to another address and carry what it read with it, so only add code you trust.</p>
    <FormField label="Name" error={tried && !d.name.trim() ? "Name this extension." : undefined}><input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></FormField>
    <FormField label="Code"><textarea className="input mono" rows={10} spellCheck={false} value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} /></FormField>
    <label className="check"><input type="checkbox" checked={d.canWrite} onChange={(e) => setD({ ...d, canWrite: e.target.checked })} />Can change records</label>
    <div><Btn variant="primary" onClick={() => { setTried(true); if (!d.name.trim()) return; const x = { id: uid(), name: d.name.trim(), code: d.code, canWrite: d.canWrite }; send({ kind: "saveExtension", extension: x }); open(x.id); }}>Add extension</Btn></div>
    {base.extensions?.map((x) => <div key={x.id} className="bx-token"><span><b>{x.name}</b><small className="muted">{x.canWrite ? "Can change records" : "Read only"}</small></span><Btn icon="trash" variant="ghost" aria-label={`Delete ${x.name}`} onClick={() => send({ kind: "deleteExtension", id: x.id })} /></div>)}
  </div>;
}

/** sandbox="allow-scripts" without allow-same-origin gives the frame a throwaway origin, and the CSP blocks fetches, forms and outside content. No CSP rule stops the frame navigating itself, so what it reads can still leave, which is why only admins can save extensions. */
function ExtensionFrame({ ext, table, eng, editable, send }: { ext: BaseExtension; table: Table; eng: Computed; editable: boolean; send: (o: Op) => void }) {
  const frame = useRef<HTMLIFrameElement>(null), live = useRef({ table, eng });
  useEffect(() => { live.current = { table, eng }; }, [table, eng]);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data || typeof e.data !== "object") return;
      const { id, type, record, fields } = e.data as { id: number; type: string; record?: string; fields?: Record<string, unknown> }, { table: t, eng: en } = live.current;
      const reply = (result: unknown, error?: string) => frame.current?.contentWindow?.postMessage({ id, result, error }, "*");
      if (type === "getRecords") reply(t.records.slice(0, 50000).map((r) => ({ id: r.id, fields: Object.fromEntries(t.fields.map((f) => [f.name, en.display(r, f)])) })));
      else if (type === "updateRecord") {
        if (!ext.canWrite || !editable) return reply(null, "This extension can't change records.");
        if (!t.records.some((r) => r.id === record)) return reply(null, "That record doesn't exist.");
        const cells: Record<string, unknown> = {}; for (const [k, v] of Object.entries(fields ?? {})) { const f = t.fields.find((x) => x.name === k); if (!f) return reply(null, `There's no field called ${k}.`); cells[f.id] = v; }
        send({ kind: "setCells", table: t.id, updates: [{ id: String(record), cells }] }); reply(true);
      } else reply(null, "Basalt doesn't recognise that request.");
    };
    addEventListener("message", on); return () => removeEventListener("message", on);
  }, [ext.canWrite, editable, send]);
  const doc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"><style>body{font:14px system-ui,sans-serif;margin:16px;color:#171a21;background:#fff}</style><script>window.basalt=(function(){var n=0,w={};addEventListener("message",function(e){if(e.source!==parent)return;var p=w[e.data.id];if(!p)return;delete w[e.data.id];e.data.error?p[1](new Error(e.data.error)):p[0](e.data.result)});function c(m){return new Promise(function(a,b){m.id=++n;w[m.id]=[a,b];parent.postMessage(m,"*")})}return{getRecords:function(){return c({type:"getRecords"})},updateRecord:function(id,fields){return c({type:"updateRecord",record:id,fields:fields})}}})();<\/script></head><body>${ext.code}</body></html>`;
  return <iframe ref={frame} className="bx-ext" title={ext.name} sandbox="allow-scripts" srcDoc={doc} />;
}
