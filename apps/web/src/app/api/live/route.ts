import { currentUser, errorResponse, HttpError } from "@/server/auth";
import { watchTables } from "@/server/live";

/** Tells an open dashboard or view when a table it reads has changed. It doesn't carry data. */
export async function GET(req: Request) {
  try {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, "Sign in to continue.");
    const tables = (new URL(req.url).searchParams.get("tables") ?? "").split(",").filter(Boolean).slice(0, 200);
    const enc = new TextEncoder();
    let stop = () => {};
    const stream = new ReadableStream({
      start(c) {
        const send = (s: string) => { try { c.enqueue(enc.encode(s)); } catch { stop(); } };
        send(": connected\n\n");
        const off = watchTables(user.id, tables, (changed) => send(`data: ${JSON.stringify({ tables: changed, at: Date.now() })}\n\n`));
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
