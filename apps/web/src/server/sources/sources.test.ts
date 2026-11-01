// Native sources against the closest thing to the real service that runs here. No real cloud account is involved.
// In-process wire stubs (Firestore and Spanner gRPC, SQL Server TDS) always run. Emulators run when their address is set:
// BASALT_TEST_MOTO (moto_server), BASALT_TEST_COSMOS (@zeit/cosmosdb-server), BASALT_TEST_PG (a real PostgreSQL).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import test, { after as cleanup } from "node:test";
import type { Connection } from "../../lib/types.ts";
import { EXTRA } from "../../lib/sourceRows.ts";
import { scanStructured } from "../../lib/pii.ts";
import type { Batch, Source } from "../connectors.ts";
import { athenaSource } from "./athena.ts";
import { awsAccount, gcsToken, requireExternalId, roleCredentials, ROLE_ARN } from "./common.ts";
import { cosmosSource } from "./cosmos.ts";
import { dynamoSource } from "./dynamodb.ts";
import { firestoreSource } from "./firestore.ts";
import { mssqlConfig, mssqlSource } from "./mssql.ts";
import { redshiftSource } from "./redshift.ts";
import { spannerSource } from "./spanner.ts";

const require = createRequire(import.meta.url);
const base = (x: Partial<Connection>): Connection => ({ id: "t", name: "t", slug: "t", createdAt: "", type: "dynamodb", ...x });
const collect = async (src: Source, stream: string, columns: { name: string; type: string }[], opts: object = {}) => {
  const rows: Batch = [], sizes: number[] = [];
  let active = 0, most = 0;
  await src.read(stream, { columns, ...opts }, async (b) => { active++; most = Math.max(most, active); await new Promise((d) => setTimeout(d, 2)); rows.push(...b); sizes.push(b.length); active--; });
  return { rows, sizes, most };
};
const KEY = JSON.stringify({ project_id: "demo", client_email: "reader@demo.iam.gserviceaccount.com", private_key: "unused-by-the-stub" });

/* ---- Cloud Storage with a service account ---- */
test("a service account key becomes a token, and a bad key isn't quoted", async () => {
  let who = "";
  assert.equal(await gcsToken(KEY, async (email) => { who = email; return { token: "tok" }; }), "tok");
  assert.equal(who, "reader@demo.iam.gserviceaccount.com");
  await assert.rejects(gcsToken(KEY, async () => ({ token: null })), /no token/);
  await assert.rejects(gcsToken("my-private-text", async () => ({ token: "x" })), (e: Error) => !e.message.includes("my-private-text"));
});

