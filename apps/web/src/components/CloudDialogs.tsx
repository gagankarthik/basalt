"use client";
import { useEffect, useState } from "react";
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
  s3: [["", "Access key"], ["role", "A role in your AWS account"], ["chain", "This server's own IAM role"]],
  dynamodb: [["", "Access key"], ["role", "A role in your AWS account"], ["chain", "This server's own IAM role"]],
  athena: [["", "Access key"], ["role", "A role in your AWS account"], ["chain", "This server's own IAM role"]],
  gcs: [["", "HMAC key"], ["serviceAccount", "Service account"]],
  azure: [["", "Account name and key"], ["principal", "Service principal"], ["string", "Connection string"], ["chain", "Managed identity (not tested on Azure)"]],
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

/** What the customer sets up in their own AWS account, so Basalt never holds a key to it. */
function RoleSteps({ aws }: { aws: { externalId: string; account: string | null } }) {
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${aws.account ?? "BASALT_ACCOUNT"}:root` }, Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": aws.externalId } } }] }, null, 2);
  return <div style={{ display: "grid", gap: 8 }}>
    <p className="small">In your AWS account, create a role with this trust policy and read access to your data, then paste its ARN below. Basalt never holds a key to your account.</p>
    {!aws.account && <div className="banner warn" role="alert"><Icon name="warn" /><span>This server has no AWS identity yet, so a role can&apos;t be used. Contact your administrator.</span></div>}
    <code className="token-box">{trust}</code>
    <div><Btn icon="copy" onClick={() => navigator.clipboard.writeText(trust).then(() => toast("Trust policy copied"))}>Copy trust policy</Btn></div>
  </div>;
}

export function AddCloud({ kind, onClose }: { kind: CloudKind; onClose: () => void }) {
  const [f, setF] = useState<Record<string, string>>({ name: "" }), [state, setState] = useState<"idle" | "testing" | "saving">("idle"), [error, setError] = useState(""), [checks, setChecks] = useState<string[] | null>(null), [found, setFound] = useState(0);
  const body = { ...f, type: TYPE[kind.id] ?? kind.id, name: f.name || f.database || kind.name };
  // The machine's identity needs no key, and a connection string already holds the account
  const fields = [...FIELDS[kind.id], ...(f.auth === "role" ? [["roleArn", "Role ARN", "Such as arn:aws:iam::123456789012:role/basalt-read"] as F] : []), ...(f.auth === "principal" ? [["tenantId", "Tenant ID", "Directory (tenant) ID on the app's overview page"] as F, ["clientId", "Client ID", "Application (client) ID on the same page"] as F] : [])].filter(([k]) => !(f.auth === "serviceAccount" && k === "user") && !((f.auth === "chain" || f.auth === "role") && (k === "password" || (["s3", "dynamodb", "athena"].includes(kind.id) && k === "user"))) && !(f.auth === "string" && k === "user")).map((x): F => (f.auth === "string" && x[0] === "password" ? ["password", "Connection string", undefined, true] : f.auth === "serviceAccount" && x[0] === "password" ? ["password", "Service account key", "Paste the JSON key file", true, true] : f.auth === "principal" && x[0] === "password" ? ["password", "Client secret", "The secret's value, not its ID", true] : x)).sort((a, b) => (f.auth === "principal" ? Number(a[0] === "password") - Number(b[0] === "password") : 0));
  const [tried, setTried] = useState(false), [aws, setAws] = useState<{ externalId: string; account: string | null } | null>(null);
  useEffect(() => { if (f.auth === "role" && !aws) call<{ externalId: string; account: string | null }>("/api/connections?awsRole=1").then(setAws, (e) => setError(e.message)); }, [f.auth, aws]);
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
      {f.auth === "role" && aws && <RoleSteps aws={aws} />}
      {fields.map(([k, label, hint, secret, area]) => <Field key={k} label={label} hint={hint} error={missing(k, label)}>{area ? <textarea className="input mono" rows={5} spellCheck={false} value={f[k] ?? ""} onChange={(e) => { setF({ ...f, [k]: e.target.value }); setChecks(null); }} /> : <input className="input" type={secret ? "password" : "text"} autoComplete={secret ? "new-password" : "off"} value={f[k] ?? ""} onChange={(e) => { setF({ ...f, [k]: e.target.value }); setChecks(null); }} />}</Field>)}
      <p className="small muted">{f.auth === "serviceAccount" ? "Give this account the Storage Object Viewer role on the bucket, or Storage Object User to export there." : kind.id === "azure" && f.auth === "principal" ? "Give this app the Storage Blob Data Reader role on the container, or Storage Blob Data Contributor to export there. Reader or Contributor alone isn't enough." : READ_ONLY[kind.id] ?? "Give this login read access, and write access only if you plan to export to it."} The secret is encrypted on this server.</p>
      {error && <div className="banner bad" role="alert"><Icon name="warn" /><span>{error}</span></div>}
      {checks && <div style={{ display: "grid", gap: 4 }}>{checks.map((c) => <div key={c} className={`banner ${c.startsWith("Warning") ? "warn" : "good"}`}><Icon name={c.startsWith("Warning") ? "warn" : "check"} />{c}</div>)}<div className="banner info"><Icon name="table" />Found {found} tables.</div></div>}
    </Modal>
  );
}

const FORMATS: [string, string][] = [["parquet", "Parquet"], ["csv", "CSV"], ["json", "JSON (one row per line)"], ["xlsx", "Excel"], ["xml", "XML"], ["delta", "Delta table (a folder)"]];

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
      {conn && <Field label={isWarehouse ? "Table name" : "Path in the bucket"} hint={isWarehouse ? "An existing table with this name is replaced." : format === "delta" ? "A folder. A new version replaces the table each time, and older versions stay readable." : "An existing file at this path is replaced."}><input className="input mono" placeholder={isWarehouse ? name : format === "delta" ? `exports/${name}` : `exports/${name}.${format}`} value={target} onChange={(e) => setTarget(e.target.value)} /></Field>}
      {error && <div className="banner bad" role="alert"><Icon name="warn" /><span>{error}</span></div>}
    </Modal>
  );
}
