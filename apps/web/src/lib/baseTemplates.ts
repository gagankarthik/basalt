import { applyOp, newTable, newView, type Base, type Field, type FieldType, type Table } from "./base.ts";

export const BASE_TEMPLATES: { id: string; name: string; note: string; icon: "base" | "board" | "people" | "dashboard" | "catalog" }[] = [
  { id: "starter", name: "Project tracker", note: "Tasks linked to projects, with a board and a calendar.", icon: "board" },
  { id: "crm", name: "Sales pipeline", note: "Deals by stage, with their value and close date.", icon: "people" },
  { id: "content", name: "Content calendar", note: "Pieces by status and channel, on a calendar.", icon: "dashboard" },
  { id: "inventory", name: "Inventory", note: "Items, categories, stock levels and suppliers.", icon: "catalog" },
  { id: "blank", name: "Blank table", note: "An empty table to build on your own.", icon: "base" },
];

type Spec = { table: string; fields: { name: string; type: FieldType; choices?: string[] }[]; records: (string | number)[][]; board?: string; calendar?: string };
/** Sample rows are the primary field, then each field in order. A date is a number of days from today. */
const SPECS: Record<string, Spec> = {
  crm: {
    table: "Deals", board: "Stage", calendar: "Close date",
    fields: [{ name: "Stage", type: "select", choices: ["Lead", "Proposal", "Won"] }, { name: "Value", type: "currency" }, { name: "Close date", type: "date" }, { name: "Contact email", type: "email" }],
    records: [["Harbor Foods renewal", "Proposal", 18000, 12, "ana@example.com"], ["Linden Hotels pilot", "Lead", 6500, 30, "sam@example.com"], ["Mesa Logistics", "Won", 42000, -4, "kai@example.com"]],
  },
  content: {
    table: "Content", board: "Status", calendar: "Publish date",
    fields: [{ name: "Status", type: "select", choices: ["Idea", "Drafting", "Published"] }, { name: "Channel", type: "select", choices: ["Blog", "Email", "Social"] }, { name: "Publish date", type: "date" }],
    records: [["Customer story", "Drafting", "Blog", 5], ["Product update", "Idea", "Email", 14], ["Launch recap", "Published", "Social", -2]],
  },
  inventory: {
    table: "Items", board: "Category",
    fields: [{ name: "Category", type: "select", choices: ["Packaging", "Ingredients", "Equipment"] }, { name: "In stock", type: "number" }, { name: "Reorder at", type: "number" }, { name: "Supplier", type: "text" }],
    records: [["Takeaway boxes", "Packaging", 1200, 400, "Northline Supply"], ["Olive oil, 5 L", "Ingredients", 18, 10, "Verde Foods"], ["Thermal bags", "Equipment", 35, 20, "Northline Supply"]],
  },
};
const COLORS = ["gray", "blue", "green"];

/** Null for a template this file doesn't build, so the caller decides what that means. */
export function templateTables(template: string, id: () => string, by: string, at: string): Table[] | null {
  const spec = Object.hasOwn(SPECS, template) ? SPECS[template] : null;
  if (!spec) return null;
  const t = newTable(id(), spec.table, id);
  const b: Base = { id: "", name: "", slug: "", version: 0, nextAuto: 1, publish: false, tables: [t], automations: [], updatedAt: at, createdBy: by };
  const fields: Field[] = spec.fields.map((f) => ({ id: id(), name: f.name, type: f.type, ...(f.choices ? { choices: f.choices.map((name, i) => ({ id: id(), name, color: COLORS[i % COLORS.length] })) } : {}) }));
  for (const field of fields) applyOp(b, { kind: "addField", table: t.id, field }, by, at);
  const byName = (name?: string) => fields.find((f) => f.name === name);
  if (spec.board) t.views.push({ ...newView(id(), "Board", "kanban"), stackBy: byName(spec.board)!.id });
  if (spec.calendar) t.views.push({ ...newView(id(), "Calendar", "calendar"), dateField: byName(spec.calendar)!.id });
  const value = (f: Field, v: string | number) => (f.type === "select" ? f.choices!.find((c) => c.name === v)!.id : f.type === "date" ? new Date(Date.parse(at) + Number(v) * 86400000).toISOString().slice(0, 10) : v);
  applyOp(b, { kind: "addRecords", table: t.id, records: spec.records.map(([name, ...rest]) => ({ id: id(), cells: { [t.fields[0].id]: name, ...Object.fromEntries(rest.map((v, i) => [fields[i].id, value(fields[i], v)])) } })) }, by, at);
  return b.tables;
}
