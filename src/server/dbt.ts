import "server-only";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataPath, withWarehouseClosed } from "./engine";
import { dbtBlockers, dbtProjectFiles } from "@/lib/dbt-project";
import { selectNodes } from "@/lib/dbt-select";
import type { Ctx } from "@/lib/dbt-compile";

// Called indirectly on purpose: the bundler reads a direct path.join with variable parts as a glob over the project, which lists ./data in the build
const joinPath = path.join.bind(path);

const TIMEOUT_MS = Number(process.env.BASALT_DBT_TIMEOUT) || 30 * 60000;
const dbtPath = () => process.env.BASALT_DBT;

function launchDbt(args: string[], cwd: string, timeout = TIMEOUT_MS): Promise<{ code: number | null; log: string }> {
  return new Promise((resolve, reject) => {
    const home = os.tmpdir();
    // only what dbt needs to start: server secrets in the environment aren't passed on, so Jinja's env_var can't reach them
    const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: home, TMP: home, HOME: home, USERPROFILE: home, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", DBT_SEND_ANONYMOUS_USAGE_STATS: "false", DO_NOT_TRACK: "1" } as unknown as NodeJS.ProcessEnv;
    // Called indirectly on purpose: a direct spawn() makes the bundler treat the project as files this process needs, which adds ./data
    // to the build's file list. That fails on locked database files and would ship customer data in the build output.
    const launch = childProcess.spawn.bind(childProcess);
    const p = launch(dbtPath()!, ["--no-use-colors", ...args], { cwd, env });
    let log = "", timedOut = false;
    const add = (d: Buffer) => { log = (log + d.toString()).slice(-20000); };
    p.stdout.on("data", add); p.stderr.on("data", add);
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, timeout);
    p.on("error", (e) => { clearTimeout(timer); reject(new Error(`dbt couldn't start from ${dbtPath()}: ${e.message}`)); });
    p.on("close", (code) => { clearTimeout(timer); if (timedOut) reject(new Error(`dbt ran for more than ${Math.round(timeout / 60000)} minutes and was stopped.`)); else resolve({ code, log }); });
  });
}

let version: string | null | undefined;
/** The installed dbt, or null when BASALT_DBT is unset or broken, which leaves the built-in builder in charge. */
export async function dbtVersion(): Promise<string | null> {
  if (!dbtPath()) return null;
  if (version) return version;
  try { version = /installed:\s*([\d.]+)/.exec((await launchDbt(["--version"], os.tmpdir(), 60000)).log)?.[1] ?? null; } catch { version = null; }
  return version;
}
/** Why this project can't use dbt right now, or null when it can. */
export async function dbtUnavailable(ctx: Ctx): Promise<string | null> {
  if (!dbtPath()) return "dbt isn't enabled";
  if (!(await dbtVersion())) return "dbt couldn't start";
  const blocked = dbtBlockers(ctx);
  return blocked.length ? `dbt can't build ${blocked.join(", ")}` : null;
}

function writeProject(ctx: Ctx, file: string) {
  const dir = dataPath(`dbt${path.sep}project`);
  // Regenerated each time, so nothing removed from Basalt lingers, and stale results can't pass for this run's
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [name, text] of Object.entries(dbtProjectFiles(ctx, file))) { const p = joinPath(dir, ...name.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  return dir;
}
const artifact = (dir: string, name: string) => { try { return JSON.parse(fs.readFileSync(joinPath(dir, "target", name), "utf8")); } catch { return null; } };
const inDir = (dir: string) => ["--project-dir", dir, "--profiles-dir", dir];

/** dbt seed, then dbt build, with the warehouse closed for both. Seeds go first in their own target, as only that target can read files. */
export function dbtBuild(ctx: Ctx, o: { select?: string; exclude?: string; fullRefresh?: boolean }) {
  return withWarehouseClosed(async (file) => {
    const dir = writeProject(ctx, file), full = o.fullRefresh ? ["--full-refresh"] : [], results: unknown[] = [];
    const seeds = selectNodes(ctx, o.select, o.exclude).filter((n) => ctx.byName.get(n)?.kind === "seed");
    if (seeds.length) {
      const r = await launchDbt(["seed", "--target", "seed", "--select", seeds.join(" "), ...full, ...inDir(dir)], dir), got = artifact(dir, "run_results.json");
      if (!got) throw new Error(r.log.trim().slice(-2000) || `dbt seed exited with code ${r.code}.`);
      results.push(...got.results);
      if (r.code !== 0) return { results: { results }, manifest: artifact(dir, "manifest.json"), log: r.log };
      fs.rmSync(joinPath(dir, "target", "run_results.json"), { force: true });
    }
    const r = await launchDbt(["build", ...(o.select ? ["--select", o.select] : []), "--exclude", `resource_type:seed${o.exclude ? ` ${o.exclude}` : ""}`, ...full, ...inDir(dir)], dir), got = artifact(dir, "run_results.json");
    if (!got) throw new Error(r.log.trim().slice(-2000) || `dbt build exited with code ${r.code}.`);
    results.push(...got.results);
    return { results: { ...got, results }, manifest: artifact(dir, "manifest.json"), log: r.log };
  });
}
export const dbtFreshness = (ctx: Ctx) => withWarehouseClosed(async (file) => {
  const dir = writeProject(ctx, file), r = await launchDbt(["source", "freshness", ...inDir(dir)], dir), got = artifact(dir, "sources.json");
  if (!got) throw new Error(r.log.trim().slice(-2000) || `dbt source freshness exited with code ${r.code}.`);
  return got;
});
export const dbtDocs = (ctx: Ctx) => withWarehouseClosed(async (file) => {
  const dir = writeProject(ctx, file), r = await launchDbt(["docs", "generate", ...inDir(dir)], dir), manifest = artifact(dir, "manifest.json"), catalog = artifact(dir, "catalog.json");
  if (!manifest || !catalog) throw new Error(r.log.trim().slice(-2000) || `dbt docs generate exited with code ${r.code}.`);
  return { manifest, catalog };
});
