import { evalFormula, FormulaError, parseFormula, text as fText, type FValue } from "./formula.ts";

export type FieldType = "text" | "longText" | "number" | "currency" | "percent" | "duration" | "rating" | "checkbox" | "select" | "multiSelect" | "date" | "email" | "url" | "phone" | "user" | "link" | "lookup" | "rollup" | "count" | "attachment" | "button" | "barcode" | "formula" | "autonumber" | "createdTime" | "modifiedTime" | "createdBy" | "modifiedBy";
export type Choice = { id: string; name: string; color: string };
export type Field = {
  id: string; name: string; type: FieldType; description?: string;
  choices?: Choice[]; precision?: number; symbol?: string; max?: number; includeTime?: boolean;
  /** link: table it points to and its matching field there. lookup, rollup, count: the link field used and the field read through it. */
  url?: string; label?: string; linkTable?: string; inverse?: string; viaField?: string; readField?: string; rollup?: string; expr?: string;
};
export type Rec = { id: string; cells: Record<string, unknown>; auto: number; createdAt: string; createdBy: string; modifiedAt: string; modifiedBy: string; comments: { id: string; at: string; by: string; text: string }[]; history: { at: string; by: string; field: string; from: string; to: string }[] };
export type FilterOp = "contains" | "notContains" | "is" | "isNot" | "empty" | "notEmpty" | "gt" | "lt" | "gte" | "lte" | "anyOf";
export type BaseFilter = { id: string; field: string; op: FilterOp; value?: string };
export type ViewType = "grid" | "kanban" | "gallery" | "calendar" | "timeline" | "form";
export type Attachment = { id: string; name: string; size: number; type: string };
export type InterfaceElement = { id: string; type: "number" | "chart" | "list"; title: string; table: string; view?: string; field?: string; measure?: string; agg?: string };
export type BaseExtension = { id: string; name: string; code: string; canWrite: boolean };
export type BaseInterface = { id: string; name: string; elements: InterfaceElement[] };
export type BaseView = {
  id: string; name: string; type: ViewType; hidden: string[]; order: string[]; widths: Record<string, number>; filters: BaseFilter[]; match: "all" | "any"; sorts: { field: string; dir: "asc" | "desc" }[];
  groupBy?: string; colorBy?: string; rowHeight?: "short" | "medium" | "tall" | "extra"; frozen?: number; stackBy?: string; dateField?: string; endField?: string; locked?: boolean; owner?: string; coverField?: string; summaries?: Record<string, string>;
  form?: { title: string; description: string; fields: string[]; required: string[]; shareId?: string; thanks?: string };
};
export type Table = { id: string; name: string; fields: Field[]; views: BaseView[]; records: Rec[]; nextAuto?: number; sync?: { base: string; table: string; view?: string; at?: string; version?: number; error?: string } };
export type Automation = {
  id: string; name: string; on: boolean; table: string; trigger: "created" | "updated" | "matches" | "form" | "schedule" | "webhook"; every?: number; lastAt?: string; hookId?: string; condition?: BaseFilter;
  actions: { id: string; type: "update" | "create" | "webhook" | "alert" | "script" | "email" | "find"; to?: string; subject?: string; find?: BaseFilter; code?: string; table?: string; cells?: Record<string, string>; url?: string; message?: string }[];
  runs: { at: string; ok: boolean; detail: string; record?: string }[];
};
export type Base = { id: string; name: string; color?: string; slug: string; version: number; nextAuto: number; publish: boolean; tables: Table[]; automations: Automation[]; interfaces?: BaseInterface[]; extensions?: BaseExtension[]; updatedAt: string; createdBy: string };
export type Op =
  | { kind: "renameBase"; name: string; color?: string } | { kind: "publish"; on: boolean }
  | { kind: "addTable"; table: Table } | { kind: "renameTable"; id: string; name: string } | { kind: "deleteTable"; id: string }
  | { kind: "addField"; table: string; field: Field; inverseName?: string; inverseId?: string } | { kind: "updateField"; table: string; id: string; patch: Partial<Field> } | { kind: "deleteField"; table: string; id: string }
  | { kind: "addRecords"; table: string; records: { id: string; cells: Record<string, unknown> }[] } | { kind: "setCells"; table: string; updates: { id: string; cells: Record<string, unknown> }[] } | { kind: "deleteRecords"; table: string; ids: string[] } | { kind: "restoreRecords"; table: string; records: Rec[] }
  | { kind: "comment"; table: string; record: string; id: string; text: string }
  | { kind: "addView"; table: string; view: BaseView } | { kind: "updateView"; table: string; id: string; patch: Partial<BaseView> } | { kind: "deleteView"; table: string; id: string }
  | { kind: "saveExtension"; extension: BaseExtension } | { kind: "deleteExtension"; id: string }
  | { kind: "saveInterface"; page: BaseInterface } | { kind: "deleteInterface"; id: string }
  | { kind: "saveAutomation"; automation: Automation } | { kind: "deleteAutomation"; id: string };

