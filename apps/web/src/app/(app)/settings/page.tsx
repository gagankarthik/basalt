"use client";
import { useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import { Avatar, Btn, Empty, Field, LoadingTable, PageHead, Sel, toast } from "@/components/ui";
import { call, fmt, useApp, when } from "@/lib/client";
import type { SalesRequest, Settings as S } from "@/lib/types";

const ACCENTS: [string, string][] = [["#4124fb", "Basalt indigo"], ["#0a6470", "Teal"], ["#6b3fa0", "Violet"], ["#a3342a", "Brick"], ["#2f6b35", "Forest"], ["#37474f", "Slate"]];

type Alerts = { webhook: string; onSyncFailure: boolean; onCheckFailure: boolean; onRowMismatch: boolean; emailAdmins?: boolean };
type Smtp = { host: string; port: number; user: string; from: string; secure: boolean; password?: string };

function EmailServer() {
  const [s, setS] = useState<Smtp>({ host: "", port: 587, user: "", from: "", secure: false, password: "" }), [tried, setTried] = useState(false);
  useEffect(() => { call<{ smtp?: Smtp | null }>("/api/alerts").then((r) => { if (r.smtp) setS({ ...r.smtp, password: "" }); }); }, []);
  const go = async (action: string) => { setTried(true); if (!s.host.trim() || !/^\S+@\S+|<\S+@\S+>/.test(s.from)) return; try { const r = await call<{ sentTo?: string }>("/api/alerts", { json: { ...s, action } }); toast(r.sentTo ? `Test email sent to ${r.sentTo}` : "Email server saved"); } catch (e) { toast((e as Error).message, true); } };
  return <section id="set-email" className="set-row"><div><h2>Email server</h2><p>Used for report subscriptions, alerts and automation emails. Basalt sends through your own mail server.</p></div><div className="set-fields">
    <div className="form-row"><Field label="Server" error={tried && !s.host.trim() ? "Enter the mail server." : undefined}><input className="input" placeholder="smtp.yourcompany.com" value={s.host} onChange={(e) => setS({ ...s, host: e.target.value })} /></Field><Field label="Port"><input className="input" type="number" value={s.port} onChange={(e) => setS({ ...s, port: Number(e.target.value) })} /></Field></div>
    <div className="form-row"><Field label="User"><input className="input" autoComplete="off" value={s.user} onChange={(e) => setS({ ...s, user: e.target.value })} /></Field><Field label="Password" hint="Leave empty to keep the saved one."><input className="input" type="password" autoComplete="new-password" value={s.password ?? ""} onChange={(e) => setS({ ...s, password: e.target.value })} /></Field></div>
    <Field label="Send from" error={tried && !/\S+@\S+/.test(s.from) ? "Enter an email address." : undefined}><input className="input" placeholder="reports@yourcompany.com" value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} /></Field>
    <label className="check"><input type="checkbox" checked={s.secure} onChange={(e) => setS({ ...s, secure: e.target.checked })} />Use TLS from the start (usually port 465)</label>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><Btn variant="primary" onClick={() => go("smtp")}>Save email server</Btn><Btn onClick={() => go("smtpTest")}>Send a test email</Btn></div>
  </div></section>;
}
const ALERT_TYPES: [keyof Alerts, string][] = [["emailAdmins", "Also email admins about each alert"], ["onSyncFailure", "A sync fails"], ["onCheckFailure", "A model build or data check fails"], ["onRowMismatch", "Row counts differ between a source and its copy"]];

function AlertSettings() {
  const [a, setA] = useState<Alerts | null>(null);
  useEffect(() => { call<{ settings?: Alerts }>("/api/alerts").then((r) => setA(r.settings ?? null)).catch(() => {}); }, []);
  if (!a) return null;
  const send = async (action: string, done: string) => { try { await call("/api/alerts", { json: { ...a, action } }); toast(done); } catch (e) { toast((e as Error).message, true); } };
  return <section id="set-alerts" className="set-row"><div><h2>Alerts</h2><p>What raises an alert, and where it&apos;s sent.</p></div><div className="set-fields">
    <div className="field"><span className="lab">Alert me when</span>{ALERT_TYPES.map(([k, l]) => <label key={k} className="check"><input type="checkbox" checked={!!a[k]} onChange={(e) => setA({ ...a, [k]: e.target.checked })} />{l}</label>)}</div>
    <Field label="Send alerts to a webhook" hint="Works with Slack, Microsoft Teams and other tools that accept webhooks. Alerts always appear under the bell."><input className="input" type="url" placeholder="https://hooks.slack.com/services/..." value={a.webhook} onChange={(e) => setA({ ...a, webhook: e.target.value })} /></Field>
    <div style={{ display: "flex", gap: 8 }}><Btn variant="primary" onClick={() => send("save", "Alert settings saved")}>Save alerts</Btn><Btn disabled={!a.webhook} onClick={() => send("test", "Test alert sent")}>Send a test alert</Btn></div>
  </div></section>;
}

