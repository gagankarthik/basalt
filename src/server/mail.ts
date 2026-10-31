import "server-only";
import nodemailer from "nodemailer";
import { getSecret, readJson, saveSecret, writeJson } from "./files";

export type Smtp = { host: string; port: number; user: string; from: string; secure: boolean };
export const getSmtp = () => readJson<Smtp | null>("smtp.json", null);
export function saveSmtp(s: Smtp, password?: string) { writeJson("smtp.json", s); if (password) saveSecret("smtp", password); }
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export { esc };

/** Mail goes through the server you configure. If there's none, this says so instead of pretending. */
export async function sendMail(to: string, subject: string, text: string, html?: string, config?: Smtp, password?: string) {
  const s = config ?? getSmtp();
  if (!s?.host) throw new Error("Set up an email server in Settings first.");
  const pass = password ?? getSecret("smtp");
  const t = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass } : undefined, connectionTimeout: 10000, socketTimeout: 20000 });
  await t.sendMail({ from: s.from, to, subject: subject.replace(/[\r\n]+/g, " ").slice(0, 200), text, html });
}
