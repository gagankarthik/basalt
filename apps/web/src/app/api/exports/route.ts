import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { api, currentUser, errorResponse, HttpError } from "@/server/auth";
import { deliver, EXT, getScheduled, parts, saveScheduled, writeFile } from "@/server/exports";
import { audit, getConfig } from "@/server/files";

// A download is a POST so the response can stream bytes rather than JSON
export async function POST(req: Request) {
  try {
    const user = currentUser(req);
    if (!user || user.role === "viewer") throw new HttpError(403, "Only editors and admins can export whole tables.");
    const b = await req.json(), table = String(b.table ?? ""), format = String(b.format ?? "");
    if (!b.connectionId) {
      if (!EXT[format]) throw new HttpError(400, "Choose CSV, JSON, Parquet, Excel or XML.");
      const file = path.join(os.tmpdir(), `basalt-${crypto.randomUUID()}.${format}`);
      try {
        await writeFile(table, format, file);
        audit(user.name, `Downloaded ${table}`, format, true);
        return new Response(fs.readFileSync(file), { headers: { "content-type": EXT[format].type, "content-disposition": `attachment; filename="${parts(table)[1]}.${format}"` } });
      } finally { fs.rmSync(file, { force: true }); }
    }
    const conn = getConfig().connections.find((c) => c.id === b.connectionId);
    if (!conn) throw new HttpError(404, "This connection no longer exists.");
    if (Number(b.every) > 0) {
      if (![15, 60, 360, 1440].includes(Number(b.every))) throw new HttpError(400, "Choose how often to export.");
      if (conn.type !== "s3" && conn.type !== "gcs" && conn.type !== "azure" && conn.type !== "bigquery" && conn.type !== "snowflake") throw new HttpError(400, "Basalt never writes to this kind of source.");
      parts(table);
      saveScheduled([...getScheduled(), { id: crypto.randomUUID(), table, format, connectionId: conn.id, path: b.path ? String(b.path) : undefined, every: Number(b.every), createdBy: user.name }]);
      audit(user.name, `Scheduled an export of ${table}`, conn.name, true);
    }
    const r = await deliver(table, format, conn, b.path ? String(b.path) : undefined, user.name);
    audit(user.name, `Wrote ${table} to ${conn.name}`, String(r.written), true);
    return Response.json(r);
  } catch (e) { return errorResponse(e); }
}

export const GET = api("editor", () => ({ formats: Object.keys(EXT), scheduled: getScheduled() }));
export const PUT = api("editor", async (req, user) => { const b = await req.json(); if (b.action === "delete") { saveScheduled(getScheduled().filter((x) => x.id !== b.id)); audit(user.name, "Stopped a scheduled export", String(b.id), true); return { ok: true }; } throw new HttpError(400, "Basalt doesn't recognise that request."); });