type Lineage = { settings: { transport: string; url: string; namespace: string; includeSql: boolean }; hasKey: boolean; status: { queued: number; dropped: number; lastError?: string; lastErrorAt?: string; lastSentAt?: string } };

function LineageSettings() {
  const [d, setD] = useState<Lineage | null>(null), [apiKey, setKey] = useState(""), [tried, setTried] = useState(false);
  useEffect(() => { call<Lineage>("/api/openlineage").then(setD).catch(() => {}); }, []);
  if (!d) return null;
  const s = d.settings, set = (p: Partial<Lineage["settings"]>) => setD({ ...d, settings: { ...s, ...p } }), http = s.transport === "http";
  const go = async (action: string, done: string) => {
    setTried(true);
    if (action !== "removeKey" && (http || action === "test") && !s.url.trim()) return;
    try { setD(await call<Lineage>("/api/openlineage", { json: { ...s, apiKey, action } })); if (action === "save") setKey(""); toast(done); }
    catch (e) { toast((e as Error).message, true); call<Lineage>("/api/openlineage").then((r) => setD({ ...r, settings: s })).catch(() => {}); }
  };
  return <section id="set-lineage" className="set-row"><div><h2>OpenLineage</h2></div><div className="set-fields">
    <div className="form-row">
      <Field label="Send run events to"><Sel options={[["none", "Nowhere"], ["http", "HTTP endpoint"], ["file", "File in the data folder"]]} value={s.transport} onChange={(v) => set({ transport: v })} /></Field>
      <Field label="Namespace"><input className="input" value={s.namespace} onChange={(e) => set({ namespace: e.target.value })} /></Field>
    </div>
    {http && <div className="form-row">
      <Field label="Endpoint" error={tried && !s.url.trim() ? "Enter the endpoint." : undefined}><input className="input" type="url" placeholder="https://lineage.yourcompany.com/api/v1/lineage" value={s.url} onChange={(e) => set({ url: e.target.value })} /></Field>
      <Field label="API key"><input className="input" type="password" autoComplete="new-password" placeholder={d.hasKey ? "Saved" : "None"} value={apiKey} onChange={(e) => setKey(e.target.value)} /></Field>
    </div>}
    <label className="check"><input type="checkbox" checked={s.includeSql} onChange={(e) => set({ includeSql: e.target.checked })} />Include model SQL text in events</label>
    {http && <dl className="kv"><dt>Waiting to send</dt><dd>{d.status.queued}</dd><dt>Dropped</dt><dd>{d.status.dropped}</dd><dt>Last sent</dt><dd>{d.status.lastSentAt ? when(d.status.lastSentAt) : "Never"}</dd><dt>Last error</dt><dd className={d.status.lastError ? "err" : ""}>{d.status.lastError ? `${when(d.status.lastErrorAt)}: ${d.status.lastError}` : "None"}</dd></dl>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><Btn variant="primary" onClick={() => go("save", "OpenLineage settings saved")}>Save</Btn>{http && <Btn onClick={() => go("test", "Test event accepted")}>Test</Btn>}{http && d.hasKey && <Btn onClick={() => go("removeKey", "API key removed")}>Remove key</Btn>}</div>
  </div></section>;
}

function SalesRequests() {
  const [rows, setRows] = useState<SalesRequest[] | null>(null);
  useEffect(() => { call<{ sales: SalesRequest[] }>("/api/admin").then((r) => setRows(r.sales)).catch(() => setRows([])); }, []);
  return <section id="set-sales" className="set-row"><div><h2>Sales requests</h2><p>Requests sent from the Talk to sales page.</p></div><div className="set-fields">
    {!rows ? <LoadingTable rows={2} label="Loading requests" /> : <DataTable<SalesRequest> id="sales-requests" rows={rows} rowKey={(r) => r.id} selectable={false} exportable exportName="sales-requests" searchPlaceholder="Search requests" initialSort={{ id: "at", dir: "desc" }} empty={<Empty compact icon="people" title="No sales requests yet">Requests from the Talk to sales page appear here.</Empty>}
      filters={[{ id: "size", label: "Team size", value: (r) => r.teamSize }]}
      columns={[
        { id: "at", header: "Received", width: 170, sortValue: (r) => r.at, cell: (r) => when(r.at) },
        { id: "name", header: "Name", width: 260, hideable: false, sortValue: (r) => r.name, searchValue: (r) => `${r.name} ${r.email}`, exportValue: (r) => `${r.name} <${r.email}>`, cell: (r) => <span className="person"><Avatar name={r.name} /><span className="stack"><b>{r.name}</b><small>{r.email}</small></span></span> },
        { id: "company", header: "Company", width: 190, sortValue: (r) => r.company, searchValue: (r) => r.company, cell: (r) => r.company },
        { id: "size", header: "Team size", width: 130, sortValue: (r) => r.teamSize, cell: (r) => r.teamSize },
        { id: "sources", header: "Where data lives", width: 220, sortValue: (r) => r.sources, searchValue: (r) => r.sources, cell: (r) => r.sources },
        { id: "message", header: "Message", width: 380, wrap: true, sortValue: (r) => r.message, searchValue: (r) => r.message, cell: (r) => <span className="muted small">{r.message}</span> },
      ]} />}
  </div></section>;
}

export default function Settings() {
  const { config, patch, can } = useApp();
  const s = config!.settings, off = !can("editor");
  const set = (p: Partial<S>) => patch((c) => ({ ...c, settings: { ...c.settings, ...p } }));
  return (
    <>
      <PageHead title="Settings" />
      <div className="body set">
        <nav className="set-nav" aria-label="Settings sections">{[["workspace", "Workspace"], ...(can("admin") ? [["alerts", "Alerts"], ["email", "Email server"], ["lineage", "OpenLineage"], ["sales", "Sales requests"]] : []), ["appearance", "Appearance"], ["numbers", "Numbers and dates"]].map(([id, l]) => <a key={id} href={`#set-${id}`}>{l}</a>)}</nav>
        <section id="set-workspace" className="set-row"><div><h2>Workspace</h2><p>The name people see across Basalt.</p></div><div className="set-fields"><Field label="Workspace name"><input disabled={off} className="input" value={s.workspace} onChange={(e) => set({ workspace: e.target.value })} /></Field></div></section>
        {can("admin") && <AlertSettings />}
        {can("admin") && <EmailServer />}
        {can("admin") && <LineageSettings />}
        {can("admin") && <SalesRequests />}
        <section id="set-appearance" className="set-row"><div><h2>Appearance</h2><p>The accent color, theme and spacing.</p></div><div className="set-fields">
          <div className="field"><span className="lab">Accent color</span><div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>{ACCENTS.map(([c, n]) => <button key={c} disabled={off} aria-label={n} aria-pressed={s.accent === c} title={n} onClick={() => set({ accent: c })} style={{ width: 28, height: 28, borderRadius: 4, background: c, border: s.accent === c ? "2px solid var(--ink)" : "1px solid var(--line-2)", cursor: "pointer" }} />)}<label className="check small">Custom <input disabled={off} type="color" aria-label="Custom accent color" value={s.accent} onChange={(e) => set({ accent: e.target.value })} /></label></div></div>
          <div className="form-row">
            <Field label="Default theme" hint="For browsers where nobody has chosen a theme from the top bar."><Sel disabled={off} options={[["system", "Match my device"], ["light", "Light"], ["dark", "Dark"]]} value={s.theme} onChange={(v) => set({ theme: v as S["theme"] })} /></Field>
            <Field label="Density"><Sel disabled={off} options={[["compact", "Compact"], ["regular", "Regular"]]} value={s.density} onChange={(v) => set({ density: v as S["density"] })} /></Field>
          </div>
        </div></section>
        <section id="set-numbers" className="set-row"><div><h2>Numbers and dates</h2><p>How values appear in tables and dashboards.</p></div><div className="set-fields">
          <div className="form-row">
            <Field label="Currency"><Sel disabled={off} options={[["USD", "US dollar"], ["CAD", "Canadian dollar"], ["EUR", "Euro"], ["GBP", "British pound"], ["AUD", "Australian dollar"]]} value={s.currency} onChange={(v) => set({ currency: v })} /></Field>
            <Field label="Number format"><Sel disabled={off} options={[["en-US", "1,234,567.50 (US)"], ["en-GB", "1,234,567.50 (UK)"], ["de-DE", "1.234.567,50 (Europe)"]]} value={s.locale} onChange={(v) => set({ locale: v })} /></Field>
            <Field label="Time zone"><Sel disabled={off} options={["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "Europe/London", "UTC"]} value={s.timezone} onChange={(v) => set({ timezone: v })} /></Field>
          </div>
          <p className="muted small">Example: {fmt(1234567.5, "currency", s.locale, s.currency)} and {fmt(1234567.5, "number", s.locale, s.currency)}</p>
        </div></section>
      </div>
    </>
  );
}