export const TYPE_LABEL: Record<FieldType, string> = { text: "Single line text", longText: "Long text", number: "Number", currency: "Currency", percent: "Percent", duration: "Duration", rating: "Rating", checkbox: "Checkbox", select: "Single select", multiSelect: "Multiple select", date: "Date", email: "Email", url: "URL", phone: "Phone number", user: "User", attachment: "Attachment", button: "Button", barcode: "Barcode", link: "Link to another record", lookup: "Lookup", rollup: "Rollup", count: "Count", formula: "Formula", autonumber: "Autonumber", createdTime: "Created time", modifiedTime: "Last modified time", createdBy: "Created by", modifiedBy: "Last modified by" };
const COMPUTED: FieldType[] = ["button", "lookup", "rollup", "count", "formula", "autonumber", "createdTime", "modifiedTime", "createdBy", "modifiedBy"];
export const isComputed = (t: FieldType) => COMPUTED.includes(t);
export const CHOICE_COLORS = ["blue", "cyan", "teal", "green", "yellow", "orange", "red", "pink", "purple", "gray"];
export const MAX_RECORDS = 50000;
export const ROLLUPS: [string, string][] = [["SUM", "Sum"], ["AVERAGE", "Average"], ["MAX", "Highest"], ["MIN", "Lowest"], ["COUNT", "Count numbers"], ["COUNTA", "Count filled"], ["ARRAYJOIN", "Join as text"], ["ARRAYUNIQUE", "Unique values"], ["AND", "All true"], ["OR", "Any true"]];

const tableOf = (b: Base, id: string) => b.tables.find((t) => t.id === id) ?? bad("This table no longer exists.");
const fieldOf = (t: Table, id: string) => t.fields.find((f) => f.id === id) ?? bad("This field no longer exists.");
function bad(m: string): never { throw new Error(m); }

/** Turns whatever was typed or pasted into what the field stores. Values that don't fit become empty rather than wrong. */
export function coerce(f: Field, v: unknown): unknown {
  if (f.type === "attachment") return Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && "id" in x) : [];
  if (v === "" || v == null) return f.type === "checkbox" ? false : null;
  const s = Array.isArray(v) ? v.join(", ") : String(v).trim();
  switch (f.type) {
    case "number": case "currency": case "duration": { const n = Number(s.replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : null; }
    case "percent": { const n = Number(s.replace(/[%,\s]/g, "")); return Number.isFinite(n) ? n : null; }
    case "rating": { const n = Math.round(Number(s)); return Number.isFinite(n) && n > 0 ? Math.min(n, f.max ?? 5) : null; }
    case "checkbox": return v === true || /^(1|true|yes|y|on|checked|x)$/i.test(s);
    case "select": return f.choices?.find((c) => c.name.toLowerCase() === s.toLowerCase() || c.id === s)?.id ?? null;
    case "multiSelect": { const parts = Array.isArray(v) ? v.map(String) : s.split(/\s*,\s*/); return [...new Set(parts.map((p) => f.choices?.find((c) => c.name.toLowerCase() === p.toLowerCase() || c.id === p)?.id).filter(Boolean))]; }
    case "date": { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : f.includeTime ? d.toISOString() : d.toISOString().slice(0, 10); }
    case "link": return Array.isArray(v) ? [...new Set(v.map(String))] : s ? [s] : [];
    case "email": return /^\S+@\S+$/.test(s) ? s : null;
    default: return s;
  }
}

