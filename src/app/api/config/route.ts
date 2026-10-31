import { visibleConfig } from "@/server/apps";
import { api, HttpError } from "@/server/auth";
import { audit, getConfig, saveConfig } from "@/server/files";
import type { Config } from "@/lib/types";

// Dashboards in a published app go to viewers through /api/apps only, limited by audience
export const GET = api("viewer", (_req, user) => visibleConfig(getConfig(), user));

/** Rule changes are written to the sensitive audit trail by comparing old and new. */
export const PUT = api("editor", async (req, user) => {
  const next: Config = await req.json(), prev = getConfig();
  // Python runs as real code on this server, unlike sandboxed SQL, so only admins can change it
  if (user.role !== "admin") for (const m of next.models) {
    if ((m.python ?? "") !== (prev.models.find((x) => x.id === m.id)?.python ?? "")) throw new HttpError(403, "Only admins can change Python code.");
  }
  // Full Jinja can run code inside real dbt, so like Python it stays with admins
  if (user.role !== "admin") {
    if ((next.project?.dbtMacros ?? "") !== (prev.project?.dbtMacros ?? "")) throw new HttpError(403, "Only admins can change dbt macros.");
    for (const m of next.models) {
      const was = prev.models.find((x) => x.id === m.id);
      if (!!m.jinja !== !!was?.jinja || (m.jinja && m.sql !== was?.sql)) throw new HttpError(403, "Only admins can change full Jinja models.");
    }
  }
  for (const m of next.models) {
    const was = prev.models.find((x) => x.id === m.id);
    if (m.jinja && m.sql !== was?.sql) audit(user.name, "Changed full Jinja model", m.name, true);
    if ((m.python ?? "") !== (was?.python ?? "")) audit(user.name, "Changed Python model", m.name, true);
  }
  for (const p of next.pipelines) {
    const old = prev.pipelines.find((x) => x.id === p.id);
    for (const s of p.streams) {
      const was = old?.streams.find((x) => x.name === s.name)?.rules ?? {};
      for (const [col, rule] of Object.entries(s.rules)) if (was[col] !== rule) audit(user.name, "Changed personal data rule", `${s.name}.${col}: ${was[col] ?? "none"} to ${rule}`, true);
    }
  }
  // Opening or closing a data layer to viewers is an access decision
  if (user.role !== "admin" && JSON.stringify(next.semantic?.viewerStages ?? {}) !== JSON.stringify(prev.semantic?.viewerStages ?? {})) throw new HttpError(403, "Only admins can change who reads a data layer.");
  // connections are managed through /api/connections so credentials go through one audited path
  saveConfig({ ...next, connections: prev.connections });
});
