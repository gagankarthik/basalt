import "server-only";
import fs from "node:fs";
import crypto from "node:crypto";
import { DATA_DIR, dataPath } from "./engine";
import { defaultConfig } from "./seed";
import type { AuditEntry, Config, Member, RlsRule, Role, Run, SalesRequest } from "@/lib/types";

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(dataPath(file), "utf8")); } catch { return fallback; }
}
// write-then-rename so a crash mid-write can't leave a half-written config behind
export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const p = dataPath(file), tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, p);
}

export const getConfig = () => readJson<Config>("config.json", defaultConfig());
export const saveConfig = (c: Config) => writeJson("config.json", c);

export const getRuns = () => readJson<Run[]>("runs.json", []);
export function saveRun(run: Run) {
  const runs = getRuns().filter((r) => r.id !== run.id);
  writeJson("runs.json", [run, ...runs].slice(0, 500));
}
export const getStreamState = () => readJson<Record<string, Record<string, string>>>("stream-state.json", {});
export const saveStreamState = (s: Record<string, Record<string, string>>) => writeJson("stream-state.json", s);

export const getAudit = () => readJson<AuditEntry[]>("audit.json", []);
export function audit(actor: string, action: string, detail = "", sensitive = false) {
  writeJson("audit.json", [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, sensitive }, ...getAudit()].slice(0, 5000));
}

export const getSalesRequests = () => readJson<SalesRequest[]>("sales-requests.json", []);
export const saveSalesRequest = (r: SalesRequest) => writeJson("sales-requests.json", [r, ...getSalesRequests()].slice(0, 5000));

/* ---- users ---- */
export type StoredUser = Member & { salt: string; hash: string; sessions?: number; ssoId?: string };
export type Revoked = { userId: string; table: string };
export const getRevoked = () => readJson<Revoked[]>("revoked.json", []);
export const saveRevoked = (r: Revoked[]) => writeJson("revoked.json", r);
export const getRls = () => readJson<RlsRule[]>("rls.json", []);
export const saveRls = (r: RlsRule[]) => writeJson("rls.json", r);
export const getUsers = () => readJson<StoredUser[]>("users.json", []);
export const saveUsers = (u: StoredUser[]) => writeJson("users.json", u);
export const publicUser = (u: StoredUser): Member => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt });
export function hashPassword(pw: string, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
export function checkPassword(u: StoredUser, pw: string) {
  return crypto.timingSafeEqual(Buffer.from(hashPassword(pw, u.salt).hash, "hex"), Buffer.from(u.hash, "hex"));
}
export function createUser(email: string, name: string, role: Role, password: string) {
  const u: StoredUser = { id: crypto.randomUUID(), email: email.toLowerCase(), name, role, createdAt: new Date().toISOString(), ...hashPassword(password) };
  saveUsers([...getUsers(), u]);
  return u;
}

/* ---- keys and secrets: connection passwords are encrypted at rest and never sent back to the browser ---- */
export function appKey(): Buffer {
  const p = dataPath(".key");
  try { return Buffer.from(fs.readFileSync(p, "utf8"), "hex"); } catch {
    const k = crypto.randomBytes(32);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(p, k.toString("hex"), { mode: 0o600 });
    return k;
  }
}
export const maskSalt = () => crypto.createHmac("sha256", appKey()).update("mask-salt").digest("hex");
export function saveSecret(id: string, secret: string) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", appKey(), iv);
  const data = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  writeJson("secrets.json", { ...readJson<Record<string, string>>("secrets.json", {}), [id]: [iv, c.getAuthTag(), data].map((b) => b.toString("hex")).join(".") });
}
export function getSecret(id: string): string | undefined {
  const v = readJson<Record<string, string>>("secrets.json", {})[id];
  if (!v) return undefined;
  const [iv, tag, data] = v.split(".").map((h) => Buffer.from(h, "hex"));
  const d = crypto.createDecipheriv("aes-256-gcm", appKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}
export function deleteSecret(id: string) {
  const all = readJson<Record<string, string>>("secrets.json", {});
  delete all[id];
  writeJson("secrets.json", all);
}
