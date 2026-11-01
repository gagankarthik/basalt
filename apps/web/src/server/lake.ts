import "server-only";
import { assertHostedAllowed } from "@/lib/hosted";
import { gcsToken, roleCredentials } from "./sources/common";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { lit, q } from "@/lib/sql";
import { asTextSql } from "@/lib/nested";
import { MAX_XML_BYTES, XML_TOO_LARGE, xmlRows } from "@/lib/xml";
import type { Connection, StreamInfo } from "@/lib/types";
import type { Batch, ReadOpts, Source } from "./connectors";

// Called indirectly on purpose: the bundler reads a direct path.join with variable parts as a glob over the project, which lists ./data in the build
const joinPath = path.join.bind(path);

const FORMATS: Record<string, string> = { ".csv": "csv", ".tsv": "csv", ".parquet": "parquet", ".json": "json", ".jsonl": "json", ".ndjson": "json", ".xlsx": "xlsx", ".xml": "xml", ".avro": "avro" };
export const formatOf = (file: string) => FORMATS[path.extname(file).toLowerCase()];
type Stream = { format: string; paths: string[] };

/** A throwaway engine with network access. It's separate from the warehouse, which stays locked, and user SQL never reaches it. */
export async function openGateway(conn?: Connection, secret?: string) {
  if (conn) await assertHostedAllowed(conn, secret);
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await c.run("INSTALL httpfs; LOAD httpfs;");
  if (conn?.type === "azure") {
    await c.run("INSTALL azure; LOAD azure;");
    await c.run(conn.auth === "principal" ? `CREATE SECRET (TYPE azure, PROVIDER service_principal, TENANT_ID ${lit(conn.tenantId ?? "")}, CLIENT_ID ${lit(conn.clientId ?? "")}, CLIENT_SECRET ${lit(secret ?? "")}, ACCOUNT_NAME ${lit(conn.user ?? "")})`
      : conn.auth === "chain" ? `CREATE SECRET (TYPE azure, PROVIDER credential_chain, CHAIN 'managed_identity;workload_identity', ACCOUNT_NAME ${lit(conn.user ?? "")})`
      : `CREATE SECRET (TYPE azure, CONNECTION_STRING ${lit(conn.auth === "string" ? secret ?? "" : `DefaultEndpointsProtocol=https;AccountName=${conn.user};AccountKey=${secret};EndpointSuffix=core.windows.net`)})`);
  }
  if (conn?.type === "s3" || conn?.type === "gcs") {
    // The aws extension has no provider for ECS task roles, so those aren't in this chain
    if (conn.auth === "chain") await c.run("INSTALL aws; LOAD aws;");
    // shortcut: these keys and Google tokens last an hour and a DuckDB secret can't renew them, so a single read or export over an hour fails; open a new secret per file if that happens
    const temp = conn.auth === "role" ? await roleCredentials(conn, secret ?? "")() : null;
    const opts = [`TYPE ${conn.type}`, ...(conn.auth === "serviceAccount" ? [`BEARER_TOKEN ${lit(await gcsToken(secret ?? ""))}`] : temp ? [`KEY_ID ${lit(temp.accessKeyId)}`, `SECRET ${lit(temp.secretAccessKey)}`, `SESSION_TOKEN ${lit(temp.sessionToken ?? "")}`] : conn.auth === "chain" ? ["PROVIDER credential_chain", "CHAIN 'env;web_identity;instance;config'"] : [`KEY_ID ${lit(conn.user ?? "")}`, `SECRET ${lit(secret ?? "")}`])];
    if (conn.region) opts.push(`REGION ${lit(conn.region)}`);
    if (conn.host) {
      const u = new URL(/:\/\//.test(conn.host) ? conn.host : `https://${conn.host}`);
      opts.push(`ENDPOINT ${lit(u.host)}`, "URL_STYLE 'path'", `USE_SSL ${u.protocol === "https:"}`);
    }
    await c.run(`CREATE SECRET (${opts.join(", ")})`).catch((e: Error) => { throw conn.auth === "chain" ? new Error("Basalt found no AWS credentials on this server. Use an access key, or contact your administrator.") : e; });
  }
  return { c, close: () => { c.closeSync(); db.closeSync(); } };
}

export const bucketUrl = (conn: Connection, rest = "") => `${conn.type === "gcs" ? "gs" : conn.type === "azure" ? "az" : "s3"}://${conn.database}/${[conn.prefix?.replace(/^\/+|\/+$/g, ""), rest].filter(Boolean).join("/")}`;

/** Folders of same-format files are one table, a folder with _delta_log is a Delta table, and a loose file is its own table. */
export function groupFiles(files: string[], root: string) {
  const out = new Map<string, Stream>();
  const add = (name: string, format: string, file: string) => {
    const s = out.get(name);
    if (s && s.format === format) s.paths.push(file);
    else if (!s) out.set(name, { format, paths: [file] });
  };
  const deltaRoots = new Set(files.flatMap((f) => { const i = f.indexOf("/_delta_log/"); return i < 0 ? [] : [f.slice(0, i)]; }));
  for (const d of deltaRoots) out.set(d.slice(root.length).replace(/^\/+/, "") || path.posix.basename(d), { format: "delta", paths: [d] });
  for (const f of files) {
    if ([...deltaRoots].some((d) => f.startsWith(`${d}/`))) continue;
    const format = formatOf(f);
    if (!format) continue;
    const rel = f.slice(root.length).replace(/^\/+/, ""), dir = path.posix.dirname(rel);
    if (dir === ".") add(path.posix.basename(rel, path.posix.extname(rel)), format, f);
    else add(dir, format, f);
  }
  return out;
}

async function xmlView(c: DuckDBConnection, files: string[], name: string) {
  const list = `[${files.map(lit).join(", ")}]`;
  // Asked first, so an oversized file is never pulled into memory
  const sizes = (await c.runAndReadAll(`SELECT size FROM read_blob(${list})`)).getRowObjectsJson() as { size: string | number }[];
  if (sizes.reduce((a, r) => a + Number(r.size), 0) > MAX_XML_BYTES) throw new Error(XML_TOO_LARGE);
  const rows = (await c.runAndReadAll(`SELECT content FROM read_text(${list})`)).getRowObjectsJson() as { content: string }[];
  const tmp = joinPath(os.tmpdir(), `basalt-${crypto.randomUUID()}.ndjson`);
  try {
    fs.writeFileSync(tmp, rows.flatMap((r) => xmlRows(r.content)).map((r) => JSON.stringify(r)).join("\n"));
    await c.run(`CREATE OR REPLACE TEMP TABLE ${q(name)} AS SELECT * FROM read_json_auto(${lit(tmp)}, format = 'newline_delimited', sample_size = -1)`);
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function storageSource(conn: Connection, secret: string): Source {
  const root = bucketUrl(conn).replace(/\/+$/, "");
  let gate: Awaited<ReturnType<typeof openGateway>> | undefined, streams: Map<string, Stream> | undefined;
  const open = async () => (gate ??= await openGateway(conn, secret));
  const rows = async (sql: string) => (await (await open()).c.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
  const list = async () => (streams ??= groupFiles((await rows(`SELECT file FROM glob(${lit(`${root}/**`)})`)).map((r) => String(r.file)), root));
  const loaded = new Set<string>();
  const from = async (stream: string) => {
    const s = (await list()).get(stream);
    if (!s) throw new Error(`${stream} wasn't found in storage.`);
    const paths = `[${s.paths.map(lit).join(", ")}]`, c = (await open()).c;
    if (s.format === "csv") return `read_csv_auto(${paths}, union_by_name = true, sample_size = -1)`;
    if (s.format === "parquet") return `read_parquet(${paths}, union_by_name = true)`;
    // Every row is read to find the types: from a sample, a later key is dropped and a later type fails the sync
    if (s.format === "json") return `read_json_auto(${paths}, union_by_name = true, sample_size = -1)`;
    if (s.format === "avro") { if (!loaded.has("avro")) { await c.run("INSTALL avro; LOAD avro;"); loaded.add("avro"); } return `read_avro(${paths}, union_by_name = true)`; }
    if (s.format === "delta") { if (!loaded.has("delta")) { await c.run("INSTALL delta; LOAD delta;"); loaded.add("delta"); } return `delta_scan(${lit(s.paths[0])})`; }
    if (s.format === "xlsx") { if (!loaded.has("excel")) { await c.run("INSTALL excel; LOAD excel;"); loaded.add("excel"); } return `read_xlsx(${lit(s.paths[0])}, header = true)`; }
    const view = `xml_${crypto.createHash("sha1").update(stream).digest("hex").slice(0, 10)}`;
    if (!loaded.has(view)) { await xmlView(c, s.paths, view); loaded.add(view); }
    return q(view);
  };
  return {
    async check() { const n = (await list()).size; return [`Reached ${root}`, `Found ${n} table${n === 1 ? "" : "s"} in CSV, JSON, Parquet, Avro, Excel, XML or Delta Lake format`]; },
    async discover() {
      const out: StreamInfo[] = [];
      for (const name of (await list()).keys()) out.push({ name, columns: (await rows(`DESCRIBE SELECT * FROM ${await from(name)}`)).map((r) => ({ name: String(r.column_name), type: String(r.column_type) })) });
      return out;
    },
    async sample(stream, column) { return (await rows(`SELECT CAST(${q(column)} AS VARCHAR) v FROM ${await from(stream)} WHERE ${q(column)} IS NOT NULL LIMIT 50`)).map((r) => r.v as string); },
    async count(stream) { return Number((await rows(`SELECT count(*) n FROM ${await from(stream)}`))[0].n); },
    async read(stream, { columns, cursor, after, maxRows, inclusive }: ReadOpts, onBatch: (b: Batch) => Promise<void>) {
      const sel = columns.map((x) => asTextSql(x.name, x.type)).join(", "), where = cursor && after ? `WHERE ${q(cursor)} ${inclusive ? ">=" : ">"} ${lit(after)}` : "";
      const r = await (await open()).c.stream(`SELECT ${sel} FROM ${await from(stream)} ${where} ${cursor ? `ORDER BY ${q(cursor)}` : ""} ${maxRows ? `LIMIT ${maxRows}` : ""}`);
      for (;;) {
        const chunk = await r.fetchChunk();
        if (!chunk || chunk.rowCount === 0) break;
        await onBatch(chunk.getRows().map((row) => row.map((v) => (v == null ? null : String(v)))));
      }
    },
    close: async () => { gate?.close(); gate = undefined; },
  };
}
