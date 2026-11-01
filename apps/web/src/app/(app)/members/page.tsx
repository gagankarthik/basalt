"use client";
import { useEffect, useState } from "react";
import { IDLE_OPTIONS, MAX_OPTIONS } from "@/lib/sessionPolicy";
import DataTable from "@/components/DataTable";
import { Icon } from "@/components/icons";
import { Avatar, Btn, Confirm, ErrorState, Field, Modal, PageHead, PermissionDenied, Pop, Sel, LoadingTable, Tabs, toast } from "@/components/ui";
import { call, useApp, when, useNewHandler } from "@/lib/client";
import type { AuditEntry, Member, RlsRule, Role } from "@/lib/types";

const ROLES: [Role, string][] = [["admin", "Admin"], ["editor", "Editor"], ["viewer", "Viewer"]];
const ABOUT: [string, string][] = [["Admin", "Everything, including members and removing connections"], ["Editor", "Connections, pipelines, models, dashboards and any SQL"], ["Viewer", "Dashboards, data views and read-only SQL"]];

type Sso = { enabled: boolean; name: string; issuer: string; clientId: string; publicUrl: string; defaultRole: Role; allowedDomain: string; enforce: boolean; trustEmails?: boolean; hasSecret: boolean };
type Admin = { members: Member[]; audit: AuditEntry[]; rls: RlsRule[]; sso: Sso; security: { requireMfa: boolean; idleMinutes: number; maxHours: number } };

function RowAccess({ members, saved, onSave }: { members: Member[]; saved: RlsRule[]; onSave: (r: RlsRule[]) => void }) {
  const viewers = members.filter((m) => m.role === "viewer");
  const [rules, setRules] = useState(saved);
  const up = (id: string, p: Partial<RlsRule>) => setRules(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  return <section style={{ display: "grid", gap: 12 }}>
    <div><h2>Limit which rows a viewer can see</h2><p className="muted small" style={{ marginTop: 4 }}>A viewer with a rule only sees matching rows in dashboards, data views, exports and SQL. Tables without the field are hidden from them. Viewers without a rule see everything. Rules don&apos;t apply to editors and admins, because they can change models and data.</p></div>
    {!viewers.length && <div className="banner info"><Icon name="info" />Add a member with the Viewer role to create a rule.</div>}
    {rules.map((r) => <div key={r.id} className="rule-row">
      <Sel aria-label="Viewer" options={[["", "Choose a viewer"], ...viewers.map((m): [string, string] => [m.id, m.name])]} value={r.userId} onChange={(v) => up(r.id, { userId: v })} />
      <input className="input mono" aria-label="Field" placeholder="Field, such as city" value={r.column} onChange={(e) => up(r.id, { column: e.target.value })} />
      <input className="input" aria-label="Allowed values" placeholder="Allowed values, separated by commas" value={r.values.join(",")} onChange={(e) => up(r.id, { values: e.target.value.split(",") })} />
      <Btn icon="trash" variant="ghost" aria-label="Remove rule" onClick={() => setRules(rules.filter((x) => x.id !== r.id))} />
    </div>)}
    <div style={{ display: "flex", gap: 8 }}>{viewers.length > 0 && <Btn icon="plus" onClick={() => setRules([...rules, { id: crypto.randomUUID(), userId: "", column: "", values: [] }])}>Add rule</Btn>}<Btn variant="primary" disabled={JSON.stringify(rules) === JSON.stringify(saved)} onClick={() => onSave(rules)}>Save rules</Btn></div>
  </section>;
}

function SsoForm({ saved, onSave }: { saved: Sso; onSave: (s: Sso & { secret: string }) => void }) {
  const [s, setS] = useState({ ...saved, secret: "" });
  const on = (k: keyof Sso | "secret") => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: e.target.value });
  return <section className="form-page">
    <div><h2>Single sign-on</h2><p className="muted small" style={{ marginTop: 4 }}>Works with identity providers that support OpenID Connect, such as Okta, Microsoft Entra ID and Google Workspace. Add this redirect address to your provider: <code>{(s.publicUrl || "https://your-server").replace(/\/+$/, "")}/api/auth/sso/callback</code></p></div>
    <label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />Turn on single sign-on</label>
    <Field label="Button name" hint="Shown as “Continue with ...” on the sign-in page"><input className="input" value={s.name} onChange={on("name")} /></Field>
    <Field label="This workspace's address"><input className="input" placeholder="https://basalt.yourcompany.com" value={s.publicUrl} onChange={on("publicUrl")} /></Field>
    <Field label="Issuer URL"><input className="input" placeholder="https://yourcompany.okta.com" value={s.issuer} onChange={on("issuer")} /></Field>
    <div className="form-row"><Field label="Client ID"><input className="input" value={s.clientId} onChange={on("clientId")} /></Field>
      <Field label="Client secret" hint={s.hasSecret ? "Saved. Leave empty to keep it." : undefined}><input className="input" type="password" autoComplete="new-password" value={s.secret} onChange={on("secret")} /></Field></div>
    <div className="form-row"><Field label="Role for new people"><Sel options={ROLES} value={s.defaultRole} onChange={(v) => setS({ ...s, defaultRole: v as Role })} /></Field>
      <Field label="Allowed email domain" hint="Leave empty to allow anyone your provider signs in"><input className="input" placeholder="yourcompany.com" value={s.allowedDomain} onChange={on("allowedDomain")} /></Field></div>
    <label className="check"><input type="checkbox" checked={!!s.trustEmails} onChange={(e) => setS({ ...s, trustEmails: e.target.checked })} />My provider only issues emails it has verified. Needed for providers that don&apos;t confirm emails at sign-in, such as a single-tenant Microsoft Entra ID.</label>
    <label className="check"><input type="checkbox" checked={s.enforce} onChange={(e) => setS({ ...s, enforce: e.target.checked })} />Require single sign-on. Admins keep password access so a provider outage can&apos;t lock everyone out.</label>
    <div><Btn variant="primary" onClick={() => onSave(s)}>Save single sign-on</Btn></div>
  </section>;
}