/* ---- assuming a role in a customer's account ---- */
const ROLE = base({ roleArn: "arn:aws:iam::123456789012:role/read", slug: "shop" });
const fakeSts = (fn: (input: Record<string, unknown>) => unknown) => ({ send: async (c: { input: Record<string, unknown> }) => fn(c.input) }) as never;
const denied = () => { throw Object.assign(new Error("User is not authorized to perform: sts:AssumeRole"), { name: "AccessDenied" }); };
test("a role is always assumed with the external ID, and gives temporary keys", async () => {
  let seen: Record<string, unknown> = {};
  const k = await roleCredentials(ROLE, "ext-1", fakeSts((i) => { seen = i; return { Credentials: { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T", Expiration: new Date(0) } }; }))();
  assert.equal(seen.ExternalId, "ext-1"); assert.equal(seen.RoleArn, ROLE.roleArn); assert.equal(seen.RoleSessionName, "basalt-shop");
  assert.deepEqual([k.accessKeyId, k.secretAccessKey, k.sessionToken], ["A", "S", "T"]);
});
test("a refused role says what to fix, and leaks nothing", async () => {
  await assert.rejects(roleCredentials(ROLE, "ext-secret", fakeSts(denied))(), (e: Error) => /trust policy/.test(e.message) && !e.message.includes("ext-secret"));
  await assert.rejects(roleCredentials(ROLE, "x", fakeSts(() => { throw new Error("Could not load credentials from any providers"); }))(), /no AWS identity/);
});
test("a role that works without the external ID is refused", async () => {
  await assert.rejects(requireExternalId(ROLE, fakeSts(() => ({ Credentials: {} }))), /isn't safe/);
  await requireExternalId(ROLE, fakeSts(denied));
  await assert.rejects(requireExternalId(ROLE, fakeSts(() => { throw new Error("network down"); })), /network down/, "an outage isn't reported as safe");
});
test("role ARNs are checked, and no AWS identity is reported as none", async () => {
  for (const ok of ["arn:aws:iam::123456789012:role/a", "arn:aws-us-gov:iam::123456789012:role/path/a.b"]) assert.ok(ROLE_ARN.test(ok), ok);
  for (const no of ["", "arn:aws:iam::12:role/a", "arn:aws:iam::123456789012:user/a", "arn:aws:s3:::b"]) assert.ok(!ROLE_ARN.test(no), no);
  assert.equal(await awsAccount(fakeSts(() => { throw new Error("none"); })), null);
  assert.equal(await awsAccount(fakeSts(() => ({ Account: "111122223333" }))), "111122223333");
});

/* ---- DynamoDB on moto, through a proxy that records every call ---- */
const moto = process.env.BASALT_TEST_MOTO;
test("DynamoDB on moto: paged scan, bounded sample, unseen fields, incremental, read-only", { skip: !moto }, async () => {
  const calls: { op: string; body: Record<string, unknown> }[] = [];
  const proxy = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks), u = new URL(moto!);
      calls.push({ op: String(req.headers["x-amz-target"]).split(".").pop()!, body: JSON.parse(body.toString() || "{}") });
      const up = http.request({ host: u.hostname, port: u.port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
      up.end(body);
    });
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  cleanup(() => { proxy.close(); });
  const endpoint = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
  const { DynamoDBClient, CreateTableCommand, BatchWriteItemCommand } = await import("@aws-sdk/client-dynamodb");
  const admin = new DynamoDBClient({ region: "us-east-1", endpoint: moto, credentials: { accessKeyId: "a", secretAccessKey: "b" } });
  const TableName = `orders_${Date.now()}`;
  await admin.send(new CreateTableCommand({ TableName, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }] }));
  const items = Array.from({ length: 2500 }, (_, i) => ({ pk: { S: `k${String(i).padStart(5, "0")}` }, n: { N: String(i) }, big: { N: "12345678901234567890123" }, info: { M: { city: { S: "Oslo" }, tags: { SS: ["a"] } } } }));
  for (let i = 0; i < items.length; i += 25) await admin.send(new BatchWriteItemCommand({ RequestItems: { [TableName]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }));
  admin.destroy();

  const src = await dynamoSource(base({ region: "us-east-1", host: endpoint, user: "a" }), "b");
  const scans = () => calls.filter((c) => c.op === "Scan");
  const notes = await src.check();
  assert.ok(notes.some((n) => n.startsWith("Reached DynamoDB")));
  assert.equal(scans().length, 0, "check must not scan");
  const info = (await src.discover()).find((s) => s.name === TableName)!;
  assert.equal(info.primaryKey, "pk");
  const type = (n: string) => info.columns.find((c) => c.name === n)?.type;
  assert.equal(type("n"), "BIGINT"); assert.equal(type("info"), "JSON"); assert.equal(type("big"), "VARCHAR"); assert.equal(type(EXTRA), "JSON");
  await src.sample(TableName, "n"); await src.sample(TableName, "info");
  const ours = scans().filter((c) => c.body.TableName === TableName);
  assert.equal(ours.length, 1, "one sample a table, however many columns ask");
  assert.ok((ours[0].body.Limit as number) <= 200);
  assert.ok(JSON.parse((await src.sample(TableName, "info"))[0]!).tags);
  assert.ok((await src.count(TableName)) >= 0);
  assert.equal(src.uncounted, true);

  const { rows, sizes, most } = await collect(src, TableName, info.columns);
  assert.equal(rows.length, 2500);
  assert.equal(new Set(rows.map((r) => r[0])).size, 2500);
  assert.ok(Math.max(...sizes) <= 1000, "pages stay bounded");
  assert.equal(most, 1, "the next page waits for this one");
  assert.ok(rows.some((r) => r.includes("12345678901234567890123")), "long numbers stay exact");
  assert.equal((await collect(src, TableName, info.columns, { maxRows: 1500 })).rows.length, 1500);
  const inc = await collect(src, TableName, info.columns, { cursor: "n", after: "2489" });
  assert.equal(inc.rows.length, 10);
  assert.equal((await collect(src, TableName, info.columns, { cursor: "n", after: "2489", inclusive: true })).rows.length, 11);
  await src.close();

  const written = calls.filter((c) => !["ListTables", "DescribeTable", "Scan"].includes(c.op));
  assert.deepEqual(written, [], "only list, describe and scan ever reach the service");
});

test("DynamoDB on moto: a field first seen past the sample is kept and scanned", { skip: !moto }, async () => {
  const { DynamoDBClient, CreateTableCommand, PutItemCommand } = await import("@aws-sdk/client-dynamodb");
  const admin = new DynamoDBClient({ region: "us-east-1", endpoint: moto, credentials: { accessKeyId: "a", secretAccessKey: "b" } });
  const TableName = `people_${Date.now()}`;
  await admin.send(new CreateTableCommand({ TableName, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }] }));
  for (let i = 0; i < 205; i++) await admin.send(new PutItemCommand({ TableName, Item: { pk: { S: `a${String(i).padStart(3, "0")}` }, age: { N: "1" } } }));
  await admin.send(new PutItemCommand({ TableName, Item: { pk: { S: "z" }, age: { S: "unknown" }, email: { S: "hidden@example.com" } } }));
  admin.destroy();
  const src = await dynamoSource(base({ region: "us-east-1", host: moto, user: "a" }), "b");
  const info = (await src.discover()).find((s) => s.name === TableName)!;
  assert.ok(!info.columns.some((c) => c.name === "email"), "this test needs the field to be outside the sample");
  const { rows } = await collect(src, TableName, info.columns);
  assert.equal(rows.length, 206);
  const extra = rows.map((r) => r.at(-1)).filter(Boolean) as string[];
  assert.equal(extra.length, 1);
  assert.deepEqual(JSON.parse(extra[0]), { age: "unknown", email: "hidden@example.com" });
  assert.equal(scanStructured(EXTRA, extra[0])?.kind, "Email address");
  await src.close();
});

test("DynamoDB: a bad secret or region fails with a message and leaks nothing", { skip: !moto }, async () => {
  await assert.rejects(() => dynamoSource(base({ host: moto, user: "a" }), "SECRET"), /Enter the region/);
});

/* ---- Athena on moto. It doesn't run SQL: results are queued, so this proves the SDK calls and paging, not the statements ---- */
test("Athena on moto with queued results", { skip: !moto }, async () => {
  const queue = async (rows: string[][]) => {
    const r = await fetch(`${moto}/moto-api/static/athena/query-results`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: "123456789012", region: "us-east-1", results: [{ rows: rows.map((x) => ({ Data: x.map((VarCharValue) => ({ VarCharValue })) })), column_info: [] }] }) });
    assert.equal(r.status, 201);
  };
  const src = await athenaSource(base({ type: "athena", region: "us-east-1", host: moto, user: "a", database: "lake", prefix: "s3://results/x/" }), "b");
  await queue([["_col0"], ["1"]]);
  assert.ok((await src.check())[0].includes("Athena"));
  await queue([["table_name", "column_name", "data_type"], ["events", "id", "bigint"], ["events", "tags", "array(varchar)"], ["events", "at", "timestamp(3)"]]);
  const [info] = await src.discover();
  assert.deepEqual(info.columns, [{ name: "id", type: "BIGINT" }, { name: "tags", type: "JSON" }, { name: "at", type: "TIMESTAMP" }]);
  await queue([["id", "tags", "at"], ["1", '["x"]', "2024-01-01 00:00:00.000"]]);
  assert.deepEqual(await src.sample("events", "tags"), ['["x"]']);
  assert.deepEqual(await src.sample("events", "id"), ["1"], "the second column reuses the one query");
  await queue([["id", "tags", "at"], ["1", '["x"]', "2024-01-01 00:00:00.000"], ["2", null as never, "2024-01-02 00:00:00.000"]]);
  const { rows } = await collect(src, "events", info.columns, { cursor: "id", after: "0" });
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], "2");
  await assert.rejects(() => src.count("events"));
  assert.equal(src.uncounted, true);
  await src.close();
});

