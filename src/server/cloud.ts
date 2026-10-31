import "server-only";
import crypto from "node:crypto";
import type { Connection, StreamInfo } from "@/lib/types";
import { toDuckType, type Batch, type ReadOpts, type Source } from "./connectors";

type Page = { columns: string[]; rows: (string | null)[][] };
/** What Basalt needs from a cloud warehouse: run one statement and hand back its pages. */
export type CloudSql = { run(sql: string, onPage?: (p: Page) => Promise<void>): Promise<void>; quote(id: string): string; schema: string; toText(col: string, type: string): string; typeOf(duck: string): string };

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const jwt = (claims: object, key: crypto.KeyLike) => { const h = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify(claims))}`; return `${h}.${crypto.sign("sha256", Buffer.from(h), key).toString("base64url")}`; };
async function send(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(300000) });
  const body = (await res.json().catch(() => ({}))) as Record<string, never>;
  if (!res.ok) throw new Error((body.error as { message?: string } | undefined)?.message ?? (body.message as string | undefined) ?? `The service answered with status ${res.status}.`);
  return body as Record<string, unknown>;
}

export function bigQuery(conn: Connection, keyJson: string): CloudSql {
  let key: { client_email: string; private_key: string; token_uri: string; project_id?: string };
  try { key = JSON.parse(keyJson); } catch { throw new Error("Paste the service account key as JSON."); }
  const project = conn.database || key.project_id, base = (conn.host || "https://bigquery.googleapis.com").replace(/\/+$/, "");
  if (!project) throw new Error("Enter the project ID.");
  let token = "", until = 0;
  const auth = async () => {
    if (Date.now() < until) return token;
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt({ iss: key.client_email, scope: "https://www.googleapis.com/auth/bigquery", aud: key.token_uri, iat: now, exp: now + 3600 }, key.private_key);
    const r = await send(key.token_uri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
    token = String(r.access_token); until = Date.now() + 3000000;
    return token;
  };
  const api = async (p: string, init: RequestInit = {}) => send(`${base}/bigquery/v2/projects/${encodeURIComponent(project)}${p}`, { ...init, headers: { authorization: `Bearer ${await auth()}`, "content-type": "application/json" } });
  return {
    schema: conn.prefix ?? "",
    quote: (id) => `\`${id.replace(/`/g, "")}\``,
    toText: (c, t) => (/^(ARRAY|STRUCT|JSON)/i.test(t) ? `TO_JSON_STRING(${c})` : `CAST(${c} AS STRING)`),
    typeOf: (t) => (/INT/.test(t) ? "INT64" : /DOUBLE|FLOAT|DECIMAL|REAL/.test(t) ? "FLOAT64" : /BOOL/.test(t) ? "BOOL" : t === "DATE" ? "DATE" : /TIMESTAMP/.test(t) ? "TIMESTAMP" : "STRING"),
    async run(sql, onPage) {
      let r = await api("/queries", { method: "POST", body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 60000, maxResults: 5000 }) });
      const job = (r.jobReference as { jobId: string; location?: string } | undefined);
      const q = (extra = "") => `/queries/${job!.jobId}?maxResults=5000${job!.location ? `&location=${job!.location}` : ""}${extra}`;
      while (!r.jobComplete) r = await api(q());
      for (;;) {
        const columns = ((r.schema as { fields?: { name: string }[] } | undefined)?.fields ?? []).map((f) => f.name);
        const rows = ((r.rows as { f: { v: string | null }[] }[] | undefined) ?? []).map((x) => x.f.map((c) => c.v));
        if (rows.length && onPage) await onPage({ columns, rows });
        if (!r.pageToken) return;
        r = await api(q(`&pageToken=${encodeURIComponent(String(r.pageToken))}`));
      }
    },
  };
}

