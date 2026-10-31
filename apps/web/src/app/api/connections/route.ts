import crypto from "node:crypto";
import { CONVERSIONS, convertSql, suggestConversion } from "@/lib/csvTypes";
import { cloudMessage, GUID } from "@/lib/cloudErrors";
import { readJson, writeJson } from "@/server/files";
import { awsAccount, gcpKey, requireExternalId, ROLE_ARN } from "@/server/sources/common";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { api, HttpError } from "@/server/auth";
import { toUtf8, type TextEncoding } from "@/lib/textEncoding";
import { cachedInspect, forgetCatalog, inspectAirbyte, resolveRef } from "@/server/airbyte";
import { openSource } from "@/server/connectors";
import { sourceStore, toResult, withConn } from "@/server/engine";
import { audit, deleteSecret, getConfig, getRuns, saveConfig, saveSecret } from "@/server/files";
import { ensureSampleSource } from "@/server/jobs";
import { collectLeaves, flattenSql, isNestedType, leafName, type Leaves } from "@/lib/nested";
import { detectPii, piiLabel } from "@/lib/pii";
import { lit, q } from "@/lib/sql";
import { MAX_XML_BYTES, XML_TOO_LARGE, xmlRows } from "@/lib/xml";
import type { Connection, ConnectorType, Pipeline, StreamCfg } from "@/lib/types";

