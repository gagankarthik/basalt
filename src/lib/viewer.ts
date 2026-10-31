import { effectiveOf, makeCtx, type Ctx } from "./dbt-compile.ts";
import type { Config, Dashboard, Model, Run } from "./types.ts";

export const RUN_HIDDEN = "This run failed. An editor or admin can open it to see why.";

/** Names and dependencies only. The references stay in a comment, so lineage reads them the same way it reads a real model. */
function viewerModel(m: Model, ctx: Ctx): Model {
  const e = effectiveOf(m, ctx);
  const reads = [...e.deps.map((d) => `{{ ref('${d}') }}`), ...e.srcs.map((s) => { const [a, b] = s.replace(/^raw_/, "").split("."); return `{{ source('${a}','${b}') }}`; })];
  const sql = `/* Only editors can read how this model is built.${reads.length ? ` It reads from: ${reads.join(" ")}` : ""} */\nSELECT * FROM "analytics"."${m.name}"`;
  return { id: m.id, name: m.name, description: m.description, generated: m.generated, kind: "sql", materialized: e.materialized, sql, tests: m.tests.map((t) => ({ type: t.type, column: t.column, severity: t.severity })), owner: m.owner, columnDocs: m.columnDocs, tags: e.tags, contract: m.contract };
}

/** A saved bookmark names filter values, which someone limited to certain rows may not be allowed to see. */
export const withoutBookmarks = (d: Dashboard): Dashboard => ({ ...d, bookmarks: undefined });

/**
 * What a viewer's browser receives. Viewers can't save config, so nothing here can overwrite the real definitions.
 * Dashboards keep their filters because the browser builds tile queries from them.
 */
export function viewerConfig(c: Config, who: { name: string; limited: boolean }): Config {
  let ctx: Ctx;
  try { ctx = makeCtx(c.models, c.project); } catch { ctx = makeCtx(c.models); }
  return {
    ...c,
    models: c.models.map((m) => viewerModel(m, ctx)),
    connections: c.connections.map((x) => ({ id: x.id, name: x.name, type: x.type, slug: x.slug, createdAt: x.createdAt, ...(x.airbyte ? { airbyte: { ...x.airbyte, repo: "", version: "", secretKeys: [], pypi: undefined, cdk: undefined } } : {}) })),
    queries: c.queries.filter((q) => q.owner === who.name),
    views: c.views.filter((v) => v.shared !== false && !(who.limited && (v.filters.length || v.colorRules.length))),
    dashboards: who.limited ? c.dashboards.map(withoutBookmarks) : c.dashboards,
    project: c.project && { sources: c.project.sources, exposures: c.project.exposures },
  };
}

/**
 * Error text and third-party logs can quote row values, including columns held back from the warehouse, so no viewer gets them.
 * Someone limited to certain rows also doesn't get counts, which describe rows outside their limit.
 */
export function viewerRun(r: Run, limited: boolean): Run {
  const { artifacts: _a, messages, ...rest } = r;
  void _a;
  if (limited) return { ...rest, summary: undefined, streams: r.streams?.map((s) => ({ name: s.name, status: s.status, read: 0, written: 0, heldBack: [] })) };
  return {
    ...rest,
    summary: r.status === "failed" ? RUN_HIDDEN : r.summary,
    streams: r.streams?.map((s) => (s.error ? { ...s, error: RUN_HIDDEN } : s)),
    messages: messages?.filter((m) => m.type === "RECORD" || m.type === "CATALOG" || (m.type === "TRACE" && m.level !== "ERROR")),
  };
}
