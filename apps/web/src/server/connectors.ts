import "server-only";
import { assertHostedAllowed } from "@/lib/hosted";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { DuckDBInstance, type DuckDBDataChunk } from "@duckdb/node-api";
import type { Client as PgClient } from "pg";
import type { Connection as MyConn } from "mysql2/promise";
import { withConn, sourceStore, toResult } from "./engine";
import { airbyteSource } from "./airbyte";
import { cloudSource } from "./cloud";
import { getSecret } from "./files";
import { storageSource } from "./lake";
import { asTextSql } from "@/lib/nested";
import { toDuckType } from "@/lib/sourceRows";
import { q, lit } from "@/lib/sql";
import type { Column, Connection, LogMessage, StreamInfo } from "@/lib/types";

// Called indirectly on purpose: the bundler reads a direct path.join with variable parts as a glob over the project, which lists ./data in the build
const joinPath = path.join.bind(path);

export { toDuckType };
export type Batch = (string | null)[][];
export type ReadOpts = { columns: Column[]; cursor?: string; after?: string; maxRows?: number; orderBy?: string; inclusive?: boolean; state?: Record<string, string>; withheld?: string[]; log?: (m: Omit<LogMessage, "at">) => void };
export interface Source {
  /** CHECK: reach the database and confirm the login can't write. Returns notes to show the person connecting. */
  check(): Promise<string[]>;
  /** DISCOVER: tables, columns and primary keys. */
  discover(): Promise<StreamInfo[]>;
  sample(stream: string, column: string): Promise<(string | null)[]>;
  count(stream: string): Promise<number>;
  /** READ: rows as text in batches. Types are restored when they reach the warehouse. */
  read(stream: string, opts: ReadOpts, onBatch: (rows: Batch) => Promise<void>): Promise<void>;
  /** A much faster read through DuckDB's own reader, or null if it can't be used here. Chunks hold every column as text, in column order. */
  fastRead?(stream: string, opts: ReadOpts): Promise<AsyncIterable<DuckDBDataChunk> | null>;
  close(): Promise<void>;
  /** The source can't report a row total, so there's no row check to make. */
  uncounted?: boolean;
  /** Saves a connector's own progress into the pipeline state. Called only after the rows are committed. */
  commitState?(stream: string, state: Record<string, string>): boolean;
}

const BATCH = 5000;
const text = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString("hex");
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};
/** JSON text for a JSON column, where a bare string isn't valid. */
const jsonText = (v: unknown, col?: Column) => (v != null && col?.type === "JSON" ? JSON.stringify(v) : text(v));
const PG_ARRAY: Record<string, string> = { _int2: "INTEGER", _int4: "INTEGER", _int8: "BIGINT", _float4: "DOUBLE", _float8: "DOUBLE", _numeric: "DOUBLE", _bool: "BOOLEAN", _text: "VARCHAR", _varchar: "VARCHAR", _bpchar: "VARCHAR", _uuid: "VARCHAR", _date: "DATE", _timestamp: "TIMESTAMP", _timestamptz: "TIMESTAMP" };
/** PostgreSQL reports every array as data_type "ARRAY"; udt_name holds the element, and attndims the declared depth. Unknown arrays stay as text. */
export const pgType = (dataType: string, udt: string, dims = 1): string => {
  if (dataType === "ARRAY" && PG_ARRAY[udt]) return PG_ARRAY[udt] + "[]".repeat(Math.max(1, dims));
  return toDuckType(dataType);
};
// Updating by one column of a composite key would delete unrelated rows, so only a single-column key is offered.
function withSingleKey(streams: Map<string, StreamInfo>, keys: Map<string, string[]>) {
  for (const [name, k] of keys) if (k.length === 1) streams.get(name)!.primaryKey = k[0];
  return [...streams.values()];
}

