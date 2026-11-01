import { kindOf } from "./sql.ts";
import type { Result } from "./types.ts";

export type NotebookCell = { id: string; kind: "sql" | "python" | "text"; source: string };
export type Notebook = { id: string; name: string; cells: NotebookCell[]; every?: number; owner: string; updatedAt: string };

const python = (n?: Notebook) => (n?.cells ?? []).filter((c) => c.kind === "python").map((c) => c.source).join("\u0000");
/** Python runs as real code on the server, so anyone but an admin can only leave it exactly as it was. */
export function pythonEdited(before: Notebook[] = [], after: Notebook[] = []) {
  return after.some((n) => python(n) !== python(before.find((x) => x.id === n.id))) || before.some((n) => python(n) && !after.some((x) => x.id === n.id));
}

export const isDue = (n: Notebook, lastStart: string | undefined, now: number) => !!n.every && (!lastStart || now - Date.parse(lastStart) >= n.every * 60000);

/** What a later cell calls an earlier one's result: cell1, cell2 and so on, counting every cell on the page. */
export const cellName = (index: number) => `cell${index + 1}`;

/** Runs cells in order and stops at the first failure, because later cells may rely on it. Text cells have nothing to run. */
export async function runCells<R>(cells: NotebookCell[], exec: (c: NotebookCell, earlier: Record<string, R>) => Promise<R>) {
  const results: Record<string, R> = {};
  for (const [i, c] of cells.entries()) {
    if (c.kind === "text" || !c.source.trim()) continue;
    try { results[cellName(i)] = await exec(c, results); } catch (e) { return { results, failed: { index: i, message: e instanceof Error ? e.message : String(e) } }; }
  }
  return { results, failed: null };
}

const typeOf = (values: unknown[]) => {
  const set = values.filter((v) => v != null);
  if (set.length && set.every((v) => typeof v === "number")) return "DOUBLE";
  if (set.length && set.every((v) => typeof v === "boolean")) return "BOOLEAN";
  return set.some((v) => typeof v === "object") ? "JSON" : "VARCHAR";
};
/** Shapes rows from Python like a query result, so they show in the same table and chart. */
export function rowsToResult(rows: Record<string, unknown>[], ms = 0, limit = 20000): Result {
  const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns = names.map((name) => { const type = typeOf(rows.map((r) => r[name])); return { name, type, kind: kindOf(type) }; });
  return { columns, rows: rows.slice(0, limit), ms, truncated: rows.length > limit };
}
