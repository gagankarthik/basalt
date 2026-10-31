/** Pure list logic behind the Sel dropdown: flattening, keyboard movement, type-ahead and filtering. */
export type SelOption = string | readonly [value: string, label: string, disabled?: boolean];
export type SelEntry = SelOption | { group: string; options: readonly SelOption[] };
export type FlatOption = { value: string; label: string; disabled: boolean; group?: string };

const one = (o: SelOption, group?: string): FlatOption => typeof o === "string" ? { value: o, label: o, disabled: false, group } : { value: o[0], label: o[1], disabled: !!o[2], group };
export const flatten = (entries: readonly SelEntry[]): FlatOption[] => entries.flatMap((e) => typeof e === "object" && "group" in e ? e.options.map((o) => one(o, e.group)) : [one(e)]);

/** The nearest enabled option from `from` in direction `dir`, without wrapping; `from` itself if there is none. */
export function step(list: FlatOption[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < list.length; i += dir) if (!list[i].disabled) return i;
  return from;
}
export const first = (list: FlatOption[]) => Math.max(list.findIndex((o) => !o.disabled), 0);
export const last = (list: FlatOption[]) => { const i = step(list, list.length, -1); return i === list.length ? 0 : i; };

/** Where the typed buffer lands, or -1. Repeating one letter cycles through its matches; a longer word stays put while it still matches. */
export function typeAhead(list: FlatOption[], buffer: string, from: number): number {
  const b = buffer.toLowerCase(), same = [...b].every((c) => c === b[0]), want = same ? b[0] : b, start = same ? from + 1 : Math.max(from, 0);
  for (let n = 0; n < list.length; n++) {
    const i = (start + n) % list.length;
    if (!list[i].disabled && list[i].label.trim().toLowerCase().startsWith(want)) return i;
  }
  return -1;
}

export const filterList = (list: FlatOption[], query: string) => { const q = query.trim().toLowerCase(); return q ? list.filter((o) => o.label.toLowerCase().includes(q)) : list; };
