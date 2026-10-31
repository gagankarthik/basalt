import type { IconName } from "./icons";

export type NavItem = { href: string; label: string; icon: IconName };

/** Sidebar groups. */
export const NAV: { title: string; items: NavItem[] }[] = [
  { title: "", items: [{ href: "/home", label: "Home", icon: "home" }] },
  { title: "Ingest", items: [
    { href: "/connections", label: "Connections", icon: "plug" },
    { href: "/pipelines", label: "Pipelines", icon: "pipeline" },
  ] },
  { title: "Transform", items: [
    { href: "/models", label: "Models", icon: "model" },
    { href: "/catalog", label: "Data catalog", icon: "catalog" },
  ] },
  { title: "Analyze", items: [
    { href: "/bases", label: "Bases", icon: "base" },
    { href: "/explore", label: "Data views", icon: "table" },
    { href: "/sql", label: "SQL editor", icon: "code" },
    { href: "/dashboards", label: "Dashboards", icon: "dashboard" },
    { href: "/metrics", label: "Metrics", icon: "metric" },
  ] },
  { title: "Workspace", items: [
    { href: "/personal-data", label: "Personal data", icon: "shield" },
    { href: "/settings", label: "Settings", icon: "settings" },
  ] },
];
/** Pages reached from a tab on their sidebar item. Their URLs stay as they were. */
export const SECTIONS: { parent: string; pages: (NavItem & { admin?: boolean })[] }[] = [
  { parent: "/pipelines", pages: [{ href: "/pipelines", label: "Pipelines", icon: "pipeline" }, { href: "/flow", label: "ETL flow", icon: "workflow" }, { href: "/runs", label: "Run history", icon: "history" }] },
  { parent: "/dashboards", pages: [{ href: "/dashboards", label: "Dashboards", icon: "dashboard" }, { href: "/apps", label: "Apps", icon: "apps" }] },
  { parent: "/settings", pages: [{ href: "/settings", label: "Settings", icon: "settings" }, { href: "/members", label: "Members and audit", icon: "people", admin: true }, { href: "/standards", label: "Standards and formats", icon: "standards" }] },
];
export const sectionOf = (path: string) => SECTIONS.find((s) => s.pages.some((p) => p.href === path));
export const parentOf = (path: string) => SECTIONS.find((s) => s.pages.some((p) => path === p.href || path.startsWith(`${p.href}/`)))?.parent ?? path;
export const ALL_NAV = NAV.flatMap((g) => g.items);
export const navFor = (path: string) => ALL_NAV.find((n) => n.href === path || path.startsWith(`${n.href}/`));
