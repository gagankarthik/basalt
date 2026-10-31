"use client";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { Btn, Field, Modal, Sel, Spinner, SuccessState, toast } from "@/components/ui";
import { call, useApp } from "@/lib/client";

export type CloudKind = { id: "s3" | "gcs" | "azure" | "bigquery" | "snowflake" | "dynamodb" | "athena" | "redshift" | "firestore" | "spanner" | "cosmos" | "mssql" | "azuresql" | "synapse"; name: string };
type F = [key: string, label: string, hint?: string, secret?: boolean, area?: boolean];
const CA: F = ["ca", "CA certificate", "Only for a private CA", false, true];
const SQL: F[] = [["host", "Server"], ["port", "Port", "1433 if left empty"], ["database", "Database"], ["user", "User"], ["password", "Password", undefined, true], CA];
const FIELDS: Record<CloudKind["id"], F[]> = {
  s3: [["database", "Bucket"], ["prefix", "Folder", "Optional. Every table under this folder is found."], ["region", "Region", "Such as us-east-1"], ["host", "Custom endpoint", "Optional, for MinIO, Cloudflare R2 and other S3-compatible storage"], ["user", "Access key ID"], ["password", "Secret access key", undefined, true]],
  gcs: [["database", "Bucket"], ["prefix", "Folder", "Optional. Every table under this folder is found."], ["user", "HMAC access key"], ["password", "HMAC secret", "Created under Cloud Storage settings, Interoperability", true]],
  azure: [["database", "Container"], ["prefix", "Folder", "Optional. Every table under this folder is found."], ["user", "Storage account"], ["password", "Account key", undefined, true]],
  bigquery: [["database", "Project ID"], ["prefix", "Dataset"], ["password", "Service account key", "Paste the JSON key file", true, true]],
  dynamodb: [["region", "Region", "Such as us-east-1"], ["user", "Access key ID"], ["password", "Secret access key", undefined, true], ["capacity", "Read capacity limit", "Units a second. 100 if left empty."]],
  athena: [["region", "Region", "Such as us-east-1"], ["database", "Database"], ["warehouse", "Workgroup", "primary if left empty"], ["prefix", "Query results location", "Such as s3://bucket/results/. Optional if the workgroup sets one."], ["user", "Access key ID"], ["password", "Secret access key", undefined, true]],
  redshift: [["host", "Endpoint", "The cluster endpoint, or the Serverless workgroup endpoint"], ["port", "Port", "5439 if left empty"], ["database", "Database"], ["user", "User"], ["password", "Password", undefined, true], CA],
  firestore: [["database", "Database ID", "(default) if left empty"], ["password", "Service account key", "Paste the JSON key file", true, true]],
  spanner: [["warehouse", "Instance ID"], ["database", "Database", "GoogleSQL databases only"], ["password", "Service account key", "Paste the JSON key file", true, true]],
  cosmos: [["host", "Account URI", "Such as https://myaccount.documents.azure.com"], ["database", "Database", "NoSQL API only"], ["password", "Read-only key", undefined, true]],
  mssql: SQL, azuresql: SQL,
  synapse: [["host", "SQL endpoint", "Such as myworkspace.sql.azuresynapse.net"], ...SQL.slice(1)],
  snowflake: [["host", "Account identifier", "Such as myorg-account1"], ["user", "User"], ["warehouse", "Warehouse"], ["database", "Database"], ["prefix", "Schema", "PUBLIC if left empty"], ["password", "Private key", "An unencrypted PEM key registered to this user", true, true]],
};