export function snowflake(conn: Connection, privateKey: string): CloudSql {
  const account = String(conn.host ?? ""), user = String(conn.user ?? "").toUpperCase();
  if (!account || !user) throw new Error("Enter the account and user.");
  const base = account.includes("://") ? account.replace(/\/+$/, "") : `https://${account}.snowflakecomputing.com`;
  const acct = (account.includes("://") ? "LOCAL" : account.split(".")[0]).toUpperCase();
  let key: crypto.KeyObject;
  try { key = crypto.createPrivateKey(privateKey); } catch { throw new Error("Paste an unencrypted private key in PEM format."); }
  const fp = crypto.createHash("sha256").update(crypto.createPublicKey(key).export({ type: "spki", format: "der" })).digest("base64");
  const headers = () => { const now = Math.floor(Date.now() / 1000); return { authorization: `Bearer ${jwt({ iss: `${acct}.${user}.SHA256:${fp}`, sub: `${acct}.${user}`, iat: now, exp: now + 3540 }, key)}`, "x-snowflake-authorization-token-type": "KEYPAIR_JWT", "content-type": "application/json", accept: "application/json" }; };
  type Res = { statementHandle?: string; message?: string; data?: (string | null)[][]; resultSetMetaData?: { rowType?: { name: string }[]; partitionInfo?: unknown[] } };
  return {
    schema: conn.prefix ?? "PUBLIC",
    quote: (id) => `"${id.replace(/"/g, '""')}"`,
    toText: (c) => `TO_VARCHAR(${c})`,
    typeOf: (t) => (/INT/.test(t) ? "NUMBER(38,0)" : /DOUBLE|FLOAT|DECIMAL|REAL/.test(t) ? "FLOAT" : /BOOL/.test(t) ? "BOOLEAN" : t === "DATE" ? "DATE" : /TIMESTAMP/.test(t) ? "TIMESTAMP_NTZ" : "VARCHAR"),
    async run(sql, onPage) {
      const res = await fetch(`${base}/api/v2/statements`, { method: "POST", headers: headers(), signal: AbortSignal.timeout(300000), body: JSON.stringify({ statement: sql, timeout: 280, warehouse: conn.warehouse, database: conn.database, schema: conn.prefix ?? "PUBLIC" }) });
      let r = (await res.json().catch(() => ({}))) as Res, status = res.status;
      if (status >= 400) throw new Error(r.message ?? `Snowflake answered with status ${status}.`);
      while (status === 202) {
        await new Promise((d) => setTimeout(d, 1000));
        const p = await fetch(`${base}/api/v2/statements/${r.statementHandle}`, { headers: headers(), signal: AbortSignal.timeout(60000) });
        r = (await p.json().catch(() => ({}))) as Res; status = p.status;
        if (status >= 400) throw new Error(r.message ?? `Snowflake answered with status ${status}.`);
      }
      const columns = (r.resultSetMetaData?.rowType ?? []).map((c) => c.name), parts = r.resultSetMetaData?.partitionInfo?.length ?? 1;
      if (r.data?.length && onPage) await onPage({ columns, rows: r.data });
      for (let i = 1; i < parts; i++) {
        const p = (await send(`${base}/api/v2/statements/${r.statementHandle}?partition=${i}`, { headers: headers() })) as Res;
        if (p.data?.length && onPage) await onPage({ columns, rows: p.data });
      }
    },
  };
}

export const cloudSql = (conn: Connection, secret: string) => (conn.type === "bigquery" ? bigQuery(conn, secret) : snowflake(conn, secret));
const str = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}'`;
const safeLimit = (n?: number) => (n && Number.isSafeInteger(n) && n > 0 ? ` LIMIT ${n}` : "");

