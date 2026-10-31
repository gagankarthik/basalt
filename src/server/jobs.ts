import "server-only";
import crypto from "node:crypto";
import type { DuckDBConnection } from "@duckdb/node-api";
import { withConn, qualified, sourceStore } from "./engine";
import { openSource, type Source } from "./connectors";
import { audit, getConfig, readJson, writeJson, getRuns, getStreamState, maskSalt, saveRun, saveStreamState } from "./files";
import { getAlertSettings, raise, resolve } from "./alerts";
import { getCdcStatus, holdChanges, releaseChanges, takeDirtyPipelines } from "./cdc";
import { runScheduledAutomations } from "./bases";
import { runDataAlerts } from "./apps";
import { runSubscriptions } from "./subscriptions";
import { runScheduledExports } from "./exports";
import { startBuildLineage, startSyncLineage, tickLineage, withFlowLineage } from "./openlineage";
import type { RunRef } from "@/lib/openlineage";
import { hoursStale, shouldRetry, withDownstream } from "@/lib/schedule";
import { buildPythonModel } from "./python";
import { SAMPLE_SQL } from "./seed";
import { topoSort } from "@/lib/graph";
import { buildManifest, buildNode, runTest, sourceFreshness, buildCatalog } from "@/lib/dbt-build";
import { effectiveOf, makeCtx, type Ctx } from "@/lib/dbt-compile";
import { readDbtResults } from "@/lib/dbt-project";
import { nodeId, selectNodes } from "@/lib/dbt-select";
import { dbtBuild, dbtDocs, dbtFreshness, dbtUnavailable, dbtVersion } from "./dbt";
import { detectPii, maskExpr, scanStructured, STRUCTURED_SQL } from "@/lib/pii";
import { fromTextSql, isNestedType } from "@/lib/nested";
import { lit, q } from "@/lib/sql";
import type { Column, LogMessage, Model, Pipeline, Run, StreamCfg, StreamStat } from "@/lib/types";

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export async function ensureSampleSource() {
  await withConn(async (c) => {
    const r = await c.runAndReadAll(`SELECT count(*) n FROM information_schema.tables WHERE table_schema = 'sample'`);
    if (Number(r.getRowObjectsJson()[0].n) === 0) await c.run(`BEGIN; ${SAMPLE_SQL}; COMMIT;`);
  }, sourceStore());
}

/** Column rule for this sync. Personal data without a rule is held back, so a new column can't leak on the next sync. */
export async function classify(src: Source, s: StreamCfg, columns: Column[]) {
  const copied: { col: Column; expr: string }[] = [], heldBack: string[] = [], salt = maskSalt();
  for (const col of columns) {
    let rule = s.rules[col.name];
    if (!rule) {
      const found = detectPii(col.name, await src.sample(s.name, col.name));
      if (found) { heldBack.push(col.name); continue; }
      rule = "keep";
    }
    const expr = maskExpr(col.name, rule, salt);
    if (expr) copied.push({ col, expr });
  }
  return { copied, heldBack };
}

/** Every loaded row of a column kept without a rule. A sample can't promise what later rows or later syncs hold in a nested field. */
async function nestedFinding(c: DuckDBConnection, column: string) {
  const r = await c.stream(`SELECT ${q(column)} FROM _load WHERE regexp_matches(${q(column)}, ${lit(STRUCTURED_SQL)})`), seen = new Set<string>();
  let found: ReturnType<typeof scanStructured> = null;
  // Read to the end even after a find: the connection can't run anything else while a result is open
  for (;;) {
    const chunk = await r.fetchChunk();
    if (!chunk || chunk.rowCount === 0) return found;
    if (!found) for (const [v] of chunk.getRows()) { found = scanStructured(column, String(v), seen); if (found) break; }
  }
}

