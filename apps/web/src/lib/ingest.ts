import type { Rule } from "./types.ts";

export const MAX_BODY = 10 * 1024 * 1024, MAX_EVENTS = 50000, MAX_COLUMNS = 300, MAX_DEPTH = 5;

export type Kind = "int" | "float" | "bool" | "time" | "text" | "list";
export type Flat = { row: Record<string, string | null>; kinds: Record<string, Kind> };

/** One JSON object, a JSON array of objects, or one object per line. */
export function parseEvents(text: string): Record<string, unknown>[] {
  const t = text.trim();
  if (!t) throw new Error("Send at least one event.");
  let list: unknown[];
  if (t[0] === "[") {
    try { list = JSON.parse(t) as unknown[]; } catch { throw new Error("The body isn't valid JSON."); }
  } else {
    try { list = [JSON.parse(t)]; } catch {
      list = t.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
        try { return JSON.parse(l) as unknown; } catch { throw new Error(`Line ${i + 1} isn't valid JSON.`); }
      });
    }
  }
  if (!list.length) throw new Error("Send at least one event.");
  if (list.length > MAX_EVENTS) throw new Error(`Send at most ${MAX_EVENTS.toLocaleString("en-US")} events in one request.`);
  list.forEach((e, i) => { if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`Event ${i + 1} isn't a JSON object.`); });
  return list as Record<string, unknown>[];
}

/** Lowercase snake case, so "firstName" and "first_name" are one column and personal data checks can read the name. */
export function columnName(key: string) {
  const name = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/\W+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100) || "field";
  if (name.startsWith("basalt_")) throw new Error(`The field ${key} uses a reserved name.`);
  return /^\d/.test(name) ? `f_${name}` : name;
}

const TIME = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/;
const kindOfValue = (v: unknown): Kind => typeof v === "boolean" ? "bool" : typeof v === "number" ? (Number.isSafeInteger(v) ? "int" : "float") : typeof v === "string" && TIME.test(v) ? "time" : "text";

/**
 * Nested objects become columns such as customer_email, so the personal data checks see every field by name. A list stays one
 * JSON column, and the checks read inside it.
 */
export function flatten(event: Record<string, unknown>): Flat {
  const out: Flat = { row: {}, kinds: {} };
  const walk = (o: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      const name = prefix + columnName(k);
      if (v && typeof v === "object" && !Array.isArray(v) && depth < MAX_DEPTH) { walk(v as Record<string, unknown>, `${name}_`, depth + 1); continue; }
      if (v == null) { out.row[name] ??= null; continue; }
      if (typeof v === "object") { out.row[name] = JSON.stringify(v); out.kinds[name] = "list"; continue; }
      out.row[name] = String(v);
      out.kinds[name] = kindOfValue(v);
    }
  };
  walk(event, "", 0);
  return out;
}

/** A column seen with two kinds of value widens to whatever holds both. */
export const mergeKind = (a: Kind | undefined, b: Kind): Kind => !a || a === b ? b : a === "list" || b === "list" ? "list" : (a === "int" && b === "float") || (a === "float" && b === "int") ? "float" : "text";

export const duckType = (kind: Kind): string => ({ int: "BIGINT", float: "DOUBLE", bool: "BOOLEAN", time: "TIMESTAMP", text: "VARCHAR", list: "VARCHAR" })[kind];
/** The column's type in the warehouse once its rule has been applied. */
export const storedType = (kind: Kind, rule: Rule | undefined) => rule === "hash" || rule === "mask" ? "VARCHAR" : rule === "month" ? "DATE" : duckType(kind);

export const streamName = (s: string) => s.trim().toLowerCase().replace(/\W+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
