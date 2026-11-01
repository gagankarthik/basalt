import type { Rule } from "./types.ts";
import { q, lit } from "./sql.ts";

const NAME: [RegExp, string, Rule][] = [
  [/(^|_)(ssn|social_?security|ein|tax_?id|itin|passport|drivers?_?license)($|_|_?(no|num|number)$)/i, "Government ID", "drop"],
  [/(bank_?acc|account_?(no|num)|routing_?(no|num)|iban|card_?(no|num)|cvv)/i, "Financial account", "drop"],
  [/(e_?mail)/i, "Email address", "hash"],
  [/(phone|mobile|(^|_)cell($|_)|(^|_)fax($|_)|contact_?no)/i, "Phone number", "mask"],
  [/(address|street|pincode|zip|postal_?code|landmark)/i, "Postal address", "drop"],
  [/(^|_)(full_?name|first_?name|last_?name|surname|customer_?name|contact_?name|user_?name|person_?name|employee_?name|patient_?name|member_?name|client_?name)($|_)/i, "Person name", "mask"],
  [/(dob|birth_?date|date_?of_?birth)/i, "Date of birth", "month"],
  [/(^|_)(ip_?addr|ip)($|_)/i, "IP address", "hash"],
  [/(password|passwd|secret|api_?key|token)/i, "Credential", "drop"],
];
const VALUE: [RegExp, string, Rule][] = [
  [/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i, "Email address", "hash"],
  [/^\d{3}-\d{2}-\d{4}$/, "Government ID", "drop"],
  [/^(\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/, "Phone number", "mask"],
  [/^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}$/, "Financial account", "drop"],
];

export type PiiFinding = { kind: string; rule: Rule; path?: string };
const flatName = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/\W+/g, "_");
const byName = (name: string) => { const n = flatName(name); return NAME.find(([re]) => re.test(n)); };

// Inside nested data one match is enough, and the value can sit inside longer text.
const EMBEDDED: [RegExp, string][] = [
  [/[^\s@"'<>,;:()[\]{}=]+@[^\s@"'<>,;:()[\]{}=]+\.[a-z]{2,}/i, "Email address"],
  [/(^|\D)\d{3}-\d{2}-\d{4}($|\D)/, "Government ID"],
  [/(^|\D)\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}($|\D)/, "Financial account"],
  [/(^|[^\d-])\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}($|[^\d-])/, "Phone number"],
];
const inText = (s: string) => EMBEDDED.find(([re]) => re.test(s))?.[1];
const inValue = (s: string) => VALUE.find(([re]) => re.test(s))?.[1];
const STRUCTURED = /^\s*[{[<]|^\s*\(.*,|^\s*"[^"]*"\s*=>/;
/** Picks out values that might be nested data, so a scan of every row can skip the plain ones. Wider than STRUCTURED on purpose. */
export const STRUCTURED_SQL = `^\\s*[{\\[<("]`;
const MAX_DEPTH = 200;

/** Checks one value holding nested data: every key path and every value. Anything it can't finish reading counts as found. */
export function findInNested(column: string, text: string, seen = new Set<string>()): PiiFinding | null {
  const hit = (kind: string, path: string): PiiFinding => ({ kind, rule: "drop", path });
  const key = (flat: string, shown: string) => {
    if (seen.has(flat)) return null;
    const found = byName(flat);
    if (found) return hit(found[1], shown);
    seen.add(flat);
    return null;
  };
  const walk = (v: unknown, flat: string, shown: string, depth: number): PiiFinding | null => {
    if (depth > MAX_DEPTH) return hit("Nested too deeply to check", shown);
    if (Array.isArray(v)) { for (const x of v) { const f = walk(x, flat, `${shown}[]`, depth + 1); if (f) return f; } return null; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const f2 = `${flat}_${k}`, s2 = `${shown}.${k}`, f = key(f2, s2) ?? walk(x, f2, s2, depth + 1);
        if (f) return f;
      }
      return null;
    }
    if (typeof v === "number") { const kind = inValue(String(v)); return kind ? hit(kind, shown) : null; }
    if (typeof v !== "string") return null;
    if (STRUCTURED.test(v)) return read(v, flat, shown, depth + 1);
    const kind = inText(v) ?? inValue(v.trim());
    return kind ? hit(kind, shown) : null;
  };
  const read = (s: string, flat: string, shown: string, depth: number): PiiFinding | null => {
    let doc: unknown;
    try { doc = JSON.parse(s); } catch {
      // Not JSON: XML, DuckDB's print of a STRUCT, hstore, or an array literal. Names are read from the text itself.
      for (const m of s.matchAll(/<\/?\s*([\w:.-]+)|["']?([\w.:-]+)["']?\s*(?:=>|:|=)/g)) { const name = m[1] ?? m[2], f = key(`${flat}_${name}`, `${shown}.${name}`); if (f) return f; }
      const kind = inText(s);
      return kind ? hit(kind, shown) : null;
    }
    return walk(doc, flat, shown, depth);
  };
  try { return read(text, column, column, 0); } catch { return hit("Nested too deeply to check", column); }
}

/** The same check for any column's value: plain values aren't nested data and return null. */
export const scanStructured = (column: string, value: string, seen?: Set<string>) => (STRUCTURED.test(value) ? findInNested(column, value, seen) : null);

/** Column name first; sampled values catch columns with unhelpful names such as "contact" or "field_7". */
export function detectPii(name: string, samples: (string | null)[] = []): PiiFinding | null {
  const named = byName(name);
  if (named) return { kind: named[1], rule: named[2] };
  const vals = samples.filter((s): s is string => !!s), seen = new Set<string>();
  for (const v of vals) { const f = scanStructured(name, v, seen); if (f) return f; }
  if (vals.length < 3) return null;
  for (const [re, kind, rule] of VALUE) if (vals.filter((v) => re.test(v.trim())).length / vals.length >= 0.8) return { kind, rule };
  return null;
}
/** How a finding reads on screen. */
export const piiLabel = (f: PiiFinding | null) => (f ? (f.path ? `${f.kind} in ${f.path}` : f.kind) : null);

/** For rows that arrive a few at a time: with too few values to judge, what's there counts for the whole sample, so one email is enough to hold a column back. */
export const detectLive = (name: string, values: (string | null)[]) => {
  const v = values.filter((s): s is string => !!s);
  return detectPii(name, v.length && v.length < 3 ? [...v, ...v, ...v] : v);
};

export const RULE_LABELS: Record<Rule, string> = { keep: "Keep as is", mask: "Mask characters", hash: "Replace with a code", month: "Round date to month", drop: "Leave out" };

/** SELECT expression for one column; null means the column is not copied. */
export function maskExpr(col: string, rule: Rule | undefined, salt: string): string | null {
  const c = q(col), s = `CAST(${c} AS VARCHAR)`;
  switch (rule ?? "keep") {
    case "keep": return c;
    case "drop": return null;
    case "hash": return `CASE WHEN ${c} IS NULL THEN NULL ELSE 'id_' || left(sha256(${lit(salt)} || ${s}), 12) END AS ${c}`;
    case "month": return `date_trunc('month', TRY_CAST(${c} AS DATE))::DATE AS ${c}`;
    case "mask": return `CASE WHEN ${c} IS NULL THEN NULL WHEN length(${s}) <= 4 THEN repeat('•', length(${s})) ELSE left(${s}, 2) || repeat('•', length(${s}) - 4) || right(${s}, 2) END AS ${c}`;
  }
}
