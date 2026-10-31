import { isLimited } from "@/server/rls";
import { withoutBookmarks } from "@/lib/viewer";
import { cleanDoc, liveVersion, NO_APP_ACCESS, NO_PAGE_ACCESS, publish, rollback, statusOf, visibleItems } from "@/lib/apps";
import { getApps, saveApps } from "@/server/apps";
import { api, HttpError } from "@/server/auth";
import { audit, getConfig, getUsers } from "@/server/files";

const idOf = (req: Request) => decodeURIComponent(new URL(req.url).pathname.split("/").at(-1) ?? "");

export const GET = api("viewer", (req, user) => {
  const url = new URL(req.url), a = getApps().find((x) => x.id === idOf(req)), author = user.role !== "viewer";
  if (!a) throw new HttpError(author ? 404 : 403, author ? "This app no longer exists." : NO_APP_ACCESS);
  if (url.searchParams.get("edit")) {
    if (!author) throw new HttpError(403, NO_APP_ACCESS);
    const all = getConfig().dashboards;
    return { app: a, status: statusOf(a, all), dashboards: all.map((d) => ({ id: d.id, name: d.name })), members: getUsers().map((u) => ({ id: u.id, name: u.name, role: u.role })) };
  }
  const v = liveVersion(a);
  if (!v) { if (author) return { id: a.id, name: a.draft.name, unpublished: true }; throw new HttpError(403, NO_APP_ACCESS); }
  const items = visibleItems(v.doc, user);
  if (!items.length) throw new HttpError(403, NO_APP_ACCESS);
  // A page outside this person's audience answers the same whether or not it exists, and its content is never sent
  const asked = url.searchParams.get("page"), page = asked ? items.find((i) => i.id === asked) : items.find((i) => i.kind === "dashboard");
  if (asked && !page) throw new HttpError(403, NO_PAGE_ACCESS);
  const dash = page?.kind === "dashboard" ? v.dashboards.find((d) => d.id === page.dashboard) : undefined;
  return { id: a.id, name: v.doc.name, logo: v.doc.logo, version: { n: v.n, at: v.at }, items, pageId: page?.id, dashboard: dash && isLimited(user) ? withoutBookmarks(dash) : dash };
});

export const POST = api("editor", async (req, user) => {
  const b = await req.json(), id = idOf(req), apps = getApps(), a = apps.find((x) => x.id === id), now = new Date().toISOString();
  if (!a) throw new HttpError(404, "This app no longer exists.");
  const put = (next: typeof a) => saveApps(apps.map((x) => (x.id === id ? next : x)));
  if (b.action === "delete") { saveApps(apps.filter((x) => x.id !== id)); audit(user.name, "Deleted an app", a.draft.name, true); return { ok: true }; }
  if (b.action === "rollback") { put(rollback(a, Number(b.version), user.name, now)); audit(user.name, "Rolled back an app", `${a.draft.name}: version ${b.version}`, true); return { updatedAt: now }; }
  if (b.action === "unpublish") { put({ ...a, live: undefined, updatedAt: now }); audit(user.name, "Unpublished an app", a.draft.name, true); return { updatedAt: now }; }
  if (b.action !== "save" && b.action !== "publish") throw new HttpError(400, "Unknown action.");
  if (b.base !== a.updatedAt) throw new HttpError(409, "Someone else changed this app. Close it and open it again to see their changes.");
  const saved = { ...a, draft: cleanDoc(b.doc), updatedAt: now };
  if (b.action === "save") { put(saved); return { updatedAt: now }; }
  const next = publish(saved, getConfig().dashboards, user.name, now);
  put(next);
  // Who can see what is an access decision, so it goes in the sensitive audit trail
  audit(user.name, "Published an app", `${next.draft.name}: version ${next.live}`, true);
  return { updatedAt: now };
});
