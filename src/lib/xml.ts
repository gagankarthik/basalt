import { XMLParser, XMLValidator } from "fast-xml-parser";

type Row = Record<string, unknown>;

/** Parsing holds the whole document in memory, at many times its size, so this is lower than the limit for other files. */
export const MAX_XML_BYTES = 100 * 1024 * 1024;
export const XML_TOO_LARGE = "XML files can be up to 100 MB, because they're read into memory. Split this file, or convert it to JSON lines, which can be up to 500 MB.";

const TEXT = "#text", ATTR = "@";
const column = (k: string) => k.replace(/\W+/g, "_").replace(/^_+/, "") || "value";
// Attribute and element names share one set of columns, so a clash gets a prefix rather than losing a value
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (typeof v === "string") return v.trim();
  if (!v || typeof v !== "object") return v;
  const out: Row = {}, entries = Object.entries(v as Row);
  const put = (name: string, val: unknown) => { let n = name, i = 2; while (n in out) n = `${name}_${i++}`; out[n] = val; };
  for (const [k, x] of entries) if (k !== TEXT && !k.startsWith(ATTR)) put(column(k), clean(x));
  for (const [k, x] of entries) if (k.startsWith(ATTR)) { const n = column(k.slice(ATTR.length)); put(n in out ? `attr_${n}` : n, clean(x)); }
  // Text between child elements keeps its words but not its place among them
  if (TEXT in (v as Row)) { const t = String((v as Row)[TEXT]).replace(/\s+/g, " ").trim(); if (t) put("value" in out ? "text_value" : "value", t); }
  return out;
}

/** Counts what sits under a node, so the record is the repeating element that holds most of the document, not its children. */
function weigh(n: unknown, best: { size: number; items: unknown[] }): number {
  if (Array.isArray(n)) {
    const size = n.reduce<number>((a, x) => a + weigh(x, best), n.length);
    if (n.some((x) => x && typeof x === "object") && size > best.size) { best.size = size; best.items = n; }
    return size;
  }
  return n && typeof n === "object" ? Object.values(n).reduce<number>((a, x) => a + 1 + weigh(x, best), 0) : 0;
}

/** Finds the repeating element that is the document's table and returns one row per item, keeping nested elements and repeats as objects and arrays. */
export function xmlRows(text: string): Row[] {
  if (Buffer.byteLength(text) > MAX_XML_BYTES) throw new Error(XML_TOO_LARGE);
  // Never expanded or fetched: entity declarations are how XML reads server files and how expansion bombs work
  if (/<!DOCTYPE/i.test(text) && /<!DOCTYPE[^>]*\[/i.test(text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, ""))) throw new Error("This XML file declares its own entities in a DOCTYPE, which Basalt doesn't read for safety. Remove the DOCTYPE and import it again.");
  const valid = XMLValidator.validate(text, { allowBooleanAttributes: true });
  if (valid !== true) throw new Error(`This XML file isn't valid: ${valid.err.msg} (line ${valid.err.line}).`);
  let doc: Row;
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: ATTR, textNodeName: TEXT, parseTagValue: false, parseAttributeValue: false, processEntities: true, trimValues: false, allowBooleanAttributes: true, ignoreDeclaration: true, ignorePiTags: true }).parse(text) as Row;
  } catch (e) {
    throw new Error(/nested/i.test(String(e)) ? "This XML file is nested more than 100 levels deep, which Basalt doesn't read." : `This XML file can't be read: ${e instanceof Error ? e.message : e}`);
  }
  const best = { size: 0, items: [] as unknown[] };
  weigh(doc, best);
  const blank = (x: unknown) => typeof x === "string" && !x.trim();
  const items = best.items.length ? best.items.filter((x) => !blank(x)) : Object.values(doc).filter((x) => x && typeof x === "object").slice(0, 1); // no repeats: one record
  return items.map((x) => (x && typeof x === "object" ? clean(x) as Row : { value: String(x).trim() }));
}

const esc = (v: unknown) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tag = (name: string) => (/^[A-Za-z_]/.test(name) ? name : `_${name}`).replace(/[^\w.-]/g, "_");
export const xmlRow = (row: Row) => `<row>${Object.entries(row).filter(([, v]) => v != null).map(([k, v]) => `<${tag(k)}>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</${tag(k)}>`).join("")}</row>`;
