import type { Connection, StreamInfo } from "../../lib/types.ts";
import { toDuckType, toText } from "../../lib/sourceRows.ts";
import type { Source } from "../connectors.ts";
import { NOT_COUNTED, gcpKey } from "./common.ts";

const BATCH = 5000;
const quote = (id: string) => `\`${id.replace(/[`\\]/g, "\\$&")}\``;
/** "Schema.Table", or "Table" in the default schema. */
const table = (s: string) => s.split(".").map(quote).join(".");
const duck = (t: string) => (/^(ARRAY|STRUCT|JSON)/i.test(t) ? "JSON" : /^INT64/i.test(t) ? "BIGINT" : /^(FLOAT|NUMERIC)/i.test(t) ? "DOUBLE" : /^BOOL/i.test(t) ? "BOOLEAN" : toDuckType(t));
const asText = (c: string, t: string) => (/^(ARRAY|STRUCT|JSON)/i.test(t) ? `TO_JSON_STRING(${quote(c)})` : /^BYTES/i.test(t) ? `TO_HEX(${quote(c)})` : `CAST(${quote(c)} AS STRING)`);

export async function spannerSource(conn: Connection, secret: string): Promise<Source> {
  const { Spanner } = await import("@google-cloud/spanner");
  if (!conn.warehouse || !conn.database) throw new Error("Enter the instance and database.");
  const key = gcpKey(secret), m = /^http:\/\/([^:/]+):(\d+)/.exec(conn.host ?? "");
  const client = new Spanner({ ...key, ...(m ? { servicePath: m[1], port: Number(m[2]), sslCreds: (await import("@grpc/grpc-js")).credentials.createInsecure() } : {}) });
  const db = client.instance(conn.warehouse).database(conn.database), types = new Map<string, string>();
  /** Every statement is a read-only snapshot, so a write can't happen on this path even by mistake. */
  const rows = async function* (sql: string, params?: Record<string, string>) {
    const [snap] = await db.getSnapshot();
    try {
      for await (const r of snap.runStream({ sql, params, json: true }) as AsyncIterable<Record<string, unknown>>) yield r;
    } finally { snap.end(); }
  };
  const all = async (sql: string) => { const out: Record<string, unknown>[] = []; for await (const r of rows(sql)) out.push(r); return out; };
  const self: Source = {
    uncounted: true,
    async check() {
      await all("SELECT 1 AS one");
      return [`Reached ${conn.database} on ${conn.warehouse}`, "Every read runs in a read-only snapshot", "Google doesn't tell a client what else its key allows, so give this service account the Cloud Spanner Database Reader role."];
    },
    async discover() {
      const out = new Map<string, StreamInfo>(), keys = new Map<string, string[]>(), name = (s: unknown, t: unknown) => (s ? `${s}.${t}` : String(t));
      for (const r of await all("SELECT c.TABLE_SCHEMA s, c.TABLE_NAME t, c.COLUMN_NAME n, c.SPANNER_TYPE d FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES x ON x.TABLE_SCHEMA = c.TABLE_SCHEMA AND x.TABLE_NAME = c.TABLE_NAME WHERE x.TABLE_TYPE = 'BASE TABLE' AND c.TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'SPANNER_SYS') ORDER BY s, t, c.ORDINAL_POSITION")) {
        const k = name(r.s, r.t);
        if (!out.has(k)) out.set(k, { name: k, columns: [] });
        out.get(k)!.columns.push({ name: String(r.n), type: duck(String(r.d)) });
        types.set(`${k}\0${r.n}`, String(r.d));
      }
      for (const r of await all("SELECT TABLE_SCHEMA s, TABLE_NAME t, COLUMN_NAME n FROM INFORMATION_SCHEMA.INDEX_COLUMNS WHERE INDEX_NAME = 'PRIMARY_KEY' AND TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'SPANNER_SYS')")) { const k = name(r.s, r.t); keys.set(k, [...(keys.get(k) ?? []), String(r.n)]); }
      for (const [k, v] of keys) if (v.length === 1 && out.has(k)) out.get(k)!.primaryKey = v[0];
      return [...out.values()];
    },
    async sample(stream, column) { return (await all(`SELECT ${asText(column, types.get(`${stream}\0${column}`) ?? "STRING")} AS v FROM ${table(stream)} WHERE ${quote(column)} IS NOT NULL LIMIT 50`)).map((r) => toText(r.v)); },
    // A count passes every row of an index, and is charged for it
    count: async () => { throw new Error(NOT_COUNTED); },
    async read(stream, { columns, cursor, after, maxRows, orderBy, inclusive }, onBatch) {
      if (!types.size) await self.discover();
      const type = (c: string) => types.get(`${stream}\0${c}`) ?? "STRING", order = cursor ?? orderBy;
      const sel = columns.map((c) => `${asText(c.name, type(c.name))} AS ${quote(c.name)}`).join(", ");
      const where = cursor && after ? ` WHERE ${quote(cursor)} ${inclusive ? ">=" : ">"} CAST(@after AS ${type(cursor).replace(/\(.*$/, "")})` : "";
      let batch: (string | null)[][] = [];
      // The stream only asks for more once this loop comes back round, so a slow store slows the read
      for await (const r of rows(`SELECT ${sel} FROM ${table(stream)}${where}${order ? ` ORDER BY ${quote(order)}` : ""}${maxRows ? ` LIMIT ${Math.floor(maxRows)}` : ""}`, where ? { after: after! } : undefined)) {
        batch.push(columns.map((c) => toText(r[c.name])));
        if (batch.length >= BATCH) { await onBatch(batch); batch = []; }
      }
      if (batch.length) await onBatch(batch);
    },
    close: async () => { await db.close(); client.close(); },
  };
  return self;
}