/* ---- Redshift's code on a real PostgreSQL: the wire and most of the SQL are shared, Redshift itself isn't there ---- */
const pgUrl = process.env.BASALT_TEST_PG;
test("Redshift source on PostgreSQL: read-only, cursors, write warning", { skip: !pgUrl }, async () => {
  const { Client } = await import("pg");
  const u = new URL(pgUrl!), admin = new Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`DROP TABLE IF EXISTS facts; DROP ROLE IF EXISTS ro; CREATE TABLE facts (id bigint, amount numeric(10,2), at timestamp, label varchar(20)); INSERT INTO facts SELECT g, g * 1.5, timestamp '2024-01-01' + g * interval '1 hour', 'it''s' FROM generate_series(1, 12000) g; CREATE ROLE ro LOGIN PASSWORD 'ro'; GRANT SELECT ON facts TO ro;`);
  const conn = (user: string, password: string) => redshiftSource(base({ type: "redshift", host: u.hostname, port: Number(u.port), database: u.pathname.slice(1), user }), password);
  const su = await conn("postgres", "pw");
  assert.ok((await su.check()).some((n) => n.includes("superuser")));
  await su.close();
  await admin.query("CREATE ROLE rw LOGIN PASSWORD 'rw'; GRANT INSERT ON facts TO rw;").catch(() => {});
  const rw = await conn("rw", "rw");
  assert.ok((await rw.check()).some((n) => /Warning: this login can write to 1 tables/.test(n)));
  await rw.close();

  const src = await conn("ro", "ro");
  assert.ok(!(await src.check()).some((n) => n.startsWith("Warning")));
  const info = (await src.discover()).find((s) => s.name === "facts")!;
  assert.deepEqual(info.columns.map((c) => c.type), ["BIGINT", "DOUBLE", "TIMESTAMP", "VARCHAR"]);
  assert.equal((await src.sample("facts", "label")).length, 50);
  assert.equal(await src.count("facts"), 12000);
  const { rows, sizes, most } = await collect(src, "facts", info.columns);
  assert.equal(rows.length, 12000); assert.ok(Math.max(...sizes) <= 5000); assert.equal(most, 1);
  assert.equal((await collect(src, "facts", info.columns, { cursor: "label", after: "it's" })).rows.length, 0, "a quote in a cursor value stays a value");
  const inc = await collect(src, "facts", info.columns, { cursor: "id", after: "11990", inclusive: true });
  assert.deepEqual([inc.rows.length, inc.rows[0][0]], [11, "11990"]);
  assert.equal(inc.rows[0][2], "2025-05-14 14:00:00", "a time stays as written");
  await src.close();
  await admin.query("BEGIN READ ONLY");
  await assert.rejects(() => admin.query("INSERT INTO facts (id) VALUES (0)"), /read-only/);
  await admin.query("ROLLBACK");
  await admin.end();
});

