"use client";
import { useEffect, useState } from "react";
import { Btn, Confirm, Field, Modal, Sel, Sk, Tabs, toast, Upload } from "@/components/ui";
import type { AppAudience, AppDoc, AppItem, AppSummary, StoredApp } from "@/lib/apps";
import { call, uid, when } from "@/lib/client";

type Loaded = { app: StoredApp; status: AppSummary["status"]; dashboards: { id: string; name: string }[]; members: { id: string; name: string; role: string }[] };
type Tab = "setup" | "content" | "audience" | "history";
export const STATUS_LABEL: Record<AppSummary["status"], string> = { draft: "Not published", live: "Published", changed: "Changes not published" };
export const STATUS_TONE: Record<AppSummary["status"], string> = { draft: "", live: "good", changed: "warn" };

export function AppEditor({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [state, setState] = useState<Loaded | null>(null), [doc, setDoc] = useState<AppDoc | null>(null), [base, setBase] = useState(""), [tab, setTab] = useState<Tab>("setup"), [busy, setBusy] = useState(false), [asking, setAsking] = useState<"publish" | "delete" | "unpublish" | null>(null);
  const [addDash, setAddDash] = useState(""), [link, setLink] = useState({ label: "", url: "" });
  const load = async () => { const r = await call<Loaded>(`/api/apps/${id}?edit=1`); setState(r); setDoc(r.app.draft); setBase(r.app.updatedAt); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load().catch((e) => { toast(e.message, true); onClose(); }); }, [id]);
  if (!state || !doc) return <Modal full wide title="App" onClose={onClose}><Sk h={120} /></Modal>;

  const up = (p: Partial<AppDoc>) => setDoc({ ...doc, ...p });
  const upItem = (i: string, p: Partial<AppItem>) => up({ items: doc.items.map((x) => (x.id === i ? { ...x, ...p } as AppItem : x)) });
  const move = (i: number, by: number) => { const items = [...doc.items]; const [x] = items.splice(i, 1); items.splice(i + by, 0, x); up({ items }); };
  // As in Power BI: everything is included on the first publish, and later additions stay hidden until you choose who sees them
  const addItem = (x: AppItem) => up({ items: [...doc.items, x], audiences: state.app.versions.length ? doc.audiences : doc.audiences.map((a) => ({ ...a, items: [...a.items, x.id] })) });
  const upAud = (i: string, p: Partial<AppAudience>) => up({ audiences: doc.audiences.map((a) => (a.id === i ? { ...a, ...p } : a)) });
  const flip = (list: string[], v: string, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  const act = async (json: object, done: string) => { setBusy(true); try { await call(`/api/apps/${id}`, { json }); toast(done); await load(); onChanged(); } catch (e) { toast((e as Error).message, true); } setBusy(false); };
  const logo = (f?: File) => { if (!f) return; if (f.size > 200 * 1024) { toast("Choose an image of up to 200 KB.", true); return; } const r = new FileReader(); r.onload = () => up({ logo: String(r.result) }); r.readAsDataURL(f); };
  const viewers = state.members.filter((m) => m.role === "viewer"), live = state.app.live;
  const deps = [...new Set(doc.items.flatMap((i) => (i.kind === "dashboard" ? [state.dashboards.find((d) => d.id === i.dashboard)?.name ?? i.label] : [])))].join(", ");

  return <Modal full wide title={doc.name || "App"} onClose={onClose} foot={<>
    <span className={`badge dot ${STATUS_TONE[state.status]}`}>{STATUS_LABEL[state.status]}{live ? `, version ${live}` : ""}</span>
    <span className="grow" />
    <Btn disabled={busy} onClick={() => act({ action: "save", doc, base }, "Draft saved")}>Save draft</Btn>
    <Btn variant="primary" disabled={busy} onClick={() => setAsking("publish")}>Publish</Btn>
  </>}>
    <div className="app-edit">
      <Tabs<Tab> tabs={[["setup", "Setup"], ["content", "Pages"], ["audience", "Audiences"], ["history", "History"]]} value={tab} onChange={setTab} />
      {tab === "setup" && <>
        <Field label="App name"><input className="input" maxLength={80} value={doc.name} onChange={(e) => up({ name: e.target.value })} /></Field>
        <div className="field"><span className="lab">Logo</span><div className="tile-row">{/* eslint-disable @next/next/no-img-element */}{doc.logo && <img className="app-logo" src={doc.logo} alt="" />}<Upload label={doc.logo ? "Replace logo" : "Upload logo"} ariaLabel="Logo file" accept="image/png,image/jpeg,image/webp" onFiles={(f) => logo(f[0])} />{doc.logo && <Btn onClick={() => up({ logo: undefined })}>Remove</Btn>}</div></div>
        <div className="tile-row">{live && <Btn disabled={busy} onClick={() => setAsking("unpublish")}>Unpublish</Btn>}<Btn variant="danger" icon="trash" disabled={busy} onClick={() => setAsking("delete")}>Delete app</Btn></div>
      </>}
      {tab === "content" && <>
        {!!doc.items.length && <div className="tbl-wrap app-table"><table className="tbl"><thead><tr><th>Name in navigation</th><th>Opens</th><th /></tr></thead><tbody>{doc.items.map((x, i) => <tr key={x.id}>
          <td><input className="input" aria-label="Name in navigation" value={x.label} onChange={(e) => upItem(x.id, { label: e.target.value })} /></td>
          <td>{x.kind === "link" ? <input className="input" aria-label="Link address" value={x.url} onChange={(e) => upItem(x.id, { url: e.target.value })} /> : state.dashboards.find((d) => d.id === x.dashboard)?.name ?? <span className="err small">Dashboard deleted</span>}</td>
          <td className="num"><span className="app-move"><Btn className="app-up" icon="chevDown" variant="ghost" aria-label={`Move ${x.label} up`} disabled={i === 0} onClick={() => move(i, -1)} /><Btn icon="chevDown" variant="ghost" aria-label={`Move ${x.label} down`} disabled={i === doc.items.length - 1} onClick={() => move(i, 1)} /><Btn icon="x" variant="ghost" aria-label={`Remove ${x.label}`} onClick={() => up({ items: doc.items.filter((y) => y.id !== x.id), audiences: doc.audiences.map((a) => ({ ...a, items: a.items.filter((y) => y !== x.id) })) })} /></span></td>
        </tr>)}</tbody></table></div>}
        <div className="form-row"><Field label="Add a dashboard"><Sel options={[["", "Choose a dashboard"], ...state.dashboards.filter((d) => !doc.items.some((i) => i.kind === "dashboard" && i.dashboard === d.id)).map((d): [string, string] => [d.id, d.name])]} value={addDash} onChange={setAddDash} /></Field><div className="field"><span className="lab">&nbsp;</span><Btn icon="plus" disabled={!addDash} onClick={() => { addItem({ id: uid(), kind: "dashboard", dashboard: addDash, label: state.dashboards.find((d) => d.id === addDash)!.name }); setAddDash(""); }}>Add dashboard</Btn></div></div>
        <div className="form-row"><Field label="Link name"><input className="input" value={link.label} onChange={(e) => setLink({ ...link, label: e.target.value })} /></Field><Field label="Link address"><input className="input" placeholder="https://" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} /></Field><div className="field"><span className="lab">&nbsp;</span><Btn icon="plus" disabled={!link.label.trim() || !/^https?:\/\/\S+$/i.test(link.url.trim())} onClick={() => { addItem({ id: uid(), kind: "link", label: link.label.trim(), url: link.url.trim() }); setLink({ label: "", url: "" }); }}>Add link</Btn></div></div>
      </>}
      {tab === "audience" && <>
        <div className="banner info"><span>Editors and admins see every page. An audience limits viewers, and viewers still reach tables through SQL unless a table or row rule stops them.</span></div>
        {doc.audiences.map((a) => <section key={a.id} className="app-audience">
          <div><Field label="Audience name"><input className="input" value={a.name} onChange={(e) => upAud(a.id, { name: e.target.value })} /></Field><Btn icon="trash" variant="ghost" aria-label={`Remove ${a.name}`} onClick={() => up({ audiences: doc.audiences.filter((x) => x.id !== a.id) })} /></div>
          <div className="field"><span className="lab">People</span><div className="app-checks"><label className="check"><input type="checkbox" checked={a.roles.includes("viewer")} onChange={(e) => upAud(a.id, { roles: e.target.checked ? ["viewer"] : [] })} />Everyone with the viewer role</label>{viewers.map((m) => <label key={m.id} className="check"><input type="checkbox" checked={a.members.includes(m.id)} onChange={(e) => upAud(a.id, { members: flip(a.members, m.id, e.target.checked) })} />{m.name}</label>)}</div></div>
          <div className="field"><span className="lab">Pages</span><div className="app-checks">{doc.items.map((x) => <label key={x.id} className="check"><input type="checkbox" checked={a.items.includes(x.id)} onChange={(e) => upAud(a.id, { items: flip(a.items, x.id, e.target.checked) })} />{x.label}</label>)}</div></div>
        </section>)}
        <div><Btn icon="plus" onClick={() => up({ audiences: [...doc.audiences, { id: uid(), name: `Audience ${doc.audiences.length + 1}`, roles: [], members: [], items: doc.items.map((x) => x.id) }] })}>Add audience</Btn></div>
      </>}
      {tab === "history" && (!state.app.versions.length ? <p className="muted">Nothing published yet.</p> : <div className="tbl-wrap app-table"><table className="tbl"><thead><tr><th>Version</th><th>Published</th><th>By</th><th>Pages</th><th>Note</th><th /></tr></thead><tbody>{state.app.versions.map((v) => <tr key={v.n}><td>{v.n}{v.n === live && <span className="badge good" style={{ marginLeft: 8 }}>Live</span>}</td><td>{when(v.at)}</td><td>{v.by}</td><td>{v.doc.items.length}</td><td>{v.note}</td><td className="num">{v.n !== live && <Btn disabled={busy} onClick={() => act({ action: "rollback", version: v.n }, `Version ${v.n} is live again`)}>Roll back</Btn>}</td></tr>)}</tbody></table></div>)}
    </div>
    {asking === "publish" && <Confirm title={`Publish ${doc.name}?`} action="Publish" body={`Readers get a frozen copy of ${deps || "these pages"}. Viewers will then read those dashboards only through this app, and they keep reading this copy until you publish again.`} onYes={() => act({ action: "publish", doc, base }, "Published")} onClose={() => setAsking(null)} />}
    {asking === "unpublish" && <Confirm title={`Unpublish ${doc.name}?`} action="Unpublish" body="Readers lose this app. Its dashboards go back to following the workspace's normal access." onYes={() => act({ action: "unpublish" }, "Unpublished")} onClose={() => setAsking(null)} />}
    {asking === "delete" && <Confirm title={`Delete ${doc.name}?`} action="Delete app" body="The app and its history are removed. Its dashboards aren't affected." onYes={() => call(`/api/apps/${id}`, { json: { action: "delete" } }).then(() => { toast("App deleted"); location.assign("/apps"); }, (e) => toast(e.message, true))} onClose={() => setAsking(null)} />}
  </Modal>;
}