const MAX_UPLOAD = 500 * 1024 * 1024;
const IMPORT_TYPES: string[] = ["VARCHAR", "BIGINT", "DOUBLE", "BOOLEAN", "DATE", "TIMESTAMP", "JSON", ...CONVERSIONS];
const MAX_FLATTENED = 500;
const parsed = (s: unknown) => { try { return JSON.parse(String(s)); } catch { return s; } };
const slugify = (s: string, taken: string[]) => {
  const base = s.toLowerCase().replace(/\W+/g, "_").replace(/^_+|_+$/g, "") || "source";
  let slug = base, i = 2;
  while (taken.includes(slug)) slug = `${base}_${i++}`;
  return slug;
};
/** Native read-only sources, and the fields each can't work without. */
const NATIVE: Partial<Record<ConnectorType, [string, string][]>> = {
  dynamodb: [["region", "region"]], athena: [["region", "region"], ["database", "database"]], redshift: [["host", "endpoint"], ["database", "database"], ["user", "user"]],
  firestore: [], spanner: [["warehouse", "instance ID"], ["database", "database"]], cosmos: [["host", "account URI"], ["database", "database"]],
  mssql: [["host", "server"], ["database", "database"], ["user", "user"]], synapse: [["host", "SQL endpoint"], ["database", "database"], ["user", "user"]],
};
function draft(b: Record<string, unknown>): Connection {
  const type = b.type as ConnectorType;
  const text = (k: string) => String(b[k] ?? "").trim() || undefined;
  if (type === "azure") {
    const auth = b.auth === "string" || b.auth === "chain" || b.auth === "principal" ? b.auth : undefined, secret = String(b.password ?? "");
    if (auth === "principal" && (!GUID.test(String(b.tenantId ?? "").trim()) || !GUID.test(String(b.clientId ?? "").trim()))) throw new HttpError(400, "Enter the tenant ID and client ID, which look like 11111111-2222-3333-4444-555555555555.");
    if (!b.database) throw new HttpError(400, "Enter the container.");
    if (auth !== "chain" && !secret) throw new HttpError(400, auth === "principal" ? "Enter the client secret." : auth ? "Enter the connection string." : "Enter the account key.");
    // A connection string only gives up its account name, for display. The key in it goes to the secret store with the rest
    const user = auth === "string" ? /(?:^|;)\s*AccountName=([^;]+)/i.exec(secret)?.[1] : text("user");
    if (auth !== "string" && !/^[a-z0-9]{3,24}$/.test(user ?? "")) throw new HttpError(400, "Enter the storage account name, in lowercase letters and numbers.");
    return { id: "", name: String(b.name ?? b.database), type, slug: "", database: text("database"), user, prefix: text("prefix"), auth, ...(auth === "principal" ? { tenantId: text("tenantId"), clientId: text("clientId") } : {}), createdAt: "" };
  }
  if (type === "s3" && b.auth === "chain") {
    if (!b.database) throw new HttpError(400, "Enter the bucket.");
    return { id: "", name: String(b.name ?? b.database), type, slug: "", database: text("database"), prefix: text("prefix"), region: text("region"), host: text("host"), auth: "chain", createdAt: "" };
  }
  if (type === "gcs" && b.auth === "serviceAccount") {
    if (!b.database) throw new HttpError(400, "Enter the bucket.");
    let email = "";
    try { email = gcpKey(String(b.password ?? "")).credentials.client_email; } catch (e) { throw new HttpError(400, (e as Error).message); }
    return { id: "", name: String(b.name ?? b.database), type, slug: "", database: text("database"), prefix: text("prefix"), user: email, auth: "serviceAccount", createdAt: "" };
  }
  if (type === "s3" || type === "gcs") {
    if (!b.database || !b.user) throw new HttpError(400, "Enter the bucket and access key.");
    return { id: "", name: String(b.name ?? b.database), type, slug: "", database: text("database"), user: text("user"), prefix: text("prefix"), region: text("region"), host: text("host"), createdAt: "" };
  }
  if (type === "bigquery") {
    if (!b.database || !b.prefix) throw new HttpError(400, "Enter the project ID and dataset.");
    return { id: "", name: String(b.name ?? b.database), type, slug: "", database: text("database"), prefix: text("prefix"), host: text("host"), createdAt: "" };
  }
  if (type === "snowflake") {
    if (!b.host || !b.user || !b.database || !b.warehouse) throw new HttpError(400, "Enter the account, user, warehouse and database.");
    return { id: "", name: String(b.name ?? b.database), type, slug: "", host: text("host"), user: text("user"), database: text("database"), warehouse: text("warehouse"), prefix: text("prefix"), createdAt: "" };
  }
  if (NATIVE[type]) {
    for (const [k, label] of NATIVE[type]!) if (!b[k]) throw new HttpError(400, `Enter the ${label}.`);
    const aws = type === "dynamodb" || type === "athena", chain = aws && b.auth === "chain";
    if (aws && !chain && !b.user) throw new HttpError(400, "Enter the access key ID.");
    if (!chain && !b.password) throw new HttpError(400, "Enter the secret.");
    const pem = text("ca");
    if (pem && !pem.includes("-----BEGIN CERTIFICATE-----")) throw new HttpError(400, "Paste the CA certificate in PEM format.");
    return { id: "", name: String(b.name ?? b.database ?? type), type, slug: "", host: text("host"), port: Number(b.port) || undefined, database: text("database"), user: chain ? undefined : text("user"), region: text("region"), warehouse: text("warehouse"), prefix: text("prefix"), capacity: Number(b.capacity) > 0 ? Number(b.capacity) : undefined, ssl: b.ssl !== false, ...(pem ? { ca: pem } : {}), ...(chain ? { auth: "chain" as const } : {}), createdAt: "" };
  }
  if (!["postgres", "mysql"].includes(type)) throw new HttpError(400, "This connector type isn't supported.");
  if (!b.host || !b.database || !b.user) throw new HttpError(400, "Enter the host, database and user.");
  const ca = b.ssl ? text("ca") : undefined;
  if (ca && !ca.includes("-----BEGIN CERTIFICATE-----")) throw new HttpError(400, "Paste the CA certificate in PEM format.");
  return { id: "", name: String(b.name ?? b.database), type, slug: "", host: String(b.host), port: Number(b.port) || undefined, database: String(b.database), user: String(b.user), ssl: !!b.ssl, ...(ca ? { ca, caOnly: !!b.caOnly } : {}), createdAt: "" };
}
const streamDefaults = (name: string, pk?: string): StreamCfg => ({ name, enabled: true, mode: "full_refresh", primaryKey: pk, rules: {} });

