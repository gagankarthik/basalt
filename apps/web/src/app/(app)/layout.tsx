"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useRef } from "react";
import { Icon, Mark, type IconName } from "@/components/icons";
import { ALL_NAV, NAV, parentOf, SECTIONS, sectionOf } from "@/components/nav";
import { AccountMenu, Btn, ConnectionStatus, ErrorState, Modal, NoResults, Pop, Sk, Toasts } from "@/components/ui";
import { call, loadThemePref, requestNew, setThemePref, useApp, useIsDark, useNet, useTables, useThemeChoice, when, type ThemeChoice } from "@/lib/client";

const ALL: [string, string, IconName][] = [...new Map([...ALL_NAV, ...SECTIONS.flatMap((s) => s.pages)].map((n): [string, [string, string, IconName]] => [n.href, [n.href, n.label, n.icon]])).values(), ["/docs", "Docs", "book"]];
// Workspaces saved before the default changed hold the old colour without anyone having chosen it
const OLD_DEFAULT = "#1457d2";
const THEMES: [ThemeChoice, string, IconName][] = [["light", "Light", "sun"], ["dark", "Dark", "moon"], ["system", "Match device", "settings"]];
const NEW_ITEMS: { kind: string; href: string; label: string; note: string; icon: IconName; admin?: boolean }[] = [
  { kind: "connection", href: "/connections", label: "Connection", note: "Sync a database or cloud storage", icon: "plug" },
  { kind: "import", href: "/connections", label: "File import", note: "Load CSV, Excel, JSON, Parquet or XML", icon: "upload" },
  { kind: "model", href: "/models", label: "Transformation", note: "Build a table with SQL, Python or steps", icon: "model" },
  { kind: "base", href: "/bases", label: "Base", note: "Tables your team edits together", icon: "base" },
  { kind: "query", href: "/sql", label: "Query", note: "Write SQL against your data", icon: "code" },
  { kind: "notebook", href: "/notebooks", label: "Notebook", note: "Mix SQL, Python and notes, and run them on a schedule", icon: "notebook" },
  { kind: "view", href: "/explore", label: "Data view", note: "Save a filtered look at a table", icon: "table" },
  { kind: "dashboard", href: "/dashboards", label: "Dashboard", note: "Charts and numbers to share", icon: "dashboard" },
  { kind: "app", href: "/apps", label: "App", note: "Package dashboards for readers", icon: "apps" },
  { kind: "metric", href: "/metrics", label: "Metric", note: "Define a number once and reuse it", icon: "metric" },
  { kind: "member", href: "/members", label: "Member", note: "Invite someone to this workspace", icon: "people", admin: true },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, config, load } = useApp();
  const path = usePathname(), router = useRouter();
  const [open, setOpen] = useState(false), [palette, setPalette] = useState(false), [side, setSide] = useState<"auto" | "open" | "rail">("auto");
  const [failed, setFailed] = useState("");
  // Holds the page it was opened on, so moving to another page closes it
  const [newAt, setNewAt] = useState<string | null>(null);

  useEffect(() => { load().catch((e) => { if (useNet.getState().expired) window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); else setFailed(e.message); }); }, [load]);
  useEffect(() => { setOpen(false); setPalette(false); document.querySelector('.sb-item[aria-current="page"]')?.scrollIntoView({ block: "nearest" }); }, [path, config]);
  useEffect(() => { try { const v = localStorage.getItem("basalt-sidebar"); if (v === "open" || v === "rail") setSide(v); } catch { /* a preference only */ } }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); } };
    addEventListener("keydown", key); return () => removeEventListener("keydown", key);
  }, []);
  const s = config?.settings, theme = useThemeChoice(), dark = useIsDark();
  const themeSet = useRef(false);
  useEffect(loadThemePref, []);
  useEffect(() => {
    if (!s) return;
    const r = document.documentElement;
    const apply = () => { r.dataset.theme = theme; r.dataset.density = s.density; r.style.setProperty("--accent", s.accent === OLD_DEFAULT ? "#4124fb" : s.accent); };
    // Only a change made while the page is open animates; the first run here is just the page loading
    const changed = themeSet.current && r.dataset.theme !== theme;
    themeSet.current = true;
    // a page snapshot covers everything at once, including charts drawn on canvas; the new theme spreads out from the theme button
    if (changed && document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const b = document.querySelector('[aria-label="Theme"]')?.getBoundingClientRect();
      const x = b ? b.left + b.width / 2 : innerWidth, y = b ? b.top + b.height / 2 : 0;
      r.style.setProperty("--wave-x", `${x}px`); r.style.setProperty("--wave-y", `${y}px`);
      r.style.setProperty("--wave-end", `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 200}px`);
      r.classList.add("theme-wave");
      const t = document.startViewTransition(apply);
      // Quick repeat clicks cancel the running animation, which is expected; the theme is still applied
      t.ready.catch(() => {}); t.finished.catch(() => {}).finally(() => r.classList.remove("theme-wave"));
    } else apply();
  }, [s, theme]);

  // recents stay in this browser; they're a convenience and nothing depends on them
  useEffect(() => {
    if (!config || path === "/home") return;
    const dash = path.startsWith("/dashboards/") && config.dashboards.find((d) => path.endsWith(`/${d.id}`));
    const nav = ALL.find(([h]) => h === path);
    const item = dash ? { href: path, label: dash.name, icon: "dashboard" } : nav ? { href: nav[0], label: nav[1], icon: nav[2] } : null;
    if (!item) return;
    try { const old = JSON.parse(localStorage.getItem("basalt-recents") ?? "[]") as { href: string }[]; localStorage.setItem("basalt-recents", JSON.stringify([item, ...old.filter((x) => x.href !== item.href)].slice(0, 8))); } catch { /* storage may be blocked */ }
  }, [path, config]);
  if (failed) return <div className="auth"><ErrorState retry={() => location.reload()}>{failed}</ErrorState></div>;
  if (!config || !user) return <div className="auth"><div style={{ width: 260, display: "grid", gap: 8 }}><Sk h={18} /><Sk w="70%" /></div></div>;
  const parent = parentOf(path), current = ALL.find(([href]) => href === parent || parent.startsWith(`${href}/`)), section = sectionOf(path);
  const logout = async () => { await call("/api/auth", { json: { action: "logout" } }); window.location.assign("/login"); };
  const canEdit = useApp.getState().can("editor");
  const toggleSide = () => {
    if (innerWidth <= 860) { setOpen(!open); return; }
    const isRail = side === "rail" || (side === "auto" && innerWidth < 1200), next = isRail ? "open" : "rail";
    setSide(next); try { localStorage.setItem("basalt-sidebar", next); } catch { /* a preference only */ }
  };
  return (
    <div className={`shell side-${side}`}>
      <header className="topbar">
        <Btn className="tb-menu" icon="sidebar" variant="ghost" aria-label="Open navigation" aria-expanded={open} onClick={toggleSide} />
                <Link href="/home" className="brand"><Mark size={24} /><span>Basalt</span></Link>
        <button className="tb-search" aria-label="Search" onClick={() => setPalette(true)}><Icon name="search" /><span>Search tables, views and models</span><kbd>Ctrl K</kbd></button>
        <div className="tb-end">
          <Link href="/docs" className="btn ghost tb-docs" aria-label="Docs"><Icon name="book" /><span className="tb-label">Docs</span></Link>
          <Bell />
          <Pop align="right" width={200} trigger={(_, t) => <Btn icon={dark ? "moon" : "sun"} variant="ghost" aria-label="Theme" title="Theme" onClick={t} />}>{(close) => <div className="menu">{THEMES.map(([v, l, ic]) => <button key={v} aria-pressed={theme === v} onClick={() => { close(); setThemePref(v); }}><Icon name={ic} />{l}{theme === v && <Icon name="check" style={{ marginLeft: "auto" }} />}</button>)}</div>}</Pop>
          <AccountMenu user={user} onSignOut={logout} />
        </div>
      </header>
      <ConnectionStatus />
      <div className="workarea">
        <div className={`scrim ${open ? "open" : ""}`} aria-hidden="true" onClick={() => setOpen(false)} />
        <nav className={`sb ${open ? "open" : ""}`} aria-label="Main">
          {canEdit && <div className="sb-new"><Btn variant="primary" icon="plus" aria-label="New" title="Create something new" onClick={() => { setOpen(false); setNewAt(path); }}><span className="long">New</span></Btn></div>}
          <div className="sb-scroll">
          {NAV.map((g) => (
            <div key={g.title || "top"} className="sb-group">
              {g.title && <h4>{g.title}</h4>}
              {g.items.map((n) => { const on = current?.[0] === n.href; return <Link key={n.href} className="sb-item" href={n.href} title={n.label} aria-current={on ? "page" : undefined}><span className="sb-ic"><Icon name={n.icon} size={20} /></span><span className="long">{n.label}</span></Link>; })}
            </div>
          ))}
          </div>
          <div className="sb-foot"><button className="sb-item" aria-label="Collapse or expand sidebar" title="Collapse or expand sidebar" onClick={toggleSide}><span className="sb-ic"><Icon name="sidebar" size={20} /></span><span className="long">Collapse</span><span className="short">Expand</span></button></div>
        </nav>
        {newAt === path && <Modal full wide title="Create new" onClose={() => setNewAt(null)}><div className="conn-grid">{NEW_ITEMS.filter((n) => !n.admin || user.role === "admin").map((n) => <button key={n.kind} className="conn" onClick={() => { setNewAt(null); requestNew(n.kind); router.push(n.href); }}><Icon name={n.icon} size={22} /><div><b>{n.label}</b><div className="small muted">{n.note}</div></div></button>)}</div></Modal>}
        <main className="page">{section && <nav className="tabs" aria-label="Section">{section.pages.filter((n) => !n.admin || user.role === "admin").map((n) => <Link key={n.href} href={n.href} aria-current={n.href === path ? "page" : undefined}>{n.label}</Link>)}</nav>}{children}</main>
      </div>
      {palette && <Palette onClose={() => setPalette(false)} go={(h) => { setPalette(false); router.push(h); }} />}
      <Toasts />
    </div>
  );
}

