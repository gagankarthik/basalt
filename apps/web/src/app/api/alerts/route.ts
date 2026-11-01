import { api, HttpError } from "@/server/auth";
import { getAlertSettings, getNotices, saveAlertSettings, sendWebhook } from "@/server/alerts";
import { audit, getRls } from "@/server/files";
import { getSmtp, saveSmtp, sendMail } from "@/server/mail";

// The webhook address is a credential, so only admins receive it.
// Notices can quote record values, so someone limited to certain rows doesn't get them.
export const GET = api("viewer", (_req, user) => ({ items: user.role === "viewer" && getRls().some((r) => r.userId === user.id) ? [] : getNotices().slice(0, 50).map((n) => (user.role === "viewer" ? { ...n, detail: "", delivery: undefined } : n)), settings: user.role === "admin" ? getAlertSettings() : undefined, smtp: user.role === "admin" ? getSmtp() : undefined }));

export const POST = api("admin", async (req, user) => {
  const b = await req.json();
  if (b.action === "smtp" || b.action === "smtpTest") {
    const s = { host: String(b.host ?? "").trim(), port: Number(b.port) || 587, user: String(b.user ?? "").trim(), from: String(b.from ?? "").trim(), secure: !!b.secure };
    if (!s.host || !s.from) throw new HttpError(400, "Enter the mail server and the address to send from.");
    if (b.action === "smtpTest") { try { await sendMail(user.email, "Basalt test email", "Email from Basalt is working.", undefined, s, b.password ? String(b.password) : undefined); } catch (e) { throw new HttpError(400, `The email couldn't be sent: ${e instanceof Error ? e.message : e}`); } return { sentTo: user.email }; }
    saveSmtp(s, b.password ? String(b.password) : undefined);
    audit(user.name, "Changed the email server", s.host, true);
    return { ok: true };
  }
  const webhook = String(b.webhook ?? "").trim();
  if (webhook && !/^https?:\/\/\S+$/i.test(webhook)) throw new HttpError(400, "Enter a webhook address that starts with https://.");
  if (b.action === "test") {
    if (!webhook) throw new HttpError(400, "Enter a webhook address first.");
    const problem = await sendWebhook(webhook, { level: "warn", title: "Basalt test alert", detail: "Alerts from Basalt will appear here.", href: "/settings" });
    if (problem) throw new HttpError(400, problem);
    return { ok: true };
  }
  saveAlertSettings({ webhook, onSyncFailure: !!b.onSyncFailure, onCheckFailure: !!b.onCheckFailure, onRowMismatch: !!b.onRowMismatch, emailAdmins: !!b.emailAdmins });
  audit(user.name, "Changed alert settings", webhook ? "Webhook set" : "No webhook", true);
});
