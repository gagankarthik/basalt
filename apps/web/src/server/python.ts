import "server-only";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { toResult } from "./engine";
import { refsOf, sourcesOf } from "@/lib/graph";
import { MODEL_RUNNER } from "@/lib/pythonRunner";
import { q, table } from "@/lib/sql";
import type { Model } from "@/lib/types";

// Called indirectly on purpose: the bundler reads a direct path.join with variable parts as a glob over the project, which lists ./data in the build
const joinPath = path.join.bind(path);

const MAX_INPUT_ROWS = 500000, TIMEOUT_MS = 300000;

/** The version of Python this server would use, or null if there isn't one. */
export function pythonVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const launch = childProcess.execFile.bind(childProcess);
    launch(process.env.BASALT_PYTHON ?? "python", ["--version"], { timeout: 10000 }, (err, out, errOut) => resolve(err ? null : String(out || errOut).trim() || null));
  });
}

/** Runs runner.py in dir with its fixed input, output and code files, as a separate process with no server secrets. */
export function runPythonFiles(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // only what Python needs to start: server secrets in the environment aren't passed on
    const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: dir, TMP: dir, HOME: dir, PYTHONIOENCODING: "utf-8" } as unknown as NodeJS.ProcessEnv;
    // Called indirectly on purpose: a direct spawn() makes the bundler treat the project as files this process needs, which adds ./data
    // to the build's file list. That fails on locked database files and would ship customer data in the build output.
    const launch = childProcess.spawn.bind(childProcess);
    const p = launch(process.env.BASALT_PYTHON ?? "python", ["-I", "runner.py", "input.json", "output.json", "user_code.py"], { cwd: dir, env });
    let log = "";
    const add = (d: Buffer) => { log = (log + d.toString()).slice(-4000); };
    p.stdout.on("data", add); p.stderr.on("data", add);
    const timer = setTimeout(() => { p.kill(); reject(new Error("This Python code ran for more than 5 minutes and was stopped.")); }, TIMEOUT_MS);
    p.on("error", () => { clearTimeout(timer); reject(new Error("Python isn't available on this server. Contact your administrator.")); });
    p.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(log); else reject(new Error(log.trim() || `Python exited with code ${code}.`)); });
  });
}

function columnType(values: unknown[]) {
  const set = values.filter((v) => v != null);
  if (!set.length) return "VARCHAR";
  if (set.every((v) => typeof v === "boolean")) return "BOOLEAN";
  if (set.every((v) => typeof v === "number")) return set.every(Number.isInteger) ? "BIGINT" : "DOUBLE";
  return "VARCHAR";
}

/** Runs model(dbt, session) or transform(tables) in a separate process and stores what it returns. Inputs come from the warehouse, so personal data is already masked. */
export async function buildPythonModel(c: DuckDBConnection, m: Model): Promise<string> {
  const read = async (full: string) => toResult(await c.runAndReadAll(`SELECT * FROM ${table(full)} LIMIT ${MAX_INPUT_ROWS}`), Date.now(), MAX_INPUT_ROWS).rows;
  const refs: Record<string, unknown[]> = {}, sources: Record<string, unknown[]> = {};
  for (const r of refsOf(m.sql)) refs[r] = await read(`analytics.${r}`);
  for (const s of sourcesOf(m.sql)) sources[s] = await read(s);
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "basalt-py-"));
  try {
    fs.writeFileSync(joinPath(dir, "runner.py"), MODEL_RUNNER);
    fs.writeFileSync(joinPath(dir, "user_code.py"), m.python ?? "");
    fs.writeFileSync(joinPath(dir, "input.json"), JSON.stringify({ refs, sources }));
    const log = await runPythonFiles(dir);
    const rows = JSON.parse(fs.readFileSync(joinPath(dir, "output.json"), "utf8")) as Record<string, unknown>[];
    if (!rows.length) throw new Error("This Python model returned no rows.");
    const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    await c.run(`CREATE OR REPLACE TEMP TABLE _py (${names.map((n) => `${q(n)} VARCHAR`).join(", ")})`);
    const app = await c.createAppender("_py", "main", "temp");
    for (const r of rows) {
      for (const n of names) { const v = r[n]; if (v == null) app.appendNull(); else app.appendVarchar(typeof v === "object" ? JSON.stringify(v) : String(v)); }
      app.endRow();
    }
    app.closeSync();
    const sel = names.map((n) => `TRY_CAST(${q(n)} AS ${columnType(rows.map((r) => r[n]))}) AS ${q(n)}`).join(", ");
    await c.run(`CREATE OR REPLACE TABLE "analytics".${q(m.name)} AS SELECT ${sel} FROM _py`);
    await c.run(`DROP TABLE _py`);
    return `Python returned ${rows.length} rows${log.trim() ? `. Output: ${log.trim().slice(-300)}` : ""}`;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
