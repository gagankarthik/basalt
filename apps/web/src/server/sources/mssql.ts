import type { Connection, StreamInfo } from "../../lib/types.ts";
import { toText } from "../../lib/sourceRows.ts";
import type { Source } from "../connectors.ts";

const BATCH = 5000;
const quote = (id: string) => `[${id.replace(/]/g, "]]")}]`;
const parts = (s: string) => { const i = s.indexOf("."); return i < 0 ? ["dbo", s] : [s.slice(0, i), s.slice(i + 1)]; };
const qt = (s: string) => parts(s).map(quote).join(".");
const duck = (t: string) => {
  const s = t.toLowerCase();
  if (s === "bit") return "BOOLEAN";
  if (s === "bigint") return "BIGINT";
  if (["int", "smallint", "tinyint"].includes(s)) return "INTEGER";
  if (["decimal", "numeric", "money", "smallmoney", "float", "real"].includes(s)) return "DOUBLE";
  if (s === "date") return "DATE";
  // "timestamp" here is rowversion, which is binary and holds no time
  if (["datetime", "datetime2", "smalldatetime", "datetimeoffset"].includes(s)) return "TIMESTAMP";
  return "VARCHAR";
};
const asText = (c: string, t: string) => {
  const s = t.toLowerCase(), n = quote(c);
  // As the server writes them: through a JS Date they'd shift by this server's zone
  if (["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset", "time"].includes(s)) return `CONVERT(varchar(40), ${n}, 126)`;
  if (["binary", "varbinary", "image", "timestamp", "rowversion"].includes(s)) return `CONVERT(varchar(max), ${s === "image" ? `CAST(${n} AS varbinary(max))` : n}, 2)`;
  if (["geometry", "geography", "hierarchyid"].includes(s)) return `${n}.ToString()`;
  if (["xml", "text", "ntext", "sql_variant"].includes(s)) return `CAST(${n} AS nvarchar(max))`;
  return n;
};
/** The settings every connection opens with. Exported so a test can hold them to the promise made on screen. */
export const mssqlConfig = (conn: Connection, password: string) => ({
  server: conn.host ?? "", port: conn.port ?? 1433, database: conn.database, user: conn.user, password, connectionTimeout: 15000, requestTimeout: 300000, pool: { max: 2, min: 0 },
  options: { encrypt: conn.ssl !== false, trustServerCertificate: false, readOnlyIntent: true, appName: "basalt", ...(conn.ca ? { cryptoCredentialsDetails: { ca: conn.ca } } : {}) },
});

