import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDue, rowsToResult, runCells, type NotebookCell } from "@/lib/notebook";
import { CELL_RUNNER } from "@/lib/pythonRunner";
import type { Result, Run } from "@/lib/types";
import { raise, resolve } from "./alerts";
import { runSql } from "./engine";
import { audit, getConfig, getRuns, saveRun } from "./files";
import { notebookLineage } from "./openlineage";
import { runPythonFiles } from "./python";

// Called indirectly on purpose: the bundler reads a direct path.join with variable parts as a glob over the project, which lists ./data in the build
const joinPath = path.join.bind(path);

const SESSIONS = joinPath(os.tmpdir(), "basalt-notebook-sessions"), SESSION_HOURS = 24;
/** Where a notebook session's variables are saved between cells. Sessions nobody has used for a day are removed. */
function sessionFile(session: string) {
  if (!/^[\w-]{4,64}$/.test(session)) throw new Error("That notebook session isn't valid.");
  // Saved variables can hold real data, so only this server user can read them
  fs.mkdirSync(SESSIONS, { recursive: true, mode: 0o700 });
  const old = Date.now() - SESSION_HOURS * 3600000;
  for (const f of fs.readdirSync(SESSIONS)) { const p = joinPath(SESSIONS, f); try { if (fs.statSync(p).mtimeMs < old) fs.rmSync(p, { force: true }); } catch { /* another cell may have just removed it */ } }
  return joinPath(SESSIONS, `${session}.pkl`);
}
export const endSession = (session: string) => { fs.rmSync(sessionFile(session), { force: true }); };

/**
 * Runs one Python cell in its own process. It reads earlier cells through `results`, and display(rows) sets what it shows.
 * Variables, functions, classes and imports carry to the next cell in the same session.
 */
export async function runPythonCell(code: string, earlier: Record<string, Result>, session?: string): Promise<Result & { log: string }> {
  const saved = session ? sessionFile(session) : null;
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "basalt-nb-")), started = Date.now();
  try {
    fs.writeFileSync(joinPath(dir, "runner.py"), CELL_RUNNER);
    if (saved && fs.existsSync(saved)) fs.copyFileSync(saved, joinPath(dir, "state.pkl"));
    fs.writeFileSync(joinPath(dir, "user_code.py"), code);
    fs.writeFileSync(joinPath(dir, "input.json"), JSON.stringify(Object.fromEntries(Object.entries(earlier).map(([k, r]) => [k, r.rows]))));
    // Kept even when the cell fails, as what it made before failing still exists in a notebook
    const keepState = () => { if (saved && fs.existsSync(joinPath(dir, "state.pkl"))) fs.copyFileSync(joinPath(dir, "state.pkl"), saved); };
    let log: string;
    try { log = await runPythonFiles(dir); } finally { keepState(); }
    const rows = JSON.parse(fs.readFileSync(joinPath(dir, "output.json"), "utf8")) as Record<string, unknown>[];
    return { ...rowsToResult(rows, Date.now() - started), log: log.trim() };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}


/** Runs a saved notebook from top to bottom and records it with the other jobs. */
export async function runNotebook(id: string, trigger: Run["trigger"], actor: string): Promise<Run> {
  const n = getConfig().notebooks?.find((x) => x.id === id);
  if (!n) throw new Error("This notebook no longer exists.");
  const run: Run = { id: crypto.randomUUID(), kind: "notebook", refId: id, name: n.name, status: "running", startedAt: new Date().toISOString(), trigger, actor };
  const lineage = notebookLineage(run, n.name, n.cells.filter((c) => c.kind === "sql" && c.source.trim()).map((c) => c.source));
  const touched = await lineage.start();
  saveRun(run);
  // A run starts clean and shares one set of variables from top to bottom
  const session = crypto.randomUUID();
  const execCell = async (c: NotebookCell, earlier: Record<string, Result>): Promise<Result> => (c.kind === "python" ? runPythonCell(c.source, earlier, session) : runSql(c.source, { readOnly: false, limit: 20000 }));
  const { results, failed } = await runCells(n.cells, execCell).finally(() => endSession(session)), ran = Object.keys(results).length, href = `/notebooks?n=${id}`, key = `notebook:${id}`;
  const done: Run = { ...run, status: failed ? "failed" : "succeeded", endedAt: new Date().toISOString(), summary: failed ? `Cell ${failed.index + 1} failed: ${failed.message}`.slice(0, 500) : `Ran ${ran} cell${ran === 1 ? "" : "s"}` };
  lineage.finish(touched, done.status, failed?.message);
  saveRun({ ...done, artifacts: run.artifacts });
  if (failed) await raise(key, "bad", `Notebook failed: ${n.name}`, done.summary!, href); else await resolve(key, `Notebook recovered: ${n.name}`, href);
  audit(actor, `Ran notebook ${n.name}`, done.summary);
  return done;
}

export async function runDueNotebooks() {
  const runs = getRuns(), now = Date.now();
  for (const n of getConfig().notebooks ?? []) if (isDue(n, runs.find((r) => r.kind === "notebook" && r.refId === n.id)?.startedAt, now)) await runNotebook(n.id, "schedule", "Schedule").catch(console.error);
}
