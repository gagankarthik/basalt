import { serverSem } from "./model";
import "server-only";
import crypto from "node:crypto";
import { alertMet, liveVersion, NO_APP_ACCESS, restrictedDashboards, visibleItems, type DataAlert, type StoredApp, type TileComment } from "@/lib/apps";
import { withParams } from "@/lib/report";
import { widgetSql } from "@/lib/sql";
import type { Config, Dashboard, Role } from "@/lib/types";
import { HttpError } from "./auth";
import { runSql } from "./engine";
import { getConfig, getRls, getUsers, readJson, writeJson } from "./files";
import { getSmtp, sendMail } from "./mail";
import { viewerConfig } from "@/lib/viewer";
import { guardFor, isLimited } from "./rls";

type Who = { id: string; role: Role };
const COMMENTS = "tile-comments.json", ALERTS = "tile-alerts.json", CHECK_MS = 15 * 60000;
export const getApps = () => readJson<StoredApp[]>("apps.json", []);
export const saveApps = (a: StoredApp[]) => writeJson("apps.json", a);

/** What /api/config sends. Apps live in their own file and never appear in it. */
export function visibleConfig(c: Config, u: Who & { name: string }): Config {
  if (u.role !== "viewer") return c;
  const hidden = restrictedDashboards(getApps());
  return viewerConfig({ ...c, dashboards: c.dashboards.filter((d) => !hidden.has(d.id)) }, { name: u.name, limited: isLimited(u) });
}
export const canReadDashboard = (u: Who, id: string) => u.role !== "viewer" || !restrictedDashboards(getApps()).has(id);

/** The definition this person may read: the published copy inside an app, otherwise the workspace's own. */
export function dashboardFor(u: Who, id: string, appId?: string): Dashboard {
  if (appId) {
    const a = getApps().find((x) => x.id === appId), v = a && liveVersion(a);
    const d = v && visibleItems(v.doc, u).some((i) => i.kind === "dashboard" && i.dashboard === id) ? v.dashboards.find((x) => x.id === id) : undefined;
    if (!d) throw new HttpError(403, NO_APP_ACCESS);
    return d;
  }
  if (!canReadDashboard(u, id)) throw new HttpError(403, "Open this dashboard from its app.");
  const d = getConfig().dashboards.find((x) => x.id === id);
  if (!d) throw new HttpError(404, "This dashboard no longer exists.");
  return d;
}

/* ---- comments ---- */
const allComments = () => readJson<TileComment[]>(COMMENTS, []);
/** Comments can quote figures, so someone limited to certain rows sees only their own, as with notices. */
export function commentsFor(u: Who, dashboard: string) {
  const limited = u.role === "viewer" && getRls().some((r) => r.userId === u.id);
  return allComments().filter((c) => c.dashboard === dashboard && (!limited || c.userId === u.id));
}
export function addComment(u: Who & { name: string }, dashboard: string, widget: string, text: string) {
  const t = text.trim();
  if (!t || t.length > 2000) throw new HttpError(400, "Write a comment of up to 2,000 characters.");
  writeJson(COMMENTS, [...allComments(), { id: crypto.randomUUID(), dashboard, widget, userId: u.id, name: u.name, text: t, at: new Date().toISOString() }].slice(-5000));
}
export function deleteComment(u: Who, id: string) {
  const all = allComments(), c = all.find((x) => x.id === id);
  if (!c) return;
  if (c.userId !== u.id && u.role !== "admin") throw new HttpError(403, "You can delete only your own comments.");
  writeJson(COMMENTS, all.filter((x) => x.id !== id));
}

/* ---- data alerts: each person's own, checked through their own row rules ---- */
const allAlerts = () => readJson<DataAlert[]>(ALERTS, []);
export const alertsFor = (u: Who, dashboard: string) => allAlerts().filter((a) => a.userId === u.id && a.dashboard === dashboard);
export const deleteAlert = (u: Who, id: string) => writeJson(ALERTS, allAlerts().filter((a) => !(a.id === id && a.userId === u.id)));

async function checkAlert(a: DataAlert, now: string): Promise<DataAlert> {
  const next: DataAlert = { ...a, lastAt: now, lastError: undefined };
  const user = getUsers().find((u) => u.id === a.userId);
  if (!user) return { ...next, lastError: "This person is no longer a member." };
  try {
    const d = dashboardFor(user, a.dashboard, a.app), w = d.widgets.find((x) => x.id === a.widget);
    if (!w) throw new Error("This tile no longer exists.");
    const sql = widgetSql({ ...w, semantic: w.model ? await serverSem() : undefined, daxMeasures: Object.fromEntries((d.measures ?? []).map((m) => [m.name, m.dax])), rels: d.relationships });
    if (!sql) throw new Error("This tile has no value to check.");
    const r = await runSql(withParams(sql, Object.fromEntries((d.params ?? []).map((p) => [p.name, p.value]))), { readOnly: true, limit: 1, rewrite: guardFor(user) });
    const v = r.rows[0]?.m0 == null ? NaN : Number(r.rows[0].m0);
    if (!Number.isFinite(v)) throw new Error("This tile returned no number.");
    next.lastValue = v;
    const met = alertMet(a, v);
    next.firing = met;
    // Only on crossing the line, so a number that stays past it doesn't send an email every check
    if (met && !a.firing) {
      next.firedAt = now;
      if (getSmtp()?.host) {
        const link = process.env.BASALT_URL ? `\n\n${process.env.BASALT_URL.replace(/\/+$/, "")}${a.app ? `/apps/${a.app}` : `/dashboards/${d.id}`}` : "";
        await sendMail(user.email, `Alert: ${w.title}`, `${w.title} on ${d.name} is ${v.toLocaleString("en-US")}, ${a.op === "gt" ? "above" : "below"} your limit of ${a.value.toLocaleString("en-US")}.${link}`);
      }
    }
  } catch (e) { next.lastError = e instanceof Error ? e.message : String(e); }
  return next;
}
/** Checks once when saved, so the tile shows a real status straight away. */
export async function setAlert(u: Who, dashboard: string, widget: string, op: "gt" | "lt", value: number, app?: string) {
  const now = new Date().toISOString(), a = await checkAlert({ id: crypto.randomUUID(), userId: u.id, dashboard, widget, app, op, value, at: now }, now);
  writeJson(ALERTS, [...allAlerts().filter((x) => !(x.userId === u.id && x.dashboard === dashboard && x.widget === widget)), a]);
  return a;
}
export async function runDataAlerts() {
  const now = Date.now(), done = new Map<string, DataAlert>();
  for (const a of allAlerts()) if (!a.lastAt || now - Date.parse(a.lastAt) >= CHECK_MS) done.set(a.id, await checkAlert(a, new Date(now).toISOString()));
  // Read again so an alert saved during the checks isn't lost
  if (done.size) writeJson(ALERTS, allAlerts().map((a) => done.get(a.id) ?? a));
}
