import { api, HttpError } from "@/server/auth";
import { audit } from "@/server/files";
import { endSession, runNotebook, runPythonCell } from "@/server/notebooks";
import { pythonVersion } from "@/server/python";
import type { Result } from "@/lib/types";

export const GET = api("editor", async () => ({ python: await pythonVersion() }));

export const POST = api("editor", async (req, user) => {
  const b = await req.json();
  if (b.action === "run") return runNotebook(String(b.id), "manual", user.name);
  if (b.action === "restart") { if (user.role !== "admin") throw new HttpError(403, "Only admins can run Python."); endSession(String(b.session)); return; }
  if (b.action === "python") {
    // Python runs as real code on this server, unlike sandboxed SQL, so only admins can run what they've typed
    if (user.role !== "admin") throw new HttpError(403, "Only admins can run Python.");
    if (typeof b.code !== "string" || !b.code.trim()) throw new HttpError(400, "Write some Python to run.");
    audit(user.name, "Ran a Python cell", b.code.slice(0, 200), true);
    return runPythonCell(b.code, (b.earlier ?? {}) as Record<string, Result>, b.session ? String(b.session) : undefined);
  }
  throw new HttpError(400, "Basalt doesn't recognise that request.");
});
