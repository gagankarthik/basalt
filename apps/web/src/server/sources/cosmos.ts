import type { Connection, StreamInfo } from "../../lib/types.ts";
import { inferColumns, rowOf, sampleOf, type Doc } from "../../lib/sourceRows.ts";
import type { Source } from "../connectors.ts";
import { NOT_COUNTED, knownFields } from "./common.ts";

const SAMPLE = 200, PAGE = 1000;
// Cosmos's own bookkeeping, except _ts, which is the natural cursor
const clean = ({ _rid, _self, _etag, _attachments, ...d }: Doc): Doc => { void _rid; void _self; void _etag; void _attachments; return d; };

export async function cosmosSource(conn: Connection, key: string): Promise<Source> {
  const { CosmosClient } = await import("@azure/cosmos");
  if (!conn.host || !conn.database) throw new Error("Enter the account URI and database.");
  const client = new CosmosClient({ endpoint: conn.host, key }), db = client.database(conn.database);
  const samples = new Map<string, Doc[]>(), catalog = new Map<string, StreamInfo>();
  const sample = async (name: string) => {
    if (!samples.has(name)) samples.set(name, (await db.container(name).items.query<Doc>(`SELECT TOP ${SAMPLE} * FROM c`, { maxItemCount: SAMPLE, maxDegreeOfParallelism: 1 }).fetchNext()).resources.map(clean));
    return samples.get(name)!;
  };
  const self: Source = {
    uncounted: true,
    async check() {
      const { resources } = await db.containers.readAll().fetchAll();
      return [`Reached ${conn.database}`, `Found ${resources.length} container${resources.length === 1 ? "" : "s"}`, "Basalt only runs SELECT. Use the account's read-only key, as Azure doesn't report what a key allows."];
    },
    async discover() {
      const { resources } = await db.containers.readAll().fetchAll(), out: StreamInfo[] = [];
      for (const { id } of resources) {
        const info: StreamInfo = { name: id, primaryKey: "id", cursor: "_ts", columns: inferColumns(await sample(id), ["id"]) };
        catalog.set(id, info);
        out.push(info);
      }
      return out;
    },
    async sample(stream, column) { return sampleOf(await sample(stream), column); },
    // COUNT is charged by how much it reads, so opening a connection doesn't run one
    count: async () => { throw new Error(NOT_COUNTED); },
    async read(stream, { columns, cursor, after, maxRows, inclusive, withheld }, onBatch) {
      const known = await knownFields(stream, catalog, columns, self), hold = new Set(withheld?.map((w) => w.toLowerCase()));
      const type = catalog.get(stream)?.columns.find((c) => c.name === cursor)?.type, numeric = type === "BIGINT" || type === "DOUBLE";
      const field = cursor ? `c[${JSON.stringify(cursor)}]` : "", filtered = !!(cursor && after);
      const parameters = filtered ? [{ name: "@after", value: numeric ? Number(after) : after! }] : [];
      const it = db.container(stream).items.query<Doc>({ query: `SELECT ${maxRows ? `TOP ${Math.floor(maxRows)} ` : ""}* FROM c${filtered ? ` WHERE ${field} ${inclusive ? ">=" : ">"} @after ORDER BY ${field}` : ""}`, parameters }, { maxItemCount: PAGE, maxDegreeOfParallelism: 1 });
      // One page at a time: the next isn't asked for until this one is stored. The SDK waits out 429s as the service asks
      while (it.hasMoreResults()) {
        const { resources } = await it.fetchNext();
        if (resources.length) await onBatch(resources.map((d) => rowOf(clean(d), columns, known, hold)));
      }
    },
    close: async () => { client.dispose(); },
  };
  return self;
}
