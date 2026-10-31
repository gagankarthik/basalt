"use client";
import Link from "next/link";
import { useState } from "react";
import DataTable from "@/components/DataTable";
import { AddAirbyte, AirbyteLogo, type AirbyteEntry } from "@/components/AirbyteDialogs";
import { ConnectionCatalog, type Live } from "@/components/ConnectionCatalog";
import { AddCloud, type CloudKind } from "@/components/CloudDialogs";
import { ImportDialog } from "@/components/ImportDialog";
import { Streams } from "@/components/Streams";
import { Icon, Logo, type BrandName } from "@/components/icons";
import { Btn, Confirm, Empty, Field, Modal, PageHead, Spinner, toast } from "@/components/ui";
import { call, refreshTables, useApp, useNewHandler, when } from "@/lib/client";
import type { Connection } from "@/lib/types";

const CLOUD_LOGO: Partial<Record<Connection["type"], BrandName>> = { s3: "s3", gcs: "gcs", azure: "azure", bigquery: "bigquery", snowflake: "snowflake", dynamodb: "dynamodb", athena: "athena", redshift: "redshift", firestore: "firestore", spanner: "spanner", cosmos: "cosmos", mssql: "sqlserver", synapse: "azure" };
const logoFor = (c: Connection): React.ReactNode => c.type === "airbyte" ? <AirbyteLogo src={c.airbyte?.icon} /> : CLOUD_LOGO[c.type] ? <Logo name={CLOUD_LOGO[c.type]!} /> : c.type === "postgres" ? <Logo name="postgres" /> : c.type === "mysql" ? <Logo name="mysql" /> : c.type === "file" ? <Icon name="file" size={22} /> : <Icon name="db" size={22} />;
const typeName = (c: Connection) => c.type === "airbyte" ? `Airbyte: ${c.airbyte?.name}` : ({ postgres: "PostgreSQL", mysql: "MySQL or MariaDB", file: "Uploaded file", sample: "Sample data", s3: "Amazon S3", gcs: "Google Cloud Storage", azure: "Azure Blob or ADLS Gen2", bigquery: "Google BigQuery", snowflake: "Snowflake", dynamodb: "Amazon DynamoDB", athena: "Amazon Athena", redshift: "Amazon Redshift", firestore: "Firestore", spanner: "Spanner", cosmos: "Cosmos DB", mssql: "SQL Server or Azure SQL", synapse: "Synapse Analytics" }[c.type as string]);
const addressOf = (c: Connection) => c.type === "dynamodb" ? `DynamoDB in ${c.region}` : c.type === "athena" ? `${c.region}/${c.database}` : c.type === "firestore" ? c.database ?? "(default)" : c.type === "spanner" ? `${c.warehouse}/${c.database}` : c.type === "cosmos" ? `${c.host}/${c.database}` : c.type === "airbyte" ? `${c.airbyte?.repo}:${c.airbyte?.version}` : (c.type === "s3" || c.type === "gcs" || c.type === "azure" ? `${c.type === "s3" ? "s3" : c.type === "azure" ? "az" : "gs"}://${c.database}/${c.prefix ?? ""}` : c.type === "bigquery" ? `${c.database}.${c.prefix}` : c.type === "snowflake" ? `${c.host}/${c.database}` : c.host ? `${c.host}:${c.port ?? ""}/${c.database}` : "On this server");

type Inspect = { checks: string[]; streams: { name: string; rowCount?: number; columns: { name: string; pii: string | null }[] }[] };

