import "server-only";
import crypto from "node:crypto";
import { createCache, createLimiter, fingerprint, isCacheable, queryLabel } from "@/lib/queryCache";
import { widgetSql } from "@/lib/sql";
import type { Result } from "@/lib/types";
import { dataPath, runSql } from "./engine";
import { getConfig } from "./files";
import { accessScope, guardFor } from "./rls";

type Answer = Result & { kinds: string[]; cached?: boolean };
type Who = { id: string; role: string };
type Slow = { sql: string; runs: number; totalMs: number; maxMs: number };
const MINUTE = 60000, MAX_ROWS = 50000, TRACKED = 200, SLOWEST = 10, WARM_MAX = 200, WARM_AFTER_MS = 5000;
// A view can hide now() or random(), so nothing is trusted for longer than this even if the data hasn't changed
const options = { maxBytes: 128 * 1024 * 1024, maxEntryBytes: 16 * 1024 * 1024, ttlMs: 5 * MINUTE };

// On globalThis because API routes are bundled separately, and all of them must share one cache
type Store = { cache: ReturnType<typeof createCache<Answer>>; limiter: ReturnType<typeof createLimiter>; pending: Map<string, Promise<Answer>>; hits: number; misses: number; skipped: number; slow: Map<string, Slow>; warmTimer?: ReturnType<typeof setTimeout>; warmedAt?: string; warmed: number };
const g = globalThis as unknown as { __basaltAnalytics?: Store };
const store: Store = (g.__basaltAnalytics ??= { cache: createCache<Answer>(options), limiter: createLimiter(Number(process.env.BASALT_QUERY_CONCURRENCY) || 8), pending: new Map(), hits: 0, misses: 0, skipped: 0, slow: new Map(), warmed: 0 });

const print = () => fingerprint(dataPath("warehouse.duckdb"));

function track(sql: string, ms: number) {
  const label = queryLabel(sql), s = store.slow.get(label) ?? { sql: label, runs: 0, totalMs: 0, maxMs: 0 };
  s.runs++; s.totalMs += ms; s.maxMs = Math.max(s.maxMs, ms);
  store.slow.delete(label); store.slow.set(label, s);
  for (const k of store.slow.keys()) { if (store.slow.size <= TRACKED) break; store.slow.delete(k); }
}

/** Every query from the app. A plain read may come from the cache, but only from this person's own scope, so row rules and revoked tables still hold. */
export async function querySql(sql: string, user: Who, limit?: number): Promise<Answer> {
  const exec = async () => { const r = await store.limiter.run(() => runSql(sql, { readOnly: user.role === "viewer", limit, rewrite: guardFor(user) })); track(sql, r.ms); return r; };
  if (!isCacheable(sql)) { store.skipped++; return exec(); }
  const key = crypto.createHash("sha256").update(JSON.stringify([accessScope(user), limit ?? null, sql])).digest("hex"), before = print();
  const hit = store.cache.get(key, before);
  if (hit) { store.hits++; return { ...hit, ms: 0, cached: true }; }
  // The same read already running gives everyone its answer, which is what a dashboard opened by many people sends
  const flight = `${key}:${before}`, running = store.pending.get(flight);
  if (running) { store.hits++; return { ...(await running), cached: true }; }
  store.misses++;
  const p = exec().then((r) => {
    // A write during the read means this answer may mix both, so it's returned but never kept
    if (r.kinds.every((k) => k === "DQL") && r.rows.length <= MAX_ROWS && print() === before) store.cache.set(key, r, before, Buffer.byteLength(JSON.stringify(r.rows)));
    return r;
  }).finally(() => store.pending.delete(flight));
  store.pending.set(flight, p);
  return p;
}

/** Reads every dashboard's visuals after new data arrives, so the next person to open one doesn't wait. Editors and admins share these; a viewer's first read is still their own. */
export function warmDashboards() {
  clearTimeout(store.warmTimer);
  // Waits for a burst: a sync followed by its model build warms once
  store.warmTimer = setTimeout(() => void warm().catch(console.error), WARM_AFTER_MS);
}
async function warm() {
  const list = getConfig().dashboards.flatMap((d) => d.widgets.filter((w) => !w.model).map((w) => widgetSql(w, d.filters))).filter((s): s is string => !!s);
  let done = 0;
  for (const sql of [...new Set(list)].slice(0, WARM_MAX)) {
    // One at a time on purpose: people asking for something come first. A visual that can't run yet isn't this job's problem
    await querySql(sql, { id: "warm", role: "admin" }).then(() => { done++; }, () => {});
  }
  store.warmed = done; store.warmedAt = new Date().toISOString();
}

export function analyticsStats() {
  const asked = store.hits + store.misses;
  return {
    hits: store.hits, misses: store.misses, skipped: store.skipped, hitRate: asked ? store.hits / asked : 0, ...store.cache.stats(), maxBytes: options.maxBytes, waiting: store.limiter.waiting(), warmed: store.warmed, warmedAt: store.warmedAt,
    slowest: [...store.slow.values()].sort((a, b) => b.maxMs - a.maxMs).slice(0, SLOWEST).map((s) => ({ sql: s.sql, runs: s.runs, maxMs: s.maxMs, avgMs: Math.round(s.totalMs / s.runs) })),
  };
}
