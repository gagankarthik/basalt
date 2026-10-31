"use client";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useQuery } from "./client";
import { coalescer, tableKey } from "./live";

/** However fast a table changes, what reads it refreshes at most this often. */
const REFRESH_EVERY = 3000;

export type LiveStatus = "idle" | "connecting" | "live" | "reconnecting" | "off" | "paused";
const useStore = create<{ status: LiveStatus; paused: boolean; lastAt: number | null; ticks: Record<string, number> }>(() => ({ status: "idle", paused: false, lastAt: null, ticks: {} }));
const bump = (tables: string[]) => useStore.setState((s) => {
  const ticks = { ...s.ticks };
  for (const t of tables) ticks[t] = (ticks[t] ?? 0) + 1;
  return { ticks, lastAt: Date.now() };
});
export const useLiveState = () => useStore();
export const togglePaused = () => useStore.setState((s) => ({ paused: !s.paused }));

const keyOf = (tables: string[]) => [...new Set(tables.filter(Boolean).map(tableKey))].sort().join(",");

/** The one connection a page holds. It closes while paused, and a tab in the background holds its refreshes until it's looked at again. */
export function useLiveFeed(tables: string[]) {
  const key = keyOf(tables), paused = useStore((s) => s.paused);
  useEffect(() => {
    if (!key) { useStore.setState({ status: "idle" }); return; }
    if (paused) { useStore.setState({ status: "paused" }); return; }
    const list = key.split(","), behind = new Set<string>(), wasPaused = useStore.getState().status === "paused";
    let missed = wasPaused;
    const c = coalescer(REFRESH_EVERY, (k) => { if (document.hidden) k.forEach((x) => behind.add(x)); else bump(k); });
    const onVisible = () => { if (!document.hidden && behind.size) { const k = [...behind]; behind.clear(); bump(k); } };
    document.addEventListener("visibilitychange", onVisible);
    useStore.setState({ status: "connecting", lastAt: Date.now() });
    const es = new EventSource(`/api/live?tables=${encodeURIComponent(key)}`);
    es.onopen = () => { useStore.setState({ status: "live" }); if (missed) { missed = false; c.add(list); } };
    es.onerror = () => { missed = true; useStore.setState({ status: es.readyState === EventSource.CLOSED ? "off" : "reconnecting" }); };
    es.onmessage = (e) => c.add((JSON.parse(e.data) as { tables: string[] }).tables);
    return () => { es.close(); c.stop(); document.removeEventListener("visibilitychange", onVisible); };
  }, [key, paused]);
}

/** Moves on only when one of these tables changes, so a tile on another table sends no query at all. */
export function useLiveTick(tables: string[]) {
  const key = keyOf(tables);
  return useStore((s) => { let n = 0; if (key) for (const t of key.split(",")) n += s.ticks[t] ?? 0; return n; });
}

/** useQuery that refreshes when these tables change. A slow query finishes before the next starts, and the old result stays on screen meanwhile. */
export function useLiveQuery(text: string | null, tables: string[]) {
  const tick = useLiveTick(tables), [shown, setShown] = useState(tick), [settled, setSettled] = useState<string | null>(null);
  const q = useQuery(text, [shown]), busy = q.loading;
  useEffect(() => {
    if (busy) return;
    setSettled(text);
    if (tick !== shown) setShown(tick);
  }, [busy, text, tick, shown]);
  return useMemo(() => ({ ...q, loading: busy && settled !== text }), [q, busy, settled, text]);
}