/* ---- sample data and uploaded files, kept in the separate source store ---- */
function localSource(schema: string): Source {
  const db = sourceStore();
  const run = <T,>(fn: Parameters<typeof withConn<T>>[0]) => withConn(fn, db);
  const rows = (sql: string) => run(async (c) => toResult(await c.runAndReadAll(sql), Date.now(), 1e9).rows);
  return {
    check: async () => ["Stored on this server"],
    async discover() {
      const cols = await rows(`SELECT table_name t, column_name c, data_type d FROM information_schema.columns WHERE table_schema = ${lit(schema)} ORDER BY t, ordinal_position`);
      const out = new Map<string, StreamInfo>();
      for (const r of cols) {
        const name = String(r.t);
        if (!out.has(name)) out.set(name, { name, columns: [] });
        out.get(name)!.columns.push({ name: String(r.c), type: String(r.d) });
      }
      return [...out.values()];
    },
    async sample(stream, column) { return (await rows(`SELECT CAST(${q(column)} AS VARCHAR) v FROM ${q(schema)}.${q(stream)} WHERE ${q(column)} IS NOT NULL LIMIT 50`)).map((r) => r.v as string); },
    async count(stream) { return Number((await rows(`SELECT count(*) n FROM ${q(schema)}.${q(stream)}`))[0].n); },
    async read(stream, { columns, cursor, after, maxRows, inclusive }, onBatch) {
      const sel = columns.map((c) => asTextSql(c.name, c.type)).join(", ");
      const where = cursor && after ? `WHERE ${q(cursor)} ${inclusive ? ">=" : ">"} ${lit(after)}` : "";
      await run(async (c) => {
        const r = await c.stream(`SELECT ${sel} FROM ${q(schema)}.${q(stream)} ${where} ${cursor ? `ORDER BY ${q(cursor)}` : ""} ${maxRows ? `LIMIT ${maxRows}` : ""}`);
        for (;;) {
          const chunk = await r.fetchChunk();
          if (!chunk || chunk.rowCount === 0) break;
          await onBatch(chunk.getRows().map((row) => row.map((v) => (v == null ? null : String(v)))));
        }
      });
    },
    close: async () => {},
  };
}

