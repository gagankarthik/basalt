import crypto from "node:crypto";
import { errorResponse, HttpError, readLimited } from "@/server/auth";
import { saveSalesRequest } from "@/server/files";

const recent = new Map<string, number[]>();
const WINDOW = 3600000, MAX_PER_WINDOW = 5;
const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/** Public: visitors aren't signed in. Input is capped and rate limited, and stored as plain data for admins to read. */
export async function POST(req: Request) {
  try {
    const b = JSON.parse(await readLimited(req, 64 * 1024));
    // hidden field that people never see and bots tend to fill in
    if (b.website) return Response.json({ ok: true });
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
    const now = Date.now(), hits = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW);
    if (hits.length >= MAX_PER_WINDOW) throw new HttpError(429, "Too many requests. Try again in an hour.");
    const name = text(b.name, 120), email = text(b.email, 200), company = text(b.company, 160);
    if (!name || !company) throw new HttpError(400, "Enter your name and company.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid work email.");
    saveSalesRequest({ id: crypto.randomUUID(), at: new Date().toISOString(), name, email, company, teamSize: text(b.teamSize, 40), sources: text(b.sources, 200), message: text(b.message, 2000) });
    // Made-up addresses would otherwise fill memory
    if (recent.size >= 10000) recent.clear();
    recent.set(ip, [...hits, now]);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