/** Reads catalog and personal data findings for one connection. */
async function inspectRaw(conn: Connection, password?: string) {
  if (conn.type === "sample") await ensureSampleSource();
  const src = await openSource(conn, password);
  // A full sync reads every row, so it can hold back a column this sample looked fine in. It still has to be listed here to get a rule.
  const pl = getConfig().pipelines.find((p) => p.connectionId === conn.id);
  const lastSync = pl && getRuns().find((r) => r.kind === "sync" && r.refId === pl.id && r.status !== "running");
  try {
    const checks = await src.check();
    const streams = await src.discover();
    const out = [];
    for (const s of streams) {
      const cols = [];
      const held = lastSync?.streams?.find((x) => x.name === s.name)?.heldBack ?? [];
      for (const c of s.columns) {
        const found = detectPii(c.name, await src.sample(s.name, c.name).catch(() => [])) ?? (held.includes(c.name) ? { kind: "Personal data found in a nested field", rule: "drop" as const } : null);
        cols.push({ ...c, pii: piiLabel(found), suggested: found?.rule ?? null });
      }
      out.push({ ...s, columns: cols, rowCount: await src.count(s.name).catch(() => undefined) });
    }

    return { checks, streams: out };
  } finally { await src.close().catch(() => {}); }
}

const inspect = (conn: Connection, password?: string) => inspectRaw(conn, password).catch((e: Error) => { throw new Error(cloudMessage(conn.type, e.message)); });

/** One per workspace and made here, never chosen by the person connecting: a chosen one would let someone name another workspace's role and ID. It isn't a secret. */
function externalId() {
  const saved = readJson<{ id?: string }>("aws-external-id.json", {}).id;
  if (saved) return saved;
  const id = `basalt-${crypto.randomUUID()}`;
  writeJson("aws-external-id.json", { id });
  return id;
}

export const GET = api("viewer", async (req, user) => {
  if (new URL(req.url).searchParams.has("awsRole")) {
    if (user.role !== "admin") throw new HttpError(403, "Only admins can connect with a role.");
    return { externalId: externalId(), account: await awsAccount() };
  }
  const id = new URL(req.url).searchParams.get("inspect");
  const conn = getConfig().connections.find((c) => c.id === id);
  if (!conn) throw new HttpError(404, "This connection no longer exists.");
  // Opening a page must not start third-party code, so this shows the catalog saved when an admin last ran the connector
  if (conn.type === "airbyte") {
    const pl = getConfig().pipelines.find((p) => p.connectionId === conn.id);
    return cachedInspect(conn.id, pl && getRuns().find((r) => r.kind === "sync" && r.refId === pl.id && r.status !== "running")?.streams);
  }
  return inspect(conn);
});

