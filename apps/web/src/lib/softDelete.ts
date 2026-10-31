import type { DuckDBConnection } from "@duckdb/node-api";
import { q } from "./sql.ts";

export const DELETED = "_basalt_deleted";

/**
 * Flags rows the source no longer has, rather than removing them, so history stays and a model can choose to filter them. A row that comes back is unflagged.
 * keys is a table or view of every key the source has now. A read that came back empty is treated as a failed read, not as "everything was deleted".
 */
export async function markDeleted(c: DuckDBConnection, dest: string, primaryKey: string, keys: string) {
  const pk = q(primaryKey), del = q(DELETED);
  const count = async (sql: string) => Number(((await c.runAndReadAll(sql)).getRowObjectsJson()[0] as { n: unknown }).n);
  const sourceKeys = await count(`SELECT count(*) n FROM ${keys}`), copied = await count(`SELECT count(*) n FROM ${dest}`);
  if (!sourceKeys && copied) return { skipped: true, deleted: 0, restored: 0 };
  // All or nothing, so a failure can't leave some rows flagged and others not
  await c.run("BEGIN");
  try {
    await c.run(`ALTER TABLE ${dest} ADD COLUMN IF NOT EXISTS ${del} BOOLEAN DEFAULT false`);
    const deleted = await count(`SELECT count(*) n FROM ${dest} d WHERE coalesce(d.${del}, false) = false AND d.${pk} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${keys} k WHERE k.${pk} = d.${pk})`);
    const restored = await count(`SELECT count(*) n FROM ${dest} d WHERE d.${del} = true AND EXISTS (SELECT 1 FROM ${keys} k WHERE k.${pk} = d.${pk})`);
    await c.run(`UPDATE ${dest} SET ${del} = NOT EXISTS (SELECT 1 FROM ${keys} k WHERE k.${pk} = ${dest}.${pk}) WHERE ${pk} IS NOT NULL`);
    await c.run(`UPDATE ${dest} SET ${del} = false WHERE ${del} IS NULL`);
    await c.run("COMMIT");
    return { skipped: false, deleted, restored };
  } catch (e) { await c.run("ROLLBACK").catch(() => {}); throw e; }
}
