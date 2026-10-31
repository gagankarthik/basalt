import "server-only";
import type { DuckDBConnection } from "@duckdb/node-api";
import { applyRowSecurity, checkViewerRead } from "@/lib/rowSecurity";
import { stageOf, viewerMayRead } from "@/lib/semantic";
import { HttpError } from "./auth";
import { getConfig, getRevoked, getRls } from "./files";

const denied = (msg: string) => new HttpError(403, msg);
export { applyRowSecurity };

const limitsOf = (id: string) => ({
  rules: getRls().filter((r) => r.userId === id),
  revoked: new Set(getRevoked().filter((r) => r.userId === id).map((r) => r.table)),
  anyStage: Object.values(getConfig().semantic?.viewerStages ?? {}).some((v) => v === false),
});
/** A viewer who can't read every row of every table, so what's sent to them mustn't describe the rest. */
export function isLimited(user: { id: string; role: string }) {
  const l = limitsOf(user.id);
  return user.role === "viewer" && (l.rules.length > 0 || l.revoked.size > 0 || l.anyStage);
}

/** Everything a viewer's query has to pass: stored failures and view source, revoked tables, then row rules. Editors can change data and models, so none of it could hold for them. */
export function guardFor(user: { id: string; role: string }) {
  if (user.role !== "viewer") return undefined;
  const { rules, revoked, anyStage } = limitsOf(user.id), cfg = getConfig();
  const stageClosed = (schema: string, name: string) => !viewerMayRead(cfg.semantic, stageOf(schema, name, cfg.models));
  return async (c: DuckDBConnection, sql: string) => {
    await checkViewerRead(c, sql, { revoked, stageClosed, limited: rules.length > 0 || revoked.size > 0 || anyStage }, denied);
    return rules.length ? applyRowSecurity(c, sql, rules, denied) : sql;
  };
}
