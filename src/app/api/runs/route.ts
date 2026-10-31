import { api, HttpError } from "@/server/auth";
import { getConfig, getRuns } from "@/server/files";
import { runFlow, runModels, runPipeline } from "@/server/jobs";
import { isLimited } from "@/server/rls";
import { viewerRun } from "@/lib/viewer";
import type { Run } from "@/lib/types";

// The list is polled, so it leaves out the bulky parts; ?id= returns one run whole
export const GET = api("viewer", (req, user) => {
  const id = new URL(req.url).searchParams.get("id"), runs = getRuns(), limited = isLimited(user);
  const shown = (r: Run) => (user.role === "viewer" ? viewerRun(r, limited) : r);
  if (id == null) return runs.map((x) => { const { artifacts: _a, messages: _m, ...r } = shown(x); void _a; void _m; return r; });
  const run = runs.find((r) => r.id === id);
  if (!run) throw new HttpError(404, "This run no longer exists.");
  return shown(run);
});

export const POST = api("editor", async (req, user) => {
  const b = await req.json();
  if (user.role !== "admin" && (b.kind === "sync" || b.kind === "flow")) {
    const cfg = getConfig(), usesAirbyte = cfg.pipelines.some((p) => (b.kind === "flow" ? !p.paused : p.id === String(b.id)) && cfg.connections.find((c) => c.id === p.connectionId)?.type === "airbyte");
    // A connector is third-party code running on this server. Schedules on a connection an admin added keep running.
    if (usesAirbyte) throw new HttpError(403, "This includes an Airbyte connector, which only admins can run by hand.");
  }
  if (b.kind === "sync") return runPipeline(String(b.id), "manual", user.name);
  if (b.kind === "models") return runModels("manual", user.name, b.only, !!b.fullRefresh, !!b.downstream, undefined, typeof b.select === "string" || typeof b.exclude === "string" ? { select: String(b.select ?? ""), exclude: String(b.exclude ?? "") } : undefined);
  if (b.kind === "flow") return runFlow(user.name);
  throw new HttpError(400, "Unknown run type.");
});
