import { api, HttpError } from "@/server/auth";
import { audit } from "@/server/files";
import { getLineageSettings, hasLineageKey, lineageStatus, removeLineageKey, saveLineageSettings, testLineage, type LineageSettings } from "@/server/openlineage";

const view = () => ({ settings: getLineageSettings(), hasKey: hasLineageKey(), status: lineageStatus() });

// The key is written here and never sent back; the browser only learns whether one is saved
export const GET = api("admin", view);

export const POST = api("admin", async (req, user) => {
  const b = await req.json();
  if (b.action === "removeKey") { removeLineageKey(); audit(user.name, "Removed the OpenLineage API key", "", true); return view(); }
  const s: LineageSettings = { transport: b.transport === "http" || b.transport === "file" ? b.transport : "none", url: String(b.url ?? "").trim(), namespace: String(b.namespace ?? "").trim() || "basalt", includeSql: !!b.includeSql };
  if (!/^[\w.-]+$/.test(s.namespace)) throw new HttpError(400, "Use letters, numbers, dots and dashes in the namespace.");
  const key = b.apiKey ? String(b.apiKey) : undefined;
  try {
    if (b.action === "test") {
      if (!s.url) throw new Error("Enter the endpoint first.");
      const problem = await testLineage(s.url, key, s.namespace);
      if (problem) throw new Error(problem);
    } else {
      if (s.transport === "http" && !s.url) throw new Error("Enter the endpoint.");
      saveLineageSettings(s, key);
      audit(user.name, "Changed OpenLineage settings", s.transport === "http" ? new URL(s.url).host : s.transport, true);
    }
  } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
  return view();
});