/** Fixes an address, certificate or login without removing the connection and its copied data. */
function EditDb({ c, onClose }: { c: Connection; onClose: () => void }) {
  const [f, setF] = useState({ host: c.host ?? "", port: String(c.port ?? ""), user: c.user ?? "", password: "", ssl: !!c.ssl, ca: c.ca ?? "", caOnly: !!c.caOnly }), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const moved = f.host !== (c.host ?? "") || f.port !== String(c.port ?? "") || (!!c.ssl && !f.ssl);
  const save = async () => {
    setBusy(true); setError("");
    try { await call("/api/connections", { method: "PATCH", json: { ...f, id: c.id, port: Number(f.port) } }); await useApp.getState().load(); toast(`${c.name} saved`); onClose(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <Modal sheet title={`Edit ${c.name}`} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={busy || !f.host || !f.user || (moved && !f.password)} onClick={save}>{busy ? <><Spinner />Testing</> : "Test and save"}</Btn></>}>
    <div className="form-row"><Field label="Host"><input className="input" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} /></Field><Field label="Port"><input className="input" inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></Field></div>
    <Field label="User"><input className="input" value={f.user} autoComplete="off" onChange={(e) => setF({ ...f, user: e.target.value })} /></Field>
    <Field label="Password" hint={moved ? "Needed for a new address or without TLS." : "Leave empty to keep the saved password."}><input className="input" type="password" value={f.password} autoComplete="new-password" onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
    <label className="check"><input type="checkbox" checked={f.ssl} onChange={(e) => setF({ ...f, ssl: e.target.checked })} />Encrypt the connection with TLS and verify the server certificate</label>
    {f.ssl && c.type === "postgres" && <Field label="CA certificate" hint="For a server signed by a private CA."><textarea className="input mono" rows={4} spellCheck={false} value={f.ca} onChange={(e) => setF({ ...f, ca: e.target.value })} /></Field>}
    {f.ssl && c.type === "postgres" && f.ca.trim() && <label className="check"><input type="checkbox" checked={f.caOnly} onChange={(e) => setF({ ...f, caOnly: e.target.checked })} />Check the CA only, not the host name</label>}
    {error && <div className="banner bad" role="alert"><Icon name="warn" /><span>{error}</span></div>}
  </Modal>;
}

function AddDb({ kind, onClose }: { kind: Live; onClose: () => void }) {
  const [f, setF] = useState({ name: "", host: "", port: String(kind.port), database: "", user: "", password: "", ssl: true, ca: "", caOnly: false });
  const [state, setState] = useState<"idle" | "testing" | "saving">("idle"), [error, setError] = useState(""), [result, setResult] = useState<Inspect | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setF({ ...f, [k]: k === "ssl" || k === "caOnly" ? (e.target as HTMLInputElement).checked : e.target.value }); setResult(null); };
  const body = { ...f, name: f.name || f.database, type: kind.engine, port: Number(f.port) };
  const test = async () => {
    setState("testing"); setError(""); setResult(null);
    try { setResult(await call<Inspect>("/api/connections", { json: { ...body, action: "test" } })); } catch (e) { setError((e as Error).message); }
    setState("idle");
  };
  const save = async () => {
    setState("saving"); setError("");
    try { const r = await call<{ pipeline: { id: string } }>("/api/connections", { json: body }); await useApp.getState().load(); window.location.assign(`/pipelines?p=${r.pipeline.id}`); }
    catch (e) { setError((e as Error).message); setState("idle"); }
  };
  const pii = result?.streams.reduce((a, s) => a + s.columns.filter((c) => c.pii).length, 0) ?? 0;
  return (
    <Modal full title={`Connect ${kind.name}`} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn onClick={test} disabled={state !== "idle" || !f.host || !f.database || !f.user}>{state === "testing" ? <><Spinner />Testing</> : "Test connection"}</Btn><Btn variant="primary" onClick={save} disabled={!result || state !== "idle"}>{state === "saving" ? "Saving" : "Save and set up pipeline"}</Btn></>}>
      <div className="banner info"><Icon name="info" /><span>Use a read-only login and a read replica if you have one. Basalt opens every session as read-only, and the password is encrypted on this server.</span></div>
      <Field label="Connection name" hint="Shown in Basalt and used to name the copied schema"><input className="input" value={f.name} onChange={set("name")} placeholder={f.database || "Production replica"} /></Field>
      <div className="form-row"><Field label="Host"><input className="input" value={f.host} onChange={set("host")} placeholder="replica.yourcompany.internal" /></Field><Field label="Port"><input className="input" inputMode="numeric" value={f.port} onChange={set("port")} /></Field></div>
      <div className="form-row"><Field label="Database"><input className="input" value={f.database} onChange={set("database")} /></Field><Field label="User"><input className="input" value={f.user} onChange={set("user")} autoComplete="off" /></Field></div>
      <Field label="Password"><input className="input" type="password" value={f.password} onChange={set("password")} autoComplete="new-password" /></Field>
      <label className="check"><input type="checkbox" checked={f.ssl} onChange={set("ssl")} />Encrypt the connection with TLS and verify the server certificate</label>
      {f.ssl && <Field label="CA certificate" hint={kind.caHelp ?? "Needed for Amazon RDS, Aurora and Cloud SQL. Leave empty for Azure Database and public CAs."}><textarea className="input mono" rows={4} spellCheck={false} value={f.ca} onChange={set("ca")} placeholder="-----BEGIN CERTIFICATE-----" /></Field>}
      {f.ssl && f.ca.trim() && <label className="check"><input type="checkbox" checked={f.caOnly} onChange={set("caOnly")} />Check the CA only, not the host name (Cloud SQL by IP address)</label>}
      {error && <div className="banner bad" role="alert"><Icon name="warn" /><span>{error}</span></div>}
      {result && <div style={{ display: "grid", gap: 4 }}>
        {result.checks.map((c) => <div key={c} className={`banner ${c.startsWith("Warning") ? "warn" : "good"}`} style={{ padding: "4px 10px" }}><Icon name={c.startsWith("Warning") ? "warn" : "check"} />{c}</div>)}
        <div className="banner info" style={{ padding: "4px 10px" }}><Icon name="table" />Found {result.streams.length} tables and {pii} possible personal data columns.</div>
      </div>}
    </Modal>
  );
}