/* ---- PostgreSQL ---- */
async function pgSource(conn: Connection, password: string): Promise<Source> {
  const { Client } = await import("pg");
  const { types } = await import("pg");
  let gate: DuckDBInstance | undefined, caFile: string | undefined;
  const client: PgClient = new Client({
    // dates and zone-less timestamps stay as written; turning them into JS Dates shifts them by this server's zone
    types: { getTypeParser: ((oid: number, format?: "text" | "binary") => (oid === 1082 || oid === 1114 ? (v: string) => v : types.getTypeParser(oid, format as "text"))) as typeof types.getTypeParser },
    host: conn.host, port: conn.port ?? 5432, database: conn.database, user: conn.user, password,
    // With no CA pasted, Node's public roots apply, which cover Azure Database. RDS, Aurora and Cloud SQL use their own CAs
    ssl: conn.ssl ? { rejectUnauthorized: true, ...(conn.ca ? { ca: conn.ca } : {}), ...(conn.ca && conn.caOnly ? { checkServerIdentity: () => undefined } : {}) } : undefined, connectionTimeoutMillis: 10000, statement_timeout: 300000, application_name: "basalt",
  });
  await client.connect().catch((e: Error) => { throw /certificate|altnames/i.test(e.message) ? new Error(`Basalt couldn't verify this server's certificate: ${e.message}. Add the CA certificate from your cloud provider to this connection.`) : e; });
  // session stays read-only, so even a bug on our side can't write to the customer's database
  await client.query("SET default_transaction_read_only = on");
  const parse = (s: string) => { const i = s.indexOf("."); return i < 0 ? ["public", s] : [s.slice(0, i), s.slice(i + 1)]; };
  const qt = (s: string) => parse(s).map(q).join(".");
  return {
    async check() {
      const notes: string[] = ["Reached the database", "Session set to read-only"];
      const r = await client.query(`SELECT version() v, pg_is_in_recovery() replica, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) su,
        (SELECT count(*) FROM information_schema.table_privileges WHERE grantee = current_user AND privilege_type IN ('INSERT','UPDATE','DELETE') AND table_schema NOT IN ('pg_catalog','information_schema')) writes`);
      const row = r.rows[0];
      notes.push(String(row.v).split(" ").slice(0, 2).join(" "));
      notes.push(row.replica ? "Connected to a read replica" : "Connected to the primary. A read replica avoids any load on production.");
      if (row.su) notes.push("Warning: this login is a superuser. Use a read-only login.");
      else if (Number(row.writes) > 0) notes.push(`Warning: this login can write to ${row.writes} tables. Use a read-only login.`);
      return notes;
    },
    async discover() {
      const { rows } = await client.query(`SELECT c.table_schema s, c.table_name t, c.column_name n, c.data_type d, c.udt_name u,
        (SELECT a.attndims FROM pg_attribute a WHERE a.attrelid = format('%I.%I', c.table_schema, c.table_name)::regclass AND a.attname = c.column_name) dims,
        EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indisprimary AND i.indrelid = format('%I.%I', c.table_schema, c.table_name)::regclass AND a.attname = c.column_name) pk
        FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE t.table_type = 'BASE TABLE' AND c.table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2, c.ordinal_position`);
      const out = new Map<string, StreamInfo>(), keys = new Map<string, string[]>();
      for (const r of rows) {
        const name = r.s === "public" ? r.t : `${r.s}.${r.t}`;
        if (!out.has(name)) out.set(name, { name, columns: [] });
        const si = out.get(name)!;
        si.columns.push({ name: r.n, type: pgType(r.d, r.u, r.dims) });
        if (r.pk) keys.set(name, [...(keys.get(name) ?? []), r.n]);
      }
      return withSingleKey(out, keys);
    },
    async sample(stream, column) { return (await client.query(`SELECT ${q(column)}::text v FROM ${qt(stream)} WHERE ${q(column)} IS NOT NULL LIMIT 50`)).rows.map((r) => r.v); },
    async count(stream) { return Number((await client.query(`SELECT count(*) n FROM ${qt(stream)}`)).rows[0].n); },
    async read(stream, { columns, cursor, after, maxRows, orderBy, inclusive }, onBatch) {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const sel = columns.map((c) => q(c.name)).join(", "), order = cursor ?? orderBy;
        const where = cursor && after ? `WHERE ${q(cursor)} ${inclusive ? ">=" : ">"} $1` : "";
        // A cursor stays quick however far it gets; OFFSET re-reads every earlier row on each page
        await client.query({ text: `DECLARE basalt_read NO SCROLL CURSOR FOR SELECT ${sel} FROM ${qt(stream)} ${where} ${order ? `ORDER BY ${q(order)}` : ""}${maxRows ? ` LIMIT ${Number(maxRows)}` : ""}`, values: where ? [after] : [] });
        for (;;) {
          const { rows } = await client.query({ text: `FETCH ${BATCH} FROM basalt_read`, rowMode: "array" });
          if (!rows.length) break;
          await onBatch(rows.map((r: unknown[]) => r.map((v, i) => jsonText(v, columns[i]))));
        }
      } finally { await client.query("COMMIT"); }
    },
    /** Reads through DuckDB's PostgreSQL reader in a throwaway engine, which is far faster than passing rows through Node. */
    async fastRead(stream, { columns, cursor, after, maxRows, orderBy, inclusive }) {
      try {
        gate ??= await DuckDBInstance.create(":memory:");
        const c = await gate.connect(), e = (v: unknown) => `'${String(v ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
        await c.run("INSTALL postgres; LOAD postgres; INSTALL icu; LOAD icu; SET TimeZone = 'UTC'");
        // The same checks as the client above. libpq can't use Node's roots directly, and may reconnect during a read, so the file stays until close
        if (conn.ssl && !caFile) { caFile = joinPath(os.tmpdir(), `basalt-${crypto.randomUUID()}.pem`); fs.writeFileSync(caFile, conn.ca || tls.rootCertificates.join("\n")); }
        const dsn = `host=${e(conn.host)} port=${conn.port ?? 5432} dbname=${e(conn.database)} user=${e(conn.user)} password=${e(password)} ${conn.ssl ? `sslmode=${conn.ca && conn.caOnly ? "verify-ca" : "verify-full"} sslrootcert=${e(caFile)}` : "sslmode=disable"} application_name=basalt`;
        await c.run(`ATTACH ${lit(dsn)} AS basalt_src (TYPE postgres, READ_ONLY)`);
        // Sorting only matters when a cursor or a row limit depends on the order
        const [schema, name] = stream.includes(".") ? stream.split(".") : ["public", stream], order = cursor ?? (maxRows ? orderBy : undefined);
        const sel = columns.map((x) => asTextSql(x.name, x.type)).join(", "), where = cursor && after ? `WHERE ${q(cursor)} ${inclusive ? ">=" : ">"} ${lit(after)}` : "";
        const r = await c.stream(`SELECT ${sel} FROM basalt_src.${q(schema)}.${q(name)} ${where} ${order ? `ORDER BY ${q(order)}` : ""} ${maxRows ? `LIMIT ${Number(maxRows)}` : ""}`);
        return (async function* () { try { for (;;) { const chunk = await r.fetchChunk(); if (!chunk || chunk.rowCount === 0) return; yield chunk; } } finally { c.closeSync(); } })();
      } catch { return null; }
    },
    close: async () => { gate?.closeSync(); gate = undefined; if (caFile) fs.rmSync(caFile, { force: true }); await client.end(); },
  };
}

/* ---- MySQL and MariaDB ---- */
async function mysqlSource(conn: Connection, password: string): Promise<Source> {
  const mysql = await import("mysql2/promise");
  const c: MyConn = await mysql.createConnection({
    host: conn.host, port: conn.port ?? 3306, database: conn.database, user: conn.user, password,
    // With no CA pasted, Node's public roots apply, which cover Azure Database. RDS, Aurora and Cloud SQL use their own CAs
    ssl: conn.ssl ? { rejectUnauthorized: true, ...(conn.ca ? { ca: conn.ca } : {}), verifyIdentity: !(conn.ca && conn.caOnly) } : undefined, connectTimeout: 10000, dateStrings: true, rowsAsArray: false,
  });
  await c.query("SET SESSION TRANSACTION READ ONLY");
  const mq = (id: string) => "`" + id.replace(/`/g, "``") + "`";
  const list = async (sql: string, args: unknown[] = []) => (await c.query(sql, args))[0] as Record<string, unknown>[];
  return {
    async check() {
      const [v] = await list("SELECT VERSION() v");
      const grants = (await list("SHOW GRANTS")).map((g) => String(Object.values(g)[0]));
      const canWrite = grants.some((g) => /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP)\b/i.test(g));
      return ["Reached the database", "Session set to read-only", `MySQL ${v.v}`, canWrite ? "Warning: this login has write permissions. Use a read-only login." : "Login has no write permissions"];
    },
    async discover() {
      const rows = await list(`SELECT TABLE_NAME t, COLUMN_NAME n, DATA_TYPE d, COLUMN_KEY k FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE') ORDER BY 1, ORDINAL_POSITION`, [conn.database, conn.database]);
      const out = new Map<string, StreamInfo>(), keys = new Map<string, string[]>();
      for (const r of rows) {
        const name = String(r.t);
        if (!out.has(name)) out.set(name, { name, columns: [] });
        const si = out.get(name)!;
        si.columns.push({ name: String(r.n), type: toDuckType(String(r.d)) });
        if (r.k === "PRI") keys.set(name, [...(keys.get(name) ?? []), String(r.n)]);
      }
      return withSingleKey(out, keys);
    },
    async sample(stream, column) { return (await list(`SELECT CAST(${mq(column)} AS CHAR) v FROM ${mq(stream)} WHERE ${mq(column)} IS NOT NULL LIMIT 50`)).map((r) => r.v as string); },
    async count(stream) { return Number((await list(`SELECT count(*) n FROM ${mq(stream)}`))[0].n); },
    async read(stream, { columns, cursor, after, maxRows, orderBy, inclusive }, onBatch) {
      const sel = columns.map((x) => mq(x.name)).join(", "), order = cursor ?? orderBy;
      const where = cursor && after ? `WHERE ${mq(cursor)} ${inclusive ? ">=" : ">"} ?` : "";
      // One query streamed: paging with OFFSET slows as it goes and can lose or repeat rows when there's no order
      const rows = (c as unknown as { connection: { query(o: { sql: string; values: unknown[] }): { stream(): unknown } } }).connection.query({ sql: `SELECT ${sel} FROM ${mq(stream)} ${where} ${order ? `ORDER BY ${mq(order)}` : ""} ${maxRows ? `LIMIT ${Number(maxRows)}` : ""}`, values: where ? [after] : [] }).stream();
      let batch: Batch = [];
      for await (const r of rows as AsyncIterable<Record<string, unknown>>) {
        batch.push(columns.map((x) => jsonText(r[x.name], x)));
        if (batch.length >= BATCH) { await onBatch(batch); batch = []; }
      }
      if (batch.length) await onBatch(batch);
    },
    close: () => c.end(),
  };
}