type Notice = { id: string; at: string; level: "bad" | "warn" | "good"; title: string; detail: string; href: string; resolvedAt?: string; delivery?: string };
function Bell() {
  const [items, setItems] = useState<Notice[]>([]);
  useEffect(() => { const t = () => call<{ items: Notice[] }>("/api/alerts").then((r) => setItems(r.items)).catch(() => {}); void t(); const i = setInterval(t, 60000); return () => clearInterval(i); }, []);
  const open = items.filter((n) => !n.resolvedAt).length;
  return (
    <Pop align="right" width={340} trigger={(_, t) => <span className="bell"><Btn icon="bell" variant="ghost" aria-label={open ? `Alerts, ${open} open` : "Alerts"} onClick={t} />{open > 0 && <i aria-hidden="true">{open}</i>}</span>}>
      {(close) => <div className="notices">
        <h3>Alerts</h3>
        {!items.length && <p className="muted small">No alerts. Failed syncs and checks appear here.</p>}
        {items.slice(0, 12).map((n) => <Link key={n.id} href={n.href} onClick={close} className={n.resolvedAt && n.level !== "good" ? "old" : ""}>
          <Icon name={n.level === "good" ? "check" : "warn"} size={15} style={{ color: `var(--${n.level})` }} />
          <span><b>{n.title}</b><small>{n.detail}</small><small>{when(n.at)}{n.resolvedAt && n.level !== "good" ? ", resolved" : ""}{n.delivery ? `. ${n.delivery}` : ""}</small></span>
        </Link>)}
      </div>}
    </Pop>
  );
}

