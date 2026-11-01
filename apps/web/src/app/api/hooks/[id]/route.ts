import { errorResponse, HttpError, readLimited } from "@/server/auth";
import { runHook } from "@/server/bases";

const recent = new Map<string, number[]>();

/** Public address for an automation's "webhook received" trigger. The long random id is what authorizes the caller. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params, now = Date.now(), hits = (recent.get(id) ?? []).filter((t) => now - t < 1000);
    if (hits.length >= 5) throw new HttpError(429, "Too many requests. The limit is 5 a second.");
    // Made-up addresses would otherwise fill memory
    if (recent.size >= 10000) recent.clear();
    recent.set(id, [...hits, now]);
    const text = await readLimited(req, 1024 * 1024);
    let payload: unknown = {};
    if (text) { try { payload = JSON.parse(text); } catch { throw new HttpError(400, "Send JSON."); } }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new HttpError(400, "Send a JSON object.");
    if (!(await runHook(id, payload as Record<string, unknown>))) throw new HttpError(404, "This webhook isn't active.");
    return Response.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