export function cloudSource(conn: Connection, secret: string): Source {
  const w = cloudSql(conn, secret), table = (t: string) => `${w.quote(w.schema)}.${w.quote(t)}`;
  const collect = async (sql: string) => { const out: (string | null)[][] = []; await w.run(sql, async (p) => { out.push(...p.rows); }); return out; };
  const needSchema = () => { if (!w.schema) throw new Error("Enter the dataset to read."); };
  const types = new Map<string, string>();
  return {
    async check() { needSchema(); await w.run("SELECT 1"); return [`Signed in to ${conn.type === "bigquery" ? "BigQuery" : "Snowflake"}`, "Basalt only runs SELECT on this connection when reading"]; },
    async discover() {
      needSchema();
      const info = conn.type === "bigquery" ? `${w.quote(w.schema)}.INFORMATION_SCHEMA.COLUMNS` : "INFORMATION_SCHEMA.COLUMNS";
      const rows = await collect(`SELECT table_name, column_name, data_type FROM ${info} WHERE upper(table_schema) = upper(${str(w.schema)}) ORDER BY table_name, ordinal_position`);
      const out = new Map<string, StreamInfo>();
      for (const [t, c, d] of rows) {
        if (!out.has(t!)) out.set(t!, { name: t!, columns: [] });
        out.get(t!)!.columns.push({ name: c!, type: toDuckType(d!) });
        types.set(`${t}.${c}`, d!);
      }
      return [...out.values()];
    },
    async sample(stream, column) { return (await collect(`SELECT ${w.toText(w.quote(column), types.get(`${stream}.${column}`) ?? "")} FROM ${table(stream)} WHERE ${w.quote(column)} IS NOT NULL LIMIT 50`)).map((r) => r[0]); },
    async count(stream) { return Number((await collect(`SELECT count(*) FROM ${table(stream)}`))[0]?.[0] ?? 0); },
    async read(stream, { columns, cursor, after, maxRows, inclusive }: ReadOpts, onBatch: (b: Batch) => Promise<void>) {
      if (!types.size) await this.discover();
      const sel = columns.map((c) => `${w.toText(w.quote(c.name), types.get(`${stream}.${c.name}`) ?? "")} AS ${w.quote(c.name)}`).join(", ");
      const where = cursor && after ? ` WHERE ${w.toText(w.quote(cursor), types.get(`${stream}.${cursor}`) ?? "")} ${inclusive ? ">=" : ">"} ${str(after)}` : "";
      await w.run(`SELECT ${sel} FROM ${table(stream)}${where}${cursor ? ` ORDER BY ${w.quote(cursor)}` : ""}${safeLimit(maxRows)}`, (p) => onBatch(p.rows));
    },
    close: async () => {},
  };
}

/** Replaces the target table only once every row has loaded. Rows go in small batches because both warehouses cap the size of one statement. */
export async function writeCloud(conn: Connection, secret: string, target: string, columns: { name: string; type: string }[], rows: AsyncIterable<(string | null)[]>) {
  const w = cloudSql(conn, secret);
  if (!w.schema) throw new Error("This connection has no dataset to write to.");
  const t = `${w.quote(w.schema)}.${w.quote(target)}`, tmp = `${w.quote(w.schema)}.${w.quote(`${target}__basalt_load_${crypto.randomUUID().replace(/-/g, "")}`)}`;
  const cols = columns.map((c) => `${w.quote(c.name)} ${w.typeOf(c.type)}`).join(", ");
  try {
    await w.run(`CREATE TABLE ${tmp} (${cols})`);
    let batch: string[] = [], n = 0;
    const flush = async () => { if (batch.length) await w.run(`INSERT INTO ${tmp} (${columns.map((c) => w.quote(c.name)).join(", ")}) VALUES ${batch.join(", ")}`); batch = []; };
    for await (const r of rows) {
      batch.push(`(${r.map((v, i) => (v == null ? `CAST(NULL AS ${w.typeOf(columns[i].type)})` : `CAST(${str(v)} AS ${w.typeOf(columns[i].type)})`)).join(", ")})`);
      n++;
      if (batch.length >= 500) await flush();
    }
    await flush();
    // Neither warehouse can rename onto an existing table: BigQuery replaces it by copy, Snowflake swaps with it, so it must exist first
    if (conn.type === "bigquery") await w.run(`CREATE OR REPLACE TABLE ${t} COPY ${tmp}`);
    else { await w.run(`CREATE TABLE IF NOT EXISTS ${t} (${cols})`); await w.run(`ALTER TABLE ${tmp} SWAP WITH ${t}`); }
    return n;
  } finally {
    // After a swap this holds the old table. A failed drop only leaves a stray table, so it mustn't fail the export
    await w.run(`DROP TABLE IF EXISTS ${tmp}`).catch((e) => console.error("Couldn't remove the temporary export table", e));
  }
}
