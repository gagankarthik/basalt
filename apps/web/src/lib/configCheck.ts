/**
 * What a saved config must look like. Every page reads it without checking, so one missing list or empty entry would break pages for everyone.
 * Returns what's wrong, or null. It only covers what pages rely on being there, so settings the app adds later still save.
 */
export function configProblem(c: unknown): string | null {
  const o = c as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return "the configuration";
  if (!o.settings || typeof o.settings !== "object" || Array.isArray(o.settings)) return "settings";
  const lists: [string, boolean, (x: Record<string, unknown>) => boolean][] = [
    ["pipelines", true, (x) => Array.isArray(x.streams) && x.streams.every((s) => !!s && typeof s.name === "string" && !!s.rules && typeof s.rules === "object")],
    ["models", true, () => true],
    ["views", true, () => true],
    ["dashboards", true, (x) => Array.isArray(x.widgets) && x.widgets.every((w) => !!w && typeof w === "object") && Array.isArray(x.filters)],
    ["metrics", true, () => true],
    ["queries", true, () => true],
    ["notebooks", false, (x) => Array.isArray(x.cells) && x.cells.every((y) => !!y && typeof y === "object")],
  ];
  for (const [name, required, inner] of lists) {
    const l = o[name];
    if (l === undefined && !required) continue;
    if (!Array.isArray(l)) return name;
    for (const x of l) if (!x || typeof x !== "object" || typeof x.id !== "string" || !x.id || typeof x.name !== "string" || !inner(x)) return name;
  }
  return null;
}

type Item = { id: string };
type Rec = Record<string, unknown>;
export type ConfigDelta = { lists: Record<string, { upsert: Item[]; remove: string[]; order?: string[] }>; objects: Record<string, { set: Rec; unset: string[] }> };
const LISTS = ["pipelines", "models", "views", "dashboards", "metrics", "queries", "notebooks"], OBJECTS = ["settings", "project", "semantic"];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Only what this browser changed since it last saved. Sending the whole config let a tab opened earlier undo what others had saved since.
 * shortcut: two people editing the same dashboard or model still means the last save wins; add per-item versions if that becomes common.
 */
export function configDelta(base: object, next: object): ConfigDelta {
  const b = base as Rec, n = next as Rec, out: ConfigDelta = { lists: {}, objects: {} };
  for (const k of LISTS) {
    const was = (b[k] ?? []) as Item[], now = (n[k] ?? []) as Item[], before = new Map(was.map((x) => [x.id, x])), ids = new Set(now.map((x) => x.id));
    const upsert = now.filter((x) => !same(before.get(x.id), x)), remove = was.filter((x) => !ids.has(x.id)).map((x) => x.id);
    const kept = now.filter((x) => before.has(x.id)).map((x) => x.id), moved = !same(kept, was.filter((x) => ids.has(x.id)).map((x) => x.id));
    if (upsert.length || remove.length || moved) out.lists[k] = { upsert, remove, ...(moved ? { order: now.map((x) => x.id) } : {}) };
  }
  for (const k of OBJECTS) {
    const was = (b[k] ?? {}) as Rec, now = (n[k] ?? {}) as Rec;
    const set = Object.fromEntries(Object.entries(now).filter(([x, v]) => !same(was[x], v))), unset = Object.keys(was).filter((x) => !(x in now));
    if (Object.keys(set).length || unset.length) out.objects[k] = { set, unset };
  }
  return out;
}
export const emptyDelta = (d: ConfigDelta) => !Object.keys(d.lists).length && !Object.keys(d.objects).length;

/** The latest saved config with one person's changes on top. Anything they didn't touch stays as it is now. Connections have their own route, so they can't change here. */
export function applyDelta<T extends object>(current: T, d: ConfigDelta): T {
  const out = { ...current } as Rec;
  for (const [k, c] of Object.entries(d?.lists ?? {})) {
    if (!LISTS.includes(k) || !Array.isArray(c?.upsert) || !Array.isArray(c?.remove)) throw new Error("bad");
    const gone = new Set(c.remove), fresh = new Map(c.upsert.map((x) => [x?.id, x]));
    let l = ((out[k] ?? []) as Item[]).filter((x) => !gone.has(x.id)).map((x) => { const y = fresh.get(x.id); if (y) fresh.delete(x.id); return y ?? x; });
    l = [...l, ...fresh.values()];
    if (Array.isArray(c.order)) { const at = new Map(c.order.map((id, i) => [id, i])); l = l.map((x, i) => [x, i] as const).sort((a, z) => (at.get(a[0]?.id) ?? c.order!.length + a[1]) - (at.get(z[0]?.id) ?? c.order!.length + z[1])).map((p) => p[0]); }
    out[k] = l;
  }
  for (const [k, c] of Object.entries(d?.objects ?? {})) {
    if (!OBJECTS.includes(k) || !c?.set || typeof c.set !== "object" || !Array.isArray(c.unset)) throw new Error("bad");
    const o = { ...((out[k] ?? {}) as Rec), ...c.set };
    for (const u of c.unset) delete o[u];
    out[k] = o;
  }
  return out as T;
}
