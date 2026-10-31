// Writes a real dbt project from Basalt's model config, and reads dbt's artifacts back into run records.
// Everything user-written arrives here already expanded by the safe compiler, and text is escaped so dbt can't read it as Jinja. Secrets are never in the config this reads.
import { auditName, compileForDbt, dbtEscape, effectiveOf, renderSql, testName, testSql, testStatus, type Ctx, type Effective } from "./dbt-compile.ts";
import { q } from "./sql.ts";
import type { Model } from "./types.ts";

const SAFE_NAME = /^[A-Za-z_][\w ]*$/;
const name = (n: string, what: string) => { if (!SAFE_NAME.test(n)) throw new Error(`${what} "${n}" can't be used with dbt.`); return n; };
const py = (v: unknown) => JSON.stringify(v);
/** Python models and history tables from before snapshot strategies have no dbt equivalent, so those projects stay on the built-in builder. */
export function dbtBlockers(ctx: Ctx) {
  return ctx.models.filter((m) => m.kind === "python" || (effectiveOf(m, ctx).materialized === "snapshot" && !effectiveOf(m, ctx).snapshotStrategy)).map((m) => m.name);
}
const keyConfig = (k?: string) => { const l = (k ?? "").split(",").map((s) => s.trim()).filter(Boolean); l.forEach((x) => name(x, "The key")); return l.length > 1 ? l : l[0]; };

function modelSql(e: Effective, ctx: Ctx) {
  const body = compileForDbt(e, ctx);
  if (e.jinja || e.materialized !== "incremental" || !e.cursor) return body;
  const c = q(name(e.cursor, "The cursor")), op = e.uniqueKey ? ">=" : ">";
  return `{% if is_incremental() %}SELECT * FROM (\n${body}\n) WHERE ${c} ${op} (SELECT max(${c}) FROM {{ this }}) OR (SELECT max(${c}) FROM {{ this }}) IS NULL{% else %}${body}{% endif %}`;
}
export function dbtProjectFiles(ctx: Ctx, warehousePath: string): Record<string, string> {
  const files: Record<string, string> = {}, models: unknown[] = [], tables = new Map<string, Map<string, Record<string, unknown>>>();
  files["dbt_project.yml"] = JSON.stringify({ name: "basalt", version: "1.0", "config-version": 2, profile: "basalt", "model-paths": ["models"], "seed-paths": ["seeds"], "test-paths": ["tests"], "snapshot-paths": ["snapshots"], "macro-paths": ["macros"], "target-path": "target", flags: { send_anonymous_usage_stats: false, partial_parse: false } }, null, 1);
  const base = { type: "duckdb", path: warehousePath, schema: "analytics", threads: 1 };
  // Same lock as the warehouse. Only the seed target can read files, and it only ever runs dbt seed on CSV files Basalt wrote.
  files["profiles.yml"] = JSON.stringify({ basalt: { target: "prod", outputs: { prod: { ...base, config_options: { enable_external_access: false, lock_configuration: true } }, seed: base } } }, null, 1);
  if (ctx.project.dbtMacros?.trim()) files["macros/admin.sql"] = ctx.project.dbtMacros;
  const source = (s: string, t: string) => { if (!tables.has(s)) tables.set(s, new Map()); if (!tables.get(s)!.has(t)) tables.get(s)!.set(t, { name: t }); return tables.get(s)!.get(t)!; };
  for (const m of ctx.models) {
    const e = effectiveOf(m, ctx);
    if (e.compileError) throw new Error(`${m.name}: ${e.compileError}`);
    name(m.name, "The model");
    e.srcs.forEach((s) => source(s.slice(4, s.indexOf(".")), s.slice(s.indexOf(".") + 1)));
    const description = dbtEscape(m.description ?? "");
    const columns = [...new Set([...Object.keys(m.columnDocs ?? {}), ...(m.contract ?? []).map((c) => c.name)])].map((n) => {
      const c = m.contract?.find((x) => x.name === n);
      return { name: n, description: dbtEscape(m.columnDocs?.[n] ?? ""), ...(c ? { data_type: dbtEscape(c.type), constraints: [...(c.notNull ? [{ type: "not_null" }] : []), ...(c.unique ? [{ type: "unique" }] : []), ...(c.primaryKey ? [{ type: "primary_key" }] : [])] } : {}) };
    });
    const hookCfg = { ...(e.preHook?.length ? { "pre-hook": e.preHook.map((h) => renderSql(h, ctx, m.name, "dbt")) } : {}), ...(e.postHook?.length ? { "post-hook": e.postHook.map((h) => renderSql(h, ctx, m.name, "dbt")) } : {}) };
    if (m.kind === "seed") { files[`seeds/${m.name}.csv`] = m.csv ?? ""; }
    else if (e.materialized === "snapshot") {
      const cfg = { target_schema: "analytics", unique_key: keyConfig(e.uniqueKey), strategy: e.snapshotStrategy, ...(e.updatedAt ? { updated_at: name(e.updatedAt, "The column") } : {}), ...(e.snapshotStrategy === "check" ? { check_cols: !e.checkCols || e.checkCols === "all" ? "all" : e.checkCols.split(",").map((s) => name(s.trim(), "The column")) } : {}), ...(e.hardDeletes ? { hard_deletes: e.hardDeletes } : {}), ...hookCfg };
      files[`snapshots/${m.name}.sql`] = `{% snapshot ${m.name} %}\n{{ config(**${py(cfg)}) }}\n${compileForDbt(e, ctx)}\n{% endsnapshot %}\n`;
    } else {
      // Hooks go in the file, as dbt renders {{ this }} in them at run time there and at parse time in YAML
      files[`models/${m.name}.sql`] = `${Object.keys(hookCfg).length ? `{{ config(**${py(hookCfg)}) }}
` : ""}${modelSql(e, ctx)}`;
      const inc = e.materialized === "incremental" ? { unique_key: keyConfig(e.uniqueKey), on_schema_change: e.onSchemaChange ?? "ignore", ...(e.incrementalStrategy ? { incremental_strategy: e.incrementalStrategy } : {}) } : {};
      models.push({ name: m.name, description, columns, config: { materialized: e.materialized, tags: e.tags ?? [], ...inc, ...(m.contract?.length ? { contract: { enforced: true } } : {}) } });
    }
    m.tests.forEach((t, i) => {
      const n = auditName(m, i), block = !!t.block && (t.severity ?? "error") === "error";
      // A non-blocking failure mustn't skip models downstream, so dbt sees a warning and the real status comes from testStatus when results are read
      const cfg = block ? { severity: "error", error_if: t.errorIf || "!=0", warn_if: t.warnIf || "!=0" } : { severity: "warn", warn_if: "!=0" };
      testStatus(0, t); // refuses a threshold that can't be read before dbt sees it
      files[`tests/${n}.sql`] = `{{ config(**${py({ ...cfg, ...(t.storeFailures ? { store_failures: true } : {}), tags: e.tags ?? [] })}) }}\n${testSql(m, t, ctx, "dbt")}\n`;
    });
  }
  for (const s of ctx.project.sources ?? []) {
    const r = source(name(s.source, "The source"), name(s.table, "The table"));
    if (s.description) r.description = dbtEscape(s.description);
    if (s.warnAfter || s.errorAfter) // dbt reads a plain TIMESTAMP as UTC, but Basalt's columns hold server-local time, which would make fresh data look hours old
      r.config = { loaded_at_field: `CAST(${q(name(s.loadedAtField || "_basalt_synced_at", "The column"))} AS TIMESTAMPTZ)`, freshness: { ...(s.warnAfter ? { warn_after: s.warnAfter } : {}), ...(s.errorAfter ? { error_after: s.errorAfter } : {}), ...(s.filter ? { filter: dbtEscape(s.filter) } : {}) } };
  }
  const known = new Set(ctx.models.map((m) => m.name));
  const exposures = (ctx.project.exposures ?? []).map((x) => ({ name: name(x.name, "The exposure"), type: x.type, owner: { name: dbtEscape(x.ownerName), ...(x.ownerEmail ? { email: dbtEscape(x.ownerEmail) } : {}) }, ...(x.url ? { url: dbtEscape(x.url) } : {}), ...(x.description ? { description: dbtEscape(x.description) } : {}), ...(x.maturity ? { maturity: x.maturity } : {}), depends_on: x.dependsOn.filter((d) => known.has(d)).map((d) => `ref(${py(d)})`) }));
  files["models/schema.yml"] = JSON.stringify({ version: 2, models, ...(exposures.length ? { exposures } : {}), sources: [...tables].map(([s, t]) => ({ name: s, schema: `raw_${s}`, tables: [...t.values()] })) }, null, 1);
  return files;
}