function linkSync(b: Base, t: Table, f: Field, recId: string, before: string[], after: string[]) {
  if (f.type !== "link" || !f.linkTable || !f.inverse) return;
  const other = tableOf(b, f.linkTable);
  for (const id of after.filter((x) => !before.includes(x))) { const r = recById(other, id); if (r) r.cells[f.inverse] = [...new Set([...((r.cells[f.inverse] as string[]) ?? []), recId])]; }
  for (const id of before.filter((x) => !after.includes(x))) { const r = recById(other, id); if (r) r.cells[f.inverse] = ((r.cells[f.inverse] as string[]) ?? []).filter((x) => x !== recId); }
}
const show = (f: Field, v: unknown) => (f.type === "attachment" ? ((v as Attachment[]) ?? []).map((a) => a.name).join(", ") : f.type === "select" ? f.choices?.find((c) => c.id === v)?.name ?? "" : f.type === "multiSelect" ? ((v as string[]) ?? []).map((id) => f.choices?.find((c) => c.id === id)?.name ?? "").join(", ") : Array.isArray(v) ? v.join(", ") : String(v ?? ""));

function writeCells(b: Base, t: Table, r: Rec, cells: Record<string, unknown>, by: string, at: string, log: boolean) {
  for (const [fid, raw] of Object.entries(cells)) {
    const f = t.fields.find((x) => x.id === fid);
    if (!f || isComputed(f.type)) continue;
    const next = coerce(f, raw), old = r.cells[fid];
    if (JSON.stringify(next ?? null) === JSON.stringify(old ?? null)) continue;
    if (f.type === "link") {
      const linked = tableOf(b, f.linkTable!), ok = (next as string[]).filter((id) => !!recById(linked, id));
      linkSync(b, t, f, r.id, (old as string[]) ?? [], ok);
      r.cells[fid] = ok;
    } else r.cells[fid] = next;
    if (log) { r.history.unshift({ at, by, field: f.name, from: show(f, old), to: show(f, r.cells[fid]) }); r.history.length = Math.min(r.history.length, 50); }
    r.modifiedAt = at; r.modifiedBy = by;
  }
}

