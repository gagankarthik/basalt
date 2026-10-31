import "server-only";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataPath } from "./engine";
import { audit, readJson, saveSecret, writeJson } from "./files";
import type { Batch, Source } from "./connectors";
import { configuredStream, fullName, LineSplitter, parseMessage, recordRow, scrubber, secretKeys, secretValues, stateFor, streamInfo, type AirbyteStream, type JsonSchema, type Message } from "@/lib/airbyte";
import { detectPii, piiLabel } from "@/lib/pii";
import type { AirbyteRef, Connection, StreamInfo } from "@/lib/types";

// Called indirectly on purpose: the bundler reads a direct path.join with variable parts as a glob over the project, which lists ./data in the build
const joinPath = path.join.bind(path);

/* Airbyte connectors run unmodified, as separate processes, and talk over the Airbyte Protocol on stdout. No Airbyte code is part of Basalt. */

// registries.airbyte.com answered 526 when this was written, so this is the address Airbyte's own metadata uses
const REGISTRY_URL = "https://connectors.airbyte.com/files/registries/v0/oss_registry.json";
const FILES_URL = "https://connectors.airbyte.com/files/metadata";
const REGISTRY_MAX_AGE = 24 * 3600e3, BATCH = 5000, BATCH_CHARS = 32 * 1024 * 1024, SAMPLE_ROWS = 1000, SAMPLE_VALUES = 50, SAMPLE_MS = 60000, MAX_LOGS = 50;
const CONTROL_MS = 5 * 60000, INSTALL_MS = 15 * 60000, IDLE_MS = 30 * 60000;
const REPO = /^airbyte\/source-[a-z0-9-]+$/, VERSION = /^\d+\.\d+\.\d+[a-z0-9.-]*$/i;

// Called indirectly on purpose: a direct spawn() makes the bundler treat the project as files this process needs, which adds ./data
// to the build's file list. That fails on locked database files and would ship customer data in the build output.
const launch = childProcess.spawn.bind(childProcess);
const launchSync = childProcess.spawnSync.bind(childProcess);
const WIN = process.platform === "win32";

/** Only what a connector needs to start and reach the network: server secrets in the environment aren't passed on. */
function childEnv(dir: string) {
  const env: Record<string, string> = { TEMP: dir, TMP: dir, TMPDIR: dir, HOME: dir, USERPROFILE: dir, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  for (const k of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "WINDIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "PIP_INDEX_URL", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"]) if (process.env[k]) env[k] = process.env[k]!;
  return env as unknown as NodeJS.ProcessEnv;
}

/** A folder only this OS user can open. A failure stops the run rather than leaving credentials readable. */
function privateDir() {
  const dir = fs.mkdtempSync(joinPath(os.tmpdir(), "basalt-ab-"));
  if (WIN) {
    const r = launchSync("icacls", [dir, "/inheritance:r", "/grant:r", `${os.userInfo().username}:(OI)(CI)F`], { windowsHide: true });
    if (r.status !== 0) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error("Basalt couldn't restrict access to the connector's temporary folder."); }
  } else fs.chmodSync(dir, 0o700);
  return dir;
}

/* ---- what's on this server ---- */
function runQuiet(cmd: string, args: string[], ms: number, env: NodeJS.ProcessEnv = childEnv(os.tmpdir()), cwd = os.tmpdir()): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "", done = false;
    const end = (code: number | null) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out }); } };
    const p = launch(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const add = (d: Buffer) => { out = (out + d.toString()).slice(-8000); };
    p.stdout!.on("data", add); p.stderr!.on("data", add);
    const t = setTimeout(() => { killTree(p, undefined); end(null); }, ms);
    p.on("error", () => end(-1)); p.on("close", end);
  });
}

