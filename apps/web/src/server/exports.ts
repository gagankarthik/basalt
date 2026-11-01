import "server-only";
import { cloudMessage } from "@/lib/cloudErrors";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeDelta } from "@/lib/delta";
import { lit, q } from "@/lib/sql";
import { xmlRow } from "@/lib/xml";
import type { Connection } from "@/lib/types";
import { raise, resolve } from "./alerts";
import { writeCloud } from "./cloud";
import { withConn } from "./engine";
import { getConfig, getSecret, readJson, writeJson } from "./files";
import { bucketUrl, openGateway } from "./lake";
import { HttpError } from "./auth";
import { withExportLineage } from "./openlineage";

// Called indirectly on purpose: the bundler reads a direct path.join with variable parts as a glob over the project, which lists ./data in the build
const joinPath = path.join.bind(path);

export const EXT: Record<string, { copy: string; type: string }> = {
  csv: { copy: "FORMAT csv, HEADER true", type: "text/csv" },
  json: { copy: "FORMAT json, ARRAY false", type: "application/x-ndjson" },
  parquet: { copy: "FORMAT parquet", type: "application/vnd.apache.parquet" },
  xlsx: { copy: "FORMAT xlsx, HEADER true", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  xml: { copy: "", type: "application/xml" },
};
type Col = { name: string; type: string };
export const parts = (table: string) => { const m = /^(\w+)\.(\w+)$/.exec(table); if (!m) throw new HttpError(400, "Choose a table to export."); return [m[1], m[2]]; };

/** Rows leave the warehouse only through this read, so an export can only contain data that's already masked. */
export async function rowsOf<T>(table: string, fn: (cols: Col[], rows: AsyncIterable<(string | null)[]>) => Promise<T>) {
  const [schema, name] = parts(table);
  return withConn(async (c) => {
    const cols = ((await c.runAndReadAll(`SELECT column_name n, data_type t FROM information_schema.columns WHERE table_schema = ${lit(schema)} AND table_name = ${lit(name)} ORDER BY ordinal_position`)).getRowObjectsJson() as { n: string; t: string }[]).map((x) => ({ name: x.n, type: x.t }));
    if (!cols.length) throw new HttpError(404, `${table} isn't in the warehouse.`);
    const r = await c.stream(`SELECT ${cols.map((x) => `CAST(${q(x.name)} AS VARCHAR)`).join(", ")} FROM ${q(schema)}.${q(name)}`);
    async function* iter() {
      for (;;) {
        const chunk = await r.fetchChunk();
        if (!chunk || chunk.rowCount === 0) return;
        for (const row of chunk.getRows()) yield row.map((v) => (v == null ? null : String(v)));
      }
    }
    return fn(cols, iter());
  });
}

async function toNdjson(cols: Col[], rows: AsyncIterable<(string | null)[]>, file: string) {
  const out = fs.createWriteStream(file);
  for await (const r of rows) {
    const o = Object.fromEntries(cols.map((c, i) => [c.name, r[i]]));
    if (!out.write(`${JSON.stringify(o)}\n`)) await new Promise<void>((d) => out.once("drain", () => d()));
  }
  await new Promise<void>((d) => out.end(() => d()));
}

/** Writes a warehouse table as a file, either in storage or in a temporary local path. */
export async function writeFile(table: string, format: string, target: string, conn?: Connection) {
  const tmp = joinPath(os.tmpdir(), `basalt-${crypto.randomUUID()}`);
  const gate = await openGateway(conn, conn ? getSecret(conn.id) : undefined);
  try {
    const cols = await rowsOf(table, async (c, rows) => { await toNdjson(c, rows, tmp); return c; });
    if (format === "xlsx") await gate.c.run("INSTALL excel; LOAD excel;");
    // All columns were written as text; the warehouse's own types are restored here. Excel can't hold every type, so it keeps text.
    const typed = cols.map((c) => `TRY_CAST(${q(c.name)} AS ${format === "xlsx" && !/INT|DOUBLE|FLOAT|DECIMAL|BOOL/.test(c.type) ? "VARCHAR" : c.type}) AS ${q(c.name)}`).join(", ");
    const from = `read_json(${lit(tmp)}, format = 'newline_delimited', columns = {${cols.map((c) => `${lit(c.name)}: 'VARCHAR'`).join(", ")}}, maximum_object_size = 268435456)`;
    if (format === "delta") await writeDelta(gate.c, cols, from, target);
    else if (format === "xml") {
      const lines = `SELECT '<rows>' AS l UNION ALL SELECT x FROM xml_rows UNION ALL SELECT '</rows>'`;
      const xml = `${tmp}.xml.ndjson`;
      fs.writeFileSync(xml, fs.readFileSync(tmp, "utf8").split("\n").filter(Boolean).map((l) => JSON.stringify({ x: xmlRow(JSON.parse(l)) })).join("\n"));
      try {
        await gate.c.run(`CREATE TEMP TABLE xml_rows AS SELECT x FROM read_json(${lit(xml)}, format = 'newline_delimited', columns = {'x': 'VARCHAR'}, maximum_object_size = 268435456)`);
        await gate.c.run(`COPY (${lines}) TO ${lit(target)} (FORMAT csv, HEADER false, QUOTE '', ESCAPE '', DELIMITER '\u0001')`);
      } finally { fs.rmSync(xml, { force: true }); }
    } else await gate.c.run(`COPY (SELECT ${typed} FROM ${from}) TO ${lit(target)} (${EXT[format].copy})`);
  } finally { gate.close(); fs.rmSync(tmp, { force: true }); }
}


/** Sends one table to a connection. Shared by the Export button and schedules. */
export async function deliver(table: string, format: string, conn: Connection, target?: string, actor = "Schedule") {
  parts(table);
  return withExportLineage(table, conn, actor, () => deliverNow(table, format, conn, target));
}
async function deliverNow(table: string, format: string, conn: Connection, target?: string) {
  const name = parts(table)[1];
  if (conn.type === "s3" || conn.type === "gcs" || conn.type === "azure") {
    if (!EXT[format] && format !== "delta") throw new HttpError(400, "Choose CSV, JSON, Parquet, Excel, XML or Delta.");
    // A Delta table is a folder rather than one file
    const rel = String(target ?? "").replace(/^\/+/, "") || (format === "delta" ? `exports/${name}` : `exports/${name}.${format}`);
    if (rel.split("/").includes("..")) throw new HttpError(400, "Enter a path inside this bucket.");
    const to = bucketUrl(conn, rel);
    await writeFile(table, format, to, conn).catch((e: Error) => { throw new Error(cloudMessage(conn.type, e.message)); });
    return { written: to };
  }
  if (conn.type === "bigquery" || conn.type === "snowflake") {
    const dest = String(target ?? "").trim() || name;
    if (!/^\w+$/.test(dest)) throw new HttpError(400, "Enter a table name with letters, numbers and underscores.");
    // A source is only ever read, so an export can't overwrite a table a pipeline copies from
    if (getConfig().pipelines.some((p) => p.connectionId === conn.id && p.streams.some((s) => s.enabled && s.name.split(".").pop()!.toLowerCase() === dest.toLowerCase()))) throw new HttpError(400, `${dest} is a table this connection syncs from. Choose another name.`);
    const rows = await rowsOf(table, (cols, it) => writeCloud(conn, getSecret(conn.id) ?? "", dest, cols, it));
    return { written: dest, rows };
  }
  throw new HttpError(400, "Basalt never writes to this kind of source.");
}

export type ScheduledExport = { id: string; table: string; format: string; connectionId: string; path?: string; every: number; createdBy: string; lastAt?: string; lastError?: string };
const FILE = "scheduled-exports.json";
export const getScheduled = () => readJson<ScheduledExport[]>(FILE, []);
export const saveScheduled = (l: ScheduledExport[]) => writeJson(FILE, l);
export async function runScheduledExports() {
  const list = getScheduled(), now = Date.now(); let changed = false;
  for (const x of list) {
    if (x.lastAt && now - Date.parse(x.lastAt) < x.every * 60000) continue;
    const conn = getConfig().connections.find((c) => c.id === x.connectionId), key = `export:${x.id}`;
    x.lastAt = new Date(now).toISOString(); changed = true;
    try {
      if (!conn) throw new Error("Its connection was removed.");
      await deliver(x.table, x.format, conn, x.path);
      x.lastError = undefined; await resolve(key, `Export working again: ${x.table}`, "/flow");
    } catch (e) { x.lastError = e instanceof Error ? e.message : String(e); await raise(key, "bad", `Export failed: ${x.table}`, x.lastError, "/flow"); }
  }
  if (changed) { const fresh = getScheduled(); saveScheduled(fresh.map((f) => list.find((y) => y.id === f.id) ?? f)); }
}
