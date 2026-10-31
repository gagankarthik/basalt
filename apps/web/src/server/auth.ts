import "server-only";
import crypto from "node:crypto";
import { appKey, getUsers, type StoredUser } from "./files";
import { getSecurity } from "./security";
import { ACTIVE_HEADER, parseSession, sessionVerdict } from "@/lib/sessionPolicy";
import type { Role } from "@/lib/types";

const COOKIE = "basalt_session";
/**
 * When each session was last used by a person. On globalThis because routes are bundled separately.
 * shortcut: held in memory, so a restart gives everyone a fresh idle window; one server per customer makes that fine, store it if that ever changes.
 */
const lastSeen: Map<string, number> = ((globalThis as { __basaltLastSeen?: Map<string, number> }).__basaltLastSeen ??= new Map());
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
const sign = (s: string) => crypto.createHmac("sha256", appKey()).update(s).digest("base64url");

export const signValue = (value: string) => `${value}.${sign(value)}`;
/** Returns the value only if its signature is intact. */
export function readSigned(raw: string): string | null {
  const i = raw.lastIndexOf("."), value = raw.slice(0, i), sig = raw.slice(i + 1), good = sign(value);
  return i > 0 && sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) ? value : null;
}
export function sessionCookie(user: StoredUser, secure: boolean) {
  const { maxHours } = getSecurity(), now = Date.now(), sid = crypto.randomBytes(9).toString("base64url");
  const payload = `${user.id}.${now + maxHours * 36e5}.${user.sessions ?? 0}.${now}.${sid}`;
  lastSeen.set(sid, now);
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxHours * 3600}${secure ? "; Secure" : ""}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function currentUser(req: Request): StoredUser | null {
  const raw = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const i = raw.lastIndexOf("."), payload = raw.slice(0, i), sig = raw.slice(i + 1), good = sign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const s = parseSession(payload), now = Date.now(), policy = getSecurity();
  if (sessionVerdict(s, lastSeen.get(s.sid), now, policy) !== "ok") { lastSeen.delete(s.sid); return null; }
  const user = getUsers().find((u) => u.id === s.id);
  // Signing out raises the user's number, which ends every copy of their cookie, including a stolen one
  if (!user || s.sessions !== (user.sessions ?? 0)) return null;
  // A session first seen since a restart starts its idle time now, but background polling never extends it
  if (req.headers.get(ACTIVE_HEADER) || !lastSeen.has(s.sid)) lastSeen.set(s.sid, now);
  return user;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Handler = (req: Request, user: StoredUser) => Promise<unknown> | unknown;
/** Every API route goes through this: it enforces login and role, and turns failures into readable JSON errors. */
export const api = (min: Role, fn: Handler) => async (req: Request) => {
  try {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, "Sign in to continue.");
    if (RANK[user.role] < RANK[min]) throw new HttpError(403, `This action needs the ${min} role. Your role is ${user.role}.`);
    return Response.json((await fn(req, user)) ?? { ok: true });
  } catch (e) {
    return errorResponse(e);
  }
};
/** Counts bytes as they arrive, because Content-Length is optional and can lie. For routes anyone can call. */
export async function readLimited(req: Request, max: number) {
  const tooBig = () => new HttpError(413, `Send less than ${Math.round(max / 1024)} KB.`);
  if (Number(req.headers.get("content-length")) > max) throw tooBig();
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of (req.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) throw tooBig();
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}
export function errorResponse(e: unknown) {
  const status = e instanceof HttpError ? e.status : 400;
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
}