async function syncStream(src: Source, slug: string, s: StreamCfg, columns: Column[], state: Record<string, string>, log: (m: Omit<LogMessage, "at">) => void): Promise<StreamStat> {
  const stat: StreamStat = { name: s.name, status: "ok", read: 0, written: 0, heldBack: [] };
  const { copied, heldBack } = await classify(src, s, columns);
  stat.heldBack = heldBack;
  if (heldBack.length) log({ type: "LOG", level: "WARN", stream: s.name, message: `Held back until a rule is chosen: ${heldBack.join(", ")}` });
  const schema = `raw_${slug}`, name = s.name.replace(/\W/g, "_"), dest = qualified(schema, name);
  const after = s.mode === "full_refresh" ? undefined : state[s.name];
  if (!copied.length) { log({ type: "LOG", level: "WARN", stream: s.name, message: "Nothing to copy: every column is held back or left out" }); return stat; }

  await withConn(async (c) => {
    await c.run(`CREATE SCHEMA IF NOT EXISTS ${q(schema)}`);
    // Raw rows live only in this connection's TEMP table, in memory. Only masked output is written to the warehouse file.
    await c.run(`CREATE OR REPLACE TEMP TABLE _load (${copied.map((x) => `${q(x.col.name)} VARCHAR`).join(", ")})`);
    const app = await c.createAppender("_load", "main", "temp");
    const opts = { columns: copied.map((x) => x.col), cursor: s.mode === "full_refresh" ? undefined : s.cursor, after, maxRows: s.maxRows, orderBy: s.primaryKey, inclusive: s.mode === "incremental_dedupe" && !!s.primaryKey, state: s.mode === "full_refresh" ? undefined : state, withheld: Object.keys(s.rules).filter((k) => s.rules[k] !== "keep"), log };
    const fast = await src.fastRead?.(s.name, opts);
    if (fast) {
      for await (const chunk of fast) {
        app.appendDataChunk(chunk);
        stat.read += chunk.rowCount;
        app.flushSync();
        log({ type: "RECORD", stream: s.name, records: chunk.rowCount });
      }
    } else await src.read(s.name, opts, async (rows) => {
      for (const row of rows) {
        for (const v of row) { if (v == null) app.appendNull(); else app.appendVarchar(v); }
        app.endRow();
      }
      stat.read += rows.length;
      app.flushSync();
      log({ type: "RECORD", stream: s.name, records: rows.length });
    });
    app.closeSync();
    for (const x of [...copied]) {
      if (s.rules[x.col.name] || !(isNestedType(x.col.type) || /^VARCHAR$/i.test(x.col.type))) continue;
      const found = await nestedFinding(c, x.col.name);
      if (!found) continue;
      copied.splice(copied.indexOf(x), 1); heldBack.push(x.col.name);
      log({ type: "LOG", level: "WARN", stream: s.name, message: `Held back until a rule is chosen: ${x.col.name} (${found.kind} in ${found.path})` });
    }
    if (!copied.length) { await c.run("DROP TABLE _load"); log({ type: "LOG", level: "WARN", stream: s.name, message: "Nothing to copy: every column is held back or left out" }); return; }
    // A nested value that doesn't fit its type becomes empty, which must not go unnoticed
    for (const x of copied) if (isNestedType(x.col.type)) {
      const lost = Number((await c.runAndReadAll(`SELECT count(*) n FROM _load WHERE ${q(x.col.name)} IS NOT NULL AND ${fromTextSql(x.col.name, x.col.type)} IS NULL`)).getRowObjectsJson()[0].n);
      if (lost) log({ type: "LOG", level: "WARN", stream: s.name, message: `${lost} values in ${x.col.name} didn't fit ${x.col.type} and were left empty` });
    }
    const typed = copied.map((x) => `${fromTextSql(x.col.name, x.col.type)} AS ${q(x.col.name)}`).join(", ");
    // A view, not a table: holding 2 million rows twice took most of a large sync
    await c.run(`CREATE OR REPLACE TEMP VIEW _typed AS SELECT ${typed} FROM _load`);
    const masked = copied.map((x) => x.expr).join(", ");
    const payload = `SELECT ${masked}, now()::TIMESTAMP AS _basalt_synced_at FROM _typed`;
    const exists = Number((await c.runAndReadAll(`SELECT count(*) n FROM information_schema.tables WHERE table_schema = ${lit(schema)} AND table_name = ${lit(name)}`)).getRowObjectsJson()[0].n) > 0;

    if (!exists || s.mode === "full_refresh") {
      await c.run(`CREATE OR REPLACE TABLE ${dest} AS ${payload}`);
    } else {
      // schema drift: columns newly allowed through are added; removed ones stay and fill with NULL
      const have = new Set((await c.runAndReadAll(`SELECT column_name n FROM information_schema.columns WHERE table_schema = ${lit(schema)} AND table_name = ${lit(name)}`)).getRowObjectsJson().map((r) => String(r.n)));
      for (const x of copied) if (!have.has(x.col.name)) {
        // A masked or coded value is text, whatever the source type was
        await c.run(`ALTER TABLE ${dest} ADD COLUMN ${q(x.col.name)} ${["mask", "hash"].includes(s.rules[x.col.name] ?? "") ? "VARCHAR" : x.col.type}`);
        log({ type: "LOG", level: "INFO", stream: s.name, message: `New column added to the copy: ${x.col.name}` });
      }
      // All or nothing: a crash between these two steps must not lose the rows being replaced
      await c.run("BEGIN");
      try {
      if (s.mode === "incremental_dedupe" && s.primaryKey) await c.run(`DELETE FROM ${dest} WHERE ${q(s.primaryKey)} IN (SELECT ${q(s.primaryKey)} FROM _typed)`);
      await c.run(`ALTER TABLE ${dest} ADD COLUMN IF NOT EXISTS "_basalt_synced_at" TIMESTAMP`);
      const names = [...copied.map((x) => q(x.col.name)), q("_basalt_synced_at")].join(", ");
      await c.run(`INSERT INTO ${dest} (${names}) ${payload}`);
      await c.run("COMMIT");
      } catch (e) { await c.run("ROLLBACK").catch(() => {}); throw e; }
    }
    stat.written = stat.read;
    if (s.cursor && s.mode !== "full_refresh" && copied.some((x) => x.col.name === s.cursor) && stat.read > 0) {
      const max = (await c.runAndReadAll(`SELECT max(${q(s.cursor)})::VARCHAR m FROM _typed`)).getRowObjectsJson()[0].m;
      if (max) { state[s.name] = String(max); log({ type: "STATE", stream: s.name, state: { cursor_field: s.cursor, cursor: (s.rules[s.cursor] ?? "keep") === "keep" ? max : "masked" } }); }
    }
    if (s.mode !== "full_refresh" && src.commitState?.(s.name, state)) log({ type: "STATE", stream: s.name, state: { connector_state: "saved" } });
    stat.copyRows = Number((await c.runAndReadAll(`SELECT count(*) n FROM ${dest}`)).getRowObjectsJson()[0].n);
    await c.run(`DROP VIEW _typed; DROP TABLE _load;`);
  });
  if (src.uncounted) return stat;
  stat.sourceRows = await src.count(s.name);
  if (stat.sourceRows !== stat.copyRows && s.mode !== "incremental_append" && !s.maxRows) log({ type: "LOG", level: "WARN", stream: s.name, message: `Row check: source has ${stat.sourceRows}, copy has ${stat.copyRows}` });
  return stat;
}