export async function openSource(conn: Connection, password?: string): Promise<Source> {
  if (conn.type === "sample") return localSource("sample");
  if (conn.type === "file") return localSource(`file_${conn.slug}`);
  const pw = password ?? getSecret(conn.id) ?? "";
  await assertHostedAllowed(conn, pw);
  if (conn.type === "s3" || conn.type === "gcs" || conn.type === "azure") return storageSource(conn, pw);
  if (conn.type === "bigquery" || conn.type === "snowflake") return cloudSource(conn, pw);
  if (conn.type === "airbyte") return airbyteSource(conn, pw);
  // Imported on first use, so these SDKs add nothing to startup or to pages that never need them
  if (conn.type === "dynamodb") return (await import("./sources/dynamodb")).dynamoSource(conn, pw);
  if (conn.type === "athena") return (await import("./sources/athena")).athenaSource(conn, pw);
  if (conn.type === "redshift") return (await import("./sources/redshift")).redshiftSource(conn, pw);
  if (conn.type === "firestore") return (await import("./sources/firestore")).firestoreSource(conn, pw);
  if (conn.type === "spanner") return (await import("./sources/spanner")).spannerSource(conn, pw);
  if (conn.type === "cosmos") return (await import("./sources/cosmos")).cosmosSource(conn, pw);
  if (conn.type === "mssql" || conn.type === "synapse") return (await import("./sources/mssql")).mssqlSource(conn, pw);
  return conn.type === "postgres" ? pgSource(conn, pw) : mysqlSource(conn, pw);
}
