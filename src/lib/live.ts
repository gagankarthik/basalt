/** At most one `fire` per key in each `gap`: the first change goes at once, and any more inside the gap are merged into one at its end. */
export function coalescer(gap: number, fire: (keys: string[]) => void) {
  const last = new Map<string, number>(), waiting = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const now = Date.now(), due = [...waiting].filter((k) => now - (last.get(k) ?? 0) >= gap);
    for (const k of due) { waiting.delete(k); last.set(k, now); }
    if (due.length) fire(due);
    if (waiting.size) {
      const next = Math.min(...[...waiting].map((k) => (last.get(k) ?? 0) + gap - now));
      timer = setTimeout(flush, Math.max(1, next));
    }
  };
  return {
    add(keys: string[]) { for (const k of keys) waiting.add(k); if (!timer) flush(); },
    stop() { clearTimeout(timer); timer = undefined; waiting.clear(); },
  };
}

/** Schema-qualified table names a piece of a dashboard or view reads, lowercased so they compare with what the server sends. */
export const tableKey = (t: string) => t.replace(/"/g, "").toLowerCase();

const REF = /\{\{\s*ref\(\s*['"](\w+)['"]\s*\)\s*\}\}/g, SRC = /\{\{\s*source\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]\s*\)\s*\}\}/g;
type M = { name: string; sql: string; materialized?: string };
const readsOf = (m: M) => [...[...m.sql.matchAll(REF)].map((x) => `analytics.${x[1]}`), ...[...m.sql.matchAll(SRC)].map((x) => `raw_${x[1]}.${x[2]}`)].map(tableKey);
const closure = (models: M[], start: string[], through: (m: M) => boolean) => {
  const seen = new Set(start.map(tableKey)), out = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const m of models) {
      const key = `analytics.${m.name}`.toLowerCase();
      if (seen.has(key) || !through(m) || !readsOf(m).some((r) => seen.has(r))) continue;
      seen.add(key); out.add(m.name); grew = true;
    }
  }
  return out;
};

/** A view shows new data as soon as what it reads changes, so its readers refresh too. A built table only changes when it's rebuilt. */
export const withViews = (models: M[], changed: string[]) => [...changed.map(tableKey), ...[...closure(models, changed, (m) => m.materialized === "view")].map((n) => `analytics.${n}`.toLowerCase())];

/** Incremental models that read a changed table, directly or through views. Python models say nothing about their inputs, so they aren't found here. */
export const incrementalDownstream = (models: M[], changed: string[]) => {
  const views = withViews(models, changed);
  return models.filter((m) => m.materialized === "incremental" && readsOf(m).some((r) => views.includes(r))).map((m) => m.name);
};
