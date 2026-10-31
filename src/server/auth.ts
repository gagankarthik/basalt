import "server-only";
import crypto from "node:crypto";
import { appKey, getUsers, type StoredUser } from "./files";
import type { Role } from "@/lib/types";

const COOKIE = "basalt_session", DAYS = 7;
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
const sign = (s: string) => crypto.createHmac("sha256", appKey()).update(s).digest("base64url");

export const signValue = (value: string) => `${value}.${sign(value)}`;
/** Returns the value only if its signature is intact. */
export function readSigned(raw: string): string | null {
  const i = raw.lastIndexOf("."), value = raw.slice(0, i), sig = raw.slice(i + 1), good = sign(value);
  return i > 0 && sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) ? value : null;
}
export function sessionCookie(userId: string, secure: boolean) {
  const payload = `${userId}.${Date.now() + DAYS * 864e5}`;
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure ? "; Secure" : ""}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function currentUser(req: Request): StoredUser | null {
  const raw = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const i = raw.lastIndexOf("."), payload = raw.slice(0, i), sig = raw.slice(i + 1), good = sign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const [id, exp] = payload.split(".");
  if (Number(exp) < Date.now()) return null;
  return getUsers().find((u) => u.id === id) ?? null;
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
