import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { markDeleted } from "./softDelete.ts";

let c: DuckDBConnection;
const flags = async () => Object.fromEntries(((await c.runAndReadAll('SELECT id, "_basalt_deleted" d FROM copy ORDER BY id')).getRowObjectsJson() as { id: unknown; d: unknown }[]).map((r) => [String(r.id), r.d]));
const keys = (...ids: number[]) => c.run(`CREATE OR REPLACE TABLE k AS SELECT id::INT AS id FROM (SELECT unnest([${ids.join(",")}]::INT[]) AS id)`);
before(async () => { c = await (await DuckDBInstance.create(":memory:")).connect(); });
after(() => c.closeSync());
beforeEach(async () => { await c.run("CREATE OR REPLACE TABLE copy AS SELECT * FROM (VALUES (1,'a'),(2,'b'),(3,'c')) t(id, v)"); await c.run('ALTER TABLE copy DROP COLUMN IF EXISTS "_basalt_deleted"'); });

test("a row gone from the source is flagged, and its data stays", async () => {
  await keys(1, 3);
  assert.deepEqual(await markDeleted(c, "copy", "id", "k"), { skipped: false, deleted: 1, restored: 0 });
  assert.deepEqual(await flags(), { 1: false, 2: true, 3: false });
  assert.equal((await c.runAndReadAll("SELECT v FROM copy WHERE id = 2")).getRowObjectsJson()[0].v, "b");
});
test("a row that comes back is unflagged, and running again changes nothing", async () => {
  await keys(1, 3); await markDeleted(c, "copy", "id", "k");
  assert.equal((await markDeleted(c, "copy", "id", "k")).deleted, 0);
  await keys(1, 2, 3);
  assert.deepEqual(await markDeleted(c, "copy", "id", "k"), { skipped: false, deleted: 0, restored: 1 });
  assert.deepEqual(await flags(), { 1: false, 2: false, 3: false });
});
test("an empty read never flags the whole table", async () => {
  await c.run("CREATE OR REPLACE TABLE k (id INT)");
  assert.deepEqual(await markDeleted(c, "copy", "id", "k"), { skipped: true, deleted: 0, restored: 0 });
  const cols = (await c.runAndReadAll("SELECT column_name n FROM information_schema.columns WHERE table_name = 'copy'")).getRowObjectsJson().map((r) => r.n);
  assert.ok(!cols.includes("_basalt_deleted"));
});
test("a new row added later starts unflagged, and rows with no key aren't judged", async () => {
  await keys(1, 2, 3); await markDeleted(c, "copy", "id", "k");
  await c.run("INSERT INTO copy (id, v) VALUES (4, 'd'), (NULL, 'x')");
  assert.equal((await c.runAndReadAll('SELECT "_basalt_deleted" d FROM copy WHERE id = 4')).getRowObjectsJson()[0].d, false);
  await keys(1, 2, 3, 4);
  assert.equal((await markDeleted(c, "copy", "id", "k")).deleted, 0);
  assert.equal((await c.runAndReadAll('SELECT "_basalt_deleted" d FROM copy WHERE id IS NULL')).getRowObjectsJson()[0].d, false);
});
