import { api, HttpError } from "@/server/auth";
import { audit, createUser, getAudit, getRls, getSalesRequests, getSecret, getUsers, publicUser, saveRls, saveSecret, saveUsers } from "@/server/files";
import { discover, getSso, saveSso } from "@/server/sso";
import type { Role } from "@/lib/types";

const ROLES: Role[] = ["admin", "editor", "viewer"];

export const GET = api("admin", () => ({ members: getUsers().map(publicUser), audit: getAudit().slice(0, 1000), sales: getSalesRequests(), rls: getRls(), sso: { ...getSso(), hasSecret: !!getSecret("sso") } }));

export const POST = api("admin", async (req, user) => {
  const b = await req.json();
  const users = getUsers();
  if (b.action === "rls") {
    const rules = (b.rules as { id: string; userId: string; column: string; values: string[] }[]).filter((r) => r.userId && r.column).map((r) => ({ id: String(r.id), userId: String(r.userId), column: String(r.column).trim(), values: (r.values ?? []).map(String).map((v) => v.trim()).filter(Boolean) }));
    saveRls(rules);
    audit(user.name, "Changed row access rules", `${rules.length} rules`, true);
    return;
  }
  if (b.action === "sso") {
    const enabled = !!b.enabled, issuer = String(b.issuer ?? "").trim(), clientId = String(b.clientId ?? "").trim(), publicUrl = String(b.publicUrl ?? "").trim();
    if (enabled) {
      if (!issuer || !clientId || !publicUrl) throw new HttpError(400, "Enter the issuer, client ID and this workspace's address.");
      if (!/^https?:\/\//.test(publicUrl)) throw new HttpError(400, "This workspace's address must start with https://.");
      try { await discover(issuer); } catch (e) { throw new HttpError(400, `That issuer couldn't be used: ${e instanceof Error ? e.message : e}`); }
    }
    if (!ROLES.includes(b.defaultRole)) throw new HttpError(400, "Choose a role for new people.");
    if (b.secret) saveSecret("sso", String(b.secret));
    if (enabled && !getSecret("sso")) throw new HttpError(400, "Enter the client secret.");
    saveSso({ enabled, name: String(b.name || "single sign-on"), issuer, clientId, publicUrl, defaultRole: b.defaultRole, allowedDomain: String(b.allowedDomain ?? "").trim(), enforce: !!b.enforce });
    audit(user.name, "Changed single sign-on", enabled ? `On, ${issuer}` : "Off", true);
    return;
  }
  if (b.action === "invite") {
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
    if (users.some((u) => u.email === email)) throw new HttpError(400, "This person is already a member.");
    if (String(b.password ?? "").length < 10) throw new HttpError(400, "Use a password with at least 10 characters.");
    if (!ROLES.includes(b.role)) throw new HttpError(400, "Choose a role.");
    createUser(email, String(b.name || email), b.role, b.password);
    audit(user.name, "Added member", `${email} as ${b.role}`, true);
    return;
  }
  const target = users.find((u) => u.id === b.id);
  if (!target) throw new HttpError(404, "This member no longer exists.");
  const admins = users.filter((u) => u.role === "admin");
  const lastAdmin = target.role === "admin" && admins.length === 1;
  if (b.action === "role") {
    if (!ROLES.includes(b.role)) throw new HttpError(400, "Choose a role.");
    if (lastAdmin && b.role !== "admin") throw new HttpError(400, "A workspace needs at least one admin.");
    target.role = b.role;
    saveUsers(users);
    audit(user.name, "Changed member role", `${target.email} to ${b.role}`, true);
  } else if (b.action === "remove") {
    if (lastAdmin) throw new HttpError(400, "A workspace needs at least one admin.");
    saveUsers(users.filter((u) => u.id !== b.id));
    audit(user.name, "Removed member", target.email, true);
  } else throw new HttpError(400, "Unknown action.");
});
