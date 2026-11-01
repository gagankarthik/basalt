import { maskExpr } from "./pii.ts";
import { q } from "./sql.ts";
import type { Rule, StreamCfg } from "./types.ts";

/** Only an unchanged key or a repeatable code still identifies one row. Masked text can match other rows, so updating by it would delete them. */
export const keyRuleProblem = (key: string, rule?: Rule) => (!rule || rule === "keep" || rule === "hash" ? null : `The primary key ${key} can't update rows with this personal data rule. Choose Keep as is or Replace with a code for it, or sync this table another way.`);

/**
 * Why this table can't sync safely, or null. Each case would otherwise look like a good run while the copy fills with duplicates:
 * without a saved cursor every sync reads and adds every row again.
 */
export function syncProblem(s: Pick<StreamCfg, "mode" | "cursor" | "primaryKey" | "rules">, copied: string[], ownState: boolean): string | null {
  if (s.mode === "full_refresh") return null;
  if (!ownState) {
    if (s.mode === "incremental_append" && !s.cursor) return "Adding new rows needs a cursor column. Without one, every sync would add every row again.";
    if (s.cursor && !copied.includes(s.cursor)) return `The cursor column ${s.cursor} is held back or left out, so this sync couldn't record how far it got. Choose a rule that keeps it, or another cursor column.`;
  }
  if (s.mode === "incremental_dedupe" && s.primaryKey) {
    if (!copied.includes(s.primaryKey)) return `The primary key ${s.primaryKey} is held back or left out, so rows couldn't be updated. Choose a rule that keeps it.`;
    return keyRuleProblem(s.primaryKey, s.rules[s.primaryKey]);
  }
  return null;
}

/** The raw rows to load. When updating by key, the last row for a key wins, as it would across two syncs. Rows with no key can't be told apart, so all stay. */
export const loadSource = (s: Pick<StreamCfg, "mode" | "primaryKey">) => (s.mode === "incremental_dedupe" && s.primaryKey ? `(SELECT * FROM _load QUALIFY row_number() OVER (PARTITION BY ${q(s.primaryKey)} ORDER BY rowid DESC) = 1 OR ${q(s.primaryKey)} IS NULL)` : "_load");

/** Removes the rows about to be replaced. The copy holds the protected form of the key, so that's what is compared. */
export const replaceKeysSql = (dest: string, key: string, rule: Rule | undefined, salt: string) => `DELETE FROM ${dest} WHERE ${q(key)} IN (SELECT ${maskExpr(key, rule, salt)} FROM _typed)`;