/** The single place a base changes. The browser runs it for an instant result, and the server runs it to decide what's true. */
export function applyOp(b: Base, op: Op, by: string, at: string) {
  // A synced table mirrors its source, so changes are made there. Views and comments still belong to this base.
  if (["addField", "updateField", "deleteField", "addRecords", "setCells", "deleteRecords", "restoreRecords"].includes(op.kind) && b.tables.find((t) => t.id === (op as { table?: string }).table)?.sync) bad("This table is synced from another base. Change it there.");
  switch (op.kind) {
    case "renameBase": b.name = op.name.trim() || b.name; if (op.color) b.color = op.color; break;
    case "publish": b.publish = !!op.on; break;
    case "addTable": if (b.tables.some((t) => t.id === op.table.id)) bad("That table already exists."); b.tables.push(op.table); break;
    case "renameTable": tableOf(b, op.id).name = op.name.trim() || tableOf(b, op.id).name; break;
    case "deleteTable": {
      if (b.tables.length === 1) bad("A base needs at least one table.");
      for (const t of b.tables) if (t.id !== op.id) {
        const gone = t.fields.filter((f) => f.linkTable === op.id).map((f) => f.id);
        t.fields = t.fields.filter((f) => !gone.includes(f.id) && !gone.includes(f.viaField ?? ""));
      }
      b.tables = b.tables.filter((t) => t.id !== op.id);
      break;
    }
    case "addField": {
      const t = tableOf(b, op.table);
      if (t.fields.some((f) => f.name.toLowerCase() === op.field.name.toLowerCase())) bad(`A field named ${op.field.name} already exists.`);
      if (!op.field.name.trim()) bad("Name this field.");
      if (op.field.type === "formula") parseFormula(op.field.expr ?? "");
      t.fields.push(op.field);
      if (op.field.type === "link") {
        const other = tableOf(b, op.field.linkTable ?? bad("Choose a table to link to."));
        let name = op.inverseName || t.name; while (other.fields.some((f) => f.name === name)) name += " 2";
        const inv: Field = { id: op.inverseId ?? `${op.field.id}i`, name, type: "link", linkTable: t.id, inverse: op.field.id };
        other.fields.push(inv); op.field.inverse = inv.id;
        fieldOf(t, op.field.id).inverse = inv.id;
      }
      break;
    }
    case "updateField": {
      const t = tableOf(b, op.table), f = fieldOf(t, op.id), wasType = f.type;
      if (op.patch.name != null && t.fields.some((x) => x.id !== f.id && x.name.toLowerCase() === op.patch.name!.toLowerCase())) bad(`A field named ${op.patch.name} already exists.`);
      if (op.patch.expr != null) parseFormula(op.patch.expr);
      if (op.patch.type && op.patch.type !== wasType && f.type === "link") bad("Delete this link field instead of changing its type.");
      if (op.patch.type && t.fields[0]?.id === f.id && (op.patch.type === "link" || op.patch.type === "checkbox")) bad("The primary field can't be this type.");
      Object.assign(f, op.patch);
      if (op.patch.type && op.patch.type !== wasType) {
        const old: Field = { ...f, type: wasType };
        for (const r of t.records) { if (f.id in r.cells) { const v = isComputed(f.type) ? null : coerce(f, show(old, r.cells[f.id])); if (v == null) delete r.cells[f.id]; else r.cells[f.id] = v; } }
      }
      break;
    }
    case "deleteField": {
      const t = tableOf(b, op.table), f = fieldOf(t, op.id);
      if (t.fields[0].id === f.id) bad("The primary field can't be deleted.");
      const drop = (tb: Table, id: string) => { tb.fields = tb.fields.filter((x) => x.id !== id && x.viaField !== id); for (const r of tb.records) delete r.cells[id]; };
      drop(t, f.id);
      if (f.type === "link" && f.inverse && f.linkTable) drop(tableOf(b, f.linkTable), f.inverse);
      break;
    }
    case "addRecords": {
      const t = tableOf(b, op.table);
      if (t.records.length + op.records.length > MAX_RECORDS) bad(`A table can hold up to ${MAX_RECORDS.toLocaleString("en-US")} records.`);
      for (const n of op.records) {
        if (recById(t, n.id)) continue;
        const r: Rec = { id: n.id, cells: {}, auto: nextAuto(t), createdAt: at, createdBy: by, modifiedAt: at, modifiedBy: by, comments: [], history: [] };
        t.records.push(r);
        writeCells(b, t, r, n.cells, by, at, false);
      }
      break;
    }
    case "setCells": {
      const t = tableOf(b, op.table);
      for (const u of op.updates) { const r = recById(t, u.id); if (r) writeCells(b, t, r, u.cells, by, at, true); }
      break;
    }
    case "deleteRecords": {
      const t = tableOf(b, op.table), ids = new Set(op.ids);
      for (const r of t.records) if (ids.has(r.id)) for (const f of t.fields) if (f.type === "link") linkSync(b, t, f, r.id, (r.cells[f.id] as string[]) ?? [], []);
      t.records = t.records.filter((r) => !ids.has(r.id));
      break;
    }
    case "restoreRecords": {
      const t = tableOf(b, op.table);
      for (const r of op.records) {
        if (recById(t, r.id)) continue;
        t.records.push(r);
        for (const f of t.fields) if (f.type === "link") linkSync(b, t, f, r.id, [], (r.cells[f.id] as string[]) ?? []);
      }
      break;
    }
    case "comment": {
      const r = tableOf(b, op.table).records.find((x) => x.id === op.record) ?? bad("This record no longer exists.");
      if (!op.text.trim()) bad("Write a comment first.");
      r.comments.push({ id: op.id, at, by, text: op.text.trim().slice(0, 5000) });
      break;
    }
    case "addView": tableOf(b, op.table).views.push(op.view); break;
    case "updateView": { const t = tableOf(b, op.table), v = t.views.find((x) => x.id === op.id) ?? bad("This view no longer exists."); if (v.locked && !("locked" in op.patch)) bad("This view is locked. Unlock it to change it."); Object.assign(v, op.patch); break; }
    case "deleteView": { const t = tableOf(b, op.table); if (t.views.find((x) => x.id === op.id)?.locked) bad("This view is locked. Unlock it to delete it."); if (t.views.length === 1) bad("A table needs at least one view."); t.views = t.views.filter((v) => v.id !== op.id); break; }
    case "saveExtension": { const l = b.extensions ?? (b.extensions = []), i = l.findIndex((x) => x.id === op.extension.id); if (i >= 0) l[i] = op.extension; else l.push(op.extension); break; }
    case "deleteExtension": b.extensions = (b.extensions ?? []).filter((x) => x.id !== op.id); break;
    case "saveInterface": { const l = b.interfaces ?? (b.interfaces = []), i = l.findIndex((x) => x.id === op.page.id); if (i >= 0) l[i] = op.page; else l.push(op.page); break; }
    case "deleteInterface": b.interfaces = (b.interfaces ?? []).filter((x) => x.id !== op.id); break;
    case "saveAutomation": { const i = b.automations.findIndex((a) => a.id === op.automation.id); if (i >= 0) b.automations[i] = { ...op.automation, runs: b.automations[i].runs }; else b.automations.push({ ...op.automation, runs: [] }); break; }
    case "deleteAutomation": b.automations = b.automations.filter((a) => a.id !== op.id); break;
    default: bad("Basalt doesn't recognise that change.");
  }
  b.version++; b.updatedAt = at;
}

