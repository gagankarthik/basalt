import type { Run } from "./types.ts";

const RETRY_WAIT = 5 * 60000;

/** Whether a failed sync should run again: only after a pause, and only as many times as the pipeline allows. A partly failed sync counts: some of its tables are out of date. */
export function shouldRetry(runs: Run[], pipeline: string, retries: number, now: number) {
  if (!retries) return false;
  const mine = runs.filter((r) => r.kind === "sync" && r.refId === pipeline);
  const bad = (r?: Run) => r?.status === "failed" || r?.status === "partial";
  if (!bad(mine[0]) || now - Date.parse(mine[0].startedAt) < RETRY_WAIT) return false;
  let fails = 0;
  for (const r of mine) { if (!bad(r)) break; fails++; }
  return fails <= retries;
}

/** Hours since the last good sync, or null when it has never succeeded. */
export function hoursStale(runs: Run[], pipeline: string, now: number) {
  const good = runs.find((r) => r.kind === "sync" && r.refId === pipeline && r.status === "succeeded");
  return good ? (now - Date.parse(good.startedAt)) / 3600000 : null;
}

/** A model and everything built from it, so one change can be carried all the way through. */
export function withDownstream<T extends { name: string; refs: string[] }>(models: T[], start: string) {
  const out = new Set([start]);
  for (let grew = true; grew;) { grew = false; for (const m of models) if (!out.has(m.name) && m.refs.some((r) => out.has(r))) { out.add(m.name); grew = true; } }
  return out;
}