/* ---- Cosmos DB on a third-party Node emulator ---- */
const cosmosUrl = process.env.BASALT_TEST_COSMOS;
test("Cosmos DB on the emulator: paging, inference, cursor, unseen fields", { skip: !cosmosUrl }, async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // the emulator's certificate is self-signed
  const { CosmosClient } = await import("@azure/cosmos");
  const admin = new CosmosClient({ endpoint: cosmosUrl!, key: "dummy" });
  const { database } = await admin.databases.createIfNotExists({ id: "shop" });
  const { container } = await database.containers.createIfNotExists({ id: `orders${Date.now()}`, partitionKey: "/pk" });
  for (let i = 0; i < 1205; i++) await container.items.create({ id: `o${i}`, pk: "p", seq: i, ...(i < 3 ? { nested: { sku: "x" } } : {}) });
  await container.items.create({ id: "late", pk: "p", seq: 9000, phone_number: "212-555-0100" });
  const src = await cosmosSource(base({ type: "cosmos", host: cosmosUrl, database: "shop" }), "dummy");
  assert.ok((await src.check())[1].startsWith("Found"));
  const info = (await src.discover()).find((s) => s.name === container.id)!;
  assert.equal(info.primaryKey, "id");
  const names = info.columns.map((c) => c.name);
  assert.ok(names.includes("nested") && names.includes("_ts") && !names.includes("_etag") && names.includes(EXTRA));
  assert.ok(!names.includes("phone_number"), "this test needs the field to be outside the sample");
  await assert.rejects(() => src.count(container.id), /count/);
  const { rows, sizes, most } = await collect(src, container.id, info.columns);
  assert.equal(rows.length, 1206); assert.ok(Math.max(...sizes) <= 1000); assert.equal(most, 1);
  const seq = names.indexOf("seq"), extra = rows.find((r) => r[seq] === "9000")!.at(-1)!;
  assert.equal(scanStructured(EXTRA, extra)?.kind, "Phone number");
  assert.equal((await collect(src, container.id, info.columns, { cursor: "seq", after: "1200" })).rows.length, 5);
  assert.equal((await collect(src, container.id, info.columns, { maxRows: 7 })).rows.length, 7);
  await src.close();
  admin.dispose();
});

/* ---- Firestore: a stub speaking the real gRPC service with the SDK's own descriptors ---- */
async function grpcStub(descriptor: string, service: string, handlers: Record<string, unknown>) {
  const grpc = await import("@grpc/grpc-js"), loader = require("@grpc/proto-loader");
  const def = loader.fromJSON(require(descriptor), { keepCase: false, longs: String, enums: String, defaults: false, oneofs: true });
  const svc = service.split(".").reduce((o: Record<string, never>, k) => o[k], grpc.loadPackageDefinition(def) as never) as unknown as { service: Record<string, unknown> };
  const seen: string[] = [], wrapped: Record<string, unknown> = {};
  for (const m of Object.keys(svc.service)) wrapped[m] = (call: never, cb?: (e: unknown, r?: unknown) => void) => { seen.push(m); const h = handlers[m] as ((c: never, cb?: unknown) => void) | undefined; if (h) return h(call, cb); const err = { code: grpc.status.UNIMPLEMENTED, message: `${m} isn't in this stub` }; if (cb) cb(err); else (call as { destroy(e: unknown): void }).destroy(err); };
  const server = new grpc.Server();
  server.addService(svc.service as never, wrapped as never);
  const port = await new Promise<number>((r, x) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? x(e) : r(p))));
  cleanup(() => { server.forceShutdown(); });
  return { port, seen };
}