const recIndex = new WeakMap<Rec[], Map<string, Rec>>();
/** Records by id. Keyed on the array: records are only appended in place, and removing them makes a new array. */
export function recById(t: Table, id: string): Rec | undefined {
  let m = recIndex.get(t.records);
  if (!m) { m = new Map(); recIndex.set(t.records, m); }
  for (let i = m.size; i < t.records.length; i++) m.set(t.records[i].id, t.records[i]);
  return m.get(id);
}

/** Autonumbers count per table and are never reused, even after a delete. */
const nextAuto = (t: Table) => { const n = t.nextAuto ?? t.records.reduce((m, r) => Math.max(m, r.auto ?? 0), 0) + 1; t.nextAuto = n + 1; return n; };

export type Computed = { value: (r: Rec, f: Field) => unknown; display: (r: Rec, f: Field) => string; title: (r: Rec) => string; other: (tableId: string) => Computed | null };

/** Works out every cell on demand and remembers it. A formula that depends on itself shows an error rather than running forever. */
export function compute(b: Base, t: Table): Computed {
  const memo = new Map<string, unknown>(), running = new Set<string>(), parsed = new Map<string, ReturnType<typeof parseFormula> | Error>();
  const engines = new Map<string, Computed>([[t.id, null as unknown as Computed]]);
  const forTable = (id: string) => { if (id === t.id) return self; let e = engines.get(id); if (!e) { const o = b.tables.find((x) => x.id === id); if (!o) return null; e = compute(b, o); engines.set(id, e); } return e; };
  const value = (r: Rec, f: Field): unknown => {
    switch (f.type) {
      case "autonumber": return r.auto;
      case "createdTime": return r.createdAt;
      case "modifiedTime": return r.modifiedAt;
      case "createdBy": return r.createdBy;
      case "button": return f.label || f.name;
      case "modifiedBy": return r.modifiedBy;
      case "count": return ((r.cells[f.viaField ?? ""] as string[]) ?? []).length;
      case "lookup": case "rollup": case "formula": break;
      default: return r.cells[f.id] ?? null;
    }
    const key = `${r.id}.${f.id}`;
    if (memo.has(key)) return memo.get(key);
    if (running.has(key)) return { error: "This field depends on itself." };
    running.add(key);
    let out: unknown;
    try {
      if (f.type === "formula") {
        let p = parsed.get(f.id);
        if (!p) { try { p = parseFormula(f.expr ?? ""); } catch (e) { p = e as Error; } parsed.set(f.id, p); }
        if (p instanceof Error) throw p;
        out = evalFormula(p, { recordId: r.id, createdAt: r.createdAt, modifiedAt: r.modifiedAt, field: (name) => {
          const x = t.fields.find((y) => y.name.toLowerCase() === name.toLowerCase());
          if (!x) throw new FormulaError(`There's no field called ${name}.`);
          const v = value(r, x);
          if (v && typeof v === "object" && "error" in v) throw new FormulaError(String(v.error));
          if (x.type === "select") return x.choices?.find((c) => c.id === v)?.name ?? null;
          if (x.type === "multiSelect") return ((v as string[]) ?? []).map((id) => x.choices?.find((c) => c.id === id)?.name ?? "");
          if (x.type === "link") return ((v as string[]) ?? []).map((id) => { const o = b.tables.find((q) => q.id === x.linkTable); const rr = (o && recById(o, id)); return rr ? forTable(o!.id)!.title(rr) : ""; });
          if (x.type === "date" || x.type === "createdTime" || x.type === "modifiedTime") return v ? new Date(String(v)) : null;
          if (x.type === "checkbox") return v ? 1 : 0;
          if (x.type === "percent") return v == null ? null : Number(v) / 100;
          return v as FValue;
        } });
      } else {
        const via = t.fields.find((x) => x.id === f.viaField), o = b.tables.find((x) => x.id === via?.linkTable), read = o?.fields.find((x) => x.id === f.readField), e = o && forTable(o.id);
        if (!via || !o || !read || !e) out = { error: "Choose the link and field to read." };
        else {
          const vals = ((r.cells[via.id] as string[]) ?? []).map((id) => recById(o, id)).filter(Boolean).map((x) => (read.type === "select" || read.type === "multiSelect" || read.type === "link" ? e.display(x!, read) : e.value(x!, read)));
          if (f.type === "lookup") out = vals.flat();
          else {
            const n = vals.flat() as FValue[];
            out = evalFormula({ k: "call", name: f.rollup ?? "SUM", args: [{ k: "lit", v: n }] }, { recordId: r.id, createdAt: r.createdAt, modifiedAt: r.modifiedAt, field: () => null });
          }
        }
      }
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      out = { error: e.message };
    }
    running.delete(key); memo.set(key, out);
    return out;
  };
  const display = (r: Rec, f: Field): string => {
    const v = value(r, f);
    if (v == null) return "";
    if (typeof v === "object" && "error" in (v as object)) return "#ERROR";
    switch (f.type) {
      case "select": return f.choices?.find((c) => c.id === v)?.name ?? "";
      case "multiSelect": return (v as string[]).map((id) => f.choices?.find((c) => c.id === id)?.name ?? "").filter(Boolean).join(", ");
      case "link": { const o = b.tables.find((x) => x.id === f.linkTable), e = o && forTable(o.id); return (v as string[]).map((id) => { const rr = (o && recById(o, id)); return rr && e ? e.title(rr) : ""; }).filter(Boolean).join(", "); }
      case "attachment": return ((v as Attachment[]) ?? []).map((a) => a.name).join(", ");
      case "checkbox": return v ? "Checked" : "";
      case "currency": return `${f.symbol ?? "$"}${Number(v).toLocaleString("en-US", { minimumFractionDigits: f.precision ?? 2, maximumFractionDigits: f.precision ?? 2 })}`;
      case "percent": return `${Number(v).toLocaleString("en-US", { maximumFractionDigits: f.precision ?? 1 })}%`;
      case "number": return Number(v).toLocaleString("en-US", { maximumFractionDigits: f.precision ?? 4 });
      case "rating": return "★".repeat(Number(v));
      case "duration": { const s = Number(v), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h}:${String(m).padStart(2, "0")}`; }
      case "date": case "createdTime": case "modifiedTime": { const s = String(v), d = new Date(s); if (Number.isNaN(d.getTime())) return s; return f.type === "date" && !f.includeTime ? d.toLocaleDateString("en-US", { timeZone: "UTC" }) : d.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }); }
      default: {
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toLocaleString("en-US", { maximumFractionDigits: f.precision ?? 4 });
        return fText(v as FValue);
      }
    }
  };
  const title = (r: Rec) => display(r, t.fields[0]) || "Unnamed record";
  const self: Computed = { value, display, title, other: forTable };
  return self;
}

const sortKey = (c: Computed, r: Rec, f: Field): number | string => {
  const v = c.value(r, f);
  if (["number", "currency", "percent", "rating", "duration", "autonumber", "count"].includes(f.type) || typeof v === "number") return v == null || typeof v === "object" ? -Infinity : Number(v);
  if (f.type === "select") return f.choices?.findIndex((x) => x.id === v) ?? -1;
  if (f.type === "checkbox") return v ? 1 : 0;
  if (f.type === "date" || f.type === "createdTime" || f.type === "modifiedTime") return v ? new Date(String(v)).getTime() : -Infinity;
  return c.display(r, f).toLowerCase();
};
export function matches(c: Computed, t: Table, r: Rec, x: BaseFilter): boolean {
  const f = t.fields.find((y) => y.id === x.field);
  if (!f) return true;
  const d = c.display(r, f), want = (x.value ?? "").toLowerCase(), low = d.toLowerCase();
  switch (x.op) {
    case "empty": return d === "";
    case "notEmpty": return d !== "";
    case "contains": return !want || low.includes(want);
    case "notContains": return !want || !low.includes(want);
    case "isNot": return !want || low !== want;
    case "anyOf": return !want || want.split(",").some((w) => low.split(", ").includes(w.trim()));
    case "gt": case "lt": case "gte": case "lte": {
      if (!want) return true;
      const k = sortKey(c, r, f), raw = f.type === "date" || f.type === "createdTime" || f.type === "modifiedTime" ? new Date(x.value!).getTime() : Number(x.value);
      if (typeof k !== "number" || k === -Infinity) return false;
      return x.op === "gt" ? k > raw : x.op === "lt" ? k < raw : x.op === "gte" ? k >= raw : k <= raw;
    }
    default: return !want || low === want || (f.type === "checkbox" && (want === "true" || want === "checked") === !!c.value(r, f));
  }
}
/** The records a view shows, in order. */
export function viewRecords(c: Computed, t: Table, v: BaseView, search = ""): Rec[] {
  const q = search.trim().toLowerCase();
  let out = t.records.filter((r) => {
    if (v.filters.length) { const hit = (x: BaseFilter) => matches(c, t, r, x); if (v.match === "any" ? !v.filters.some(hit) : !v.filters.every(hit)) return false; }
    return !q || t.fields.some((f) => c.display(r, f).toLowerCase().includes(q));
  });
  const sorts = v.sorts.map((s) => ({ ...s, f: t.fields.find((x) => x.id === s.field) })).filter((s) => s.f);
  // Each key is worked out once: a sort compares about 16 times per record
  const keys = new Map(sorts.length ? out.map((r) => [r, sorts.map((s) => sortKey(c, r, s.f!))]) : []);
  if (sorts.length) out = [...out].sort((a, b) => { for (let i = 0; i < sorts.length; i++) { const s = sorts[i], x = keys.get(a)![i], y = keys.get(b)![i]; if (x !== y) return (x < y ? -1 : 1) * (s.dir === "desc" ? -1 : 1); } return a.auto - b.auto; });
  return out;
}
export const summarize = (fn: string, vals: unknown[]): string => {
  const n = vals.map(Number).filter((x, i) => vals[i] != null && vals[i] !== "" && !Number.isNaN(x)), filled = vals.filter((x) => x != null && x !== "" && !(Array.isArray(x) && !x.length)).length;
  const fmt = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  switch (fn) {
    case "sum": return fmt(n.reduce((a, b) => a + b, 0));
    case "avg": return n.length ? fmt(n.reduce((a, b) => a + b, 0) / n.length) : "";
    case "min": return n.length ? fmt(Math.min(...n)) : "";
    case "max": return n.length ? fmt(Math.max(...n)) : "";
    case "filled": return fmt(filled);
    case "empty": return fmt(vals.length - filled);
    case "unique": return fmt(new Set(vals.map((x) => JSON.stringify(x))).size);
    default: return "";
  }
};

export const newView = (id: string, name: string, type: ViewType, t?: Table): BaseView => ({ id, name, type, hidden: [], order: [], widths: {}, filters: [], match: "all", sorts: [], rowHeight: "short", frozen: 1, ...(type === "form" ? { form: { title: name, description: "", fields: (t?.fields ?? []).filter((f) => !isComputed(f.type) && f.type !== "link").map((f) => f.id), required: [] } } : {}) });
export const newTable = (id: string, name: string, ids: () => string): Table => {
  const f1: Field = { id: ids(), name: "Name", type: "text" };
  return { id, name, fields: [f1, { id: ids(), name: "Notes", type: "longText" }], records: [], views: [newView(ids(), "Grid view", "grid")] };
};
const FIELD_NAME = /[^\w]+/g;
/** Column names and text for the warehouse copy, so dashboards and SQL can use a base. */
export function warehouseColumns(t: Table) {
  const seen = new Set<string>();
  return t.fields.map((f) => {
    let name = f.name.toLowerCase().replace(FIELD_NAME, "_").replace(/^_+|_+$/g, "") || "field";
    if (/^\d/.test(name)) name = `f_${name}`;
    while (seen.has(name)) name += "_2";
    seen.add(name);
    const type = ["number", "currency", "percent", "duration", "rating", "count", "autonumber"].includes(f.type) ? "DOUBLE" : f.type === "checkbox" ? "BOOLEAN" : f.type === "date" || f.type === "createdTime" || f.type === "modifiedTime" ? "TIMESTAMP" : "VARCHAR";
    return { f, name, type };
  });
}
