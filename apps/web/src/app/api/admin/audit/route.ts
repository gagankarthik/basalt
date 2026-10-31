import fs from "node:fs";
import { currentUser, errorResponse, HttpError } from "@/server/auth";
import { dataPath } from "@/server/engine";
import { audit, AUDIT_ARCHIVE, getAudit } from "@/server/files";

/** The whole audit trail, oldest first and one entry per line, for a customer's own log store. Reading it is itself recorded. */
export async function GET(req: Request) {
  try {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, "Sign in to continue.");
    if (user.role !== "admin") throw new HttpError(403, "Only admins can download the audit log.");
    audit(user.name, "Downloaded the full audit log", "", true);
    const p = dataPath(AUDIT_ARCHIVE), old = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
    const recent = [...getAudit()].reverse().map((a) => JSON.stringify(a)).join("\n");
    return new Response(old + recent + "\n", { headers: { "content-type": "application/x-ndjson", "content-disposition": 'attachment; filename="basalt-audit-log.jsonl"', "cache-control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