test("Firestore on a gRPC stub: cursor paging, inferred schema, unseen fields, read-only", async () => {
  const root = "projects/demo/databases/(default)/documents";
  const docs = Array.from({ length: 2300 }, (_, i) => ({ name: `${root}/users/u${String(i).padStart(5, "0")}`, createTime: { seconds: "1" }, updateTime: { seconds: "1" }, fields: { seq: { integerValue: String(i) }, joined: { timestampValue: { seconds: String(1700000000 + i) } }, profile: { mapValue: { fields: { city: { stringValue: "Oslo" } } } }, ...(i === 2299 ? { email: { stringValue: "late@example.com" } } : {}) } }));
  const limits: number[] = [];
  const { port, seen } = await grpcStub(require.resolve("@google-cloud/firestore-api/build/protos/protos.json"), "google.firestore.v1.Firestore", {
    ListCollectionIds: (_c: never, cb: (e: null, r: object) => void) => cb(null, { collectionIds: ["users"] }),
    RunQuery(call: { request: { structuredQuery: { limit?: { value: number }; where?: { fieldFilter: { field: { fieldPath: string }; op: string; value: { integerValue: string } } }; startAt?: { values: { referenceValue: string }[]; before?: boolean } } }; write(x: object): void; end(): void }) {
      const q = call.request.structuredQuery, limit = q.limit?.value ?? 1e9;
      limits.push(limit);
      let out = docs;
      const f = q.where?.fieldFilter;
      if (f) out = out.filter((d) => { const v = Number(d.fields.seq.integerValue), to = Number(f.value.integerValue); return f.op === "GREATER_THAN" ? v > to : v >= to; });
      const start = q.startAt?.values.at(-1)?.referenceValue;
      if (start) out = out.filter((d) => d.name > start);
      for (const document of out.slice(0, limit)) call.write({ document, readTime: { seconds: "2" } });
      if (!out.length) call.write({ readTime: { seconds: "2" } });
      call.end();
    },
  });
  const src = await firestoreSource(base({ type: "firestore", host: `http://127.0.0.1:${port}` }), KEY);
  assert.ok((await src.check())[1].includes("1 top-level"));
  const [info] = await src.discover();
  assert.equal(info.name, "users"); assert.equal(info.primaryKey, "_id");
  const t = Object.fromEntries(info.columns.map((c) => [c.name, c.type]));
  assert.deepEqual([t.seq, t.joined, t.profile, t._id, t.email], ["BIGINT", "TIMESTAMP", "JSON", "VARCHAR", undefined]);
  assert.ok(limits[0] <= 200, "the sample has a limit");
  assert.equal(JSON.parse((await src.sample("users", "profile"))[0]!).city, "Oslo");
  await assert.rejects(() => src.count("users"));
  const { rows, sizes, most } = await collect(src, "users", info.columns);
  assert.equal(rows.length, 2300); assert.ok(Math.max(...sizes) <= 1000); assert.equal(most, 1);
  assert.equal(new Set(rows.map((r) => r[info.columns.findIndex((c) => c.name === "_id")])).size, 2300, "cursors neither repeat nor skip");
  assert.equal(scanStructured(EXTRA, rows.at(-1)!.at(-1)!)?.kind, "Email address");
  assert.equal((await collect(src, "users", info.columns, { cursor: "seq", after: "2290" })).rows.length, 9);
  assert.equal((await collect(src, "users", info.columns, { maxRows: 1200 })).rows.length, 1200);
  await src.close();
  assert.deepEqual([...new Set(seen)].sort(), ["ListCollectionIds", "RunQuery"], "only reads reach the service");
});

test("service account keys: a bad one fails without quoting itself", async () => {
  await assert.rejects(() => firestoreSource(base({ type: "firestore" }), "not json SECRET-PART"), (e: Error) => !e.message.includes("SECRET-PART"));
  await assert.rejects(() => spannerSource(base({ type: "spanner", warehouse: "i", database: "d" }), "{\"x\":\"SECRET-PART\"}"), (e: Error) => !e.message.includes("SECRET-PART") && /missing/.test(e.message));
});