export default function Members() {
  const { can, user } = useApp();
  const [tab, setTab] = useState("Members"), [data, setData] = useState<Admin | null>(null), [err, setErr] = useState("");
  const [add, setAdd] = useState(false), [f, setF] = useState({ name: "", email: "", password: "", role: "viewer" }), [formErr, setFormErr] = useState(""), [del, setDel] = useState<Member | null>(null);
  const [tried, setTried] = useState(false);
  const memberErrors = { name: f.name.trim() ? undefined : "Enter a name.", email: /^\S+@\S+\.\S+$/.test(f.email) ? undefined : "Enter a valid email, such as you@company.com.", password: f.password.length >= 10 ? undefined : "Use at least 10 characters." };
  const load = () => call<Admin>("/api/admin").then(setData, (e) => setErr(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (can("admin")) void load(); }, []);
  useNewHandler("member", () => { setTab("Members"); setF({ name: "", email: "", password: "", role: "viewer" }); setFormErr(""); setTried(false); setAdd(true); });
  const act = async (json: object, okMsg: string) => { try { await call("/api/admin", { json }); toast(okMsg); await load(); } catch (e) { toast((e as Error).message, true); } };
  if (!can("admin")) return <><PageHead title="Members and audit" /><PermissionDenied title="Only admins can open this page" /></>;
  return (
    <>
      <PageHead title="Members and audit" >
        {tab === "Members" && <Pop align="right" width={360} trigger={(_, t) => <Btn icon="info" variant="ghost" aria-label="What each role can do" title="What each role can do" onClick={t} />}><h2 style={{ fontSize: 14, marginBottom: 8 }}>What each role can do</h2><dl className="kv">{ABOUT.map(([a, b]) => <div key={a} style={{ display: "contents" }}><dt>{a}</dt><dd>{b}</dd></div>)}</dl></Pop>}
        {tab === "Members" && <Btn icon="plus" variant="primary" onClick={() => { setF({ name: "", email: "", password: "", role: "viewer" }); setFormErr(""); setTried(false); setAdd(true); }}>Add member</Btn>}
      </PageHead>
      <Tabs tabs={["Members", "Row access", "Single sign-on", "Sign-in rules", "Audit log"]} value={tab} onChange={setTab} />
      <div className="body">
        {err && <ErrorState retry={() => { setErr(""); void load(); }}>{err}</ErrorState>}
        {!data && !err && <LoadingTable label="Loading members" />}
        {data && tab === "Members" && <>
          <DataTable<Member> id="members" rows={data.members} rowKey={(m) => m.id} selectable={false} searchPlaceholder="Search members" initialSort={{ id: "name", dir: "asc" }}
            filters={[{ id: "role", label: "Role", value: (m) => m.role, options: ROLES.map(([value, label]) => ({ value, label })) }]}
            columns={[
              { id: "name", header: "Name", width: 280, hideable: false, sortValue: (m) => m.name, searchValue: (m) => `${m.name} ${m.email}`, cell: (m) => <span className="person"><Avatar name={m.name} /><span className="stack"><b>{m.name}{m.id === user!.id && <span className="badge" style={{ marginLeft: 6 }}>You</span>}</b><small>{m.email}</small></span></span> },
              { id: "role", header: "Role", width: 170, sortValue: (m) => m.role, cell: (m) => <Sel aria-label={`Role for ${m.name}`} options={ROLES} value={m.role} onChange={(v) => act({ action: "role", id: m.id, role: v }, `${m.name} is now ${v}`)} /> },
              { id: "mfa", header: "Two-factor", width: 130, sortValue: (m) => (m.mfaOn ? 1 : 0), cell: (m) => (m.mfaOn ? <span className="muted">On</span> : <span className="badge warn">Off</span>) },
              { id: "added", header: "Added", width: 180, sortValue: (m) => m.createdAt, cell: (m) => when(m.createdAt) },
              { id: "actions", header: "", width: 260, hideable: false, align: "end", cell: (m) => (m.id !== user!.id ? <span className="row-actions"><Btn variant="ghost" onClick={() => act({ action: "end-sessions", id: m.id }, `${m.name} is signed out`)}>Sign out</Btn>{m.mfaOn && <Btn variant="ghost" onClick={() => act({ action: "mfa-reset", id: m.id }, `Two-factor sign-in reset for ${m.name}`)}>Reset two-factor</Btn>}<Btn icon="trash" variant="ghost" aria-label={`Remove ${m.name}`} onClick={() => setDel(m)} /></span> : null) },
            ]} />
        </>}
        {data && tab === "Row access" && <RowAccess members={data.members} saved={data.rls} onSave={(rules) => act({ action: "rls", rules }, "Row access rules saved")} />}
        {data && tab === "Single sign-on" && <SsoForm saved={data.sso} onSave={(s) => act({ ...s, action: "sso" }, "Single sign-on saved")} />}
        {data && tab === "Sign-in rules" && <section className="account-sec">
          <h2>Two-factor sign-in</h2>
          <p className="small muted">{data.members.filter((m) => m.mfaOn).length} of {data.members.length} members have it on. Requiring it signs out everyone without it, and asks them to set it up when they next sign in with a password. People using single sign-on follow your provider&apos;s rules.</p>
          <label className="check"><input type="checkbox" checked={data.security.requireMfa} onChange={(e) => act({ action: "security", requireMfa: e.target.checked }, e.target.checked ? "Two-factor sign-in is now required" : "Two-factor sign-in is no longer required")} />Require two-factor sign-in for everyone</label>
          <h2 style={{ marginTop: 16 }}>Sessions</h2>
          <Field label="Sign out after no activity" hint="Counts someone using the page, not a page left open. Leave it off for screens that show a dashboard all day."><Sel options={IDLE_OPTIONS.map(([v, l]): [string, string] => [String(v), l])} value={String(data.security.idleMinutes)} onChange={(v) => act({ action: "security", idleMinutes: Number(v) }, "Session limits saved")} /></Field>
          <Field label="Longest a session can last" hint="Applies to people already signed in."><Sel options={MAX_OPTIONS.map(([v, l]): [string, string] => [String(v), l])} value={String(data.security.maxHours)} onChange={(v) => act({ action: "security", maxHours: Number(v) }, "Session limits saved")} /></Field>
          <div><Btn onClick={() => act({ action: "end-sessions" }, "Everyone else is signed out")}>Sign everyone else out</Btn></div>
        </section>}
        {data && tab === "Audit log" && <>
          <div><a className="btn" href="/api/admin/audit" download><Icon name="download" />Download the full log</a></div>
          <DataTable<AuditEntry> id="audit" rows={data.audit} rowKey={(a) => a.id} selectable={false} exportable exportName="audit-log" searchPlaceholder="Search audit entries" initialSort={{ id: "at", dir: "desc" }}
            filters={[{ id: "kind", label: "Type", value: (a) => (a.sensitive ? "Personal data and access" : "Everything else") }, { id: "actor", label: "Who", value: (a) => a.actor }]}
            columns={[
              { id: "at", header: "When", width: 170, sortValue: (a) => a.at, cell: (a) => when(a.at) },
              { id: "actor", header: "Who", width: 200, sortValue: (a) => a.actor, searchValue: (a) => a.actor, cell: (a) => <span className="person"><Avatar name={a.actor} size={24} />{a.actor}</span> },
              { id: "action", header: "Action", width: 300, sortValue: (a) => a.action, searchValue: (a) => a.action, cell: (a) => <>{a.sensitive && <Icon name="shield" size={13} style={{ verticalAlign: -2, marginRight: 5, display: "inline" }} />}{a.action}</> },
              { id: "detail", header: "Details", width: 420, searchValue: (a) => a.detail, sortValue: (a) => a.detail, cell: (a) => <span className="muted">{a.detail}</span> },
            ]} />
        </>}
      </div>
      {add && <Modal sheet title="Add member" onClose={() => setAdd(false)} foot={<><Btn onClick={() => setAdd(false)}>Cancel</Btn><Btn variant="primary" onClick={async () => { setFormErr(""); setTried(true); if (memberErrors.name || memberErrors.email || memberErrors.password) return; try { await call("/api/admin", { json: { action: "invite", ...f } }); toast(`Added ${f.email}`); setAdd(false); await load(); } catch (e) { setFormErr((e as Error).message); } }}>Add member</Btn></>}>
        <Field label="Name" error={tried ? memberErrors.name : undefined}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email" error={tried ? memberErrors.email : undefined}><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Temporary password" error={tried ? memberErrors.password : undefined} hint="At least 10 characters. Share it with this person privately."><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Role"><Sel options={ROLES} value={f.role} onChange={(v) => setF({ ...f, role: v })} /></Field>
        {formErr && <div className="banner bad" role="alert">{formErr}</div>}
      </Modal>}
      {del && <Confirm title={`Remove ${del.name}?`} action="Remove member" body="They lose access straight away. Their dashboards and models stay." onYes={() => act({ action: "remove", id: del.id }, `Removed ${del.name}`)} onClose={() => setDel(null)} />}
    </>
  );
}