// On globalThis because the schedule and API routes are bundled separately, and both must see the same runs
const running: Set<string> = ((globalThis as { __basaltRunning?: Set<string> }).__basaltRunning ??= new Set());

/** Nothing survives a restart, so a run still marked running has stopped. Called once at startup. */
export function failInterruptedRuns() {
  const runs = getRuns(), stuck = runs.filter((r) => r.status === "running");
  if (!stuck.length) return;
  const at = now();
  writeJson("runs.json", runs.map((r): Run => (r.status === "running" ? { ...r, status: "failed", endedAt: at, summary: "The server restarted during this run, so it didn't finish. You can start it again." } : r)));
  for (const r of stuck) audit("Basalt", "Marked an interrupted run as failed", r.name);
}

export async function runPipeline(id: string, trigger: Run["trigger"], actor: string, thenModels = true, parent?: RunRef): Promise<Run> {
  const cfg = getConfig(), p: Pipeline | undefined = cfg.pipelines.find((x) => x.id === id);
  if (!p) throw new Error("This pipeline no longer exists.");
  const conn = cfg.connections.find((c) => c.id === p.connectionId);
  if (!conn) throw new Error("This pipeline's connection was removed.");
  if (running.has(id)) throw new Error("This pipeline is already running.");
  running.add(id);
  holdChanges(id);
  const run: Run = { id: uid(), kind: "sync", refId: id, name: p.name, status: "running", startedAt: now(), trigger, actor, streams: [], messages: [] };
  const log = (m: Omit<LogMessage, "at">) => {
    const msgs = run.messages!, last = msgs[msgs.length - 1];
    if (m.type === "RECORD" && last?.type === "RECORD" && last.stream === m.stream) { last.records = (last.records ?? 0) + (m.records ?? 0); return; }
    msgs.push({ ...m, at: now() });
  };
  const ol = startSyncLineage(run, p, conn, parent);
  saveRun(run);
  const allState = getStreamState(), state = { ...(allState[id] ?? {}) };
  let src: Source | undefined;
  try {
    if (conn.type === "sample") await ensureSampleSource();
    src = await openSource(conn);
    log({ type: "LOG", level: "INFO", message: `CHECK ${(await src.check()).join("; ")}` });
    const catalog = await src.discover();
    log({ type: "CATALOG", catalog: { streams: catalog.map((c) => ({ name: c.name, json_schema: Object.fromEntries(c.columns.map((x) => [x.name, x.type])) })) } });
    for (const s of p.streams.filter((x) => x.enabled)) {
      const info = catalog.find((c) => c.name === s.name);
      if (!info) { run.streams!.push({ name: s.name, status: "failed", read: 0, written: 0, heldBack: [], error: "Table not found in the source" }); log({ type: "TRACE", level: "ERROR", stream: s.name, message: "Table not found in the source" }); continue; }
      log({ type: "TRACE", level: "INFO", stream: s.name, message: "STARTED" });
      try {
        const stat = await syncStream(src, conn.slug, s, info.columns, state, log);
        run.streams!.push(stat);
        log({ type: "TRACE", level: "INFO", stream: s.name, message: "COMPLETE" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        run.streams!.push({ name: s.name, status: "failed", read: 0, written: 0, heldBack: [], error: msg });
        log({ type: "TRACE", level: "ERROR", stream: s.name, message: msg });
      }
      // After every table, so a crash later in the run can't make this one copy its rows again
      saveStreamState({ ...getStreamState(), [id]: state });
      ol.progress();
    }
    const failed = run.streams!.filter((s) => s.status === "failed").length;
    run.status = failed === 0 ? "succeeded" : failed === run.streams!.length ? "failed" : "partial";
    const rows = run.streams!.reduce((a, s) => a + s.read, 0);
    run.summary = `${rows.toLocaleString("en-US")} rows from ${run.streams!.length} tables${failed ? `, ${failed} failed` : ""}`;
  } catch (e) {
    run.status = "failed";
    run.summary = e instanceof Error ? e.message : String(e);
    log({ type: "TRACE", level: "ERROR", message: run.summary });
  } finally {
    await src?.close().catch(() => {});
    running.delete(id);
    releaseChanges(id);
  }
  run.endedAt = now();
  await ol.finish();
  saveRun(run);
  audit(actor, `Ran sync: ${p.name}`, run.summary ?? "");
  await alertForSync(p.id, p.name, run);
  if (thenModels && p.runModelsAfter && run.status !== "failed" && cfg.models.length) await runModels(trigger, actor).catch(() => {});
  return run;
}

async function alertForSync(id: string, name: string, run: Run) {
  const s = getAlertSettings(), href = `/runs?r=${run.id}`, key = `sync:${id}`, rowKey = `rows:${id}`;
  if (run.status === "failed" || run.status === "partial") { if (s.onSyncFailure) await raise(key, "bad", `Sync failed: ${name}`, run.summary ?? "", href); }
  else await resolve(key, `Sync recovered: ${name}`, href);
  const cfg = getConfig().pipelines.find((p) => p.id === id);
  const off = (run.streams ?? []).filter((x) => { const c = cfg?.streams.find((y) => y.name === x.name); return x.status === "ok" && x.sourceRows != null && c?.mode !== "incremental_append" && !c?.maxRows && x.sourceRows !== x.copyRows; });
  if (off.length) { if (s.onRowMismatch) await raise(rowKey, "warn", `Row counts differ: ${name}`, off.map((x) => `${x.name}: source ${x.sourceRows}, copy ${x.copyRows}`).join("; "), href); }
  else if (run.status === "succeeded") await resolve(rowKey, `Row counts match again: ${name}`, href);
}

export async function runModels(trigger: Run["trigger"], actor: string, only?: string, fullRefresh = false, downstream = false, parent?: RunRef, sel?: { select?: string; exclude?: string }): Promise<Run> {
  const cfg = getConfig();
  const run: Run = { id: uid(), kind: "models", refId: sel ? `select:${sel.select ?? ""}` : only ?? "all", name: sel ? `Selection: ${[sel.select, sel.exclude && `excluding ${sel.exclude}`].filter(Boolean).join(" ")}` : only ? `Model: ${only}${downstream ? " and what depends on it" : ""}` : "All models", status: "running", startedAt: now(), trigger, actor };
  const ol = startBuildLineage(run, cfg, only, downstream, parent);
  saveRun(run);
  const results: Record<string, unknown>[] = [];
  const failed = new Set<string>();
  let okCount = 0, failCount = 0, skipped = 0, warned = 0, ctx: Ctx | undefined, dbtManifest: Record<string, unknown> | undefined, note = "";
  try {
    const project = (ctx = makeCtx(cfg.models, cfg.project));
    const eff = (m: Model) => effectiveOf(m, project), wanted = sel ? new Set(selectNodes(project, sel.select, sel.exclude)) : only && downstream ? withDownstream(cfg.models.map((m) => ({ name: m.name, refs: eff(m).deps })), only) : null;
    if (sel && !wanted!.size) throw new Error("Nothing matches that selection.");
    const order = topoSort(cfg.models, (m) => eff(m).deps).filter((m) => (wanted ? wanted.has(m.name) : !only || m.name === only));
    const why = await dbtUnavailable(project);
    if (!why) {
      const got = await dbtBuild(project, { select: sel ? sel.select : only ? (downstream ? `${only}+` : only) : undefined, exclude: sel?.exclude, fullRefresh });
      const read = readDbtResults(got.results, project);
      results.push(...read.results); okCount = read.okCount; failCount = read.failCount; skipped = read.skipped; warned = read.warned;
      if (got.manifest) { const { metadata: dm, nodes: dn, sources: ds, exposures: de, parent_map: dp, child_map: dc } = got.manifest; dbtManifest = { metadata: dm, nodes: dn, sources: ds, exposures: de, parent_map: dp, child_map: dc }; }
      order.forEach((m) => ol.model(m));
    } else {
      if (process.env.BASALT_DBT) note = ` Used the built-in builder: ${why}.`;
      await withConn(async (c) => {
        for (const m of order) {
          const e = eff(m), uidNode = nodeId(e), t0 = Date.now();
          ol.model(m);
          if (e.deps.some((r) => failed.has(r))) {
            failed.add(m.name); skipped++;
            results.push({ unique_id: uidNode, status: "skipped", execution_time: 0, message: "An upstream model failed" });
            continue;
          }
          let swapping = false;
          try {
            let message: string;
            if (m.kind === "python") {
              const thin = e.deps.find((d) => { const x = project.byName.get(d); return x && eff(x).materialized === "ephemeral"; });
              if (thin) throw new Error(`A Python model can't read the ephemeral model ${thin}, because it isn't stored anywhere.`);
              // Switching kind drops the old one first, so a build that then fails must put it back
              const had = (await c.runAndReadAll(`SELECT table_type t FROM information_schema.tables WHERE table_schema = 'analytics' AND table_name = ${lit(m.name)}`)).getRowObjectsJson()[0]?.t;
              swapping = !!had && had !== "BASE TABLE";
              if (swapping) { await c.run("BEGIN"); await c.run(`DROP VIEW "analytics".${q(m.name)} CASCADE`); }
              message = await buildPythonModel(c, m);
              if (swapping) await c.run("COMMIT");
            } else message = await buildNode(c, e, project, fullRefresh);
            okCount++;
            results.push({ unique_id: uidNode, status: "success", execution_time: (Date.now() - t0) / 1000, message });
          } catch (err) {
            if (swapping) await c.run("ROLLBACK").catch(() => {});
            failed.add(m.name); failCount++;
            results.push({ unique_id: uidNode, status: "error", execution_time: (Date.now() - t0) / 1000, message: err instanceof Error ? err.message : String(err) });
            continue;
          }
          for (const [i, t] of m.tests.entries()) {
            const r = await runTest(c, m, t, i, project);
            if (r.status === "pass" || r.status === "warn") { okCount++; if (r.status === "warn") warned++; } else { failCount++; if (r.status === "fail" && t.block) failed.add(m.name); }
            results.push(r);
          }
        }
      });
    }
    run.status = failCount || skipped ? (okCount ? "partial" : "failed") : "succeeded";
    run.summary = `${okCount} passed, ${failCount} failed, ${skipped} skipped${warned ? `, ${warned} with warnings` : ""}${note}`;
  } catch (e) {
    run.status = "failed";
    run.summary = e instanceof Error ? e.message : String(e);
  }
  run.endedAt = now();
  const metadata = { generated_at: run.endedAt, invocation_id: run.id, adapter_type: "duckdb" };
  run.artifacts = { ...run.artifacts, manifest: dbtManifest ?? (ctx ? buildManifest(ctx, metadata) : { metadata, nodes: {} }), run_results: { metadata, results, elapsed_time: (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000 } };
  await ol.finish(results as never);
  saveRun(run);
  audit(actor, `Ran models: ${run.name}`, run.summary ?? "");
  if (!only && !sel) {
    const key = "models", href = `/runs?r=${run.id}`, bad = failCount > 0 || skipped > 0 || run.status === "failed";
    if (bad && getAlertSettings().onCheckFailure) await raise(key, "bad", "Model build had failures", run.summary ?? "", href);
    else if (!bad) await resolve(key, "Model builds are healthy", href);
  }
  return run;
}

/** Every active pipeline, then the models once, but only if nothing failed upstream. */
export const runFlow = (actor: string) => withFlowLineage(actor, async (parent) => {
  const list = getConfig().pipelines.filter((p) => !p.paused && p.streams.some((s) => s.enabled));
  const synced = []; for (const p of list) synced.push(await runPipeline(p.id, "manual", actor, false, parent));
  const bad = synced.filter((r) => r.status === "failed");
  if (bad.length) return { ok: false, summary: `${bad.length} of ${synced.length} syncs failed, so models weren't built. Open Run history to see why.` };
  if (!getConfig().models.length) return { ok: true, summary: `Synced ${synced.length} pipelines. There are no models to build.` };
  const m = await runModels("manual", actor, undefined, false, false, parent);
  return { ok: m.status === "succeeded", summary: `Synced ${synced.length} pipelines. Models: ${m.summary}` };
});

/* ---- schedule: checked once a minute while the server runs ---- */
/** dbt source freshness when dbt is available and someone asks; the schedule always uses the built-in check, so it never closes the warehouse. */
export async function runFreshness(useDbt: boolean) {
  const cfg = getConfig(), ctx = makeCtx(cfg.models, cfg.project);
  const r = useDbt && !(await dbtUnavailable(ctx)) ? await dbtFreshness(ctx) : await withConn((c) => sourceFreshness(c, ctx));
  writeJson("freshness.json", { ...r, checkedAt: now() });
  const bad = (r.results as { unique_id: string; status: string }[]).filter((x) => x.status !== "pass");
  if (bad.length) await raise("freshness", bad.some((x) => x.status !== "warn") ? "bad" : "warn", "Source data is out of date", bad.map((x) => `${x.unique_id.replace("source.basalt.", "")}: ${x.status}`).join("; "), "/models");
  else await resolve("freshness", "Source data is up to date", "/models");
  return r;
}
export const lastFreshness = () => readJson<Record<string, unknown> | null>("freshness.json", null);
/** The generated docs: real dbt's when it's available, otherwise the same files built here. */
export async function projectDocs() {
  const cfg = getConfig(), ctx = makeCtx(cfg.models, cfg.project), why = await dbtUnavailable(ctx);
  if (!why) return { engine: `dbt ${await dbtVersion()}`, ...(await dbtDocs(ctx)) };
  return { engine: "built-in", manifest: buildManifest(ctx, { generated_at: now() }), catalog: await withConn((c) => buildCatalog(c, ctx)) };
}

export async function runDuePipelines() {
  if (getConfig().project?.sources?.some((s) => s.warnAfter || s.errorAfter)) { const at = lastFreshness()?.checkedAt; if (!at || Date.now() - Date.parse(String(at)) >= 3600000) await runFreshness(false).catch(console.error); }
  tickLineage();
  await runScheduledAutomations().catch(console.error);
  await runSubscriptions().catch(console.error);
  await runDataAlerts().catch(console.error);
  await runScheduledExports().catch(console.error);
  const every = getConfig().settings.buildEvery;
  if (every) { const last = getRuns().find((r) => r.kind === "models" && r.refId === "all"); if (!last || Date.now() - Date.parse(last.startedAt) >= every * 60000) await runModels("schedule", "Schedule").catch(() => {}); }
  const runs = getRuns();
  // Real-time changes reach the raw copy at once; models that depend on them catch up on this one-minute tick
  const pipelines = getConfig().pipelines;
  if (takeDirtyPipelines().some((id) => pipelines.find((p) => p.id === id)?.runModelsAfter)) await runModels("schedule", "Real-time sync").catch(() => {});
  for (const [id, st] of Object.entries(getCdcStatus())) {
    const p = pipelines.find((x) => x.id === id);
    if (!p || !st.enabledAt) continue;
    const last = Date.parse(st.lastAt ?? st.enabledAt), key = `cdc:${id}`;
    // An idle worker still checks in; silence means WAL is building up on the source database
    if (Date.now() - last > 600000) await raise(key, "bad", `Real-time sync stopped: ${p.name}`, "The worker hasn't checked in for 10 minutes. The source database keeps changes until it returns, which uses disk there.", `/pipelines?p=${id}`);
    else await resolve(key, `Real-time sync recovered: ${p.name}`, `/pipelines?p=${id}`);
  }
  for (const p of getConfig().pipelines) {
    if (p.staleHours) { const h = hoursStale(runs, p.id, Date.now()), key = `stale:${p.id}`; if (h == null || h > p.staleHours) await raise(key, "warn", `Data is out of date: ${p.name}`, h == null ? "This pipeline has never finished a sync." : `The last good sync was ${h.toFixed(1)} hours ago. The limit is ${p.staleHours}.`, `/pipelines?p=${p.id}`); else await resolve(key, `Data is up to date: ${p.name}`, `/pipelines?p=${p.id}`); }
    if (!p.paused && shouldRetry(runs, p.id, p.retries ?? 0, Date.now())) { await runPipeline(p.id, "schedule", "Automatic retry").catch(() => {}); continue; }
    if (p.paused || !p.schedule) continue;
    const last = runs.find((r) => r.kind === "sync" && r.refId === p.id);
    if (!last || Date.now() - Date.parse(last.startedAt) >= p.schedule * 60000) await runPipeline(p.id, "schedule", "Schedule").catch(() => {});
  }
}
