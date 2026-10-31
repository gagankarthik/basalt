import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { Connection, StreamInfo } from "../../lib/types.ts";
import { cursorValue, inferColumns, rowOf, sampleOf, type Doc } from "../../lib/sourceRows.ts";
import type { Source } from "../connectors.ts";
import { awsConfig, knownFields } from "./common.ts";

const SAMPLE = 200, PAGE = 1000, DEFAULT_CAPACITY = 100;
const toValue = (a: AttributeValue): unknown => {
  if (a.S !== undefined) return a.S;
  // Up to 38 digits are allowed, and a JS number keeps 15 safely. Longer ones stay exact as text
  if (a.N !== undefined) return a.N.replace(/[-.]/g, "").length <= 15 ? Number(a.N) : a.N;
  if (a.BOOL !== undefined) return a.BOOL;
  if (a.NULL) return null;
  if (a.B) return Buffer.from(a.B).toString("base64");
  if (a.L) return a.L.map(toValue);
  if (a.M) return toDoc(a.M);
  return a.SS ?? a.NS?.map((n) => toValue({ N: n })) ?? a.BS?.map((b) => Buffer.from(b).toString("base64")) ?? null;
};
const toDoc = (item: Record<string, AttributeValue>): Doc => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, toValue(v)]));

export async function dynamoSource(conn: Connection, secret: string): Promise<Source> {
  const { DynamoDBClient, DescribeTableCommand, ListTablesCommand, ScanCommand } = await import("@aws-sdk/client-dynamodb");
  const client = new DynamoDBClient(awsConfig(conn, secret));
  const capacity = conn.capacity || DEFAULT_CAPACITY, samples = new Map<string, Doc[]>(), catalog = new Map<string, StreamInfo>();
  const tables = async () => {
    const out: string[] = [];
    let start: string | undefined;
    do { const r = await client.send(new ListTablesCommand({ ExclusiveStartTableName: start })); out.push(...(r.TableNames ?? [])); start = r.LastEvaluatedTableName; } while (start);
    return out;
  };
  // One page with a Limit, so sampling costs the same on any size of table
  const sample = async (table: string) => {
    if (!samples.has(table)) samples.set(table, ((await client.send(new ScanCommand({ TableName: table, Limit: SAMPLE }))).Items ?? []).map(toDoc));
    return samples.get(table)!;
  };
  const describe = async (table: string) => (await client.send(new DescribeTableCommand({ TableName: table }))).Table;
  const self: Source = {
    uncounted: true,
    async check() {
      const n = (await client.send(new ListTablesCommand({ Limit: 100 }))).TableNames?.length ?? 0;
      return [`Reached DynamoDB in ${conn.region}`, `Found ${n === 100 ? "at least 100" : n} table${n === 1 ? "" : "s"}`, "Basalt only lists, describes and scans. AWS doesn't tell a client what else its credentials allow, so keep this key read-only."];
    },
    async discover() {
      const out: StreamInfo[] = [];
      for (const name of await tables()) {
        const keys = (await describe(name))?.KeySchema ?? [];
        const info: StreamInfo = { name, columns: inferColumns(await sample(name), keys.map((k) => k.AttributeName!)), ...(keys.length === 1 ? { primaryKey: keys[0].AttributeName } : {}) };
        catalog.set(name, info);
        out.push(info);
      }
      return out;
    },
    async sample(stream, column) { return sampleOf(await sample(stream), column); },
    // DynamoDB's own figure, refreshed about every six hours. Counting exactly would mean a full scan
    async count(stream) { return Number((await describe(stream))?.ItemCount ?? 0); },
    async read(stream, { columns, cursor, after, maxRows, inclusive, withheld }, onBatch) {
      const known = await knownFields(stream, catalog, columns, self), hold = new Set(withheld?.map((w) => w.toLowerCase()));
      const type = catalog.get(stream)?.columns.find((c) => c.name === cursor)?.type;
      const filter = cursor && after ? { FilterExpression: `#c ${inclusive ? ">=" : ">"} :v`, ExpressionAttributeNames: { "#c": cursor }, ExpressionAttributeValues: { ":v": type === "BIGINT" || type === "DOUBLE" ? { N: String(cursorValue(type, after)) } : { S: after } } } : {};
      let start: Record<string, AttributeValue> | undefined, left = maxRows ?? Infinity;
      do {
        const began = Date.now();
        const r = await client.send(new ScanCommand({ TableName: stream, Limit: Math.min(PAGE, left), ExclusiveStartKey: start, ReturnConsumedCapacity: "TOTAL", ...filter }));
        const rows = (r.Items ?? []).map((i) => rowOf(toDoc(i), columns, known, hold));
        left -= rows.length;
        if (rows.length) await onBatch(rows);
        start = r.LastEvaluatedKey;
        // One segment at a time, and paced to stay under the limit whatever a page cost
        const wait = ((r.ConsumedCapacity?.CapacityUnits ?? 0) / capacity) * 1000 - (Date.now() - began);
        if (start && left > 0 && wait > 0) await new Promise((d) => setTimeout(d, wait));
      } while (start && left > 0);
    },
    close: async () => { client.destroy(); },
  };
  return self;
}