const AUTH: Partial<Record<CloudKind["id"], [string, string][]>> = {
  s3: [["", "Access key"], ["chain", "IAM role or instance credentials"]],
  dynamodb: [["", "Access key"], ["chain", "IAM role or instance credentials"]],
  athena: [["", "Access key"], ["chain", "IAM role or instance credentials"]],
  azure: [["", "Account name and key"], ["string", "Connection string"], ["chain", "Managed identity (not tested on Azure)"]],
};
const OPTIONAL: Record<CloudKind["id"], string[]> = { s3: ["prefix", "region", "host"], gcs: ["prefix"], azure: ["prefix"], bigquery: [], snowflake: ["prefix"], dynamodb: ["capacity"], athena: ["warehouse", "prefix"], redshift: ["port", "ca"], firestore: ["database"], spanner: [], cosmos: [], mssql: ["port", "ca"], azuresql: ["port", "ca"], synapse: ["port", "ca"] };
const READ_ONLY: Partial<Record<CloudKind["id"], string>> = {
  dynamodb: "Attach the AWS policy AmazonDynamoDBReadOnlyAccess to this key or role.",
  athena: "Allow Athena queries, Glue read and S3 read on the data, and S3 write only on the query results location.",
  redshift: "Create a user with USAGE on the schemas and SELECT on the tables, and nothing else.",
  firestore: "Give this service account the Cloud Datastore Viewer role.",
  spanner: "Give this service account the Cloud Spanner Database Reader role.",
  cosmos: "Copy a read-only key from the account's Keys page.",
  mssql: "Add this login to the db_datareader role only.", azuresql: "Add this login to the db_datareader role only.", synapse: "Add this login to the db_datareader role only.",
};
// Azure SQL is the same source as SQL Server; only the name on the tile differs
const TYPE: Partial<Record<CloudKind["id"], string>> = { azuresql: "mssql" };

export function AddCloud({ kind, onClose }: { kind: CloudKind; onClose: () => void }) {
  const [f, setF] = useState<Record<string, string>>({ name: "" }), [state, setState] = useState<"idle" | "testing" | "saving">("idle"), [error, setError] = useState(""), [checks, setChecks] = useState<string[] | null>(null), [found, setFound] = useState(0);
  const body = { ...f, type: TYPE[kind.id] ?? kind.id, name: f.name || f.database || kind.name };
  // The machine's identity needs no key, and a connection string already holds the account
  const fields = FIELDS[kind.id].filter(([k]) => !(f.auth === "chain" && (k === "password" || (["s3", "dynamodb", "athena"].includes(kind.id) && k === "user"))) && !(f.auth === "string" && k === "user")).map((x): F => (f.auth === "string" && x[0] === "password" ? ["password", "Connection string", undefined, true] : x));
  const [tried, setTried] = useState(false);
  const missing = (k: string, label: string) => (tried && OPTIONAL[kind.id] && !OPTIONAL[kind.id].includes(k) && !f[k]?.trim() ? `Enter the ${label.toLowerCase()}.` : undefined);
  const test = async () => {
    setTried(true);
    if (fields.some(([k]) => !OPTIONAL[kind.id].includes(k) && !f[k]?.trim())) return;
    setState("testing"); setError(""); setChecks(null);
    try { const r = await call<{ checks: string[]; streams: unknown[] }>("/api/connections", { json: { ...body, action: "test" } }); setChecks(r.checks); setFound(r.streams.length); } catch (e) { setError((e as Error).message); }
    setState("idle");
  };
  const save = async () => {
    setState("saving"); setError("");
    try { const r = await call<{ pipeline: { id: string } }>("/api/connections", { json: body }); await useApp.getState().load(); window.location.assign(`/pipelines?p=${r.pipeline.id}`); }
    catch (e) { setError((e as Error).message); setState("idle"); }
  };
  return (
    <Modal sheet title={`Connect ${kind.name}`} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn onClick={test} disabled={state !== "idle"}>{state === "testing" ? <><Spinner />Testing</> : "Test connection"}</Btn><Btn variant="primary" onClick={save} disabled={state !== "idle" || !checks}>{state === "saving" ? <><Spinner />Saving</> : "Save connection"}</Btn></>}>
      <Field label="Connection name" hint="Shown in Basalt and used to name the copied schema"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      {AUTH[kind.id] && <Field label="Sign in with"><Sel options={AUTH[kind.id]!} value={f.auth ?? ""} onChange={(auth) => { setF({ ...f, auth }); setChecks(null); }} /></Field>}
      {fields.map(([k, label, hint, secret, area]) => <Field key={k} label={label} hint={hint} error={missing(k, label)}>{area ? <textarea className="input mono" rows={5} spellCheck={false} value={f[k] ?? ""} onChange={(e) => { setF({ ...f, [k]: e.target.value }); setChecks(null); }} /> : <input className="input" type={secret ? "password" : "text"} autoComplete={secret ? "new-password" : "off"} value={f[k] ?? ""} onChange={(e) => { setF({ ...f, [k]: e.target.value }); setChecks(null); }} />}</Field>)}
      <p className="small muted">{READ_ONLY[kind.id] ?? "Give this login read access, and write access only if you plan to export to it."} The secret is encrypted on this server.</p>
      {error && <div className="banner bad" role="alert"><Icon name="warn" /><span>{error}</span></div>}
      {checks && <div style={{ display: "grid", gap: 4 }}>{checks.map((c) => <div key={c} className={`banner ${c.startsWith("Warning") ? "warn" : "good"}`}><Icon name={c.startsWith("Warning") ? "warn" : "check"} />{c}</div>)}<div className="banner info"><Icon name="table" />Found {found} tables.</div></div>}
    </Modal>
  );
}