/** SQL Server and Azure SQL. Synapse dedicated pools share the protocol but have no snapshot isolation, so reads there run at the default level. */
export async function mssqlSource(conn: Connection, password: string): Promise<Source> {
  const sql = (await import("mssql")).default;
  const pool = new sql.ConnectionPool(mssqlConfig(conn, password) as never);
  await pool.connect().catch((e: Error) => { throw /certificate|self.signed/i.test(e.message) ? new Error(`Basalt couldn't verify this server's certificate: ${e.message}. Add the CA certificate to this connection.`) : e; });
  const synapse = conn.type === "synapse", types = new Map<string, string>();
  const list = async (text: string) => (await pool.request().query(text)).recordset as Record<string, unknown>[];
  const canSnapshot = async () => !synapse && Number((await list("SELECT snapshot_isolation_state s FROM sys.databases WHERE name = DB_NAME()"))[0]?.s) === 1;
  const self: Source = {
    async check() {
      const notes = ["Reached the database", "Connected with read-only intent"];
      const [row] = await list("SELECT @@VERSION v, IS_ROLEMEMBER('db_owner') o, IS_ROLEMEMBER('db_datawriter') w, IS_SRVROLEMEMBER('sysadmin') a, HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') i");
      notes.push(String(row.v).split("\n")[0].trim());
      if (Number(row.a) === 1 || Number(row.o) === 1) notes.push("Warning: this login owns the database. Use a read-only login.");
      else if (Number(row.w) === 1 || Number(row.i) === 1) notes.push("Warning: this login can write. Use a read-only login.");
      if (!synapse) notes.push((await canSnapshot()) ? "Reads use snapshot isolation" : "Snapshot isolation is off on this database, so reads use read committed");
      return notes;
    },
    async discover() {
      const out = new Map<string, StreamInfo>(), keys = new Map<string, string[]>(), name = (s: unknown, t: unknown) => (s === "dbo" ? String(t) : `${s}.${t}`);
      for (const r of await list("SELECT c.TABLE_SCHEMA s, c.TABLE_NAME t, c.COLUMN_NAME n, c.DATA_TYPE d FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES x ON x.TABLE_SCHEMA = c.TABLE_SCHEMA AND x.TABLE_NAME = c.TABLE_NAME WHERE x.TABLE_TYPE = 'BASE TABLE' AND c.TABLE_SCHEMA <> 'sys' ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION")) {
        const k = name(r.s, r.t);
        if (!out.has(k)) out.set(k, { name: k, columns: [] });
        out.get(k)!.columns.push({ name: String(r.n), type: duck(String(r.d)) });
        types.set(`${k}\0${r.n}`, String(r.d));
      }
      for (const r of await list("SELECT u.TABLE_SCHEMA s, u.TABLE_NAME t, u.COLUMN_NAME n FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE u JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS x ON x.CONSTRAINT_NAME = u.CONSTRAINT_NAME AND x.CONSTRAINT_SCHEMA = u.CONSTRAINT_SCHEMA WHERE x.CONSTRAINT_TYPE = 'PRIMARY KEY'")) { const k = name(r.s, r.t); keys.set(k, [...(keys.get(k) ?? []), String(r.n)]); }
      // Updating by one column of a composite key would delete unrelated rows, so only a single-column key is offered
      for (const [k, v] of keys) if (v.length === 1 && out.has(k)) out.get(k)!.primaryKey = v[0];
      return [...out.values()];
    },
    async sample(stream, column) { return (await list(`SELECT TOP 50 ${asText(column, types.get(`${stream}\0${column}`) ?? "")} AS v FROM ${qt(stream)} WHERE ${quote(column)} IS NOT NULL`)).map((r) => toText(r.v)); },
    async count(stream) { return Number((await list(`SELECT COUNT_BIG(*) n FROM ${qt(stream)}`))[0].n); },
    async read(stream, { columns, cursor, after, maxRows, orderBy, inclusive }, onBatch) {
      if (!types.size) await self.discover();
      const order = cursor ?? orderBy, sel = columns.map((c) => `${asText(c.name, types.get(`${stream}\0${c.name}`) ?? "")} AS ${quote(c.name)}`).join(", ");
      const text = `SELECT ${maxRows ? `TOP (${Math.floor(maxRows)}) ` : ""}${sel} FROM ${qt(stream)}${cursor && after ? ` WHERE ${quote(cursor)} ${inclusive ? ">=" : ">"} @after` : ""}${order ? ` ORDER BY ${quote(order)}` : ""}`;
      const tx = (await canSnapshot()) ? pool.transaction() : null;
      if (tx) await tx.begin(sql.ISOLATION_LEVEL.SNAPSHOT);
      try {
        const req = tx ? tx.request() : pool.request();
        req.stream = true;
        if (cursor && after) req.input("after", sql.NVarChar, after);
        await new Promise<void>((resolve, reject) => {
          let batch: (string | null)[][] = [], ended = false, storing: Promise<void> = Promise.resolve();
          // Rows stop arriving while a batch is stored, and any already on the wire wait for the next one
          const store = () => { const rows = batch; batch = []; req.pause(); storing = storing.then(() => onBatch(rows)).then(() => { if (!ended) req.resume(); }); storing.catch((e) => { req.cancel(); reject(e); }); };
          req.on("row", (r: Record<string, unknown>) => { batch.push(columns.map((c) => toText(r[c.name]))); if (batch.length >= BATCH) store(); });
          req.on("error", reject);
          req.on("done", () => { ended = true; if (batch.length) store(); storing.then(resolve, reject); });
          req.query(text);
        });
      } finally { if (tx) await tx.rollback().catch(() => {}); }
    },
    close: () => pool.close(),
  };
  return self;
}