export const POST = api("editor", async (req, user) => {
  const ct = req.headers.get("content-type") ?? "";
  const cfg = getConfig(), taken = cfg.connections.map((c) => c.slug);
  const finish = (conn: Connection, streams: { name: string; primaryKey?: string; cursor?: string }[]) => {
    const pl: Pipeline = { id: crypto.randomUUID(), name: `${conn.name} to warehouse`, connectionId: conn.id, schedule: 0, runModelsAfter: false, paused: false, streams: streams.map((s) => ({ ...streamDefaults(s.name, s.primaryKey), cursor: s.cursor })) };
    saveConfig({ ...cfg, connections: [...cfg.connections, conn], pipelines: [...cfg.pipelines, pl] });
    audit(user.name, "Added connection", conn.name);
    return { connection: conn, pipeline: pl };
  };

  if (ct.startsWith("multipart/")) {
    const form = await req.formData(), file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "Choose a file to upload.");
    const ext = path.extname(file.name).toLowerCase();
    const reader = { ".csv": "read_csv_auto", ".tsv": "read_csv_auto", ".json": "read_json_auto", ".jsonl": "read_json_auto", ".ndjson": "read_json_auto", ".parquet": "read_parquet", ".xlsx": "read_xlsx", ".xml": "read_json_auto", ".avro": "read_avro", ".yaml": "read_yaml", ".yml": "read_yaml" }[ext];
    if (!reader) throw new HttpError(400, "Upload a CSV, TSV, JSON, Parquet, Avro, YAML, Excel or XML file.");
    if (file.size > MAX_UPLOAD) throw new HttpError(413, "This file is larger than 500 MB. Split it, or load it through a database connection.");
    if (ext === ".xml" && file.size > MAX_XML_BYTES) throw new HttpError(413, XML_TOO_LARGE);
    const name = String(form.get("name") || path.basename(file.name, ext));
    // Loading an updated file over an earlier import, so what's built on it keeps working
    const replacing = form.get("replace") ? cfg.connections.find((c) => c.id === form.get("replace") && c.type === "file") : undefined;
    if (form.get("replace") && !replacing) throw new HttpError(404, "That import no longer exists.");
    const replacedPipeline = replacing && cfg.pipelines.find((p) => p.connectionId === replacing.id);
    const slug = replacing?.slug ?? slugify(name, taken), table = replacedPipeline?.streams[0]?.name ?? slugify(path.basename(file.name, ext), []);
    const header = form.get("header") !== "false";
    const tmp = path.join(os.tmpdir(), `basalt-${crypto.randomUUID()}${ext}`);
    let bytes: Buffer = Buffer.from(await file.arrayBuffer()), encoding: TextEncoding = "UTF-8";
    if (ext === ".csv" || ext === ".tsv") { try { ({ bytes, encoding } = toUtf8(bytes)); } catch (e) { throw new HttpError(400, `Basalt couldn't read this file: ${(e as Error).message}`); } }
    if (ext === ".xml") {
      let rows: Record<string, unknown>[];
      try { rows = xmlRows(bytes.toString("utf8")); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : "This XML file can't be read."); }
      if (!rows.length) throw new HttpError(400, "No repeating records were found in this XML file.");
      fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n"));
    } else fs.writeFileSync(tmp, bytes);
    const isCsvFile = ext === ".csv" || ext === ".tsv";
    let conversionIssues = 0, removed: string[] = [];
    try {
      if (ext === ".xlsx") await withConn((c) => c.run("INSTALL excel; LOAD excel;"), sourceStore());
      if (ext === ".avro") await withConn((c) => c.run("INSTALL avro; LOAD avro;"), sourceStore());
      if (reader === "read_yaml") await withConn((c) => c.run("INSTALL yaml FROM community; LOAD yaml;"), sourceStore());
      // Every row is read to find the types: from a sample, a later key is dropped and a later type fails the import. A single value can be as large as the file.
      const jsonOpts = `sample_size = -1, maximum_object_size = ${MAX_UPLOAD}`;
      const from = reader === "read_csv_auto" ? // Without padding, one short row turns the whole file into a single column, and one long row becomes the header. A long row gets its own visible column. Padding needs the single-threaded reader. Dates are pinned to one unmistakable format, or one clear day-first column would make the reader guess the rest of the file the same way; other formats are decided column by column
        `read_csv_auto(${lit(tmp)}, header = ${header}, sample_size = -1, null_padding = true, parallel = false, dateformat = '%Y-%m-%d')` : reader === "read_xlsx" ? `read_xlsx(${lit(tmp)}, header = ${header})` : ext === ".xml" ? `read_json_auto(${lit(tmp)}, format = 'newline_delimited', ${jsonOpts})` : reader === "read_json_auto" ? `read_json_auto(${lit(tmp)}, ${jsonOpts})` : `${reader}(${lit(tmp)})`;
      if (form.get("mode") === "preview") {
        return await withConn(async (c) => {
          const desc = toResult(await c.runAndReadAll(`DESCRIBE SELECT * FROM ${from}`), Date.now(), 2000).rows;
          const rows = toResult(await c.runAndReadAll(`SELECT * FROM ${from} LIMIT 50`), Date.now(), 50).rows;
          const total = Number(toResult(await c.runAndReadAll(`SELECT count(*) n FROM ${from}`), Date.now(), 1).rows[0].n);
          if (!total) throw new HttpError(400, "This file has no rows.");
          const nested = desc.filter((d) => isNestedType(String(d.column_type))).map((d) => String(d.column_name));
          const asJson = nested.length ? toResult(await c.runAndReadAll(`SELECT ${nested.map((n) => `CAST(to_json(${q(n)}) AS VARCHAR) AS ${q(n)}`).join(", ")} FROM ${from} LIMIT 50`), Date.now(), 50).rows : [];
          const columns = desc.map((d) => {
            const n = String(d.column_name), isNested = nested.includes(n);
            const samples = (isNested ? asJson : rows).map((r) => (r[n] == null ? null : typeof r[n] === "object" ? JSON.stringify(r[n]) : String(r[n])));
            const leaves: Leaves = new Map();
            if (isNested) for (const s of samples) if (s != null) collectLeaves(leaves, parsed(s));
            return { name: n, type: String(d.column_type), suggest: isCsvFile && /^VARCHAR$/i.test(String(d.column_type)) ? suggestConversion(samples) : "", pii: piiLabel(detectPii(n, samples)), nested: isNested, children: [...leaves.values()].map((l) => leafName("", l.path).replace(/^_/, "")).filter(Boolean) };
          });
          return { columns, rows, total, encoding };
        }, sourceStore());
      }
      type Target = { name: string; to: string; type: string; flatten?: boolean };
      let fields: Target[] | null = null, typed: Target[] = [];
      const raw = form.get("fields");
      if (raw) {
        fields = JSON.parse(String(raw)) as Target[];
        if (!fields.length) throw new HttpError(400, "Keep at least one field.");
        if (new Set(fields.map((f) => f.to)).size !== fields.length) throw new HttpError(400, "Two fields have the same name.");
        for (const f of fields) {
          if (!/^[A-Za-z_]\w*$/.test(f.to)) throw new HttpError(400, `"${f.to}" isn't a valid field name.`);
          if (f.type && !IMPORT_TYPES.includes(f.type)) throw new HttpError(400, "That field type isn't supported.");
        }
        typed = fields.filter((f) => f.type && !f.flatten);
      }
      await withConn(async (c) => {
        // Loaded before converting: DuckDB pushes casts into the file reader, where one bad value fails the whole import even with TRY_CAST
        await c.run(`CREATE OR REPLACE TEMP TABLE _import AS SELECT * FROM ${from}`);
        if (typed.length) {
          const sum = typed.map((f) => `count(*) FILTER (WHERE ${q(f.name)} IS NOT NULL AND trim(CAST(${q(f.name)} AS VARCHAR)) <> '' AND ${convertSql(f.name, f.type)} IS NULL)`).join(" + ");
          conversionIssues = Number(toResult(await c.runAndReadAll(`SELECT ${sum} AS n FROM _import`), Date.now(), 1).rows[0].n);
        }
        let select = "*";
        if (fields) {
          const taken = new Set(fields.filter((f) => !f.flatten).map((f) => f.to.toLowerCase())), parts: string[] = [];
          for (const f of fields) {
            if (!f.flatten) { parts.push(`${f.type ? convertSql(f.name, f.type) : q(f.name)} AS ${q(f.to)}`); continue; }
            // Read from every row, so a key that first appears late still gets its column
            const leaves: Leaves = new Map(), r = await c.stream(`SELECT CAST(to_json(${q(f.name)}) AS VARCHAR) FROM _import WHERE ${q(f.name)} IS NOT NULL`);
            for (;;) {
              const chunk = await r.fetchChunk();
              if (!chunk || chunk.rowCount === 0) break;
              for (const [v] of chunk.getRows()) collectLeaves(leaves, parsed(v));
              if (leaves.size > MAX_FLATTENED) throw new HttpError(400, `${f.name} would become more than ${MAX_FLATTENED} columns. Keep it nested, and extract the fields you need in a model.`);
            }
            if (leaves.size) parts.push(...flattenSql(f.name, f.to, leaves, taken));
            else parts.push(`${q(f.name)} AS ${q(f.to)}`);
          }
          select = parts.join(", ");
        }
        await c.run(`CREATE SCHEMA IF NOT EXISTS ${q(`file_${slug}`)}`);
        if (replacing) {
          const was = (await c.runAndReadAll(`SELECT column_name n FROM information_schema.columns WHERE table_schema = ${lit(`file_${slug}`)} AND table_name = ${lit(table)}`)).getRowObjectsJson().map((x) => String(x.n));
          const now = new Set((fields ? fields.map((f) => f.to) : (await c.runAndReadAll("SELECT column_name AS n FROM (DESCRIBE _import)")).getRowObjectsJson().map((x) => String(x.n))).map((x) => x.toLowerCase()));
          removed = was.filter((x) => !now.has(x.toLowerCase()));
        }
        await c.run(`CREATE OR REPLACE TABLE ${q(`file_${slug}`)}.${q(table)} AS SELECT ${select} FROM _import`);
        await c.run(`DROP TABLE _import`);
      }, sourceStore());
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, `Basalt couldn't read this file: ${e instanceof Error ? e.message.split("\n")[0].split(` in file "${tmp}"`).join("").split(tmp).join(file.name) : e}`);
    } finally { fs.rmSync(tmp, { force: true }); }
    if (replacing && replacedPipeline) {
      // A file has no cursor to read from, so its rows are only ever replaced whole
      saveConfig({ ...cfg, pipelines: cfg.pipelines.map((p) => (p.id === replacedPipeline.id ? { ...p, streams: p.streams.map((s) => ({ ...s, mode: "full_refresh" as const })) } : p)) });
      audit(user.name, "Replaced an imported file", replacing.name);
      return { connection: replacing, pipeline: replacedPipeline, table, conversionIssues, removed };
    }
    return { ...finish({ id: crypto.randomUUID(), name, type: "file", slug, createdAt: new Date().toISOString() }, [{ name: table }]), table, conversionIssues };
  }

  const b = await req.json();
  if (b.type === "airbyte") {
    // A connector is third-party code running on this server
    if (user.role !== "admin") throw new HttpError(403, "Only admins can install or run Airbyte connectors.");
    if (!b.config || typeof b.config !== "object" || Array.isArray(b.config)) throw new HttpError(400, "Enter this connector's settings.");
    const ref = await resolveRef(String(b.definitionId ?? "")), secret = JSON.stringify(b.config);
    const conn: Connection = { id: "", name: String(b.name ?? "").trim() || ref.name, type: "airbyte", slug: "", airbyte: ref, createdAt: "" };
    audit(user.name, b.action === "test" ? "Tested Airbyte connector" : "Added Airbyte connector", `${ref.repo}:${ref.version}`, true);
    if (b.action === "test") return inspectAirbyte(conn, secret, user.name);
    conn.id = crypto.randomUUID();
    conn.slug = slugify(conn.name, taken);
    conn.createdAt = new Date().toISOString();
    // Saved only once it works, so a bad login isn't kept. The whole settings object is stored encrypted, so it never reaches the browser with the config.
    const { streams } = await inspectAirbyte(conn, secret, user.name);
    saveSecret(conn.id, secret);
    return finish(conn, streams);
  }
  const role = b.auth === "role";
  if (role) {
    if (!["s3", "dynamodb", "athena"].includes(b.type)) throw new HttpError(400, "Only AWS connections can use a role.");
    // It acts with this server's own AWS identity
    if (user.role !== "admin") throw new HttpError(403, "Only admins can connect with a role.");
    if (!ROLE_ARN.test(String(b.roleArn ?? "").trim())) throw new HttpError(400, "Enter the role ARN, such as arn:aws:iam::123456789012:role/basalt-read.");
    b.password = externalId();
  }
  const conn = draft(role ? { ...b, auth: "chain" } : b);
  if (role) {
    conn.auth = "role"; conn.roleArn = String(b.roleArn).trim();
    // A custom endpoint isn't AWS, so it has no trust policy to check
    if (!conn.host) await requireExternalId(conn).catch((e: Error) => { throw new HttpError(400, e.message); });
  }
  if (b.action === "test") return inspect(conn, String(b.password ?? ""));
  conn.id = crypto.randomUUID();
  conn.slug = slugify(conn.name, taken);
  conn.createdAt = new Date().toISOString();
  const { streams } = await inspect(conn, String(b.password ?? ""));
  saveSecret(conn.id, String(b.password ?? ""));
  return finish(conn, streams);
});