function Palette({ onClose, go }: { onClose: () => void; go: (href: string) => void }) {
  const config = useApp((s) => s.config)!, tables = useTables();
  const [q, setQ] = useState(""), [i, setI] = useState(0);
  const items = useMemo(() => {
    const all: [string, string, IconName][] = [
      ...ALL.map(([h, l, ic]): [string, string, IconName] => [h, l, ic]),
      ...config.dashboards.map((d): [string, string, IconName] => [`/dashboards/${d.id}`, `Dashboard: ${d.name}`, "chart"]),
      ...config.views.map((v): [string, string, IconName] => [`/explore?view=${v.id}`, `View: ${v.name}`, "table"]),
      ...config.models.map((m): [string, string, IconName] => [`/models?m=${m.id}`, `Model: ${m.name}`, "model"]),
      ...config.pipelines.map((p): [string, string, IconName] => [`/pipelines?p=${p.id}`, `Pipeline: ${p.name}`, "flow"]),
      ...(tables ?? []).map((t): [string, string, IconName] => [`/catalog?t=${encodeURIComponent(t.full)}`, `Table: ${t.full}`, "catalog"]),
    ];
    const n = q.toLowerCase();
    return all.filter((x) => x[1].toLowerCase().includes(n)).slice(0, 40);
  }, [q, config, tables]);
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 65, background: "rgba(10,22,26,.35)" }} onClick={onClose} />
      <div className="palette" role="dialog" aria-label="Search">
        <input autoFocus placeholder="Search pages, dashboards, tables and models" aria-label="Search" value={q} onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowDown") { e.preventDefault(); setI(Math.min(i + 1, items.length - 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setI(Math.max(i - 1, 0)); } if (e.key === "Enter" && items[i]) go(items[i][0]); }} />
        <ul>{items.map((x, k) => <li key={x[0]}><button className={k === i ? "on" : ""} onClick={() => go(x[0])}><Icon name={x[2]} />{x[1]}</button></li>)}{!items.length && <li><NoResults what="pages or tables" /></li>}</ul>
      </div>
    </>
  );
}

