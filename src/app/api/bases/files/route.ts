import crypto from "node:crypto";
import fs from "node:fs";
import { api, currentUser, errorResponse, HttpError } from "@/server/auth";
import { getBase } from "@/server/bases";
import { dataPath } from "@/server/engine";
import { getRls } from "@/server/files";

const MAX = 25 * 1024 * 1024;
// Only these open in the browser. Anything else downloads, so an uploaded page can't run as this site.
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
const pathOf = (base: string, id: string) => { if (!/^[\w-]+$/.test(base) || !/^[\w-]+$/.test(id)) throw new HttpError(400, "That file address isn't valid."); return dataPath(`base-files/${base}__${id}`); };

export const POST = api("editor", async (req) => {
  const form = await req.formData(), file = form.get("file"), base = String(form.get("base") ?? "");
  if (!(file instanceof File)) throw new HttpError(400, "Choose a file to attach.");
  if (file.size > MAX) throw new HttpError(413, "Attachments can be up to 25 MB.");
  if (!getBase(base)) throw new HttpError(404, "This base no longer exists.");
  const id = crypto.randomUUID();
  fs.mkdirSync(dataPath("base-files"), { recursive: true });
  fs.writeFileSync(pathOf(base, id), Buffer.from(await file.arrayBuffer()));
  return { id, name: file.name.slice(0, 255), size: file.size, type: file.type || "application/octet-stream" };
});

export async function GET(req: Request) {
  try {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, "Sign in to continue.");
    if (user.role === "viewer" && getRls().some((r) => r.userId === user.id)) throw new HttpError(403, "Your access doesn't include bases.");
    const url = new URL(req.url), base = url.searchParams.get("base") ?? "", id = url.searchParams.get("id") ?? "", p = pathOf(base, id);
    if (!fs.existsSync(p)) throw new HttpError(404, "This file no longer exists.");
    const type = url.searchParams.get("type") ?? "", name = (url.searchParams.get("name") ?? "file").replace(/["\r\n]/g, "");
    const inline = INLINE.has(type);
    return new Response(fs.readFileSync(p), { headers: { "content-type": inline ? type : "application/octet-stream", "content-disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(name)}"`, "x-content-type-options": "nosniff", "content-security-policy": "sandbox" } });
  } catch (e) { return errorResponse(e); }
}
