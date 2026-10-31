import { HttpError } from "@/server/auth";
import { checkRate, enqueue, streamFor } from "@/server/ingest";
import { MAX_BODY, parseEvents } from "@/lib/ingest";

type Ctx = { params: Promise<{ stream: string }> };

async function readLimited(req: Request) {
  const tooBig = () => new HttpError(413, `A request can be at most ${MAX_BODY / 1024 / 1024} MB.`);
  if (Number(req.headers.get("content-length")) > MAX_BODY) throw tooBig();
  if (!req.body) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_BODY) throw tooBig();
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Takes events from applications and webhooks. It answers once they're committed, so a failure is always safe to send again. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { stream } = await ctx.params, url = new URL(req.url);
    // A query token is for webhook senders that can't set a header. It's limited to adding events to this one stream
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
    const s = streamFor(decodeURIComponent(stream), token);
    checkRate(s.id);
    let events;
    try { events = parseEvents(await readLimited(req)); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e instanceof Error ? e.message : String(e)); }
    const key = req.headers.get("idempotency-key")?.trim().slice(0, 200) || undefined;
    let result;
    try { result = await enqueue(s, events, key); } catch (e) {
      if (e instanceof HttpError) throw e;
      console.error("Ingest failed", e);
      return Response.json({ error: "These events weren't stored. Send them again." }, { status: 503, headers: { "retry-after": "1" } });
    }
    return Response.json(result);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status, headers: status === 429 ? { "retry-after": "1" } : undefined });
  }
}
