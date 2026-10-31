import type { Client as PgClient } from "pg";
import type { Connection, StreamInfo } from "../../lib/types.ts";
import { q } from "../../lib/sql.ts";
import { toDuckType, toText } from "../../lib/sourceRows.ts";
import type { Source } from "../connectors.ts";

const BATCH = 5000;
const duck = (t: string) => (/^super$/i.test(t) ? "JSON" : toDuckType(t));
const parts = (s: string) => { const i = s.indexOf("."); return i < 0 ? ["public", s] : [s.slice(0, i), s.slice(i + 1)]; };
const qt = (s: string) => parts(s).map(q).join(".");

/** Provisioned and Serverless speak the same protocol. Redshift has no session read-only setting or pg_roles, so this isn't the PostgreSQL source with a new label. */
export async function redshiftSource(conn: Connection, password: string): Promise<Source> {
  const { Client, types } = await import("pg");
  const client: PgClient = new Client({
    // dates and zone-less timestamps stay as written; turning them into JS Dates shifts them by this server's zone
    types: { getTypeParser: ((oid: number, format?: "text" | "binary") => (oid === 1082 || oid === 1114 ? (v: string) => v : types.getTypeParser(oid, format as "text"))) as typeof types.getTypeParser },
    host: conn.host, port: conn.port ?? 5439, database: conn.database, user: conn.user, password,
    ssl: conn.ssl ? { rejectUnauthorized: true, ...(conn.ca ? { ca: conn.ca } : {}) } : undefined, connectionTimeoutMillis: 15000,
  });
  await client.connect().catch((e: Error) => { throw /certificate|altnames/i.test(e.message) ? new Error(`Basalt couldn't verify this server's certificate: ${e.message}. Add the CA certificate to this connection.`) : e; });
  const typeOf = new Map<string, string>();
  const asText = (stream: string, c: string) => (typeOf.get(`${stream}\0${c}`) === "super" ? `JSON_SERIALIZE(${q(c)})` : q(c));
  /** Each statement in a READ ONLY transaction, which is how Redshift refuses writes. */
  const inTx = async <T,>(fn: () => Promise<T>) => { await client.query("BEGIN READ ONLY"); try { return await fn(); } finally { await client.query("COMMIT"); } };
  const self: Source = {
    async check() {
      const notes = ["Reached the warehouse", "Every read runs in a read-only transaction"];
      const can = (p: string) => `has_table_privilege(current_user, quote_ident(schemaname) || '.' || quote_ident(tablename), '${p}')`;
      const row = await inTx(async () => (await client.query(`SELECT version() v, (SELECT usesuper FROM pg_user WHERE usename = current_user) su,
        (SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema','pg_internal') AND (${can("INSERT")} OR ${can("UPDATE")} OR ${can("DELETE")})) writes`)).rows[0]);
      notes.push(String(row.v).split(",")[0]);
      if (row.su) notes.push("Warning: this login is a superuser. Use a read-only login.");
      else if (Number(row.writes) > 0) notes.push(`Warning: this login can write to ${row.writes} tables. Use a read-only login.`);
      return notes;
    },
    async discover() {
      const { rows } = await inTx(() => client.query(`SELECT c.table_schema s, c.table_name t, c.column_name n, c.data_type d FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE t.table_type = 'BASE TABLE' AND c.table_schema NOT IN ('pg_catalog','information_schema','pg_internal') ORDER BY 1, 2, c.ordinal_position`));
      const out = new Map<string, StreamInfo>();
      for (const r of rows) {
        const name = r.s === "public" ? r.t : `${r.s}.${r.t}`;
        if (!out.has(name)) out.set(name, { name, columns: [] });
        out.get(name)!.columns.push({ name: r.n, type: duck(r.d) });
        typeOf.set(`${name}\0${r.n}`, r.d);
      }
      return [...out.values()];
    },
    async sample(stream, column) { return inTx(async () => (await client.query({ text: `SELECT ${asText(stream, column)} v FROM ${qt(stream)} WHERE ${q(column)} IS NOT NULL LIMIT 50`, rowMode: "array" })).rows.map((r: unknown[]) => toText(r[0]))); },
    async count(stream) { return inTx(async () => Number((await client.query(`SELECT count(*) n FROM ${qt(stream)}`)).rows[0].n)); },
    async read(stream, { columns, cursor, after, maxRows, orderBy, inclusive }, onBatch) {
      await inTx(async () => {
        const order = cursor ?? orderBy, sel = columns.map((c) => `${asText(stream, c.name)} ${q(c.name)}`).join(", ");
        // Redshift cursors take no bind values, so the literal is escaped here
        const where = cursor && after ? `WHERE ${q(cursor)} ${inclusive ? ">=" : ">"} '${after.replace(/\\/g, "\\\\").replace(/'/g, "''")}'` : "";
        await client.query(`DECLARE basalt_read CURSOR FOR SELECT ${sel} FROM ${qt(stream)} ${where} ${order ? `ORDER BY ${q(order)}` : ""}${maxRows ? ` LIMIT ${Math.floor(maxRows)}` : ""}`);
        for (;;) {
          const { rows } = await client.query({ text: `FETCH FORWARD ${BATCH} FROM basalt_read`, rowMode: "array" });
          if (!rows.length) break;
          await onBatch(rows.map((r: unknown[]) => r.map(toText)));
        }
        await client.query("CLOSE basalt_read");
      });
    },
    close: () => client.end(),
  };
  return self;
}