export type Runtime = { docker: boolean; python: string | null; pythonCmd: string | null };
let runtimeCache: { at: number; value: Runtime } | undefined;
export async function runtimeInfo(): Promise<Runtime> {
  if (runtimeCache && Date.now() - runtimeCache.at < 60000) return runtimeCache.value;
  const docker = (await runQuiet("docker", ["version", "--format", "{{.Server.Version}}"], 8000)).code === 0;
  let python: string | null = null, pythonCmd: string | null = null;
  for (const c of process.env.BASALT_PYTHON ? [process.env.BASALT_PYTHON] : ["python", "python3"]) {
    const r = await runQuiet(c, ["--version"], 8000), m = r.code === 0 && /Python (\d+\.\d+\.\d+)/.exec(r.out);
    if (m) { python = m[1]; pythonCmd = c; break; }
  }
  runtimeCache = { at: Date.now(), value: { docker, python, pythonCmd } };
  return runtimeCache.value;
}

/* ---- connector list ---- */
type RegistrySource = { sourceDefinitionId: string; name: string; dockerRepository: string; dockerImageTag: string; iconUrl?: string; license?: string; language?: string; supportLevel?: string; documentationUrl?: string; maxSecondsBetweenMessages?: number; connectorBuildOptions?: { baseImage?: string }; remoteRegistries?: { pypi?: { enabled?: boolean; packageName?: string } }; spec?: { connectionSpecification?: JsonSchema }; ab_internal?: { isEnterprise?: boolean } };
const REGISTRY_FILE = "airbyte-registry.json";
let registryMem: { at: number; list: RegistrySource[] } | undefined;

async function registry(): Promise<RegistrySource[]> {
  if (registryMem && Date.now() - registryMem.at < REGISTRY_MAX_AGE) return registryMem.list;
  const saved = readJson<{ at: number; list: RegistrySource[] } | null>(REGISTRY_FILE, null);
  if (saved && Date.now() - saved.at < REGISTRY_MAX_AGE) { registryMem = saved; return saved.list; }
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = ((await res.json()) as { sources: RegistrySource[] }).sources;
    // Enterprise connectors need a licence from Airbyte, so they aren't offered. Malformed names never reach pip or Docker.
    const list = all.filter((s) => !/enterprise/i.test(s.license ?? "") && !s.ab_internal?.isEnterprise && REPO.test(s.dockerRepository) && VERSION.test(s.dockerImageTag) && s.spec?.connectionSpecification)
      .map((s) => ({ sourceDefinitionId: s.sourceDefinitionId, name: s.name, dockerRepository: s.dockerRepository, dockerImageTag: s.dockerImageTag, iconUrl: s.iconUrl, license: s.license, language: s.language, supportLevel: s.supportLevel, documentationUrl: s.documentationUrl, maxSecondsBetweenMessages: s.maxSecondsBetweenMessages, connectorBuildOptions: s.connectorBuildOptions, remoteRegistries: s.remoteRegistries, spec: { connectionSpecification: s.spec!.connectionSpecification } }));
    registryMem = { at: Date.now(), list };
    writeJson(REGISTRY_FILE, registryMem);
    return list;
  } catch (e) {
    if (saved) return saved.list; // an out-of-date list is still pinned and usable
    throw new Error(`Basalt couldn't read Airbyte's connector list from ${REGISTRY_URL}: ${e instanceof Error ? e.message : e}`);
  }
}

const routesOf = (s: RegistrySource): ("docker" | "pypi" | "manifest")[] => [
  "docker",
  ...(s.remoteRegistries?.pypi?.enabled && s.remoteRegistries.pypi.packageName ? ["pypi" as const] : []),
  ...(s.language === "manifest-only" && cdkOf(s) ? ["manifest" as const] : []),
];
function cdkOf(s: RegistrySource) {
  const m = /source-declarative-manifest:([^@]+)/.exec(s.connectorBuildOptions?.baseImage ?? "");
  return m && VERSION.test(m[1]) ? m[1] : undefined;
}

