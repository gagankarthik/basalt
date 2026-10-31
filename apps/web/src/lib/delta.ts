import crypto from "node:crypto";
import type { DuckDBConnection } from "@duckdb/node-api";
import { lit, q } from "./sql.ts";

const DIRECT: [RegExp, string][] = [[/^(VARCHAR|TEXT|STRING|UUID|JSON)$/, "string"], [/^BIGINT$/, "long"], [/^INT(EGER)?$/, "integer"], [/^SMALLINT$/, "short"], [/^TINYINT$/, "byte"], [/^DOUBLE$/, "double"], [/^(FLOAT|REAL)$/, "float"], [/^BOOLEAN$/, "boolean"], [/^DATE$/, "date"]];
// Delta stores these in Parquet with special meaning, or Spark rejects them, unless a table turns on column mapping
const BAD_NAME = /[ ,;{}()\n\t=]/;

/** How one warehouse column is stored in Delta. Types Delta has no plain form for are kept as text rather than failing the export. */
export function deltaColumn(name: string, type: string, input = q(name)) {
  const t = type.toUpperCase().trim();
  const typed = `TRY_CAST(${input} AS ${type})`;
  const decimal = /^DECIMAL\((\d+),\s*(\d+)\)$/.exec(t);
  if (decimal) return { field: { name, type: `decimal(${decimal[1]},${decimal[2]})`, nullable: true, metadata: {} }, select: `${typed} AS ${q(name)}` };
  // Delta's timestamp is an instant in UTC, so a plain warehouse timestamp is read as UTC
  if (t === "TIMESTAMP" || t === "TIMESTAMP WITH TIME ZONE" || t === "TIMESTAMPTZ") return { field: { name, type: "timestamp", nullable: true, metadata: {} }, select: `TRY_CAST(CAST(${input} AS VARCHAR) || CASE WHEN regexp_matches(CAST(${input} AS VARCHAR), '[+-][0-9]{2}(:[0-9]{2})?$') THEN '' ELSE '+00' END AS TIMESTAMPTZ) AS ${q(name)}` };
  const direct = DIRECT.find(([re]) => re.test(t));
  if (direct) return { field: { name, type: direct[1], nullable: true, metadata: {} }, select: direct[1] === "string" ? `CAST(${input} AS VARCHAR) AS ${q(name)}` : `${typed} AS ${q(name)}` };
  return { field: { name, type: "string", nullable: true, metadata: {} }, select: `CAST(${input} AS VARCHAR) AS ${q(name)}` };
}

export const logName = (version: number) => `${String(version).padStart(20, "0")}.json`;

type LogEntry = { add?: { path: string }; remove?: { path: string }; metaData?: { id: string }; commitInfo?: unknown; protocol?: unknown };
/** What's live after replaying a table's log, in version order. */
export function replayLog(commits: string[]) {
  const live = new Set<string>();
  let tableId: string | undefined;
  for (const commit of commits) for (const line of commit.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as LogEntry;
    if (e.add) live.add(e.add.path);
    if (e.remove) live.delete(e.remove.path);
    if (e.metaData) tableId = e.metaData.id;
  }
  return { live: [...live], tableId };
}

/** One commit that replaces the table's contents. */
export function overwriteCommit(opts: { version: number; tableId?: string; fields: unknown[]; file: string; size: number; rows: number; removes: string[]; now: number }) {
  const { version, fields, file, size, rows, removes, now } = opts;
  const lines: unknown[] = [{ commitInfo: { timestamp: now, operation: "WRITE", operationParameters: { mode: version ? "Overwrite" : "ErrorIfExists", partitionBy: "[]" }, isBlindAppend: !version, engineInfo: "Basalt" } }];
  if (!version) lines.push({ protocol: { minReaderVersion: 1, minWriterVersion: 2 } });
  lines.push({ metaData: { id: opts.tableId ?? crypto.randomUUID(), format: { provider: "parquet", options: {} }, schemaString: JSON.stringify({ type: "struct", fields }), partitionColumns: [], configuration: {}, createdTime: now } });
  for (const path of removes) lines.push({ remove: { path, deletionTimestamp: now, dataChange: true } });
  lines.push({ add: { path: file, partitionValues: {}, size, modificationTime: now, dataChange: true, stats: JSON.stringify({ numRecords: rows }) } });
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

const rowsOf = async (c: DuckDBConnection, sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];

/**
 * Writes rows to a Delta table in a folder, replacing what's there as a new version. Data goes first and the log entry last, so a reader sees the old table or the new one, never part of one.
 * shortcut: a commit isn't an atomic put-if-absent, so two different systems writing the same folder at once could collide; Basalt's own writes are one at a time. Use a Delta log store if another writer ever shares a table.
 * Old data files stay, so earlier versions keep working. Nothing here removes them.
 */
export async function writeDelta(c: DuckDBConnection, columns: { name: string; type: string }[], from: string, target: string, now = Date.now()) {
  const root = target.replace(/\/+$/, ""), log = `${root}/_delta_log`;
  const bad = columns.find((x) => BAD_NAME.test(x.name));
  if (bad) throw new Error(`Delta can't store the column name "${bad.name}", because of its spaces or punctuation. Rename it in a model first.`);
  const versions = async () => (await rowsOf(c, `SELECT file FROM glob(${lit(`${log}/*.json`)})`)).map((r) => /(\d{20})\.json$/.exec(String(r.file).replace(/\\/g, "/"))?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  const known = await versions(), version = known.length ? known[known.length - 1] + 1 : 0;
  if (known.length !== version) throw new Error("This Delta table's log has gaps or has been compacted with checkpoints, so Basalt won't overwrite it. Choose another folder.");
  const texts = known.length ? (await rowsOf(c, `SELECT filename, content FROM read_text(${lit(`${log}/*.json`)}) ORDER BY filename`)).map((r) => String(r.content)) : [];
  const { live, tableId } = replayLog(texts);
  const cols = columns.map((x) => deltaColumn(x.name, x.type));
  const file = `part-00000-${crypto.randomUUID()}-c000.snappy.parquet`, url = `${root}/${file}`;
  await c.run(`COPY (SELECT ${cols.map((x) => x.select).join(", ")} FROM ${from}) TO ${lit(url)} (FORMAT parquet, COMPRESSION snappy)`);
  const [meta] = await rowsOf(c, `SELECT sum(row_group_num_rows) AS n FROM (SELECT DISTINCT row_group_id, row_group_num_rows FROM parquet_metadata(${lit(url)}))`);
  const [blob] = await rowsOf(c, `SELECT size FROM read_blob(${lit(url)})`);
  const rows = Number(meta?.n ?? 0);
  const commit = overwriteCommit({ version, tableId, fields: cols.map((x) => x.field), file, size: Number(blob.size), rows, removes: live, now });
  const latest = await versions();
  if (latest.length !== known.length) throw new Error("Something else changed this Delta table during the export. Nothing was changed. Try again.");
  const lines = commit.split("\n").map(lit).join(", ");
  await c.run(`COPY (SELECT unnest([${lines}])) TO ${lit(`${log}/${logName(version)}`)} (FORMAT csv, HEADER false, QUOTE '', ESCAPE '', DELIMITER '\u0001')`);
  return { version, rows, file };
}
