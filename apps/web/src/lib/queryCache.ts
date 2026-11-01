import fs from "node:fs";

/**
 * Changes whenever a database file does: every commit reaches the write-ahead log, and a checkpoint rewrites the main file.
 * Nothing has to remember to clear the cache, so a writer added later can't serve stale numbers. Reads and TEMP tables don't touch these files.
 */
export function fingerprint(file: string) {
  return [file, `${file}.wal`].map((f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return "-"; } }).join("|");
}

// A view can hide any of these, which is why entries also expire
const VOLATILE = /\b(now|today|current_\w+|get_current_\w+|localtime\w*|random|uuid|gen_random_uuid|setseed|nextval|currval|epoch_ms|using\s+sample|tablesample|duckdb_\w+|pragma_\w+|version)\b/i;
/** One plain read whose answer depends only on the data. Anything unsure runs normally: a miss costs time, a wrong answer costs trust. */
export function isCacheable(sql: string) {
  const s = sql.trim().replace(/;\s*$/, "");
  return /^(select|with|from)\b/i.test(s) && !s.includes(";") && !VOLATILE.test(s);
}

type Entry<T> = { value: T; print: string; size: number; at: number };
export type CacheOpts = { maxBytes: number; maxEntryBytes: number; ttlMs: number };

/** Least recently used first out. An entry counts only while the warehouse is exactly as it was when the result was read. */
export function createCache<T>(o: CacheOpts) {
  const map = new Map<string, Entry<T>>();
  let bytes = 0;
  const drop = (k: string) => { const e = map.get(k); if (e) { bytes -= e.size; map.delete(k); } };
  return {
    get(key: string, print: string, now = Date.now()): T | undefined {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.print !== print || now - e.at > o.ttlMs) { drop(key); return undefined; }
      map.delete(key); map.set(key, e);
      return e.value;
    },
    set(key: string, value: T, print: string, size: number, now = Date.now()) {
      drop(key);
      if (size > o.maxEntryBytes) return;
      map.set(key, { value, print, size, at: now });
      bytes += size;
      for (const k of map.keys()) { if (bytes <= o.maxBytes) break; drop(k); }
    },
    stats: () => ({ entries: map.size, bytes }),
  };
}

/** Runs at most this many at once and queues the rest, so one busy dashboard can't take every thread from everyone else. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= max) await new Promise<void>((r) => waiting.push(r));
      else active++;
      // A finished task hands its place straight to the next, so the count stays right
      try { return await fn(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
    },
    waiting: () => waiting.length,
  };
}

/** How a query is listed among the slowest. */
export const queryLabel = (sql: string) => sql.trim().replace(/\s+/g, " ").slice(0, 200);

/** Who a cached answer may go to. Editors and admins read everything alike. A viewer's answers are their own and end the moment their access changes, since those rules live outside the warehouse. */
export const scopeKey = (user: { id: string; role: string }, access: unknown) => (user.role === "viewer" ? `viewer:${user.id}:${JSON.stringify(access)}` : "full");