export async function connectorList() {
  const [list, runtime] = await Promise.all([registry(), runtimeInfo()]);
  return {
    runtime: { docker: runtime.docker, python: runtime.python },
    connectors: list.map((s) => ({ id: s.sourceDefinitionId, name: s.name, repo: s.dockerRepository, version: s.dockerImageTag, license: s.license, support: s.supportLevel, icon: s.iconUrl?.startsWith("https://connectors.airbyte.com/") ? s.iconUrl : undefined, docs: s.documentationUrl, routes: routesOf(s) })),
  };
}
export async function connectorSpec(id: string) {
  const s = (await registry()).find((x) => x.sourceDefinitionId === id);
  if (!s) throw new Error("This connector isn't in Airbyte's connector list.");
  return { id: s.sourceDefinitionId, name: s.name, repo: s.dockerRepository, version: s.dockerImageTag, license: s.license, docs: s.documentationUrl, schema: s.spec!.connectionSpecification! };
}

/** The pinned connector to save on a connection. Everything comes from the registry, never from the browser. */
export async function resolveRef(id: string): Promise<AirbyteRef> {
  const s = (await registry()).find((x) => x.sourceDefinitionId === id);
  if (!s) throw new Error("This connector isn't in Airbyte's connector list.");
  return { definitionId: id, name: s.name, repo: s.dockerRepository, version: s.dockerImageTag, license: s.license, icon: s.iconUrl?.startsWith("https://connectors.airbyte.com/") ? s.iconUrl : undefined, routes: routesOf(s), pypi: s.remoteRegistries?.pypi?.packageName, cdk: cdkOf(s), idleSeconds: s.maxSecondsBetweenMessages, secretKeys: [...secretKeys(s.spec!.connectionSpecification!)] };
}

/* ---- install ---- */
const home = () => process.env.BASALT_AIRBYTE_HOME ?? dataPath("connectors");
const short = (repo: string) => repo.split("/")[1];
const venvBin = (venv: string, name: string) => joinPath(venv, WIN ? "Scripts" : "bin", WIN ? `${name}.exe` : name);
const installs: Map<string, Promise<void>> = ((globalThis as { __basaltAirbyteInstalls?: Map<string, Promise<void>> }).__basaltAirbyteInstalls ??= new Map());

function pipFailure(out: string, pkg: string, python: string) {
  if (/Requires-Python|requires a different Python|No matching distribution/i.test(out)) return `${pkg} doesn't support Python ${python}, the version on this server, so it isn't available. Contact your administrator.`;
  if (/long path|No such file or directory.*site-packages/i.test(out)) return `${pkg} hit a file path limit on this server, so it isn't available. Contact your administrator.`;
  return `Installing ${pkg} failed: ${out.trim().split("\n").slice(-3).join(" ").slice(0, 600)}`;
}