export default function Connections() {
  const config = useApp((s) => s.config)!, can = useApp((s) => s.can);
  const [edit, setEdit] = useState<Connection | null>(null);
  const [add, setAdd] = useState<Live | null>(null), [cloud, setCloud] = useState<CloudKind | null>(null), [del, setDel] = useState<Connection | null>(null), [importing, setImporting] = useState(false), [catalog, setCatalog] = useState<boolean | "Files">(false), [airbyte, setAirbyte] = useState<AirbyteEntry | null>(null);
  useNewHandler("connection", () => setCatalog(true));
  useNewHandler("import", () => setCatalog("Files"));
  const remove = async (c: Connection) => {
    try { await call(`/api/connections?id=${c.id}`, { method: "DELETE" }); await useApp.getState().load(); await refreshTables(); toast(`Removed ${c.name}`); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      <PageHead title="Connections">
        {can("editor") && config.connections.length > 0 && <><Btn icon="upload" onClick={() => setImporting(true)}>Import a file</Btn><Btn icon="plus" variant="primary" onClick={() => setCatalog(true)}>Add connection</Btn></>}
      </PageHead>
      <div className="body">
        {config.connections.length === 0 ? <Empty icon="plug" title="No connections yet" editor action={<Btn icon="plus" variant="primary" onClick={() => setCatalog(true)}>Add a connection</Btn>}>Add a database or cloud storage, or import a file, to bring your data in.</Empty> : (
          <DataTable<Connection> id="connections" rows={config.connections} rowKey={(c) => c.id} selectable={false} searchPlaceholder="Search connections" initialSort={{ id: "name", dir: "asc" }}
            filters={[{ id: "type", label: "Type", value: typeName }]}
            columns={[
              { id: "name", header: "Connection", width: 260, hideable: false, sortValue: (c) => c.name, searchValue: (c) => `${c.name} ${c.host ?? ""}`, cell: (c) => <span className="person">{logoFor(c)}<b>{c.name}</b></span> },
              { id: "type", header: "Type", width: 120, sortValue: typeName, cell: typeName },
              { id: "address", header: "Address", width: 230, sortValue: (c) => c.host ?? "", cell: (c) => <span className="mono">{can("editor") ? addressOf(c) : "Hidden"}</span> },
              { id: "schema", header: "Copied to schema", width: 170, sortValue: (c) => c.slug, cell: (c) => <span className="mono">raw_{c.slug}</span> },
              { id: "added", header: "Added", width: 150, sortValue: (c) => c.createdAt, cell: (c) => when(c.createdAt) },
              { id: "actions", header: "", width: 190, hideable: false, align: "end", cell: (c) => { const pl = config.pipelines.find((p) => p.connectionId === c.id); return <span className="row-actions">{pl && <Link className="btn ghost" href={`/pipelines?p=${pl.id}`}>Pipeline</Link>}{can("admin") && (c.type === "postgres" || c.type === "mysql") && <Btn variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEdit(c)}>Edit</Btn>}{can("admin") && <Btn icon="trash" variant="ghost" aria-label={`Remove ${c.name}`} onClick={() => setDel(c)} />}</span>; } },
            ]} />
        )}
        <Streams />
      </div>
      {edit && <EditDb c={edit} onClose={() => setEdit(null)} />}
      {catalog && <ConnectionCatalog start={catalog === true ? "All" : catalog} onClose={() => setCatalog(false)} onPick={(p) => { setCatalog(false); if ("db" in p) setAdd(p.db); else if ("cloud" in p) setCloud(p.cloud); else if ("airbyte" in p) setAirbyte(p.airbyte); else setImporting(true); }} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {add && <AddDb kind={add} onClose={() => setAdd(null)} />}
      {cloud && <AddCloud kind={cloud} onClose={() => setCloud(null)} />}
      {airbyte && <AddAirbyte entry={airbyte} onClose={() => setAirbyte(null)} />}
      {del && <Confirm title={`Remove ${del.name}?`} action="Remove and delete copied data" body={<>This deletes its pipeline and the copied schema <code>raw_{del.slug}</code>. Your source database isn&apos;t touched. Models that use this data will fail until you update them.</>} onYes={() => remove(del)} onClose={() => setDel(null)} />}
    </>
  );
}
