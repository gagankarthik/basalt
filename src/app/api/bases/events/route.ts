import { currentUser, errorResponse, HttpError } from "@/server/auth";
import { getBase, watchBase } from "@/server/bases";
import { getRls } from "@/server/files";

/** Tells open browsers when a base changes, so people see each other's edits straight away. */
export async function GET(req: Request) {
  try {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, "Sign in to continue.");
    if (user.role === "viewer" && getRls().some((r) => r.userId === user.id)) throw new HttpError(403, "Your access doesn't include bases.");
    const id = new URL(req.url).searchParams.get("id") ?? "", b = getBase(id);
    if (!b) throw new HttpError(404, "This base no longer exists.");
    const enc = new TextEncoder();
    let stop = () => {};
    const stream = new ReadableStream({
      start(c) {
        const send = (s: string) => { try { c.enqueue(enc.encode(s)); } catch { stop(); } };
        send(`data: ${JSON.stringify({ version: b.version })}\n\n`);
        const off = watchBase(id, (version) => send(`data: ${JSON.stringify({ version })}\n\n`));
        // Keeps proxies from closing an idle connection
        const beat = setInterval(() => send(": still here\n\n"), 25000);
        stop = () => { off(); clearInterval(beat); };
        req.signal.addEventListener("abort", () => { stop(); try { c.close(); } catch { /* already closed */ } });
      },
      cancel() { stop(); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
  } catch (e) { return errorResponse(e); }
}
