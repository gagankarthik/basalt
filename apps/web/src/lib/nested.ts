import { lit, q } from "./sql.ts";

export const isNestedType = (type: string) => /^(JSON$|STRUCT\s*\(|MAP\s*\(|UNION\s*\()|\[\d*\]$/i.test(type.trim());

/** How a column travels as text. JSON, because DuckDB's own print of a STRUCT or list isn't reliably read back. */
// A JSON column is already JSON text, and a database reader can hand it over as VARCHAR, which to_json would encode a second time
export const asTextSql = (name: string, type: string) => `CAST(${isNestedType(type) && !/^JSON$/i.test(type.trim()) ? `to_json(${q(name)})` : q(name)} AS VARCHAR) AS ${q(name)}`;
/** The reverse of asTextSql: a value that doesn't fit comes back empty. */
export const fromTextSql = (name: string, type: string) => {
  const c = q(name), t = type.trim();
  if (/^JSON$/i.test(t)) return `TRY_CAST(${c} AS JSON)`;
  return isNestedType(t) ? `TRY_CAST(TRY_CAST(${c} AS JSON) AS ${t})` : `TRY_CAST(${c} AS ${t})`;
};

/** "customer.email", "$.items[0].sku" or `"first name".x` as a quoted JSON path. Null when it isn't one, so it never reaches SQL. */
export function jsonPath(input: string): string | null {
  let s = input.trim().replace(/^\$\.?/, ""), out = "$";
  while (s) {
    const m = /^\.?(?:"([^"\\]+)"|([^.[\]"'\s\\]+))?((?:\[\d+\])*)/.exec(s);
    if (!m || !m[0]) return null;
    const key = m[1] ?? m[2];
    if (key) out += `."${key}"`;
    out += m[3];
    s = s.slice(m[0].length);
  }
  return out;
}

export type LeafType = "VARCHAR" | "BIGINT" | "DOUBLE" | "BOOLEAN" | "JSON";
export type Leaves = Map<string, { path: string[]; kinds: Set<LeafType> }>;

/** Records every field a value holds. Arrays stay whole as JSON: one row can't become a column per item. */
export function collectLeaves(leaves: Leaves, value: unknown, path: string[] = []) {
  const at = (kind?: LeafType) => { const k = JSON.stringify(path); if (!leaves.has(k)) leaves.set(k, { path, kinds: new Set() }); if (kind) leaves.get(k)!.kinds.add(kind); };
  if (value == null) { at(); return; }
  if (Array.isArray(value)) { at("JSON"); return; }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      // Such a key can't be written in a path, so the field stays together rather than being lost
      if (/["\\]/.test(k)) at("JSON"); else collectLeaves(leaves, v, [...path, k]);
    }
    return;
  }
  at(typeof value === "boolean" ? "BOOLEAN" : typeof value === "string" ? "VARCHAR" : Number.isInteger(value) ? "BIGINT" : "DOUBLE");
}

const leafType = (kinds: Set<LeafType>): LeafType => {
  if (kinds.has("JSON")) return "JSON";
  if (kinds.size === 1) return [...kinds][0];
  return kinds.size === 2 && kinds.has("BIGINT") && kinds.has("DOUBLE") ? "DOUBLE" : "VARCHAR";
};

export const leafName = (to: string, path: string[]) => [to, ...path].join("_").replace(/\W+/g, "_").replace(/_+$/, "");

/** SELECT items for a flattened column. `taken` holds names already in use, and a clash gets a number. */
export function flattenSql(col: string, to: string, leaves: Leaves, taken: Set<string>) {
  const src = `to_json(${q(col)})`;
  return [...leaves.values()].map(({ path, kinds }) => {
    const p = lit(`$${path.map((k) => `."${k}"`).join("")}`), type = leafType(kinds);
    const base = leafName(to, path);
    let name = base, n = 2;
    while (taken.has(name.toLowerCase())) name = `${base}_${n++}`;
    taken.add(name.toLowerCase());
    const expr = type === "JSON" ? `json_extract(${src}, ${p})` : type === "VARCHAR" ? `json_extract_string(${src}, ${p})` : `TRY_CAST(json_extract_string(${src}, ${p}) AS ${type})`;
    return `${expr} AS ${q(name)}`;
  });
}

/** A PostgreSQL array literal, as logical replication sends it, as JSON text. Null when it isn't one. */
export function pgArrayJson(text: string): string | null {
  let i = 0;
  const array = (): unknown[] => {
    const out: unknown[] = [];
    i++;
    if (text[i] === "}") { i++; return out; }
    for (;;) {
      if (text[i] === "{") out.push(array());
      else if (text[i] === '"') {
        let s = "";
        for (i++; text[i] !== '"'; i++) { if (i >= text.length) throw new Error("open quote"); if (text[i] === "\\") i++; s += text[i]; }
        i++;
        out.push(s);
      } else {
        const start = i;
        while (i < text.length && text[i] !== "," && text[i] !== "}") i++;
        const raw = text.slice(start, i);
        out.push(raw === "NULL" ? null : raw);
      }
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      throw new Error("bad array");
    }
  };
  try {
    if (text[0] !== "{") return null;
    const out = array();
    return i === text.length ? JSON.stringify(out) : null;
  } catch { return null; }
}

/** A cell's value on one line: objects as JSON, never "[object Object]". */
export const cellText = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Indented JSON when a cell holds nested data, including JSON stored as text. Null for anything else. */
export function prettyNested(v: unknown): string | null {
  if (v && typeof v === "object") return JSON.stringify(v, null, 2);
  if (typeof v !== "string" || !/^\s*[{[]/.test(v)) return null;
  try { const d = JSON.parse(v); return d && typeof d === "object" ? JSON.stringify(d, null, 2) : null; } catch { return null; }
}