/** A venv with one pinned package. Repeated callers share one install. */
function ensureVenv(folder: string, pkg: string, actor: string): Promise<void> {
  const venv = joinPath(home(), folder), mark = joinPath(venv, ".basalt-installed");
  if (fs.existsSync(mark)) return Promise.resolve();
  const running = installs.get(venv);
  if (running) return running;
  const job = (async () => {
    const rt = await runtimeInfo();
    if (!rt.pythonCmd) throw new Error("Connectors aren't available on this server. Contact your administrator.");
    fs.rmSync(venv, { recursive: true, force: true });
    fs.mkdirSync(home(), { recursive: true });
    audit(actor, "Installing Airbyte connector code", pkg, true);
    const made = await runQuiet(rt.pythonCmd, ["-m", "venv", venv], CONTROL_MS);
    if (made.code !== 0) throw new Error(`Basalt couldn't create a Python environment: ${made.out.slice(-400)}`);
    const pip = await runQuiet(joinPath(venv, WIN ? "Scripts" : "bin", WIN ? "python.exe" : "python"), ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", pkg], INSTALL_MS);
    if (pip.code !== 0) { fs.rmSync(venv, { recursive: true, force: true }); throw new Error(pipFailure(pip.out, pkg, rt.python ?? "")); }
    fs.writeFileSync(mark, new Date().toISOString());
    audit(actor, "Installed Airbyte connector code", pkg, true);
  })().finally(() => installs.delete(venv));
  installs.set(venv, job);
  return job;
}

type Launcher = { cmd: string; args: (verb: string, f: { config: string; catalog?: string; state?: string }) => string[]; docker?: string; route: "docker" | "pypi" | "manifest" };

/** Docker first, because it's the only route that keeps the connector away from this server's files. Installs what the chosen route needs. */
async function launcher(ref: AirbyteRef, actor: string): Promise<Launcher> {
  if (!REPO.test(ref.repo) || !VERSION.test(ref.version)) throw new Error("This connection's connector name or version isn't valid.");
  const rt = await runtimeInfo(), name = short(ref.repo), verbArgs = (verb: string, f: { config: string; catalog?: string; state?: string }, map = (s: string) => s) => [verb, ...(verb === "spec" ? [] : ["--config", map(f.config)]), ...(f.catalog ? ["--catalog", map(f.catalog)] : []), ...(f.state ? ["--state", map(f.state)] : [])];
  if (rt.docker) {
    const container = `basalt-${crypto.randomUUID()}`, user = WIN ? [] : ["--user", `${process.getuid!()}:${process.getgid!()}`];
    return { route: "docker", cmd: "docker", docker: container, args: (verb, f) => ["run", "--rm", "--name", container, "--security-opt", "no-new-privileges", "--cap-drop", "ALL", ...user, "-e", "HOME=/tmp", "-v", `${path.dirname(f.config)}:/basalt:ro`, `${ref.repo}:${ref.version}`, ...verbArgs(verb, f, (s) => `/basalt/${path.basename(s)}`)] };
  }
  if (ref.routes.includes("manifest") && ref.cdk) {
    const manifest = joinPath(home(), "manifests", `${name}-${ref.version}.yaml`);
    if (!fs.existsSync(manifest)) {
      audit(actor, "Downloading Airbyte connector manifest", `${ref.repo}:${ref.version}`, true);
      const res = await fetch(`${FILES_URL}/${ref.repo}/${ref.version}/manifest.yaml`, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`Airbyte's manifest for ${ref.name} ${ref.version} couldn't be downloaded (HTTP ${res.status}), so this connector isn't available. Contact your administrator.`);
      const text = await res.text();
      // shortcut: manifests with custom Python need components.py, which isn't published beside the manifest; these need Docker
      if (text.includes("source_declarative_manifest.components")) throw new Error(`${ref.name} includes custom Python code, which needs container support that isn't available on this server. Contact your administrator.`);
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, text);
    }
    await ensureVenv(`cdk-${ref.cdk}`, `airbyte-cdk==${ref.cdk}`, actor);
    return { route: "manifest", cmd: venvBin(joinPath(home(), `cdk-${ref.cdk}`), "source-declarative-manifest"), args: (verb, f) => [...verbArgs(verb, f), ...(verb === "spec" ? [] : ["--manifest-path", manifest])] };
  }
  if (ref.routes.includes("pypi") && ref.pypi && /^airbyte-source-[a-z0-9-]+$/.test(ref.pypi)) {
    const folder = `${name}-${ref.version}`;
    await ensureVenv(folder, `${ref.pypi}==${ref.version}`, actor);
    return { route: "pypi", cmd: venvBin(joinPath(home(), folder), name), args: verbArgs };
  }
  throw new Error(`${ref.name} is only published as a container image, which this server can't run. Contact your administrator.`);
}

/* ---- running a connector ---- */
type Kid = childProcess.ChildProcess;
/** Ends the process we started and everything under it, found from our own handle, never by name. */
function killTree(p: Kid, docker: string | undefined) {
  if (docker) launch("docker", ["kill", docker], { stdio: "ignore", windowsHide: true }).on("error", () => {});
  if (p.pid == null) return;
  if (WIN) launch("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
  else { try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); } }
}