/* ---- Spanner: the same kind of stub ---- */
test("Spanner on a gRPC stub: snapshot reads only, types, keys, batches", async () => {
  const sqls: string[] = [], str = (name: string) => ({ name, type: { code: "STRING" } });
  const answer = (sql: string, params?: { fields?: { after?: { stringValue?: string } } }) => {
    if (/SELECT 1/.test(sql)) return { fields: [{ name: "one", type: { code: "INT64" } }], rows: [["1"]] };
    if (/SPANNER_TYPE/.test(sql)) return { fields: ["s", "t", "n", "d"].map(str), rows: [["", "Orders", "Id", "INT64"], ["", "Orders", "Info", "JSON"], ["", "Orders", "Tags", "ARRAY<STRING(MAX)>"], ["sales", "Refunds", "Id", "INT64"]] };
    if (/INDEX_COLUMNS/.test(sql)) return { fields: ["s", "t", "n"].map(str), rows: [["", "Orders", "Id"], ["sales", "Refunds", "Id"], ["sales", "Refunds", "Line"]] };
    if (/LIMIT 50/.test(sql)) return { fields: [str("v")], rows: [['{"a":1}']] };
    const from = Number(params?.fields?.after?.stringValue ?? 0);
    return { fields: ["Id", "Info", "Tags"].map(str), rows: Array.from({ length: 12000 - from }, (_, i) => [String(from + i + 1), '{"a":1}', null]) };
  };
  const session = (call: { request: { database: string } }) => ({ name: `${call.request.database}/sessions/s${Math.random()}`, multiplexed: true, createTime: { seconds: "1" } });
  const { port, seen } = await grpcStub(require.resolve("@google-cloud/spanner-api/build/protos/protos.json"), "google.spanner.v1.Spanner", {
    CreateSession: (c: never, cb: (e: null, r: object) => void) => cb(null, session(c)),
    BatchCreateSessions: (c: { request: { database: string; sessionCount: number } }, cb: (e: null, r: object) => void) => cb(null, { session: Array.from({ length: c.request.sessionCount }, () => session(c)) }),
    BeginTransaction: (c: { request: { options: { readOnly?: object } } }, cb: (e: null, r: object) => void) => { assert.ok(c.request.options.readOnly, "only read-only transactions"); cb(null, { id: Buffer.from("tx"), readTimestamp: { seconds: "1" } }); },
    DeleteSession: (_c: never, cb: (e: null, r: object) => void) => cb(null, {}),
    ExecuteStreamingSql(call: { request: { sql: string; params?: never; transaction?: { singleUse?: { readOnly?: object }; begin?: { readOnly?: object } } }; write(x: object): void; end(): void }) {
      sqls.push(call.request.sql);
      const { fields, rows } = answer(call.request.sql, call.request.params);
      const pb = (v: unknown) => (v == null ? { nullValue: "NULL_VALUE" } : { stringValue: String(v) });
      const size = 2000;
      for (let i = 0; i === 0 || i < rows.length; i += size) call.write({ ...(i === 0 ? { metadata: { rowType: { fields }, transaction: { id: Buffer.from("tx"), readTimestamp: { seconds: "1" } } } } : {}), values: rows.slice(i, i + size).flat().map(pb) });
      call.end();
    },
  });
  const src = await spannerSource(base({ type: "spanner", host: `http://127.0.0.1:${port}`, warehouse: "inst", database: "db" }), KEY);
  assert.ok((await src.check()).some((n) => n.includes("read-only snapshot")));
  const streams = await src.discover();
  assert.deepEqual(streams.map((s) => s.name), ["Orders", "sales.Refunds"]);
  assert.equal(streams[0].primaryKey, "Id"); assert.equal(streams[1].primaryKey, undefined, "a composite key isn't offered");
  assert.deepEqual(streams[0].columns.map((c) => c.type), ["BIGINT", "JSON", "JSON"]);
  assert.deepEqual(await src.sample("Orders", "Info"), ['{"a":1}']);
  assert.ok(sqls.at(-1)!.includes("TO_JSON_STRING(`Info`)"));
  await assert.rejects(() => src.count("Orders"));
  const { rows, sizes, most } = await collect(src, "Orders", streams[0].columns);
  assert.equal(rows.length, 12000); assert.ok(Math.max(...sizes) <= 5000); assert.equal(most, 1);
  assert.equal((await collect(src, "Orders", streams[0].columns, { cursor: "Id", after: "11995" })).rows[0][0], "11996");
  assert.ok(sqls.at(-1)!.includes("CAST(@after AS INT64)"));
  await src.close();
  assert.deepEqual(seen.filter((m) => /Commit|ExecuteBatchDml|PartitionUpdate/.test(m)), [], "no writes reach the service");
});

