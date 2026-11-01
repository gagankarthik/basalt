import "server-only";
import { lit } from "@/lib/sql";
import { HttpError } from "./auth";
import { withConn } from "./engine";
import { audit, getRevoked, getUsers, saveRevoked, saveUsers, type StoredUser } from "./files";

const ROLES = ["admin", "editor", "viewer"];
const WHO = String.raw`'?([^'\s;]+)'?`, TABLE = String.raw`(?:table\s+)?([\w]+)\.([\w]+)`;
const text = (rows: Record<string, string>[], names: string[], started: number) => ({ columns: names.map((name) => ({ name, type: "VARCHAR", kind: "text" as const })), rows, ms: Date.now() - started, truncated: false, kinds: ["DCL"] });

export const isDcl = (sql: string) => /^\s*(grant|revoke|show\s+grants)\b/i.test(sql);

/** DuckDB has no users or privileges, so GRANT and REVOKE are carried out here against Basalt's own members. */
export async function runDcl(sql: string, actor: StoredUser) {
  const started = Date.now();
  if (actor.role !== "admin") throw new HttpError(403, "Only admins can run GRANT and REVOKE.");
  const users = getUsers(), find = (email: string) => users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? (() => { throw new HttpError(400, `${email} isn't a member of this workspace.`); })();
  if (/^\s*show\s+grants\s*;?\s*$/i.test(sql)) {
    const revoked = getRevoked();
    return text(users.map((u) => ({ member: u.email, role: u.role, revoked_tables: revoked.filter((r) => r.userId === u.id).map((r) => r.table).join(", ") })), ["member", "role", "revoked_tables"], started);
  }
  const done = (message: string) => { audit(actor.name, "Ran DCL", sql.trim().slice(0, 200), true); return text([{ result: message }], ["result"], started); };
  let m = new RegExp(`^\\s*(grant|revoke)\\s+(admin|editor|viewer)\\s+(to|from)\\s+${WHO}\\s*;?\\s*$`, "i").exec(sql);
  if (m) {
    const grant = m[1].toLowerCase() === "grant", role = grant ? m[2].toLowerCase() : "viewer", target = find(m[4]);
    if (grant !== (m[3].toLowerCase() === "to")) throw new HttpError(400, "Write GRANT role TO person, or REVOKE role FROM person.");
    if (!ROLES.includes(role)) throw new HttpError(400, "Choose a role.");
    if (target.role === "admin" && role !== "admin" && users.filter((u) => u.role === "admin").length === 1) throw new HttpError(400, "A workspace needs at least one admin.");
    target.role = role as StoredUser["role"];
    saveUsers(users);
    return done(`${target.email} is now ${role}.`);
  }
  m = new RegExp(`^\\s*(grant|revoke)\\s+select\\s+on\\s+${TABLE}\\s+(to|from)\\s+${WHO}\\s*;?\\s*$`, "i").exec(sql);
  if (!m) throw new HttpError(400, "Basalt understands GRANT SELECT ON schema.table TO 'person', REVOKE SELECT ON schema.table FROM 'person', GRANT role TO 'person', REVOKE role FROM 'person' and SHOW GRANTS.");
  const grant = m[1].toLowerCase() === "grant", table = `${m[2]}.${m[3]}`.toLowerCase(), target = find(m[5]);
  if (grant !== (m[4].toLowerCase() === "to")) throw new HttpError(400, "Write GRANT ... TO person, or REVOKE ... FROM person.");
  const found = await withConn(async (c) => Number((await c.runAndReadAll(`SELECT count(*) n FROM information_schema.tables WHERE lower(table_schema) = ${lit(m![2].toLowerCase())} AND lower(table_name) = ${lit(m![3].toLowerCase())}`)).getRowObjectsJson()[0].n));
  if (!found) throw new HttpError(400, `There's no table called ${table}.`);
  if (target.role !== "viewer") throw new HttpError(400, `${target.email} is ${target.role === "admin" ? "an admin" : "an editor"}, and table access only limits viewers. Change their role first.`);
  const rest = getRevoked().filter((r) => !(r.userId === target.id && r.table === table));
  saveRevoked(grant ? rest : [...rest, { userId: target.id, table }]);
  return done(`${target.email} ${grant ? "can read" : "can no longer read"} ${table}.`);
}