type Ctl = { cancelled: boolean; kids: Set<{ p: Kid; docker?: string }> };
const active: Map<string, Ctl> = ((globalThis as { __basaltAirbyteActive?: Map<string, Ctl> }).__basaltAirbyteActive ??= new Map());
/** Stops what's running for this connection. The stream fails, nothing partial reaches the warehouse and its state stays where it was. */
export function cancelAirbyte(connectionId: string) {
  const c = active.get(connectionId);
  if (!c) return false;
  c.cancelled = true;
  for (const k of c.kids) killTree(k.p, k.docker);
  return true;
}

export type RunOpts = {
  cmd: string; args: (f: { config: string; catalog?: string; state?: string }) => string[]; docker?: string;
  config: unknown; catalog?: unknown; state?: unknown; ctl: Ctl; label: string; scrub: (s: string) => string;
  /** Hard limit for short verbs; idleMs limits silence during a read. softMs ends the run quietly, for sampling. */
  limitMs?: number; idleMs?: number; softMs?: number;
  onMessage: (m: Message, chars: number) => Promise<void | "stop"> | void | "stop";
  onLog?: (level: "WARN" | "ERROR", message: string) => void;
};

/** One connector process. stdout is pulled only as fast as onMessage finishes, so a slow load slows the connector instead of filling memory. */
export async function runConnector(o: RunOpts): Promise<void> {
  const dir = privateDir();
  let stderr = "", lastError = "", trace = "", incomplete = "", timedOut = "", softStopped = false, kid: { p: Kid; docker?: string } | undefined;
  const write = (name: string, v: unknown) => { const f = joinPath(dir, name); fs.writeFileSync(f, JSON.stringify(v), { mode: 0o600 }); return f; };
  try {
    const files = { config: write("config.json", o.config), catalog: o.catalog ? write("catalog.json", o.catalog) : undefined, state: o.state ? write("state.json", o.state) : undefined };
    if (o.ctl.cancelled) throw new Error("Stopped by an admin.");
    const p = launch(o.cmd, o.args(files), { cwd: dir, env: childEnv(dir), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !WIN });
    kid = { p, docker: o.docker };
    o.ctl.kids.add(kid);
    let spawnError: Error | undefined;
    const closed = new Promise<number | null>((res) => { p.on("error", (e) => { spawnError = e; res(-1); }); p.on("close", (c) => res(c)); });
    p.stderr!.setEncoding("utf8");
    p.stderr!.on("data", (d: string) => { stderr = (stderr + d).slice(-4000); }); // always drained, or a chatty connector would block on a full pipe

    let seen = Date.now(), busy = false, stopped = false;
    const start = Date.now();
    const stop = () => { if (!stopped) { stopped = true; killTree(p, o.docker); } };
    const timer = setInterval(() => {
      if (o.softMs && Date.now() - start > o.softMs) { softStopped = true; stop(); return; }
      if (o.limitMs && Date.now() - start > o.limitMs) { timedOut = `${o.label} didn't finish within ${Math.round(o.limitMs / 60000)} minutes and was stopped.`; stop(); }
      else if (o.idleMs && !busy && Date.now() - seen > o.idleMs) { timedOut = `${o.label} sent nothing for ${Math.round(o.idleMs / 60000)} minutes and was stopped.`; stop(); }
    }, 1000);

    const handle = async (line: string): Promise<boolean> => {
      const m = parseMessage(line);
      if (m.type === "TEXT") { lastError = o.scrub(m.line).slice(0, 500); return false; }
      if (m.type === "LOG") {
        if (/^(ERROR|FATAL)$/.test(m.level)) { lastError = o.scrub(m.message).slice(0, 500); o.onLog?.("ERROR", lastError); }
        else if (m.level === "WARN") o.onLog?.("WARN", o.scrub(m.message).slice(0, 500));
        return false;
      }
      if (m.type === "TRACE_ERROR") { trace ||= o.scrub(m.message).slice(0, 1000); return false; }
      if (m.type === "STREAM_INCOMPLETE") { incomplete = m.stream; return false; }
      busy = true;
      try { return (await o.onMessage(m, line.length)) === "stop"; } finally { busy = false; seen = Date.now(); }
    };

    const split = new LineSplitter();
    p.stdout!.setEncoding("utf8");
    try {
      outer: for await (const chunk of p.stdout! as AsyncIterable<string>) {
        seen = Date.now();
        for (const line of split.push(chunk)) if (await handle(line)) { softStopped = true; break outer; }
      }
      if (!softStopped) for (const line of split.end()) if (await handle(line)) softStopped = true;
    } catch (e) { stop(); throw e; }
    finally { clearInterval(timer); if (softStopped) stop(); }

    // A killed process always closes; the wait is bounded in case something else kept its pipes open
    const code = await Promise.race([closed, new Promise<null>((res) => { const t = setTimeout(() => res(null), stopped ? 15000 : 3600e3); closed.finally(() => clearTimeout(t)); })]);
    if (spawnError) throw new Error(o.docker ? "Docker couldn't start the connector." : `The connector couldn't start: ${(spawnError as Error).message}`);
    if (o.ctl.cancelled) throw new Error("Stopped by an admin.");
    if (timedOut) throw new Error(timedOut);
    if (softStopped) return;
    if (trace) throw new Error(trace);
    if (code !== 0) throw new Error(`${o.label} crashed (exit code ${code}). ${lastError || o.scrub(stderr).trim().split("\n").slice(-3).join(" ").slice(0, 600)}`.trim());
    if (incomplete) throw new Error(`${o.label} reported ${incomplete} as incomplete. ${lastError}`.trim());
  } catch (e) {
    throw new Error(o.scrub(e instanceof Error ? e.message : String(e)));
  } finally {
    if (kid) o.ctl.kids.delete(kid);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/* ---- saved catalog: pages reading a connection must not start third-party code ---- */
const CATALOG_FILE = "airbyte-catalogs.json";
type SavedColumn = { name: string; type: string; pii: string | null; suggested: string | null };
type SavedStream = Omit<StreamInfo, "columns"> & { columns: SavedColumn[] };
const savedCatalogs = () => readJson<Record<string, SavedStream[]>>(CATALOG_FILE, {});
/** The saved catalog, plus columns the last sync held back after scanning every row of a nested value. */
export const cachedInspect = (id: string, last?: { name: string; heldBack: string[] }[]) => ({ checks: [] as string[], streams: (savedCatalogs()[id] ?? []).map((s) => ({ ...s, columns: s.columns.map((c) => (!c.pii && last?.find((x) => x.name === s.name)?.heldBack.includes(c.name) ? { ...c, pii: "Personal data found in a nested field", suggested: "drop" } : c)) })) });
export function forgetCatalog(id: string) { const all = savedCatalogs(); delete all[id]; writeJson(CATALOG_FILE, all); }
function nameFindings(streams: StreamInfo[], before: SavedStream[] = []): SavedStream[] {
  return streams.map((s) => ({ ...s, columns: s.columns.map((c) => {
    const found = detectPii(c.name), prior = before.find((x) => x.name === s.name)?.columns.find((x) => x.name === c.name);
    return { ...c, pii: piiLabel(found) ?? prior?.pii ?? null, suggested: found?.rule ?? prior?.suggested ?? null };
  }) }));
}

/* ---- the Source ---- */
const stateKey = (stream: string) => `airbyte:${stream}`;

export async function airbyteSource(conn: Connection, secret: string, actor = "Schedule"): Promise<Source> {
  const ref = conn.airbyte;
  if (!ref) throw new Error("This connection has no connector set.");
  let config: Record<string, unknown>;
  try { config = JSON.parse(secret || "{}"); } catch { throw new Error("This connection's saved settings can't be read. Remove it and add it again."); }
  let scrub = scrubber(secretValues(config, ref.secretKeys));
  const run = await launcher(ref, actor);
  const ctl: Ctl = { cancelled: false, kids: new Set() };
  if (conn.id) active.set(conn.id, ctl);

  const base = { cmd: run.cmd, docker: run.docker, ctl, label: `${ref.name} ${ref.version}` };
  const go = (verb: string, opts: Partial<RunOpts> & Pick<RunOpts, "onMessage">) => runConnector({
    ...base, config, scrub: (s) => scrub(s), args: (f) => run.args(verb, f), ...opts,
    onMessage: (m, n) => {
      // A connector that rotates a single-use login must keep the new one, or the next sync can't sign in
      if (m.type === "CONFIG_UPDATE") { config = m.config; scrub = scrubber(new Set([...secretValues(config, ref.secretKeys), ...secretValues(m.config, ref.secretKeys)])); if (conn.id) saveSecret(conn.id, JSON.stringify(config)); return; }
      return opts.onMessage(m, n);
    },
  });

  let catalog: AirbyteStream[] | undefined;
  const discoverRaw = async () => {
    let found: AirbyteStream[] | undefined;
    await go("discover", { limitMs: CONTROL_MS, onMessage: (m) => { if (m.type === "CATALOG") found = m.streams; } });
    if (!found) throw new Error(`${ref.name} finished without listing its streams.`);
    catalog = found;
    return found;
  };
  const rawStream = async (name: string) => {
    const s = (catalog ?? await discoverRaw()).find((x) => fullName(x.name, x.namespace) === name);
    if (!s) throw new Error(`${name} isn't a stream of ${ref.name}.`);
    return s;
  };

  const samples = new Map<string, Map<string, string[]>>();
  const pending = new Map<string, string>();
  const idleMs = Math.max(IDLE_MS, (ref.idleSeconds ?? 0) * 1000);

  const source: Source & { uncounted: true; spec?: () => Promise<JsonSchema | undefined> } = {
    uncounted: true,
    spec: run.route === "manifest" ? undefined : async () => {
      let schema: JsonSchema | undefined;
      await go("spec", { limitMs: CONTROL_MS, onMessage: (m) => { if (m.type === "SPEC") schema = m.schema; } });
      return schema;
    },
    async check() {
      let status: { ok: boolean; message?: string } | undefined;
      await go("check", { limitMs: CONTROL_MS, onMessage: (m) => { if (m.type === "STATUS") status = m; } });
      if (!status) throw new Error(`${ref.name} finished without reporting a result.`);
      if (!status.ok) throw new Error(scrub(status.message ?? `${ref.name} rejected these settings.`));
      return [`${ref.name} ${ref.version} accepted these settings`, `Airbyte connector, licence ${ref.license ?? "not stated"}, run through ${run.route === "docker" ? "Docker" : run.route === "pypi" ? "a Python environment" : "Airbyte's manifest runner in a Python environment"}`];
    },
    async discover() {
      const streams = (await discoverRaw()).map(streamInfo);
      if (conn.id) { const all = savedCatalogs(); writeJson(CATALOG_FILE, { ...all, [conn.id]: nameFindings(streams, all[conn.id]) }); }
      return streams;
    },
    /** There's no query to run, so this reads the first rows of the stream once. A failure here fails the stream, so nothing is copied unchecked. */
    async sample(stream, column) {
      let got = samples.get(stream);
      if (!got) {
        const raw = await rawStream(stream), cols = new Map<string, string[]>();
        let rows = 0;
        await go("read", {
          catalog: { streams: [configuredStream(raw, false, undefined)] }, softMs: SAMPLE_MS, idleMs: SAMPLE_MS * 2,
          onMessage: (m) => {
            if (m.type !== "RECORD" || m.stream !== stream) return;
            for (const [k, v] of Object.entries(m.data)) {
              if (v == null) continue;
              const list = cols.get(k) ?? [];
              if (list.length < SAMPLE_VALUES) { list.push(typeof v === "object" ? JSON.stringify(v) : String(v)); cols.set(k, list); }
            }
            return ++rows >= SAMPLE_ROWS ? "stop" : undefined;
          },
        });
        got = cols;
        samples.set(stream, got);
        if (conn.id) { // what values reveal is saved so the personal data page can offer a rule for a column with an unhelpful name
          const all = savedCatalogs(), st = all[conn.id]?.find((s) => s.name === stream);
          if (st) {
            for (const c of st.columns) { const f = detectPii(c.name, got.get(c.name) ?? []); if (f) { c.pii = piiLabel(f); c.suggested = f.rule; } }
            writeJson(CATALOG_FILE, all);
          }
        }
      }
      return got.get(column) ?? [];
    },
    count: async () => { throw new Error("Airbyte connectors don't report a total row count."); },
    async read(stream, opts, onBatch) {
      samples.delete(stream);
      const raw = await rawStream(stream), incremental = !!opts.state, cols = opts.columns;
      const prior = incremental ? opts.state![stateKey(stream)] : undefined;
      const known = new Set(Object.keys(raw.json_schema?.properties ?? {}));
      let batch: Batch = [], chars = 0, total = 0, logs = 0, sawState = false;
      const unknown = new Set<string>();
      const flush = async () => { if (batch.length) { const b = batch; batch = []; chars = 0; await onBatch(b); } };
      await go("read", {
        catalog: { streams: [configuredStream(raw, incremental, opts.cursor)] }, state: prior ? JSON.parse(prior) : undefined, idleMs,
        onLog: (level, message) => { if (logs++ < MAX_LOGS) opts.log?.({ type: "LOG", level, stream, message }); },
        onMessage: async (m, n) => {
          if (m.type === "STATE") {
            const st = stateFor(stream, m.state);
            // Held until the load commits: state saved earlier could skip rows after a crash
            if (st) { sawState = true; await flush(); pending.set(stream, JSON.stringify([st])); }
            return;
          }
          if (m.type !== "RECORD" || m.stream !== stream) return;
          // Only columns that passed classify ever leave this line. A field the catalog never declared has had no personal data check.
          for (const k of Object.keys(m.data)) if (!known.has(k)) unknown.add(k);
          batch.push(recordRow(m.data, cols));
          chars += n;
          total++;
          if (batch.length >= BATCH || chars >= BATCH_CHARS) await flush();
          if (opts.maxRows && total >= opts.maxRows) { await flush(); return "stop"; }
        },
      });
      await flush();
      if (unknown.size) opts.log?.({ type: "LOG", level: "WARN", stream, message: `Not copied, because the connector doesn't declare them: ${[...unknown].slice(0, 20).join(", ")}` });
      if (incremental && !sawState) opts.log?.({ type: "LOG", level: "WARN", stream, message: "The connector sent no state, so the next sync reads every row again." });
    },
    commitState(stream, state) {
      const s = pending.get(stream);
      if (!s) return false;
      state[stateKey(stream)] = s;
      pending.delete(stream);
      return true;
    },
    async close() {
      for (const k of ctl.kids) killTree(k.p, k.docker);
      samples.clear(); pending.clear();
      if (conn.id && active.get(conn.id) === ctl) active.delete(conn.id);
    },
  };
  return source;
}

/** Check and discover for the setup screen. Values aren't sampled here: on a real API every stream would cost a read, so they're checked on each sync, before anything is copied. */
export async function inspectAirbyte(conn: Connection, secret: string, actor: string) {
  const src = await airbyteSource(conn, secret, actor) as Source & { spec?: () => Promise<JsonSchema | undefined> };
  try {
    const checks = await src.check(), streams = await src.discover();
    // The installed connector's own spec has the last word on what counts as secret. The manifest runner only reports a generic one.
    if (conn.airbyte && src.spec) conn.airbyte.secretKeys = [...new Set([...conn.airbyte.secretKeys, ...secretKeys(await src.spec())])];
    return { checks, streams: nameFindings(streams) };
  } finally { await src.close().catch(() => {}); }
}