/* ---- SQL Server: a stub speaking enough TDS 7.4 for the driver. It answers by matching text and runs no SQL ---- */
function tdsStub(answer: (sql: string) => { columns: string[]; rows: (string | null)[][] } | null) {
  const log: { sql: string[]; readOnlyIntent?: boolean; transactions: number } = { sql: [], transactions: 0 };
  const packet = (type: number, body: Buffer) => { const h = Buffer.alloc(8); h[0] = type; h[1] = 1; h.writeUInt16BE(body.length + 8, 2); h[6] = 1; return Buffer.concat([h, body]); };
  const send = (s: net.Socket, body: Buffer) => { for (let i = 0; i < body.length || i === 0; i += 4000) { const part = body.subarray(i, i + 4000), p = packet(4, part); p[1] = i + 4000 >= body.length ? 1 : 0; s.write(p); } };
  const done = (status = 0) => { const b = Buffer.alloc(13); b[0] = 0xfd; b.writeUInt16LE(status, 1); return b; };
  const ucs = (x: string) => Buffer.from(x, "ucs2");
  const bv = (x: string) => Buffer.concat([Buffer.from([x.length]), ucs(x)]);
  const nvarchar = (r: { columns: string[]; rows: (string | null)[][] }) => {
    const meta = [Buffer.from([0x81, r.columns.length, 0])];
    for (const c of r.columns) { const m = Buffer.alloc(14); m[6] = 0xe7; m.writeUInt16LE(8000, 7); meta.push(m, bv(c)); }
    const rows = r.rows.map((row) => Buffer.concat([Buffer.from([0xd1]), ...row.map((v) => { if (v == null) { const n = Buffer.alloc(2); n.writeUInt16LE(0xffff, 0); return n; } const b = ucs(v), n = Buffer.alloc(2); n.writeUInt16LE(b.length, 0); return Buffer.concat([n, b]); })]));
    return Buffer.concat([...meta, ...rows]);
  };
  const server = net.createServer((s) => {
    let pending = Buffer.alloc(0), message: Buffer[] = [];
    s.on("error", () => {});
    s.on("data", (d) => {
      pending = Buffer.concat([pending, d]);
      while (pending.length >= 8 && pending.length >= pending.readUInt16BE(2)) {
        const len = pending.readUInt16BE(2), type = pending[0], eom = pending[1] & 1;
        message.push(pending.subarray(8, len)); pending = pending.subarray(len);
        if (!eom) continue;
        const body = Buffer.concat(message); message = [];
        if (type === 0x12) {
          // VERSION, ENCRYPTION (not supported), INSTOPT, THREADID, MARS
          const opts = Buffer.from([0, 0, 21, 0, 6, 1, 0, 27, 0, 1, 2, 0, 28, 0, 1, 3, 0, 29, 0, 0, 0xff, 16, 0, 0, 0, 0, 0, 2, 0]);
          s.write(packet(4, opts));
        } else if (type === 0x10) {
          log.readOnlyIntent = (body[26] & 0x20) !== 0;
          const ack = Buffer.concat([Buffer.from([1, 0x74, 0, 0, 4]), bv("stub"), Buffer.from([16, 0, 0, 0])]), h = Buffer.alloc(3); h[0] = 0xad; h.writeUInt16LE(ack.length, 1);
          send(s, Buffer.concat([h, ack, done()]));
        } else if (type === 0x0e) {
          log.transactions++;
          const begin = body.readUInt16LE(body.readUInt32LE(0)) === 5, env = begin ? Buffer.from([0xe3, 11, 0, 8, 8, 1, 0, 0, 0, 0, 0, 0, 0, 0]) : Buffer.from([0xe3, 11, 0, 10, 0, 8, 1, 0, 0, 0, 0, 0, 0, 0]);
          send(s, Buffer.concat([env, done()]));
        } else {
          const sql = body.toString("ucs2").replace(/\0/g, "");
          log.sql.push(sql);
          const r = answer(sql);
          send(s, r ? Buffer.concat([nvarchar(r), done(0x10)]) : done());
        }
      }
    });
  });
  return new Promise<{ port: number; log: typeof log; close(): void }>((res) => server.listen(0, "127.0.0.1", () => res({ port: (server.address() as net.AddressInfo).port, log, close: () => server.close() })));
}

test("SQL Server settings: encrypted, certificate checked, read-only intent", () => {
  const c = mssqlConfig(base({ type: "mssql", host: "h", ssl: true, ca: "PEM" }), "p");
  assert.deepEqual([c.options.encrypt, c.options.trustServerCertificate, c.options.readOnlyIntent], [true, false, true]);
  assert.deepEqual(c.options.cryptoCredentialsDetails, { ca: "PEM" });
  assert.equal(mssqlConfig(base({ host: "h" }), "p").options.encrypt, true, "encryption is on unless turned off on purpose");
});

