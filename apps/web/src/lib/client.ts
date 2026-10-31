"use client";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ACTIVE_HEADER } from "./sessionPolicy";
import { configDelta, emptyDelta } from "./configCheck";
import { create } from "zustand";
import type { Column, Config, Member, Result, Widget } from "./types";
import { semanticOf } from "./semantic";
import { lit } from "./sql";

/** Light, dark or the device's choice, kept per browser. The workspace setting is only the default until someone chooses. */
export type ThemeChoice = "light" | "dark" | "system";
const THEME_KEY = "basalt-theme";
const useThemePref = create<{ pref: ThemeChoice | null }>(() => ({ pref: null }));
export const loadThemePref = () => { try { const v = localStorage.getItem(THEME_KEY); if (v === "light" || v === "dark" || v === "system") useThemePref.setState({ pref: v }); } catch { /* a preference only */ } };
export const setThemePref = (pref: ThemeChoice) => { useThemePref.setState({ pref }); try { localStorage.setItem(THEME_KEY, pref); } catch { /* a preference only */ } };
export function useThemeChoice(): ThemeChoice { const pref = useThemePref((s) => s.pref), workspace = useApp((s) => s.config?.settings.theme); return pref ?? workspace ?? "system"; }
const darkQuery = () => matchMedia("(prefers-color-scheme: dark)");
/** Whether the page is dark right now, following the device when the choice is "system". */
export function useIsDark() {
  const device = useSyncExternalStore((cb) => { const m = darkQuery(); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); }, () => darkQuery().matches, () => false);
  const choice = useThemeChoice();
  return choice === "dark" || (choice === "system" && device);
}

/** What the whole app needs to know about its connection to the server. */
export const useNet = create<{ slow: boolean; expired: boolean }>(() => ({ slow: false, expired: false }));
const SLOW_MS = 5000;
// Syncs, builds and uploads are meant to take a while, so they don't count as a slow network
const LONG_RUNNING = /\/api\/(runs|connections|exports)/;
let waiting = 0;

/** Whether a person has used the page in the last minute. Polling sends no input, so it can't keep an abandoned session alive. */
let lastInput = 0;
if (typeof window !== "undefined") for (const e of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) window.addEventListener(e, () => { lastInput = Date.now(); }, { passive: true, capture: true });
const activeHeaders = (): Record<string, string> => (Date.now() - lastInput < 6e4 ? { [ACTIVE_HEADER]: "1" } : {});

export async function call<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const track = !LONG_RUNNING.test(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (track) { waiting++; timer = setTimeout(() => useNet.setState({ slow: true }), SLOW_MS); }
  let res: Response;
  try {
    res = await fetch(url, json !== undefined ? { ...rest, method: rest.method ?? "POST", headers: { "content-type": "application/json", ...activeHeaders() }, body: JSON.stringify(json) } : { ...rest, headers: { ...activeHeaders(), ...(rest.headers as Record<string, string> | undefined) } });
  } catch {
    throw new Error(navigator.onLine ? "Basalt's server can't be reached. Check that it's running, then try again." : "You're offline. Reconnect, then try again.");
  } finally {
    if (track) { clearTimeout(timer); if (--waiting === 0) useNet.setState({ slow: false }); }
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.includes("/api/auth")) { useNet.setState({ expired: true }); throw new Error("Your session has ended. Sign in again to continue."); }
  if (!res.ok) throw new Error(data.error ?? `The server returned an error (${res.status}).`);
  return data;
}
export const sql = (text: string, limit?: number) => call<Result>("/api/sql", { json: { sql: text, limit } });

/** Lets the top bar's New menu open a page's create screen, including when that page is already open. */
const useNewRequest = create<{ kind: string | null }>(() => ({ kind: null }));
export const requestNew = (kind: string) => useNewRequest.setState({ kind });
export function useNewHandler(kind: string, open: () => void) {
  const asked = useNewRequest((s) => s.kind) === kind;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (asked) { useNewRequest.setState({ kind: null }); open(); } }, [asked]);
}

