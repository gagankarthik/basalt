import { api, HttpError } from "@/server/auth";
import { listSnapshots, restoreSnapshot, takeSnapshot, syncTable, applyOps, createBase, createToken, deleteBase, getBase, listBases, listTokens, publishBase, revokeToken, unpublishBase } from "@/server/bases";
import { audit, getRls, getUsers } from "@/server/files";
import type { Op } from "@/lib/base";
import type { StoredUser } from "@/server/files";

// A base isn't filtered row by row, so someone limited to certain rows can't open bases at all
const guard = (u: StoredUser) => { if (u.role === "viewer" && getRls().some((r) => r.userId === u.id)) throw new HttpError(403, "Your access is limited to certain rows, so bases aren't available to you."); };

export const GET = api("viewer", (req, user) => {
  guard(user);
  const url = new URL(req.url), id = url.searchParams.get("id");
  if (!id) return { bases: listBases() };
  const b = getBase(id);
  if (!b) throw new HttpError(404, "This base no longer exists.");
  if (url.searchParams.has("check")) return { version: b.version };
  // Automations hold webhook addresses and the secret hook links that run them; viewers can't use them anyway
  return { base: user.role === "viewer" ? { ...b, automations: [] } : b, people: getUsers().map((u) => u.name) };
});

export const POST = api("viewer", async (req, user) => {
  guard(user);
  const body = await req.json();
  if (body.action === "ops") {
    const ops = body.ops as Op[];
    if (!Array.isArray(ops)) throw new HttpError(400, "Send a list of changes.");
    // Viewers can comment and nothing else
    if (user.role === "viewer" && ops.some((o) => o.kind !== "comment")) throw new HttpError(403, "Viewers can comment but can't edit records.");
    if (ops.some((o) => o.kind === "deleteTable") && user.role !== "admin" && user.role !== "editor") throw new HttpError(403, "You can't delete tables.");
    // Scripts run on the server, so only admins can add or change an automation that has one
    if (user.role !== "admin" && ops.some((o) => (o.kind === "saveAutomation" && (o.automation.actions.some((x) => x.type === "script") || getBase(String(body.id))?.automations.find((a) => a.id === o.automation.id)?.actions.some((x) => x.type === "script"))) || (o.kind === "deleteAutomation" && getBase(String(body.id))?.automations.find((a) => a.id === o.id)?.actions.some((x) => x.type === "script")))) throw new HttpError(403, "Only admins can change automations that run scripts.");
    // Custom extensions run in a locked-down frame, but they're still someone's code shown to everyone, so admins decide
    if (user.role !== "admin" && ops.some((o) => o.kind === "saveExtension" || o.kind === "deleteExtension")) throw new HttpError(403, "Only admins can change custom extensions.");
    return { version: applyOps(String(body.id), ops, user.name) };
  }
  if (user.role === "viewer") throw new HttpError(403, "Only editors and admins can do this.");
  if (body.action === "sync") { const tid = syncTable(String(body.id), String(body.base), String(body.table), body.view ? String(body.view) : undefined, user.name); audit(user.name, "Synced a table between bases", String(body.id)); return { table: tid }; }
  if (body.action === "tokens") return { tokens: listTokens(String(body.id)) };
  if (body.action === "createToken") { const b = getBase(String(body.id)); if (!b) throw new HttpError(404, "This base no longer exists."); if (!String(body.name ?? "").trim()) throw new HttpError(400, "Name this token."); audit(user.name, "Created an API token", `${b.name}: ${body.name}`, true); return { token: createToken(b.id, String(body.name), String(body.scope), user.name) }; }
  if (body.action === "revokeToken") { revokeToken(String(body.id), String(body.token)); audit(user.name, "Revoked an API token", String(body.id), true); return { ok: true }; }
  if (body.action === "snapshots") return { snapshots: listSnapshots(String(body.id)) };
  if (body.action === "snapshot") { const s = takeSnapshot(String(body.id), user.name, "manual"); audit(user.name, "Took a base snapshot", String(body.id)); return { snapshot: s }; }
  // A snapshot can bring back automations with scripts and custom extensions, which only admins can change
  if (body.action === "restoreSnapshot") { if (user.role !== "admin") throw new HttpError(403, "Only admins can restore a snapshot."); const v = restoreSnapshot(String(body.id), String(body.snapshot), user.name); audit(user.name, "Restored a base from a snapshot", String(body.id), true); return { version: v }; }
  if (body.action === "create") { const b = createBase(String(body.name ?? ""), String(body.template ?? ""), user.name); audit(user.name, "Created base", b.name); return { id: b.id }; }
  if (body.action === "publish") { const b = getBase(String(body.id)); if (!b) throw new HttpError(404, "This base no longer exists."); applyOps(b.id, [{ kind: "publish", on: !!body.on }], user.name); if (body.on) await publishBase(b); else await unpublishBase(b); audit(user.name, body.on ? "Shared base with the warehouse" : "Stopped sharing base with the warehouse", b.name, true); return { schema: `base_${b.slug}` }; }
  if (body.action === "delete") { if (user.role !== "admin") throw new HttpError(403, "Only admins can delete a base."); const b = getBase(String(body.id)); if (b) { await deleteBase(b.id); audit(user.name, "Deleted base", b.name, true); } return { ok: true }; }
  throw new HttpError(400, "Basalt doesn't recognise that request.");
});
