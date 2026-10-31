import { api, HttpError } from "@/server/auth";
import { audit } from "@/server/files";
import { createStream, deleteStream, listStreams, rotateToken, streamStats, updateStream } from "@/server/ingest";
import type { Rule } from "@/lib/types";

const RULES: Rule[] = ["keep", "mask", "hash", "month", "drop"];

export const GET = api("viewer", () => streamStats());

export const POST = api("editor", async (req, user) => {
  const b = await req.json() as { name?: string; uniqueField?: string; rotate?: string };
  if (b.rotate) {
    const s = listStreams().find((x) => x.id === b.rotate);
    if (!s) throw new HttpError(404, "This stream no longer exists.");
    audit(user.name, "Replaced a stream token", s.name, true);
    return { name: s.name, token: rotateToken(s.id) };
  }
  const made = createStream(String(b.name ?? ""), b.uniqueField, user.name);
  audit(user.name, "Added stream", made.name, true);
  return made;
});

export const PATCH = api("editor", async (req, user) => {
  const b = await req.json() as { id?: string; rules?: Record<string, Rule>; rebuildModels?: boolean };
  const s = listStreams().find((x) => x.id === b.id);
  if (!s) throw new HttpError(404, "This stream no longer exists.");
  const rules = b.rules ?? s.rules;
  for (const r of Object.values(rules)) if (!RULES.includes(r)) throw new HttpError(400, "That rule isn't one Basalt knows.");
  updateStream(s.id, { rules, rebuildModels: b.rebuildModels ?? s.rebuildModels });
  audit(user.name, "Changed a stream", s.name, true);
  return { ok: true };
});

export const DELETE = api("admin", async (req, user) => {
  const id = new URL(req.url).searchParams.get("id") ?? "", s = listStreams().find((x) => x.id === id);
  if (!s) throw new HttpError(404, "This stream no longer exists.");
  await deleteStream(id);
  audit(user.name, "Removed stream", s.name, true);
  return { ok: true };
});