export type DbtResult = { unique_id: string; status: string; execution_time: number; message: string | null; failures?: number | null };
type RawResults = { results?: { unique_id: string; status: string; execution_time?: number; message?: string | null; failures?: number | null }[] };
/** dbt's run_results.json as Basalt run results: test ids and statuses come out as the built-in builder writes them, so history and checks read the same. */
export function readDbtResults(raw: RawResults, ctx: Ctx) {
  const tests = new Map<string, { m: Model; i: number }>();
  for (const m of ctx.models) m.tests.forEach((_, i) => tests.set(`test.basalt.${auditName(m, i)}`, { m, i }));
  const results: DbtResult[] = [], failed = new Set<string>(); let okCount = 0, failCount = 0, skipped = 0, warned = 0;
  for (const r of raw.results ?? []) {
    const hit = tests.get(r.unique_id), base = { execution_time: r.execution_time ?? 0, message: r.message ?? null };
    if (hit) {
      const t = hit.m.tests[hit.i], unique_id = `test.basalt.${testName(hit.m, t)}`;
      if (r.status === "error" || r.status === "runtime error") { failCount++; results.push({ unique_id, status: "error", failures: null, ...base }); continue; }
      if (r.status === "skipped") { skipped++; results.push({ unique_id, status: "skipped", failures: null, ...base }); continue; }
      const n = Number(r.failures ?? 0), status = testStatus(n, t);
      if (status === "fail") { failCount++; if (t.block) failed.add(hit.m.name); } else { okCount++; if (status === "warn") warned++; }
      results.push({ unique_id, status, failures: n, ...base, message: n ? `${n} rows failed` : null });
      continue;
    }
    if (r.status === "success" || r.status === "no-op") { okCount++; results.push({ unique_id: r.unique_id, status: "success", ...base }); }
    else if (r.status === "skipped") { skipped++; results.push({ unique_id: r.unique_id, status: "skipped", ...base }); }
    else { failCount++; results.push({ unique_id: r.unique_id, status: "error", ...base }); }
  }
  return { results, okCount, failCount, skipped, warned, failed };
}