for (const type of ["mssql", "synapse"] as const) test(`${type} on a TDS stub: discovery, batches, isolation, write warning`, async () => {
  const data = Array.from({ length: 12000 }, (_, i) => [String(i + 1), "2024-01-01T00:00:00", "a@b.co"]);
  const stub = await tdsStub((sql) => {
    if (/snapshot_isolation_state/.test(sql)) return { columns: ["s"], rows: [["1"]] };
    if (/@@VERSION/.test(sql)) return { columns: ["v", "o", "w", "a", "i"], rows: [["Microsoft SQL Server 2022\nmore", "0", "1", "0", "1"]] };
    if (/DATA_TYPE/.test(sql)) return { columns: ["s", "t", "n", "d"], rows: [["dbo", "orders", "id", "bigint"], ["dbo", "orders", "at", "datetime2"], ["dbo", "orders", "contact", "nvarchar"], ["dbo", "orders", "ver", "timestamp"], ["dbo", "orders", "ok", "bit"], ["sales", "refunds", "id", "int"]] };
    if (/PRIMARY KEY/.test(sql)) return { columns: ["s", "t", "n"], rows: [["dbo", "orders", "id"]] };
    if (/COUNT_BIG/.test(sql)) return { columns: ["n"], rows: [["12000"]] };
    if (/TOP 50/.test(sql)) return { columns: ["v"], rows: [["a@b.co"]] };
    if (/FROM \[dbo\]\.\[orders\]/.test(sql)) return { columns: ["id", "at", "contact"], rows: data };
    return null;
  });
  cleanup(() => stub.close());
  const conn = base({ type, host: "127.0.0.1", port: stub.port, database: "db", user: "u", ssl: false });
  const src = await mssqlSource(conn, "p");
  assert.equal(stub.log.readOnlyIntent, true, "login asks for read-only intent");
  const notes = await src.check();
  assert.ok(notes.some((n) => n === "Warning: this login can write. Use a read-only login."));
  assert.equal(notes.some((n) => n.includes("snapshot isolation")), type === "mssql", "Synapse has no snapshot isolation");
  const streams = await src.discover();
  assert.deepEqual(streams.map((s) => s.name), ["orders", "sales.refunds"]);
  assert.equal(streams[0].primaryKey, "id");
  const t = Object.fromEntries(streams[0].columns.map((c) => [c.name, c.type]));
  assert.deepEqual([t.id, t.at, t.contact, t.ver, t.ok], ["BIGINT", "TIMESTAMP", "VARCHAR", "VARCHAR", "BOOLEAN"], "rowversion isn't a time");
  assert.deepEqual(await src.sample("orders", "contact"), ["a@b.co"]);
  assert.equal(await src.count("orders"), 12000);
  const columns = streams[0].columns.slice(0, 3);
  const { rows, sizes, most } = await collect(src, "orders", columns, { orderBy: "id" });
  assert.equal(rows.length, 12000); assert.deepEqual(rows[11999], ["12000", "2024-01-01T00:00:00", "a@b.co"]);
  assert.ok(Math.max(...sizes) <= 5000); assert.equal(most, 1, "a batch waits for the one before");
  const select = stub.log.sql.findLast((s) => s.includes("FROM [dbo].[orders]"))!;
  assert.ok(select.includes("CONVERT(varchar(40), [at], 126)"), "times come as the server writes them");
  assert.equal(stub.log.transactions > 0, type === "mssql");
  const inc = await collect(src, "orders", columns, { cursor: "id", after: "5", maxRows: 10, inclusive: true });
  assert.equal(inc.rows.length, 12000, "the stub doesn't filter, so this only proves the statement below");
  const last = stub.log.sql.findLast((s) => s.includes("TOP (10)"))!;
  assert.ok(last.includes("WHERE [id] >= @after") && last.includes("ORDER BY [id]"));
  assert.deepEqual(stub.log.sql.filter((s) => /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|MERGE)\b/.test(s.replace(/'[^']*'/g, ""))), [], "no write statement is ever sent");
  await src.close();
});

test("SQL Server: an unencrypted server is refused unless encryption was turned off", async () => {
  const stub = await tdsStub(() => null);
  cleanup(() => stub.close());
  await assert.rejects(() => mssqlSource(base({ type: "mssql", host: "127.0.0.1", port: stub.port, database: "db", user: "u", ssl: true }), "p"), (e: Error) => !e.message.includes("SECRET"));
});

