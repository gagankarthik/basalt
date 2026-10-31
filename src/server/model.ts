import "server-only";
import { semanticOf } from "@/lib/semantic";
import { withConn } from "./engine";
import { getConfig } from "./files";

/** The semantic model with the warehouse's current columns, for visuals that run without a browser. */
export async function serverSem() {
  const cfg = getConfig();
  if (!cfg.semantic) return undefined;
  const rows = await withConn(async (c) => (await c.runAndReadAll(`SELECT table_schema || '.' || table_name AS full, column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY ordinal_position`)).getRowObjectsJson() as { full: string; name: string; type: string }[]);
  const map = new Map<string, { name: string; type: string }[]>();
  for (const r of rows) map.set(r.full, [...(map.get(r.full) ?? []), { name: r.name, type: r.type }]);
  return semanticOf(cfg.semantic, [...map].map(([full, columns]) => ({ full, columns })), cfg.metrics);
}
