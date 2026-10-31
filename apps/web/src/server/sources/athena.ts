import type { Connection, StreamInfo } from "../../lib/types.ts";
import { toDuckType } from "../../lib/sourceRows.ts";
import type { Source } from "../connectors.ts";
import { NOT_COUNTED, awsConfig } from "./common.ts";

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`, str = (v: string) => `'${v.replace(/'/g, "''")}'`;
const nested = (t: string) => /^(array|map|row|struct)\b/i.test(t);
const duck = (t: string) => (nested(t) ? "JSON" : toDuckType(t));
const asText = (c: string, t: string) => (nested(t) ? `CAST(CAST(${quote(c)} AS JSON) AS VARCHAR) AS ${quote(c)}` : /^(varbinary|binary)/i.test(t) ? `to_hex(${quote(c)}) AS ${quote(c)}` : `CAST(${quote(c)} AS VARCHAR) AS ${quote(c)}`);

export async function athenaSource(conn: Connection, secret: string): Promise<Source> {
  const { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } = await import("@aws-sdk/client-athena");
  if (!conn.database) throw new Error("Enter the database.");
  const client = new AthenaClient(awsConfig(conn, secret));
  const db = conn.database, table = (t: string) => `${quote(db)}.${quote(t)}`;
  const types = new Map<string, Map<string, string>>(), samples = new Map<string, (string | null)[][]>();
  /** Pages of one finished statement. Athena writes results to S3, and the SDK reads them a page at a time. */
  const run = async function* (sql: string) {
    const { QueryExecutionId } = await client.send(new StartQueryExecutionCommand({ QueryString: sql, QueryExecutionContext: { Database: db }, WorkGroup: conn.warehouse || "primary", ...(conn.prefix ? { ResultConfiguration: { OutputLocation: conn.prefix } } : {}) }));
    for (let wait = 200; ; wait = Math.min(wait * 2, 5000)) {
      const s = (await client.send(new GetQueryExecutionCommand({ QueryExecutionId }))).QueryExecution?.Status;
      if (s?.State === "SUCCEEDED") break;
      if (s?.State === "FAILED" || s?.State === "CANCELLED") throw new Error(s.StateChangeReason ?? "Athena couldn't run this query.");
      await new Promise((d) => setTimeout(d, wait));
    }
    let token: string | undefined, first = true;
    do {
      const r = await client.send(new GetQueryResultsCommand({ QueryExecutionId, NextToken: token, MaxResults: 1000 }));
      const rows = (r.ResultSet?.Rows ?? []).map((x) => (x.Data ?? []).map((d) => d.VarCharValue ?? null));
      yield first ? rows.slice(1) : rows; // the first row of a SELECT's first page is its header
      first = false; token = r.NextToken;
    } while (token);
  };
  const all = async (sql: string) => { const out: (string | null)[][] = []; for await (const p of run(sql)) out.push(...p); return out; };
  const self: Source = {
    uncounted: true,
    async check() { await all("SELECT 1"); return [`Reached Athena in ${conn.region}`, "Basalt only runs SELECT, and needs write access only to the query results location", "Set a data scanned limit on this workgroup, as Athena charges by data scanned."]; },
    // Answered from the Glue catalog, so no table data is scanned
    async discover() {
      const out = new Map<string, StreamInfo>();
      for (const [t, c, d] of await all(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = ${str(db)} ORDER BY table_name, ordinal_position`)) {
        if (!out.has(t!)) { out.set(t!, { name: t!, columns: [] }); types.set(t!, new Map()); }
        out.get(t!)!.columns.push({ name: c!, type: duck(d!) });
        types.get(t!)!.set(c!, d!);
      }
      return [...out.values()];
    },
    // One query a table, however many columns ask, and stopped by its LIMIT
    async sample(stream, column) {
      if (!types.has(stream)) await self.discover();
      const cols = [...(types.get(stream) ?? [])];
      if (!samples.has(stream)) samples.set(stream, await all(`SELECT ${cols.map(([c, t]) => asText(c, t)).join(", ")} FROM ${table(stream)} LIMIT 50`));
      const i = cols.findIndex(([c]) => c === column);
      return samples.get(stream)!.map((r) => r[i]).filter((v) => v != null);
    },
    // count(*) is charged as a scan of the table on text formats
    count: async () => { throw new Error(NOT_COUNTED); },
    async read(stream, { columns, cursor, after, maxRows, inclusive }, onBatch) {
      if (!types.has(stream)) await self.discover();
      const t = types.get(stream)!, cast = (cursor && t.get(cursor)?.replace(/^string$/, "varchar")) || "varchar";
      const where = cursor && after ? ` WHERE ${quote(cursor)} ${inclusive ? ">=" : ">"} CAST(${str(after)} AS ${cast})` : "";
      for await (const page of run(`SELECT ${columns.map((c) => asText(c.name, t.get(c.name) ?? "varchar")).join(", ")} FROM ${table(stream)}${where}${cursor ? ` ORDER BY ${quote(cursor)}` : ""}${maxRows ? ` LIMIT ${Math.floor(maxRows)}` : ""}`)) if (page.length) await onBatch(page);
    },
    close: async () => { client.destroy(); },
  };
  return self;
}
