import type { Column } from "./types.ts";

export const toDuckType = (t: string): string => {
  const s = t.toLowerCase();
  if (/^jsonb?$/.test(s)) return "JSON";
  if (/^(smallint|int2|tinyint|mediumint|integer|int4|int|serial)/.test(s)) return "INTEGER";
  if (/^(bigint|int8|bigserial)/.test(s)) return "BIGINT";
  if (/^(numeric|decimal|double|real|float|money)/.test(s)) return "DOUBLE";
  if (/^bool|^bit\(1\)/.test(s)) return "BOOLEAN";
  if (/^date$/.test(s)) return "DATE";
  if (/^(timestamp|datetime)/.test(s)) return "TIMESTAMP";
  return /^(integer|bigint|double|boolean|date|timestamp|varchar|hugeint|decimal|float)/.test(s) ? t.toUpperCase() : "VARCHAR";
};

/** One value as the text a Batch carries. */
export const toText = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString("hex");
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};

/* ---- sources with no schema: columns come from a bounded sample, and rows may hold anything later ---- */
export type Doc = Record<string, unknown>;
/** Fields no column was inferred for. It's JSON, so every row of it gets the full personal data scan, and a surprise can't fail a sync or slip through unread. */
export const EXTRA = "_extra_fields";
const MAX_COLUMNS = 300, RESERVED = new Set([EXTRA, "_basalt_synced_at"]);

const kindOf = (v: unknown) => (v instanceof Date ? "TIMESTAMP" : typeof v === "boolean" ? "BOOLEAN" : typeof v === "number" ? (Number.isSafeInteger(v) ? "BIGINT" : "DOUBLE") : typeof v === "string" ? "VARCHAR" : "JSON");
const merged = (k: Set<string>) => (k.has("JSON") ? "JSON" : k.size === 1 ? [...k][0] : k.size === 2 && k.has("BIGINT") && k.has("DOUBLE") ? "DOUBLE" : "VARCHAR");

/** Columns for a sample of documents. `first` are the key fields, shown first. DuckDB names ignore case, so a second spelling of a name stays in EXTRA. */
export function inferColumns(docs: Doc[], first: string[] = []): Column[] {
  const kinds = new Map<string, Set<string>>(), lower = new Set<string>();
  for (const f of first) { kinds.set(f, new Set()); lower.add(f.toLowerCase()); }
  for (const d of docs) for (const [k, v] of Object.entries(d)) {
    if (!kinds.has(k)) {
      if (!k.trim() || k.length > 255 || RESERVED.has(k.toLowerCase()) || lower.has(k.toLowerCase()) || kinds.size >= MAX_COLUMNS) continue;
      kinds.set(k, new Set()); lower.add(k.toLowerCase());
    }
    if (v != null) kinds.get(k)!.add(kindOf(v));
  }
  return [...[...kinds].map(([name, k]) => ({ name, type: k.size ? merged(k) : "VARCHAR" })), { name: EXTRA, type: "JSON" }];
}

const fits = (type: string, v: unknown) => (type === "BIGINT" ? Number.isSafeInteger(v) : type === "DOUBLE" ? typeof v === "number" : type === "BOOLEAN" ? typeof v === "boolean" : type === "TIMESTAMP" ? v instanceof Date : true);

/**
 * One document as a row. A field outside `known`, or a value that doesn't fit its column, moves to EXTRA instead of failing or being lost.
 * `withheld` names fields with a rule other than keep: those never reach EXTRA, or a later sample that misses one would copy it unmasked.
 */
export function rowOf(doc: Doc, columns: Column[], known: Set<string>, withheld: Set<string> = new Set()): (string | null)[] {
  const extra: Doc = {}, wanted = new Map(columns.map((c) => [c.name, c.type]));
  const out = new Map<string, string | null>();
  for (const [k, v] of Object.entries(doc)) {
    if (v == null) continue;
    const type = wanted.get(k);
    if (type && k !== EXTRA && fits(type, v)) { out.set(k, type === "JSON" ? JSON.stringify(v) : toText(v)); continue; }
    // A known field that wasn't asked for was left out on purpose
    if (withheld.has(k.toLowerCase()) || (!type && known.has(k))) continue;
    extra[k] = v;
  }
  return columns.map((c) => (c.name === EXTRA ? (Object.keys(extra).length ? JSON.stringify(extra) : null) : out.get(c.name) ?? null));
}

/** Up to 50 values of a column from a sample already held, as text. Nested values as JSON, so their fields get scanned. */
export const sampleOf = (docs: Doc[], column: string) => docs.flatMap((d) => (d[column] == null ? [] : [toText(d[column])])).slice(0, 50);

/** A saved cursor value in the type of its column, for sources that compare by type. */
export function cursorValue(type: string | undefined, after: string): string | number | Date | boolean {
  if (type === "BIGINT" || type === "DOUBLE" || type === "INTEGER") { const n = Number(after); if (Number.isNaN(n)) throw new Error("The saved cursor value isn't a number. Run a full refresh."); return n; }
  if (type === "TIMESTAMP") { const d = new Date(/[zZ]|[+-]\d\d(:?\d\d)?$/.test(after) ? after : `${after.replace(" ", "T")}Z`); if (Number.isNaN(+d)) throw new Error("The saved cursor value isn't a time. Run a full refresh."); return d; }
  return type === "BOOLEAN" ? after === "true" : after;
}
