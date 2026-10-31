import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance, StatementType, type DuckDBConnection } from "@duckdb/node-api";
import { createGate } from "@/lib/gate";
import { kindOf, q } from "@/lib/sql";
import type { Result } from "@/lib/types";

// Must stay opaque to the bundler. If it can work out this folder, it lists every file in it for the build, which fails on locked
// databases and would ship customer data and data/.key with the build. Checked by `npm run check:build`.
const DEFAULT_FOLDER = new Map([["name", "data"]]).get("name")!;
export const DATA_DIR = process.env.BASALT_DATA ?? `${process.cwd()}${path.sep}${DEFAULT_FOLDER}`;
export const dataPath = (name: string) => `${DATA_DIR}${path.sep}${name}`;

type G = { warehouse?: Promise<DuckDBInstance>; sources?: Promise<DuckDBInstance>; gate?: ReturnType<typeof createGate> };
const g = globalThis as unknown as { __basalt?: G };
const cache: G = (g.__basalt ??= {});
const gate = (cache.gate ??= createGate());

async function open(file: string) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // A process that has just ended can hold the file for a moment on Windows
  for (let wait = 0; ; wait += 500) {
    try { return await DuckDBInstance.create(dataPath(file)); } catch (e) {
      if (wait >= 30000 || !/cannot open|being used|lock/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** The warehouse users query. External access is off and locked, so SQL can't read server files or reach the network. */
export function warehouse() {
  return (cache.warehouse ??= (async () => {
    const db = await open("warehouse.duckdb");
    const c = await db.connect();
    await c.run(`CREATE SCHEMA IF NOT EXISTS analytics; CREATE SCHEMA IF NOT EXISTS scratch;`);
    await c.run(`SET enable_external_access = false`);
    await c.run(`SET lock_configuration = true`);
    c.closeSync();
    return db;
  })().catch((e) => { cache.warehouse = undefined; throw e; }));
}
/** Holds sample and uploaded source data, unmasked. Never reachable from user SQL. */
export function sourceStore() {
  return (cache.sources ??= open("sources.duckdb"));
}

export async function withConn<T>(fn: (c: DuckDBConnection) => Promise<T>, db?: Promise<DuckDBInstance>): Promise<T> {
  const connect = async (from: Promise<DuckDBInstance>) => {
    const c = await (await from).connect();
    try { return await fn(c); } finally { c.closeSync(); }
  };
  return db ? connect(db) : gate.run(() => connect(warehouse()));
}

/**
 * DuckDB allows one writing process, so while real dbt runs the warehouse file is closed here. Other requests wait, and the next one
 * reopens it with the same lock, even if fn throws or dbt was stopped.
 */
export function withWarehouseClosed<T>(fn: (file: string) => Promise<T>): Promise<T> {
  return gate.exclusive(async () => {
    const open = cache.warehouse;
    cache.warehouse = undefined;
    if (open) (await open.catch(() => null))?.closeSync();
    return fn(dataPath("warehouse.duckdb"));
  });
}

export function toResult(reader: { columnNames(): string[]; columnTypes(): { toString(): string }[]; getRowObjectsJson(): unknown[] }, started: number, limit: number): Result {
  const names = reader.columnNames(), types = reader.columnTypes().map(String);
  const columns = names.map((name, i) => ({ name, type: types[i], kind: kindOf(types[i]) }));
  const numeric = columns.filter((c) => c.kind === "number").map((c) => c.name);
  const all = reader.getRowObjectsJson() as Record<string, unknown>[];
  const rows = all.slice(0, limit);
  // JSON form returns BIGINT and DECIMAL as strings; charts and sorting need numbers
  for (const r of rows) for (const n of numeric) if (typeof r[n] === "string") r[n] = Number(r[n]);
  return { columns, rows, ms: Date.now() - started, truncated: all.length > limit };
}

/** What each statement is. Anything not listed (ATTACH, LOAD, INSTALL and so on) can't be run from SQL at all. */
const FAMILY: Partial<Record<StatementType, "DQL" | "DML" | "DDL" | "TCL">> = {
  [StatementType.SELECT]: "DQL", [StatementType.EXPLAIN]: "DQL",
  [StatementType.INSERT]: "DML", [StatementType.UPDATE]: "DML", [StatementType.DELETE]: "DML", [StatementType.MERGE_INTO]: "DML",
  [StatementType.CREATE]: "DDL", [StatementType.CREATE_FUNC]: "DDL", [StatementType.ALTER]: "DDL", [StatementType.DROP]: "DDL",
  [StatementType.TRANSACTION]: "TCL",
};

export async function runSql(text: string, opts: { readOnly: boolean; limit?: number; rewrite?: (c: DuckDBConnection, sql: string) => Promise<string> }): Promise<Result & { kinds: string[] }> {
  const asked = Number(opts.limit), limit = Math.min(asked >= 0 ? asked : 10000, 100000);
  return withConn(async (c) => {
    const started = Date.now();
    const sql = opts.rewrite ? await opts.rewrite(c, text) : text;
    const st = await c.extractStatements(sql);
    if (!st.count) throw new Error("Enter a SQL statement to run.");
    // Several statements are one unit unless the script manages its own transaction
    const ownTx = /\b(begin|start\s+transaction|commit|rollback|abort)\b/i.test(sql), wrap = !opts.readOnly && st.count > 1 && !ownTx;
    const kinds = new Set<string>();
    let reader;
    if (wrap) await c.run("BEGIN");
    try {
      for (let i = 0; i < st.count; i++) {
        const p = await st.prepare(i), kind = FAMILY[p.statementType];
        if (opts.readOnly && kind !== "DQL") throw new Error("Your role can only run SELECT queries. Ask an admin for Editor access to change data.");
        // EXPLAIN ANALYZE really runs the statement, so it could change data
        if (opts.readOnly && p.statementType === StatementType.EXPLAIN && /analy[sz]e/i.test(sql)) throw new Error("Your role can't use EXPLAIN ANALYZE. Use EXPLAIN to see the plan.");
        if (!kind) throw new Error("The SQL editor doesn't allow this kind of statement.");
        kinds.add(kind);
        // A read stops just past the limit, so a huge SELECT can't fill the server's memory. Only the last one can: DuckDB refuses anything else on the connection while a read is open
        // shortcut: a large SELECT before the last statement is still read whole; cap these too if scripts ever need it
        reader = kind === "DQL" && i === st.count - 1 && !wrap && !ownTx ? await p.streamAndReadUntil(limit + 1) : await p.runAndReadAll();
      }
      if (wrap) await c.run("COMMIT");
    } catch (e) {
      if (wrap || ownTx) await c.run("ROLLBACK").catch(() => {});
      throw new Error(`${e instanceof Error ? e.message : e}${wrap ? " Nothing was changed." : ""}`);
    }
    // BEGIN only fails inside an open transaction, so this finds one left unfinished
    if (ownTx) {
      const open = await c.run("BEGIN").then(() => false, () => true);
      await c.run("ROLLBACK").catch(() => {});
      if (open) throw new Error("The transaction was never finished with COMMIT or ROLLBACK, so its changes were undone.");
    }
    return { ...toResult(reader!, started, limit), kinds: [...kinds] };
  });
}

export const qualified = (schema: string, name: string) => `${q(schema)}.${q(name)}`;