const FORMATS: [string, string][] = [["parquet", "Parquet"], ["csv", "CSV"], ["json", "JSON (one row per line)"], ["xlsx", "Excel"], ["xml", "XML"]];

/** Writes a warehouse table to a download, a bucket or a cloud warehouse. Masked data only, because that's all the warehouse holds. */
export function ExportDialog({ table, onClose }: { table: string; onClose: () => void }) {
  const dest = useApp((s) => s.config)!.connections.filter((c) => ["s3", "gcs", "azure", "bigquery", "snowflake"].includes(c.type));
  const [to, setTo] = useState(""), [format, setFormat] = useState("parquet"), [target, setTarget] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState(""), [every, setEvery] = useState("0");
  const conn = dest.find((c) => c.id === to), isWarehouse = conn?.type === "bigquery" || conn?.type === "snowflake", name = table.split(".")[1];
  const run = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/exports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ table, format, connectionId: to || undefined, path: target || undefined, every: to ? Number(every) : 0 }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "The export failed.");
      if (to) { const r = (await res.json()) as { written: string }; setDone(r.written); setBusy(false); return; }
      else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(await res.blob()); a.download = `${name}.${format}`; a.click(); URL.revokeObjectURL(a.href);
        toast(`Downloaded ${name}.${format}`);
      }
      onClose();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  if (done) return <Modal sheet title={`Export ${table}`} onClose={onClose} foot={<Btn variant="primary" onClick={onClose}>Done</Btn>}><SuccessState title="Table exported"><span className="mono small" style={{ overflowWrap: "anywhere" }}>{done}</span></SuccessState></Modal>;
  return (
    <Modal sheet title={`Export ${table}`} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={busy} onClick={run}>{busy ? <><Spinner />Exporting</> : to ? "Write table" : "Download"}</Btn></>}>
      <p className="muted small">Personal data rules still apply. Masked fields stay masked in the export.</p>
      <Field label="Send to"><Sel options={[["", "Download to this computer"], ...dest.map((c): [string, string] => [c.id, c.name])]} value={to} onChange={setTo} /></Field>
      {!isWarehouse && <Field label="Format"><Sel options={FORMATS} value={format} onChange={setFormat} /></Field>}
      {conn && <Field label="Repeat" hint="Runs while the server is up. Failures raise an alert, and you can stop it on the ETL flow page."><Sel options={[["0", "Just this once"], ["15", "Every 15 minutes"], ["60", "Every hour"], ["360", "Every 6 hours"], ["1440", "Every day"]]} value={every} onChange={setEvery} /></Field>}
      {conn && <Field label={isWarehouse ? "Table name" : "Path in the bucket"} hint={isWarehouse ? "An existing table with this name is replaced." : "An existing file at this path is replaced."}><input className="input mono" placeholder={isWarehouse ? name : `exports/${name}.${format}`} value={target} onChange={(e) => setTarget(e.target.value)} /></Field>}
      {error && <div className="banner bad" role="alert"><Icon name="warn" /><span>{error}</span></div>}
    </Modal>
  );
}
