import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { deltaColumn, overwriteCommit, replayLog, writeDelta } from "./delta.ts";

let c: DuckDBConnection, dir: string, canRead = false;
const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
const folder = (name: string) => { const p = path.join(dir, name).replace(/\\/g, "/"); fs.mkdirSync(`${p}/_delta_log`, { recursive: true }); return p; };
const COLS = [{ name: "id", type: "BIGINT" }, { name: "city", type: "VARCHAR" }, { name: "amount", type: "DECIMAL(18,2)" }, { name: "ok", type: "BOOLEAN" }, { name: "day", type: "DATE" }, { name: "at", type: "TIMESTAMP" }, { name: "tags", type: "VARCHAR[]" }];
const src = (t: string) => `(SELECT id, city, amount, ok, day, "at", tags FROM ${t})`;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-delta-"));
  c = await (await DuckDBInstance.create(":memory:")).connect();
  await c.run(`CREATE TABLE a (id BIGINT, city VARCHAR, amount DECIMAL(18,2), ok BOOLEAN, day DATE, "at" TIMESTAMP, tags VARCHAR[])`);
  await c.run(`INSERT INTO a VALUES (1,'Oslo',10.50,true,'2026-01-02','2026-01-02 03:04:05',['x','y']),(2,NULL,NULL,NULL,NULL,NULL,NULL)`);
  await c.run(`CREATE TABLE b AS SELECT 3::BIGINT AS id, 'Rome' AS city, 7.25::DECIMAL(18,2) AS amount, false AS ok, DATE '2026-03-04' AS day, TIMESTAMP '2026-03-04 00:00:00' AS "at", ['z'] AS tags`);
  try { await c.run("INSTALL delta; LOAD delta;"); canRead = true; } catch (e) { console.error("Delta reader unavailable", e); }
});
after(() => { c.closeSync(); fs.rmSync(dir, { recursive: true, force: true }); });

test("Delta's own reader opens what's written, with the right rows and types", async (t) => {
  if (!canRead) return t.skip("the delta extension couldn't be downloaded");
  const p = folder("first");
  const r = await writeDelta(c, COLS, src("a"), p);
  assert.deepEqual([r.version, r.rows], [0, 2]);
  const out = await rows(`SELECT id, city, CAST(amount AS VARCHAR) amt, ok, CAST(day AS VARCHAR) d, CAST(tags AS VARCHAR) tags, epoch("at") e FROM delta_scan('${p}') ORDER BY id`);
  assert.deepEqual([out[0].id, out[0].city, out[0].amt, out[0].ok, out[0].d], ["1", "Oslo", "10.50", true, "2026-01-02"]);
  assert.equal(Number(out[0].e), Date.UTC(2026, 0, 2, 3, 4, 5) / 1000);
  assert.match(String(out[0].tags), /x.*y/);
  assert.equal(out[1].city, null);
  const types = await rows(`DESCRIBE SELECT * FROM delta_scan('${p}')`);
  const typeOf = (n: string) => String(types.find((x) => x.column_name === n)?.column_type);
  assert.equal(typeOf("id"), "BIGINT"); assert.equal(typeOf("amount"), "DECIMAL(18,2)"); assert.equal(typeOf("day"), "DATE"); assert.equal(typeOf("tags"), "VARCHAR");
});
test("a second export replaces the rows as a new version, keeping the table's identity", async (t) => {
  if (!canRead) return t.skip("the delta extension couldn't be downloaded");
  const p = folder("second");
  await writeDelta(c, COLS, src("a"), p);
  const r = await writeDelta(c, COLS, src("b"), p);
  assert.equal(r.version, 1);
  assert.deepEqual((await rows(`SELECT id FROM delta_scan('${p}')`)).map((x) => x.id), ["3"]);
  const logs = ["00000000000000000000", "00000000000000000001"].map((v) => fs.readFileSync(`${p}/_delta_log/${v}.json`, "utf8"));
  const ids = logs.map((l) => replayLog([l]).tableId);
  assert.equal(ids[0], ids[1]);
  assert.equal(replayLog(logs).live.length, 1);
  assert.equal(fs.readdirSync(p).filter((f) => f.endsWith(".parquet")).length, 2);
});
test("an export with no rows still makes a valid empty table", async (t) => {
  if (!canRead) return t.skip("the delta extension couldn't be downloaded");
  const p = folder("empty");
  assert.equal((await writeDelta(c, COLS, `(${src("a").slice(1, -1)} WHERE id < 0)`, p)).rows, 0);
  assert.equal((await rows(`SELECT count(*) n FROM delta_scan('${p}')`))[0].n, "0");
});
test("a failed data write leaves the table as it was", async (t) => {
  if (!canRead) return t.skip("the delta extension couldn't be downloaded");
  const p = folder("failed");
  await writeDelta(c, COLS, src("a"), p);
  await assert.rejects(writeDelta(c, COLS, "(SELECT * FROM no_such_table)", p));
  assert.equal(fs.readdirSync(`${p}/_delta_log`).length, 1);
  assert.equal((await rows(`SELECT count(*) n FROM delta_scan('${p}')`))[0].n, "2");
});
test("column names Delta can't store are refused before anything is written", async () => {
  const p = folder("names");
  await assert.rejects(writeDelta(c, [{ name: "my col", type: "VARCHAR" }], "(SELECT 1)", p), /can't store the column name "my col"/);
  assert.equal(fs.readdirSync(p).filter((f) => f.endsWith(".parquet")).length, 0);
});
test("a table with a gap in its log isn't overwritten", async () => {
  const p = folder("gap");
  fs.writeFileSync(`${p}/_delta_log/00000000000000000005.json`, "{}\n");
  await assert.rejects(writeDelta(c, COLS, src("a"), p), /gaps|checkpoints/);
});
test("the log format is exact", () => {
  const lines = overwriteCommit({ version: 0, fields: [], file: "f.parquet", size: 9, rows: 2, removes: [], now: 5 }).split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[1], { protocol: { minReaderVersion: 1, minWriterVersion: 2 } });
  assert.equal(lines[3].add.path, "f.parquet");
  assert.equal(JSON.parse(lines[3].add.stats).numRecords, 2);
  const later = overwriteCommit({ version: 2, tableId: "t", fields: [], file: "g", size: 1, rows: 0, removes: ["f.parquet"], now: 5 }).split("\n").map((l) => JSON.parse(l));
  assert.ok(!later.some((l) => l.protocol));
  assert.equal(later.find((l) => l.remove).remove.path, "f.parquet");
  assert.equal(later.find((l) => l.metaData).metaData.id, "t");
});
test("every kind of warehouse type has a Delta type", () => {
  assert.equal(deltaColumn("a", "HUGEINT").field.type, "string");
  assert.equal(deltaColumn("a", "STRUCT(x INT)").field.type, "string");
  assert.equal(deltaColumn("a", "INTEGER").field.type, "integer");
  assert.equal(deltaColumn("a", "DECIMAL(10, 3)").field.type, "decimal(10,3)");
});
