import "server-only";
import crypto from "node:crypto";
import { postJson } from "@/lib/webhook";
import { getUsers, readJson, writeJson } from "./files";
import { sendMail } from "./mail";

export type Notice = { id: string; at: string; key: string; level: "bad" | "warn" | "good"; title: string; detail: string; href: string; resolvedAt?: string; delivery?: string };
export type AlertSettings = { webhook: string; onSyncFailure: boolean; onCheckFailure: boolean; onRowMismatch: boolean; emailAdmins?: boolean };
const DEFAULTS: AlertSettings = { webhook: "", onSyncFailure: true, onCheckFailure: true, onRowMismatch: true };
const REPEAT_MS = 3600000;

export const getAlertSettings = () => ({ ...DEFAULTS, ...readJson<Partial<AlertSettings>>("alert-settings.json", {}) });
export const saveAlertSettings = (s: AlertSettings) => writeJson("alert-settings.json", s);
export const getNotices = () => readJson<Notice[]>("notifications.json", []);
const saveNotices = (n: Notice[]) => writeJson("notifications.json", n.slice(0, 300));

/** Slack, Teams and most chat tools accept a JSON body with a `text` field. */
export async function sendWebhook(url: string, n: Pick<Notice, "level" | "title" | "detail" | "href">): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "The webhook address must start with http:// or https://.";
  try {
    const status = await postJson(url, JSON.stringify({ text: `${n.level === "good" ? "Resolved" : n.level === "bad" ? "Failed" : "Warning"}: ${n.title}\n${n.detail}`, title: n.title, detail: n.detail, level: n.level, path: n.href }));
    return status >= 200 && status < 300 ? "" : `The webhook answered with status ${status}.`;
  } catch (e) { return `The webhook couldn't be reached: ${e instanceof Error ? e.message : e}`; }
}

/** Raises a problem once. A problem that keeps failing repeats at most hourly, so a 15-minute schedule can't flood a channel. */
export async function raise(key: string, level: "bad" | "warn", title: string, detail: string, href: string) {
  const all = getNotices(), open = all.find((n) => n.key === key && !n.resolvedAt);
  if (open && Date.now() - Date.parse(open.at) < REPEAT_MS) return;
  if (open) open.resolvedAt = new Date().toISOString();
  const n: Notice = { id: crypto.randomUUID(), at: new Date().toISOString(), key, level, title, detail, href };
  const { webhook } = getAlertSettings();
  if (webhook) n.delivery = await sendWebhook(webhook, n);
  if (getAlertSettings().emailAdmins) for (const u of getUsers().filter((x) => x.role === "admin")) await sendMail(u.email, `Basalt: ${title}`, detail).catch((e) => { n.delivery = `Email failed: ${e instanceof Error ? e.message : e}`; });
  saveNotices([n, ...getNotices().filter((x) => x.id !== open?.id), ...(open ? [open] : [])]);
}

/** Closes an open problem and says so, so people aren't left wondering whether it was fixed. */
export async function resolve(key: string, title: string, href: string) {
  const all = getNotices(), open = all.filter((n) => n.key === key && !n.resolvedAt);
  if (!open.length) return;
  const at = new Date().toISOString();
  const { webhook } = getAlertSettings();
  const n: Notice = { id: crypto.randomUUID(), at, key, level: "good", title, detail: "This is working again.", href, resolvedAt: at };
  if (webhook) n.delivery = await sendWebhook(webhook, n);
  saveNotices([n, ...getNotices().map((x) => (x.key === key && !x.resolvedAt ? { ...x, resolvedAt: at } : x))]);
}
