"use client";
import { useCallback, useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import { Icon } from "@/components/icons";
import { Btn, Confirm, Empty, Field, Modal, Sel, toast } from "@/components/ui";
import { call, refreshTables, useApp, when } from "@/lib/client";
import { RULE_LABELS } from "@/lib/pii";
import type { Rule } from "@/lib/types";

type Stream = { id: string; name: string; table: string; uniqueField?: string; rules: Record<string, Rule>; prefix: string; rebuildModels?: boolean; heldBack?: { column: string; kind: string }[]; lastError?: string; rows: number; lastAt?: string; perSecond: number; columns: { name: string; type: string }[] };
const RULES = Object.entries(RULE_LABELS) as [Rule, string][];

const Status = ({ s }: { s: Stream }) => s.lastError ? <span className="badge bad"><Icon name="warn" size={12} />Failed</span> : s.perSecond > 0 ? <span className="badge good"><Icon name="check" size={12} />Receiving</span> : <span className="badge"><Icon name="clock" size={12} />Waiting</span>;

function TokenBox({ name, token }: { name: string; token: string }) {
  return <div className="banner info" style={{ display: "block" }}>
    <p style={{ marginBottom: 8 }}>Copy this now. The token isn&apos;t shown again.</p>
    <code className="token-box">{`curl -X POST ${location.origin}/api/ingest/${name} \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Idempotency-Key: first-batch" \\\n  -H "Content-Type: application/json" \\\n  -d '[{"id": 1, "kind": "signup"}]'`}</code>
  </div>;
}

function AddStream({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(""), [unique, setUnique] = useState(""), [made, setMade] = useState<{ name: string; token: string } | null>(null), [error, setError] = useState("");
  const add = async () => {
    setError("");
    try { setMade(await call("/api/ingest", { json: { name, uniqueField: unique } })); onDone(); } catch (e) { setError((e as Error).message); }
  };
  return <Modal sheet title="Add a stream" onClose={onClose} foot={made ? <Btn variant="primary" onClick={onClose}>Done</Btn> : <><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={!name.trim()} onClick={add}>Add stream</Btn></>}>
    {made ? <TokenBox {...made} /> : <>
      <Field label="Stream name" hint="Events go to a table of this name in raw_events"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="web_events" /></Field>
      <Field label="Unique field" hint="Optional. A later event with the same value replaces the earlier one, so a resent webhook isn't counted twice"><input className="input" value={unique} onChange={(e) => setUnique(e.target.value)} placeholder="event_id" /></Field>
      {error && <div className="banner bad" role="alert"><Icon name="warn" /><span>{error}</span></div>}
    </>}
  </Modal>;
}

function StreamSettings({ s, onClose, onDone }: { s: Stream; onClose: () => void; onDone: () => void }) {
  const [rules, setRules] = useState(s.rules), [rebuild, setRebuild] = useState(!!s.rebuildModels), [token, setToken] = useState(""), canEdit = useApp((a) => a.can)("editor");
  const names = [...new Set([...s.columns.map((c) => c.name), ...(s.heldBack ?? []).map((h) => h.column), ...Object.keys(rules)])];
  const save = async () => {
    try { await call("/api/ingest", { method: "PATCH", json: { id: s.id, rules, rebuildModels: rebuild } }); onDone(); onClose(); toast(`Saved ${s.name}`); } catch (e) { toast((e as Error).message, true); }
  };
  const rotate = async () => { try { setToken((await call<{ token: string }>("/api/ingest", { json: { rotate: s.id } })).token); onDone(); } catch (e) { toast((e as Error).message, true); } };
  return <Modal full wide title={s.name} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn>{canEdit && <Btn variant="primary" onClick={save}>Save</Btn>}</>}>
    {token && <TokenBox name={s.name} token={token} />}
    {!!s.heldBack?.length && <div className="banner warn"><Icon name="warn" /><span>Held back until a rule is chosen: {s.heldBack.map((h) => `${h.column} (${h.kind})`).join(", ")}. Values sent before you choose aren&apos;t kept.</span></div>}
    {s.lastError && <div className="banner bad"><Icon name="warn" /><span>{s.lastError}</span></div>}
    <dl className="kv"><dt>Table</dt><dd className="mono">{s.table}</dd><dt>Token</dt><dd className="mono">{s.prefix}...</dd>{s.uniqueField && <><dt>Unique field</dt><dd className="mono">{s.uniqueField}</dd></>}</dl>
    {names.length === 0 ? <Empty compact icon="table" title="No events yet">Send a first event and its fields appear here.</Empty> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Field</th><th>Type</th><th>Rule</th></tr></thead><tbody>
      {names.map((n) => <tr key={n}><td className="mono">{n}</td><td className="muted">{s.columns.find((c) => c.name === n)?.type ?? "Not stored"}</td><td><Sel aria-label={`Rule for ${n}`} disabled={!canEdit} options={[["", "Decide automatically"], ...RULES]} value={rules[n] ?? ""} onChange={(v) => { const next = { ...rules }; if (v) next[n] = v as Rule; else delete next[n]; setRules(next); }} /></td></tr>)}
    </tbody></table></div>}
    <label className="check"><input type="checkbox" checked={rebuild} disabled={!canEdit} onChange={(e) => setRebuild(e.target.checked)} />Rebuild incremental models that read this stream, at most once a minute</label>
    {canEdit && <div><Btn icon="key" onClick={rotate}>Replace the token</Btn></div>}
  </Modal>;
}

export function Streams() {
  const can = useApp((s) => s.can);
  const [list, setList] = useState<Stream[] | null>(null), [adding, setAdding] = useState(false), [open, setOpen] = useState<string | null>(null), [del, setDel] = useState<Stream | null>(null);
  const load = useCallback(() => call<Stream[]>("/api/ingest").then(setList).catch(() => setList((x) => x ?? [])), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => clearInterval(t);
  }, [load]);
  const remove = async (s: Stream) => { try { await call(`/api/ingest?id=${s.id}`, { method: "DELETE" }); await load(); await refreshTables(); toast(`Removed ${s.name}`); } catch (e) { toast((e as Error).message, true); } };
  const shown = list?.find((s) => s.id === open);
  return <section style={{ display: "grid", gap: 8, alignContent: list?.length === 0 ? "start" : undefined }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}><h2>Event streams</h2>{can("editor") && !!list?.length && <Btn icon="plus" onClick={() => setAdding(true)}>Add stream</Btn>}</div>
    {list?.length === 0 && <Empty compact icon="plug" title="No streams yet" editor action={<Btn icon="plus" variant="primary" onClick={() => setAdding(true)}>New stream</Btn>}>Send events from an application or webhook over HTTP.</Empty>}
    {!!list?.length && <DataTable<Stream> id="streams" rows={list} rowKey={(s) => s.id} selectable={false} searchPlaceholder="Search streams" initialSort={{ id: "name", dir: "asc" }}
      columns={[
        { id: "name", header: "Stream", width: 240, hideable: false, sortValue: (s) => s.name, cell: (s) => <button type="button" className="plain-link" onClick={() => setOpen(s.id)}><b>{s.name}</b></button> },
        { id: "status", header: "Status", width: 130, cell: (s) => <Status s={s} /> },
        { id: "table", header: "Table", width: 240, sortValue: (s) => s.table, cell: (s) => s.table },
        { id: "rate", header: "Events a second", width: 150, align: "end", sortValue: (s) => s.perSecond, cell: (s) => s.perSecond.toLocaleString("en-US") },
        { id: "rows", header: "Rows", width: 120, align: "end", sortValue: (s) => s.rows, cell: (s) => s.rows.toLocaleString("en-US") },
        { id: "last", header: "Last event", width: 170, sortValue: (s) => s.lastAt ?? "", cell: (s) => (s.lastAt ? when(s.lastAt) : "None yet") },
        { id: "held", header: "Held back", width: 110, align: "end", sortValue: (s) => s.heldBack?.length ?? 0, cell: (s) => s.heldBack?.length ?? 0 },
        { id: "actions", header: "", width: 70, hideable: false, align: "end", cell: (s) => can("admin") && <span className="row-actions"><Btn icon="trash" variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => setDel(s)} /></span> },
      ]} />}
    {adding && <AddStream onClose={() => setAdding(false)} onDone={() => void load()} />}
    {shown && <StreamSettings s={shown} onClose={() => setOpen(null)} onDone={() => void load()} />}
    {del && <Confirm title={`Remove ${del.name}?`} action="Remove and delete its events" body={<>This deletes the table <code>{del.table}</code> and its token. Anything still sending to it will be refused.</>} onYes={() => remove(del)} onClose={() => setDel(null)} />}
  </section>;
}
