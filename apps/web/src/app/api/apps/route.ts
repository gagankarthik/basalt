import crypto from "node:crypto";
import { cleanDoc, liveVersion, statusOf, visibleItems, type AppSummary, type StoredApp } from "@/lib/apps";
import { getApps, saveApps } from "@/server/apps";
import { api } from "@/server/auth";
import { audit, getConfig } from "@/server/files";

export const GET = api("viewer", (_req, user) => {
  const all = getConfig().dashboards;
  const items: AppSummary[] = getApps().flatMap((a): AppSummary[] => {
    const v = liveVersion(a);
    if (user.role !== "viewer") return [{ id: a.id, name: a.draft.name, logo: a.draft.logo, pages: a.draft.items.length, audiences: a.draft.audiences.length, status: statusOf(a, all), version: v?.n, at: v?.at, owner: a.owner }];
    const pages = v ? visibleItems(v.doc, user).length : 0;
    return v && pages ? [{ id: a.id, name: v.doc.name, logo: v.doc.logo, pages, status: "live", version: v.n, at: v.at, owner: a.owner }] : [];
  });
  return { items };
});
export const POST = api("editor", async (req, user) => {
  const b = await req.json(), now = new Date().toISOString();
  const a: StoredApp = { id: crypto.randomUUID(), owner: user.name, createdAt: now, updatedAt: now, draft: cleanDoc({ name: b.name, items: [], audiences: [] }), versions: [] };
  saveApps([...getApps(), a]);
  audit(user.name, "Created an app", a.draft.name);
  return { id: a.id };
});
