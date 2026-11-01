import crypto from "node:crypto";
import { compute, viewRecords, type Field, type Rec, type Table } from "@/lib/base";
import { errorResponse, HttpError } from "@/server/auth";
import { apiToken, applyOps, getBase } from "@/server/bases";

type Ctx = { params: Promise<{ base: string; table: string }> };
const MAX_BATCH = 10, recent = new Map<string, number[]>();

/** The public API, shaped like Airtable's: records have an id, a created time and fields by name. */
async function open(req: Request, ctx: Ctx, write: boolean) {
  const { base: bid, table: tn } = await ctx.params;
  const token = apiToken(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  if (!token || token.base !== bid) throw new HttpError(401, "This token isn't valid for that base.");
  if (write && token.scope !== "write") throw new HttpError(403, "This token can only read.");
  const now = Date.now(), hits = (recent.get(token.id) ?? []).filter((t) => now - t < 1000);
  if (hits.length >= 5) throw new HttpError(429, "Too many requests. The limit is 5 a second for each token.");
  recent.set(token.id, [...hits, now]);
  const b = getBase(bid);
  if (!b) throw new HttpError(404, "This base no longer exists.");
  const name = decodeURIComponent(tn), t = b.tables.find((x) => x.id === name || x.name.toLowerCase() === name.toLowerCase());
  if (!t) throw new HttpError(404, `There's no table called ${name}.`);
  return { b, t, by: `API: ${token.name}` };
}
const toCells = (t: Table, fields: Record<string, unknown> = {}) => {
  const cells: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) { const f = t.fields.find((x) => x.name === k || x.id === k); if (!f) throw new HttpError(422, `There's no field called ${k}.`); cells[f.id] = v; }
  return cells;
};
const shape = (eng: ReturnType<typeof compute>, t: Table, r: Rec, only?: string[]) => ({ id: r.id, createdTime: r.createdAt, fields: Object.fromEntries(t.fields.filter((f) => !only?.length || only.includes(f.name)).map((f: Field) => {
  const v = eng.value(r, f);
  if (f.type === "select") return [f.name, f.choices?.find((c) => c.id === v)?.name ?? null];
  if (f.type === "multiSelect") return [f.name, ((v as string[]) ?? []).map((id) => f.choices?.find((c) => c.id === id)?.name)];
  if (f.type === "button") return [f.name, eng.display(r, f)];
  return [f.name, v instanceof Date ? v.toISOString() : v && typeof v === "object" && "error" in v ? { error: true } : v];
}).filter(([, v]) => v !== null && v !== undefined && v !== "")) });

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { b, t } = await open(req, ctx, false), q = new URL(req.url).searchParams, eng = compute(b, t);
    const size = Math.min(100, Math.max(1, Number(q.get("pageSize")) || 100)), offset = Math.max(0, Number(q.get("offset")) || 0), viewName = q.get("view"), view = viewName ? t.views.find((v) => v.name === viewName || v.id === viewName) : undefined;
    if (viewName && !view) throw new HttpError(404, `There's no view called ${viewName}.`);
    const all = view ? viewRecords(eng, t, view) : t.records, page = all.slice(offset, offset + size);
    return Response.json({ records: page.map((r) => shape(eng, t, r, q.getAll("fields[]"))), ...(offset + size < all.length ? { offset: String(offset + size) } : {}) });
  } catch (e) { return errorResponse(e); }
}
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { b, t, by } = await open(req, ctx, true), body = await req.json(), list = body.records as { fields: Record<string, unknown> }[];
    if (!Array.isArray(list) || !list.length || list.length > MAX_BATCH) throw new HttpError(422, `Send between 1 and ${MAX_BATCH} records.`);
    const records = list.map((r) => ({ id: crypto.randomUUID(), cells: toCells(t, r.fields) }));
    applyOps(b.id, [{ kind: "addRecords", table: t.id, records }], by);
    const eng = compute(b, t);
    return Response.json({ records: records.map((n) => shape(eng, t, t.records.find((x) => x.id === n.id)!)) });
  } catch (e) { return errorResponse(e); }
}
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { b, t, by } = await open(req, ctx, true), body = await req.json(), list = body.records as { id: string; fields: Record<string, unknown> }[];
    if (!Array.isArray(list) || !list.length || list.length > MAX_BATCH) throw new HttpError(422, `Send between 1 and ${MAX_BATCH} records.`);
    for (const r of list) if (!t.records.some((x) => x.id === r.id)) throw new HttpError(404, `There's no record ${r.id}.`);
    applyOps(b.id, [{ kind: "setCells", table: t.id, updates: list.map((r) => ({ id: r.id, cells: toCells(t, r.fields) })) }], by);
    const eng = compute(b, t);
    return Response.json({ records: list.map((n) => shape(eng, t, t.records.find((x) => x.id === n.id)!)) });
  } catch (e) { return errorResponse(e); }
}
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { b, t, by } = await open(req, ctx, true), ids = new URL(req.url).searchParams.getAll("records[]");
    if (!ids.length || ids.length > MAX_BATCH) throw new HttpError(422, `Send between 1 and ${MAX_BATCH} record ids.`);
    applyOps(b.id, [{ kind: "deleteRecords", table: t.id, ids }], by);
    return Response.json({ records: ids.map((id) => ({ id, deleted: true })) });
  } catch (e) { return errorResponse(e); }
}
