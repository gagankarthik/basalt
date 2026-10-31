/** Everything Add a connection can offer. One list, whatever the connector's origin. */
export const CATALOG_GROUPS = ["AWS", "Google Cloud", "Azure", "Databases", "Warehouses", "Files", "Apps"] as const;
export type CatalogGroup = (typeof CATALOG_GROUPS)[number];
export type Searchable = { name: string; groups: readonly CatalogGroup[]; terms: string; airbyte?: boolean };

/** Every word must appear in the name, groups or terms. Native connectors come first, so one sharing a name with an Airbyte connector leads; otherwise names starting with the search go first. */
export function searchCatalog<T extends Searchable>(items: readonly T[], query: string, group: CatalogGroup | "All"): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (x: T) => `${x.name} ${x.groups.join(" ")} ${x.terms}`.toLowerCase();
  const found = items.filter((x) => (group === "All" || x.groups.includes(group)) && words.every((w) => hay(x).includes(w)));
  if (!words.length) return [...found];
  const lead = (x: T) => (x.name.toLowerCase().startsWith(words[0]) ? 0 : 1);
  // Array sort is stable, so ties keep the catalog's own order
  return found.sort((a, b) => Number(!!a.airbyte) - Number(!!b.airbyte) || lead(a) - lead(b));
}
