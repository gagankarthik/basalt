import "server-only";
import { getConfig, getRevoked } from "./files";
import { incrementalDownstream, tableKey, withViews } from "@/lib/live";

type Listener = (tables: string[]) => void;
type Store = { listeners: Set<Listener>; dirty: Set<string>; timer?: ReturnType<typeof setTimeout>; building: boolean };
const g = globalThis as unknown as { __basaltLive?: Store };
const store: Store = (g.__basaltLive ??= { listeners: new Set(), dirty: new Set(), building: false });

/** Tells open dashboards and views that these tables changed. Only names and times go out: the rows still come through /api/sql, with row rules applied. */
export function publish(tables: string[]) {
  if (!tables.length || !store.listeners.size) return;
  const all = withViews(getConfig().models, tables);
  store.listeners.forEach((fn) => fn(all));
}

const SEND_EVERY = 1000;
/** Events for one signed-in person. The browser asks for the tables on its page, and tables they've lost access to are removed. */
export function watchTables(userId: string, wanted: string[], send: (tables: string[]) => void) {
  const revoked = new Set(getRevoked().filter((r) => r.userId === userId).map((r) => tableKey(r.table)));
  const want = new Set(wanted.map(tableKey).filter((t) => !revoked.has(t))), waiting = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fn: Listener = (tables) => {
    for (const t of tables) if (want.has(t)) waiting.add(t);
    if (!waiting.size || timer) return;
    timer = setTimeout(() => { timer = undefined; const list = [...waiting]; waiting.clear(); send(list); }, SEND_EVERY);
  };
  store.listeners.add(fn);
  return () => { store.listeners.delete(fn); clearTimeout(timer); };
}

// Long enough that run history isn't filled by a steady stream: each model build is one saved run, and 500 are kept
const BUILD_EVERY = 60000;
async function buildDirty() {
  store.timer = undefined;
  if (store.building) return;
  const tables = [...store.dirty];
  store.dirty.clear();
  store.building = true;
  try {
    const { runModels } = await import("./jobs");
    for (const name of incrementalDownstream(getConfig().models, tables)) await runModels("schedule", "Live change", name).catch(console.error);
    // Rebuilt tables have new rows too, so anything reading them refreshes
    publish(incrementalDownstream(getConfig().models, tables).map((n) => `analytics.${n}`));
  } finally {
    store.building = false;
    if (store.dirty.size) store.timer ??= setTimeout(() => void buildDirty(), BUILD_EVERY);
  }
}
/** Debounced from the first change, so steady traffic still builds on time and a burst builds once. */
export function rebuildAfter(tables: string[]) {
  for (const t of tables) store.dirty.add(tableKey(t));
  store.timer ??= setTimeout(() => void buildDirty(), Number(process.env.BASALT_MODEL_DEBOUNCE_MS) || BUILD_EVERY);
}
