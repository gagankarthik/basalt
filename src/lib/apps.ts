import type { Dashboard, Role } from "./types.ts";

export type AppItem = { id: string; kind: "dashboard"; dashboard: string; label: string } | { id: string; kind: "link"; url: string; label: string };
export type AppAudience = { id: string; name: string; roles: Role[]; members: string[]; items: string[] };
export type AppDoc = { name: string; logo?: string; items: AppItem[]; audiences: AppAudience[] };
/** A published version freezes the dashboards too, so later edits don't reach readers until the next publish. */
export type AppVersion = { n: number; at: string; by: string; note?: string; doc: AppDoc; dashboards: Dashboard[] };
export type StoredApp = { id: string; owner: string; createdAt: string; updatedAt: string; draft: AppDoc; live?: number; versions: AppVersion[] };
export type AppSummary = { id: string; name: string; logo?: string; pages: number; audiences?: number; status: "draft" | "live" | "changed"; version?: number; at?: string; owner: string };
export type DataAlert = { id: string; userId: string; dashboard: string; widget: string; app?: string; op: "gt" | "lt"; value: number; at: string; lastAt?: string; lastValue?: number; firing?: boolean; firedAt?: string; lastError?: string };
export type TileComment = { id: string; dashboard: string; widget: string; userId: string; name: string; text: string; at: string };

type Who = { id: string; role: Role };
export const NO_APP_ACCESS = "You don't have access to this app.";
export const NO_PAGE_ACCESS = "You don't have access to this page of the app.";
const KEEP_VERSIONS = 25;

export const liveVersion = (a: StoredApp) => a.versions.find((v) => v.n === a.live);
/** Editors and admins can open every dashboard in the workspace anyway, so an audience can only limit viewers. */
export function visibleItems(doc: AppDoc, u: Who): AppItem[] {
  if (u.role !== "viewer") return doc.items;
  const seen = new Set(doc.audiences.filter((x) => x.roles.includes(u.role) || x.members.includes(u.id)).flatMap((x) => x.items));
  return doc.items.filter((i) => seen.has(i.id));
}
/** Viewers read a dashboard in a published app through that app only, or the workspace copy would show them unpublished edits. */
export const restrictedDashboards = (apps: StoredApp[]) => new Set(apps.flatMap((a) => liveVersion(a)?.doc.items ?? []).flatMap((i) => (i.kind === "dashboard" ? [i.dashboard] : [])));

export function cleanDoc(raw: AppDoc): AppDoc {
  const name = String(raw?.name ?? "").trim();
  if (!name || name.length > 80) throw new Error("Give the app a name of up to 80 characters.");
  const logo = raw.logo ? String(raw.logo) : undefined;
  if (logo && (logo.length > 300000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo))) throw new Error("The logo must be a PNG, JPEG or WebP image of up to 200 KB.");
  const items: AppItem[] = (raw.items ?? []).map((i) => {
    const id = String(i.id), label = String(i.label ?? "").trim();
    if (!id || !label) throw new Error("Every page in the app needs a name.");
    if (i.kind === "link") {
      const url = String(i.url ?? "").trim();
      if (!/^https?:\/\/\S+$/i.test(url)) throw new Error(`The link for ${label} must start with http:// or https://.`);
      return { id, kind: "link", url, label };
    }
    return { id, kind: "dashboard", dashboard: String(i.dashboard), label };
  });
  if (new Set(items.map((i) => i.id)).size !== items.length) throw new Error("Two pages in the app share an id.");
  const known = new Set(items.map((i) => i.id));
  const audiences = (raw.audiences ?? []).map((x): AppAudience => {
    const n = String(x.name ?? "").trim();
    if (!n) throw new Error("Every audience needs a name.");
    return { id: String(x.id), name: n, roles: (x.roles ?? []).includes("viewer") ? ["viewer"] : [], members: (x.members ?? []).map(String), items: (x.items ?? []).map(String).filter((i) => known.has(i)) };
  });
  return { name, logo, items, audiences };
}

const snapshot = (doc: AppDoc, all: Dashboard[]) => {
  const out: Dashboard[] = [];
  for (const i of doc.items) if (i.kind === "dashboard") {
    const d = all.find((x) => x.id === i.dashboard);
    if (!d) throw new Error(`${i.label} points to a dashboard that no longer exists. Remove it from the app first.`);
    if (!out.some((x) => x.id === d.id)) out.push(d);
  }
  return out;
};
const addVersion = (a: StoredApp, v: Omit<AppVersion, "n">, now: string): StoredApp => {
  const n = Math.max(0, ...a.versions.map((x) => x.n)) + 1;
  return { ...a, updatedAt: now, live: n, versions: [{ ...v, n }, ...a.versions].slice(0, KEEP_VERSIONS) };
};
export function publish(a: StoredApp, all: Dashboard[], by: string, now: string): StoredApp {
  if (!a.draft.items.length) throw new Error("Add at least one page before publishing.");
  if (!a.draft.audiences.some((x) => (x.roles.length || x.members.length) && x.items.length)) throw new Error("Add an audience with people and pages before publishing.");
  return addVersion(a, { at: now, by, doc: a.draft, dashboards: snapshot(a.draft, all) }, now);
}
/** Rolling back publishes the old version again, so the history still shows what happened. The draft stays as it is. */
export function rollback(a: StoredApp, n: number, by: string, now: string): StoredApp {
  const v = a.versions.find((x) => x.n === n);
  if (!v) throw new Error("That version is no longer in the history.");
  return addVersion(a, { at: now, by, note: `Rolled back to version ${n}`, doc: v.doc, dashboards: v.dashboards }, now);
}
export function statusOf(a: StoredApp, all: Dashboard[]): AppSummary["status"] {
  const v = liveVersion(a);
  if (!v) return "draft";
  if (JSON.stringify(v.doc) !== JSON.stringify(a.draft)) return "changed";
  try { return JSON.stringify(snapshot(a.draft, all)) === JSON.stringify(v.dashboards) ? "live" : "changed"; } catch { return "changed"; }
}
export const alertMet = (a: Pick<DataAlert, "op" | "value">, v: number) => (a.op === "gt" ? v > a.value : v < a.value);
