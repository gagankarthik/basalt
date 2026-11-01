import { api, errorResponse, HttpError, readLimited } from "@/server/auth";
import { applyBatch, checkCdcToken, enableCdc, getCdcStatus, type CdcChange } from "@/server/cdc";
import { audit, getConfig } from "@/server/files";

// Error text can quote row values, so viewers learn only that there was one
export const GET = api("viewer", (_req, user) => user.role !== "viewer" ? getCdcStatus() : Object.fromEntries(Object.entries(getCdcStatus()).map(([k, s]) => [k, s.lastError ? { ...s, lastError: "Real-time sync reported an error. An editor or admin can see why." } : s])));

/** Admins turn real-time on from the app; the token is shown once and only its encrypted copy is kept. */
export const PUT = api("admin", async (req, user) => {
  const { id } = await req.json(), cfg = getConfig(), p = cfg.pipelines.find((x) => x.id === id);
  const conn = cfg.connections.find((c) => c.id === p?.connectionId);
  if (!p || !conn) throw new HttpError(404, "This pipeline no longer exists.");
  if (conn.type !== "postgres") throw new HttpError(400, "Real-time sync is available for PostgreSQL sources.");
  audit(user.name, "Turned on real-time sync", p.name, true);
  return { token: enableCdc(p.id), slug: conn.slug, host: conn.host, port: conn.port ?? 5432, database: conn.database };
});

/** Called by the worker, which has a token instead of a signed-in session. */
export async function POST(req: Request) {
  try {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    // Checked before reading the body, so a stranger can't make the server hold a huge request in memory
    if (!getConfig().pipelines.some((p) => checkCdcToken(p.id, token))) throw new HttpError(401, "This token isn't valid for that pipeline.");
    const b = JSON.parse(await readLimited(req, 512 * 1024 * 1024)) as { pipeline?: string; lsn?: string; changes?: CdcChange[]; types?: Record<string, Record<string, string>> };
    if (!b.pipeline || !checkCdcToken(b.pipeline, token)) throw new HttpError(401, "This token isn't valid for that pipeline.");
    if (!Array.isArray(b.changes)) throw new HttpError(400, "Send a list of changes.");
    return Response.json(await applyBatch(b.pipeline, String(b.lsn ?? ""), b.changes, b.types));
  } catch (e) { return errorResponse(e); }
}
