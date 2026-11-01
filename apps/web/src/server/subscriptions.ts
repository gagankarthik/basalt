import { serverSem } from "./model";
import "server-only";
import crypto from "node:crypto";
import { measureLabel, widgetSql } from "@/lib/sql";
import { withParams } from "@/lib/report";
import { canReadDashboard } from "./apps";
import { getConfig, getUsers, readJson, writeJson } from "./files";
import { runSql } from "./engine";
import { esc, getSmtp, sendMail } from "./mail";
import { guardFor } from "./rls";

export type Subscription = { id: string; userId: string; dashboard: string; every: number; lastAt?: string; lastError?: string };
const FILE = "subscriptions.json";
export const getSubscriptions = () => readJson<Subscription[]>(FILE, []);
const save = (s: Subscription[]) => writeJson(FILE, s);
export function subscribe(userId: string, dashboard: string, every: number) { const list = getSubscriptions().filter((s) => !(s.userId === userId && s.dashboard === dashboard)); const s = { id: crypto.randomUUID(), userId, dashboard, every, lastAt: new Date().toISOString() }; save([...list, s]); return s; }
export const unsubscribe = (userId: string, dashboard: string) => save(getSubscriptions().filter((s) => !(s.userId === userId && s.dashboard === dashboard)));

/** Builds the email as the recipient, through their own row rules, so it never shows them more than the app would. */
export async function sendReport(s: Subscription) {
  const user = getUsers().find((u) => u.id === s.userId), d = getConfig().dashboards.find((x) => x.id === s.dashboard);
  // An app published after someone subscribed must stop this copy reaching them
  if (!user || !d || !canReadDashboard(user, d.id)) return false;
  const guard = guardFor(user);
  const values = Object.fromEntries((d.params ?? []).map((p) => [p.name, p.value]));
  const parts: { title: string; lines: string[] }[] = [];
  for (const w of d.widgets) {
    if (!["kpi", "gauge", "bar", "column", "table", "donut", "pie", "treemap", "funnel"].includes(w.type)) continue;
    const sql = widgetSql({ ...w, limit: 10, semantic: w.model ? await serverSem() : undefined, daxMeasures: Object.fromEntries((d.measures ?? []).map((m) => [m.name, m.dax])), rels: d.relationships }); if (!sql) continue;
    try {
      const r = await runSql(withParams(sql, values), { readOnly: true, limit: 10, rewrite: guard });
      const name = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(v ?? ""));
      parts.push({ title: w.title, lines: w.type === "kpi" || w.type === "gauge" ? [`${name(r.rows[0]?.m0)}`] : r.rows.slice(0, 10).map((x) => ("m0" in x ? `${name(x.d)}: ${name(x.m0)}` : Object.values(x).slice(0, 4).map(name).join(", "))) });
    } catch { parts.push({ title: w.title, lines: ["This isn't available with your access."] }); }
    if (parts.length >= 12) break;
  }
  void measureLabel;
  const link = `${(process.env.BASALT_URL ?? "").replace(/\/+$/, "")}/dashboards/${d.id}`;
  const text = [d.name, "", ...parts.flatMap((p) => [p.title, ...p.lines.map((l) => `  ${l}`), ""]), ...(process.env.BASALT_URL ? [`Open the report: ${link}`] : [])].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;color:#171a21;max-width:640px"><h1 style="font-size:20px">${esc(d.name)}</h1>${parts.map((p) => `<h2 style="font-size:14px;margin:18px 0 4px">${esc(p.title)}</h2>${p.lines.length === 1 ? `<div style="font-size:22px;font-weight:600">${esc(p.lines[0])}</div>` : `<table style="border-collapse:collapse;font-size:13px">${p.lines.map((l) => `<tr><td style="padding:3px 0">${esc(l)}</td></tr>`).join("")}</table>`}`).join("")}${process.env.BASALT_URL ? `<p style="margin-top:20px"><a href="${esc(link)}">Open the report</a></p>` : ""}</div>`;
  await sendMail(user.email, `Report: ${d.name}`, text, html);
  return true;
}
export async function runSubscriptions() {
  if (!getSmtp()?.host) return;
  const list = getSubscriptions(), now = Date.now(); let changed = false;
  for (const s of list) {
    if (s.lastAt && now - Date.parse(s.lastAt) < s.every * 3600000) continue;
    s.lastAt = new Date(now).toISOString(); changed = true;
    try { await sendReport(s); s.lastError = undefined; } catch (e) { s.lastError = e instanceof Error ? e.message : String(e); }
  }
  if (changed) { const fresh = getSubscriptions(); save(fresh.map((x) => list.find((y) => y.id === x.id) ?? x)); }
}