/** Host, port, TLS and login for a database connection. Its copied data and pipelines stay. The saved password is never sent back. */
export const PATCH = api("admin", async (req, user) => {
  const b = await req.json(), conn = getConfig().connections.find((c) => c.id === b.id), password = String(b.password ?? "");
  if (!conn) throw new HttpError(404, "This connection no longer exists.");
  if (conn.type !== "postgres" && conn.type !== "mysql") throw new HttpError(400, "Only PostgreSQL and MySQL connections can be edited here.");
  const d = draft({ type: conn.type, name: conn.name, database: conn.database, host: b.host, port: b.port, user: b.user, ssl: b.ssl, ca: b.ca, caOnly: b.caOnly });
  const rest = { ...conn }; delete rest.ca; delete rest.caOnly;
  const next: Connection = { ...rest, host: d.host, port: d.port, user: d.user, ssl: d.ssl, ...(d.ca ? { ca: d.ca, caOnly: d.caOnly } : {}) };
  // Otherwise whoever can edit could send the saved password to a server of their choosing, or in the clear
  if ((next.host !== conn.host || next.port !== conn.port || (conn.ssl && !next.ssl)) && !password) throw new HttpError(400, "Enter the password again to use it with a new address or without TLS.");
  await inspect(next, password || undefined);
  const cfg = getConfig();
  saveConfig({ ...cfg, connections: cfg.connections.map((c) => (c.id === conn.id ? next : c)) });
  if (password) saveSecret(conn.id, password);
  const changed = (["host", "port", "user", "ssl", "ca", "caOnly"] as const).filter((k) => next[k] !== conn[k]);
  audit(user.name, "Edited connection", `${conn.name}: ${[...changed, ...(password ? ["password"] : [])].join(", ") || "nothing changed"}`, true);
  return { connection: next };
});

export const DELETE = api("admin", async (req, user) => {
  const id = new URL(req.url).searchParams.get("id"), cfg = getConfig();
  const conn = cfg.connections.find((c) => c.id === id);
  if (!conn) throw new HttpError(404, "This connection no longer exists.");
  // Data first: if this fails the connection is still there to retry, and nothing is left orphaned
  await withConn((c) => c.run(`DROP SCHEMA IF EXISTS ${q(`raw_${conn.slug}`)} CASCADE`));
  if (conn.type === "file") await withConn((c) => c.run(`DROP SCHEMA IF EXISTS ${q(`file_${conn.slug}`)} CASCADE`), sourceStore());
  deleteSecret(conn.id);
  if (conn.type === "airbyte") forgetCatalog(conn.id);
  saveConfig({ ...cfg, connections: cfg.connections.filter((c) => c.id !== id), pipelines: cfg.pipelines.filter((p) => p.connectionId !== id) });
  audit(user.name, "Removed connection and its copied data", conn.name, true);
});
