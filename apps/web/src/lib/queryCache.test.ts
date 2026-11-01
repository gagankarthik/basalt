import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createCache, createLimiter, fingerprint, isCacheable, scopeKey } from "./queryCache.ts";

test("the fingerprint moves on every committed change, and stays put on reads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-cache-")), file = path.join(dir, "w.duckdb");
  const db = await DuckDBInstance.create(file), c = await db.connect();
  try {
    await c.run("CREATE TABLE t (a INT); INSERT INTO t VALUES (1); CHECKPOINT");
    const moves = async (sql: string) => { const was = fingerprint(file); await c.run(sql); return fingerprint(file) !== was; };
    for (const write of ["INSERT INTO t VALUES (2)", "UPDATE t SET a = 3 WHERE a = 2", "DELETE FROM t WHERE a = 3", "ALTER TABLE t ADD COLUMN b INT", "CREATE TABLE u AS SELECT 1 x", "CREATE VIEW v AS SELECT 1 x", "DROP TABLE u", "CHECKPOINT", "INSERT INTO t (a) VALUES (9)"]) assert.equal(await moves(write), true, write);
    await c.run("CHECKPOINT");
    for (const read of ["SELECT count(*) FROM t", "CREATE TEMP TABLE scratch AS SELECT * FROM t", "INSERT INTO scratch SELECT * FROM t"]) assert.equal(await moves(read), false, read);
    await c.run("BEGIN; INSERT INTO t (a) VALUES (10)");
    await c.run("COMMIT");
    const was = fingerprint(file);
    await c.run("BEGIN; INSERT INTO t (a) VALUES (11); ROLLBACK");
    assert.equal(fingerprint(file), was, "a change undone changes nothing");
  } finally { c.closeSync(); db.closeSync(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("only plain reads of data are cached", () => {
  for (const yes of ["SELECT a FROM t", "  select * from t;  ", "WITH x AS (SELECT 1) SELECT * FROM x", "FROM t", "SELECT 'nowhere' FROM t"]) assert.equal(isCacheable(yes), true, yes);
  for (const no of ["INSERT INTO t VALUES (1)", "DELETE FROM t", "SELECT 1; DROP TABLE t", "EXPLAIN ANALYZE SELECT 1", "SELECT now()", "SELECT * FROM t WHERE d > current_date", "SELECT random()", "SELECT * FROM t USING SAMPLE 10", "SELECT * FROM duckdb_tables()", "CREATE TABLE x AS SELECT 1"]) assert.equal(isCacheable(no), false, no);
});

test("an entry dies when the warehouse changes or it gets old, and the oldest leaves first", () => {
  const c = createCache<string>({ maxBytes: 100, maxEntryBytes: 60, ttlMs: 1000 });
  c.set("a", "A", "p1", 50, 0);
  assert.equal(c.get("a", "p1", 10), "A");
  assert.equal(c.get("a", "p2", 10), undefined, "the warehouse changed");
  assert.equal(c.get("a", "p1", 10), undefined, "and it stays gone if the fingerprint came back");
  c.set("b", "B", "p", 50, 0); assert.equal(c.get("b", "p", 1001), undefined, "too old");
  c.set("too big", "x", "p", 61, 0); assert.equal(c.get("too big", "p", 0), undefined);
  c.set("1", "1", "p", 50, 0); c.set("2", "2", "p", 50, 0); c.get("1", "p", 0); c.set("3", "3", "p", 50, 0);
  assert.equal(c.get("2", "p", 0), undefined, "least recently used");
  assert.equal(c.get("1", "p", 0), "1");
  assert.deepEqual(c.stats(), { entries: 2, bytes: 100 });
});

test("the limiter never runs more than it should, and survives a failure", async () => {
  const l = createLimiter(2); let now = 0, peak = 0;
  const job = (fail = false) => l.run(async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 5)); now--; if (fail) throw new Error("x"); return 1; });
  const out = await Promise.allSettled([job(), job(true), job(), job(), job(true), job()]);
  assert.equal(peak, 2);
  assert.equal(out.filter((r) => r.status === "rejected").length, 2);
  assert.equal(await job(), 1, "still working");
  assert.equal(l.waiting(), 0);
});

test("a viewer never shares answers with anyone, and loses them when their access changes", () => {
  const ann = { id: "ann", role: "viewer" }, bob = { id: "bob", role: "viewer" }, access = { rules: [], revoked: [] };
  assert.notEqual(scopeKey(ann, access), scopeKey(bob, access), "two viewers");
  assert.notEqual(scopeKey(ann, access), scopeKey({ id: "ann", role: "editor" }, access), "a viewer and an editor, even the same person");
  assert.notEqual(scopeKey(ann, access), scopeKey(ann, { rules: [{ table: "t", column: "c", values: ["x"] }], revoked: [] }), "a new row rule");
  assert.notEqual(scopeKey(ann, access), scopeKey(ann, { rules: [], revoked: ["a.b"] }), "a revoked table");
  assert.equal(scopeKey({ id: "x", role: "editor" }, {}), scopeKey({ id: "y", role: "admin" }, access), "editors and admins read alike");
});