type App = {
  user: Member | null; config: Config | null;
  load: () => Promise<void>;
  /** Applies a config change at once and saves it shortly after, so typing doesn't send a request per key. */
  patch: (fn: (c: Config) => Config) => void;
  /** Saves now rather than after the pause. */
  save: () => Promise<void>;
  can: (role: "editor" | "admin") => boolean;
};
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** The config as last sent to the server, so a save holds only what changed since. */
let synced: Config | null = null;
export const useApp = create<App>((set, get) => ({
  user: null, config: null,
  load: async () => {
    const [{ user }, config] = await Promise.all([call<{ user: Member | null }>("/api/auth"), call<Config>("/api/config")]);
    synced = config;
    set({ user, config });
  },
  patch: (fn) => {
    const cur = get().config; if (!cur) return;
    const next = fn(cur); set({ config: next });
    if (!get().can("editor")) return; // viewers keep their changes for this session only
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { get().save().catch((e) => import("@/components/ui").then((m) => m.toast(e.message, true))); }, 400);
  },
  save: async () => {
    clearTimeout(saveTimer);
    const next = get().config, sent = synced;
    if (!next || !sent) return;
    const delta = configDelta(sent, next);
    if (emptyDelta(delta)) return;
    synced = next;
    // Unsent changes stay in the next delta if this one fails
    await call("/api/config", { method: "PUT", json: { delta } }).catch((e) => { synced = sent; throw e; });
  },
  can: (role) => { const r = get().user?.role; return role === "editor" ? r === "admin" || r === "editor" : r === "admin"; },
}));

export function useQuery(text: string | null, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: Result; error?: string; loading: boolean }>({ loading: !!text });
  const key = JSON.stringify(deps);
  const run = useCallback(() => {
    if (!text) { setState({ loading: false }); return () => {}; }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    sql(text).then((data) => live && setState({ data, loading: false }), (e) => live && setState({ error: e.message, loading: false }));
    return () => { live = false; };
  }, [text]);
  useEffect(() => run(), [run, key]);
  return { ...state, reload: run };
}

export type TableInfo = { full: string; schema: string; name: string; type: string; columns: Column[] };
const useTablesStore = create<{ tables: TableInfo[] | null }>(() => ({ tables: null }));
export async function refreshTables() {
  const r = await sql(`SELECT c.table_schema s, c.table_name t, c.column_name n, c.data_type d, tb.table_type k FROM information_schema.columns c JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_catalog = c.table_catalog WHERE c.table_schema NOT IN ('information_schema','pg_catalog','basalt_internal') AND c.table_catalog = current_database() ORDER BY 1, 2, c.ordinal_position`, 100000);
  const map = new Map<string, TableInfo>();
  for (const x of r.rows) {
    if (useApp.getState().user?.role === "viewer" && String(x.s).endsWith("_dbt_test__audit")) continue;
    const full = `${x.s}.${x.t}`;
    if (!map.has(full)) map.set(full, { full, schema: String(x.s), name: String(x.t), type: String(x.k), columns: [] });
    map.get(full)!.columns.push({ name: String(x.n), type: String(x.d) });
  }
  useTablesStore.setState({ tables: [...map.values()] });
}
export function useTables() {
  const tables = useTablesStore((s) => s.tables);
  useEffect(() => { if (!tables) void refreshTables(); }, [tables]);
  return tables;
}
/** The semantic model with the warehouse's current columns, or nothing when this workspace has no model. */
export function useSem() {
  const model = useApp((s) => s.config?.semantic), metrics = useApp((s) => s.config?.metrics), tables = useTables();
  return useMemo(() => semanticOf(model, tables, metrics ?? []), [model, tables, metrics]);
}
export const columnsOf = (tables: TableInfo[] | null, full: string) => tables?.find((t) => t.full === full)?.columns ?? [];

export const uid = () => Math.random().toString(36).slice(2, 10);
export const quoteVal = lit;
export function download(name: string, text: BlobPart, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function fmt(v: unknown, format?: Widget["format"], locale = "en-US", currency = "USD"): string {
  if (v == null) return "";
  const n = Number(v);
  if (typeof v === "boolean" || Number.isNaN(n)) return String(v);
  switch (format) {
    case "currency": return n.toLocaleString(locale, { style: "currency", currency, maximumFractionDigits: 0 });
    case "percent": return `${n.toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
    case "compact": case "lakh" as never: // "lakh" may be saved in older workspaces
      return n.toLocaleString(locale, { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 });
  }
  return n.toLocaleString(locale, { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 });
}
export const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
export const took = (a?: string, b?: string) => { if (!a || !b) return ""; const s = (Date.parse(b) - Date.parse(a)) / 1000; return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`; };
