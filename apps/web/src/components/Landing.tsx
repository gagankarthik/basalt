"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { AccountMenu } from "@/components/ui";
import { Icon, Logo, Mark, type BrandName, type IconName } from "./icons";
import HeroIso from "./HeroIso";
import SecurityIso from "./SecurityIso";
import "./landing.css";

const ContourField = dynamic(() => import("./ContourField"), { ssr: false });

/* ---- motion: one spring for everything that moves ---- */
const SPRING = { type: "spring", bounce: 0, duration: 0.35 } as const;
const Motion = ({ children }: { children: ReactNode }) => <LazyMotion features={domMax} strict><MotionConfig reducedMotion="user" transition={SPRING}>{children}</MotionConfig></LazyMotion>;
const MLink = m.create(Link);
const PRESS = { whileTap: { scale: 0.98 } };
const LIFT = { press: { scale: 0.98 } };
// starts readable; .lp-settle in landing.css finishes it without JS, and skips it for reduced motion
const settle = (delay: number) => ({ initial: { opacity: 0.6, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { ...SPRING, delay } });
const FADE = { initial: { opacity: 0, y: -8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 } };
const PANEL = { enter: (d: number) => ({ opacity: 0, x: d * 24 }), on: { opacity: 1, x: 0 }, exit: (d: number) => ({ opacity: 0, x: d * -24 }) };

type MenuItem = { icon?: IconName; logo?: BrandName; name: string; line: string; href: string; badge?: string };
type Menu = { label: string; groups: { title: string; items: MenuItem[] }[]; aside?: { title: string; body: string; cta: string; href: string } };
const MENUS: Menu[] = [
  { label: "Product", groups: [
    { title: "Move and shape data", items: [
      { icon: "flow", name: "Pipelines", line: "Sync on a schedule, with a row check after every run", href: "#connect" },
      { icon: "shield", name: "Personal data", line: "Mask sensitive columns before anything is stored", href: "#protect" },
      { icon: "model", name: "Transformations", line: "SQL, Python, dbt-style models or a no-code editor", href: "#transform" },
    ] },
    { title: "Find and share answers", items: [
      { icon: "table", name: "Data views", line: "Grid, board, gallery and pivot views over any table", href: "#explore" },
      { icon: "code", name: "SQL editor and catalog", line: "Query anything and see what each column holds", href: "#explore" },
      { icon: "dashboard", name: "Dashboards and apps", line: "Visuals, DAX measures and published apps", href: "#report" },
    ] },
    { title: "Stay in control", items: [
      { icon: "check", name: "Data checks", line: "Row counts and model checks on every run", href: "#platform" },
      { icon: "people", name: "Roles and audit", line: "Enforced on the server, recorded and exportable", href: "#platform" },
      { icon: "book", name: "Standard formats", line: "Build files shaped like dbt's, plus lineage events", href: "#platform" },
    ] },
  ] },
  { label: "Solutions", groups: [
    { title: "By industry", items: [
      { icon: "table", name: "Retail and ecommerce", line: "Orders, customers and stock in one set of numbers", href: "#solutions" },
      { icon: "flow", name: "Manufacturing and logistics", line: "Follow production and shipments as they change", href: "#solutions" },
      { icon: "chart", name: "Financial services", line: "Reporting with row access rules and an audit trail", href: "#solutions" },
    ] },
    { title: "More industries", items: [
      { icon: "shield", name: "Healthcare operations", line: "Mask personal data before it's stored", href: "#solutions" },
      { icon: "code", name: "Software and technology", line: "Product and billing data without one-off reports", href: "#solutions" },
      { icon: "people", name: "Professional services", line: "Projects, clients and hours on shared dashboards", href: "#solutions" },
    ] },
  ], aside: { title: "Not sure if it fits?", body: "Tell us about your data and your team, and we'll help you decide.", cta: "Talk to sales", href: "/sales" } },
  { label: "Security", groups: [{ title: "How your data is protected", items: [
    { icon: "plug", name: "Read-only sources", line: "No session can write back to your database", href: "#security" },
    { icon: "shield", name: "Masking before storage", line: "Originals never reach the warehouse disk", href: "#protect" },
    { icon: "code", name: "Sandboxed SQL", line: "Queries can't read files or reach the network", href: "#security" },
    { icon: "key", name: "Encrypted passwords", line: "Connection passwords are encrypted at rest", href: "#security" },
  ] }], aside: { title: "Every layer, explained", body: "See how read-only sources, masking, the sandbox and roles work together.", cta: "See the security layers", href: "#security" } },
  { label: "Resources", groups: [{ title: "Get started and compare", items: [
    { icon: "flow", name: "How it works", line: "From connecting a source to sharing a report", href: "#how" },
    { icon: "table", name: "Compare", line: "What it replaces, and when it isn't a good fit", href: "#compare" },
    { icon: "clock", name: "Speed", line: "Measured results with the sample company", href: "#speed" },
  ] }], aside: { title: "Read the docs", body: "See how each part of Basalt works, step by step.", cta: "Open the docs", href: "/docs" } },
];
const SOLUTIONS: [IconName, string, string, string][] = [
  ["people", "Founders and operators", "Get trusted numbers without hiring a data team", "Dashboards for revenue and operations, one agreed definition for each metric, and a sample company to learn on."],
  ["code", "Developers", "Stop writing one-off reports against production", "A read-only copy for analytics, with SQL, Python and dbt-style models where you need them."],
  ["chart", "Analysts", "Model, explore and publish from one workspace", "Saved views, a catalog of every column, data checks on each build, and dashboards you can click through."],
  ["shield", "Security and compliance", "Control who sees which data", "Personal data masked before storage, row and table access rules, and an audit log you can export."],
];
const LOGOS: [BrandName | null, string, boolean][] = [["postgres", "PostgreSQL", true], ["mysql", "MySQL", true], ["mariadb", "MariaDB", true], ["parquet", "Parquet", true], ["json", "JSON", true], ["csv", "CSV", true], ["excel", "Excel", true], ["xml", "XML", true], ["s3", "Amazon S3", true], ["gcs", "Google Cloud", true], ["azure", "Azure Blob Storage", true], ["snowflake", "Snowflake", true], ["bigquery", "BigQuery", true], ["mongodb", "MongoDB", true], ["clickhouse", "ClickHouse", true], ["stripe", "Stripe", true], ["shopify", "Shopify", true]];

/* ---- small parts ---- */
function Tag({ icon, label, dark }: { icon: IconName; label: string; dark?: boolean }) {
  return <span className={`lp-tag ${dark ? "dark" : ""}`}><span><Icon name={icon} size={14} /></span>{label}<svg viewBox="0 0 12 34" aria-hidden="true"><path d="M0 .5h1L11 17 1 33.500H0" fill="none" stroke="currentColor" /><path d="M1 33.500 11 17" fill="none" stroke="var(--accent)" strokeWidth="3" /></svg></span>;
}
function Head({ tag, title, muted, dark }: { tag: { icon: IconName; label: string }; title: string; muted: string; dark?: boolean }) {
  return <header className="lp-head"><Tag {...tag} dark={dark} /><h2>{title} <span>{muted}</span></h2></header>;
}
const Pill = ({ tone, children }: { tone?: "good" | "warn" | "blue"; children: ReactNode }) => <span className={`lp-pill ${tone ?? ""}`}>{children}</span>;

/* ---- proofs: small worked examples beside each step ---- */
function ConnectProof() {
  return <div className="lp-proof"><div className="lp-proof-head"><span className="row"><Logo name="postgres" size={22} /><span><b>Production replica</b><small>PostgreSQL, read-only login</small></span></span><span className="lp-live"><Pill tone="good">Connected</Pill></span></div>
    {["Reached the database", "Session set to read-only", "Connected to a read replica", "Found 7 tables and 9 personal data columns"].map((t) => <div className="lp-line" key={t}><Icon name="check" size={15} /><span>{t}</span></div>)}
    <div className="lp-note-box"><b>Next sync</b><small>Every 15 minutes, with a row check after each run</small></div></div>;
}
function ProtectProof() {
  const rows: [string, string, string, string?][] = [["phone", "Mask characters", "21••••••42", "warn"], ["email", "Replace with a code", "id_75ce63f80337", "warn"], ["birth_date", "Round date to month", "1990-04-01", "warn"], ["home_address", "Leave out", "Not copied"]];
  return <div className="lp-proof flush"><table className="lp-mini"><thead><tr><th>Column</th><th>Rule</th><th>What gets stored</th></tr></thead><tbody>{rows.map(([a, b, c, t]) => <tr key={a}><td><code>{a}</code></td><td>{b}</td><td>{t ? <mark>{c}</mark> : <span className="faded">{c}</span>}</td></tr>)}
    <tr><td><code>alt_phone</code></td><td colSpan={2}><Pill tone="warn">Held back until a rule is chosen</Pill></td></tr></tbody></table></div>;
}
function TransformProof() {
  return <div className="lp-proof"><div className="lp-kinds"><span className="on">Python</span><span>SQL</span><span>No-code steps</span></div>
    <pre>{`def transform(tables):
    rows = tables["kitchen_performance"]
    return [
        {"kitchen": r["kitchen"],
         "busy": r["orders"] > 20000}
        for r in rows
    ]`}</pre>
    <div className="lp-line"><Icon name="check" size={15} /><span>Built in dependency order</span><Pill tone="good">Checks passed</Pill></div></div>;
}
function ExploreProof() {
  const rows: [string, string, string, "good" | "warn"][] = [["Williamsburg", "Lunch", "$11.21", "good"], ["East Austin", "Dinner", "$7.04", "good"], ["River North", "Lunch", "$6.21", "warn"]];
  return <div className="lp-proof flush"><div className="lp-chips"><span>Kitchen <b>Any</b></span><span>Meal <b>Any</b></span><span>Status <b>Any</b></span></div><table className="lp-mini"><thead><tr><th>Kitchen</th><th>Meal</th><th className="r">Amount</th><th>Status</th></tr></thead><tbody>{rows.map(([a, b, c, t]) => <tr key={a}><td>{a}</td><td>{b}</td><td className="r">{c}</td><td><Pill tone={t}>{t === "good" ? "Delivered" : "Pending"}</Pill></td></tr>)}</tbody></table></div>;
}
function ReportProof() {
  const bars = [34, 48, 44, 62, 58, 76, 88, 96];
  return <div className="lp-proof"><div className="lp-proof-head"><span><b>Revenue by month</b><small>Click a bar and the whole page follows</small></span></div>
    <svg viewBox="0 0 420 150" className="lp-bars" aria-hidden="true">{[30, 70, 110].map((y) => <line key={y} x1="0" x2="420" y1={y} y2={y} />)}{bars.map((h, i) => <rect key={i} x={10 + i * 51} y={148 - h * 1.4} width="34" height={h * 1.4} rx="3" className={i === bars.length - 1 ? "hi" : ""} />)}</svg></div>;
}

const STEPS: { id: string; nav: string; title: string; muted: string; body: string; proof: () => ReactNode }[] = [
  { id: "connect", nav: "Connect a source", title: "Connect your database.", muted: "Read-only, always", body: "Add a database with a read-only login, connect cloud storage on AWS, Azure or Google Cloud, or upload a file. Basalt opens every session as read-only, warns you if the login can write, and can follow PostgreSQL changes as they happen.", proof: ConnectProof },
  { id: "protect", nav: "Protect personal data", title: "Choose what gets stored.", muted: "Originals stay at the source", body: "Basalt scans column names and sampled values for personal data. Rules run before anything is written to disk, and a new personal data column is held back until someone chooses a rule.", proof: ProtectProof },
  { id: "transform", nav: "Transform", title: "Clean and join it.", muted: "With or without code", body: "Write SQL or Python, use dbt-style models, or prepare data in a no-code editor. Models run in dependency order, data checks report anything wrong, and lineage shows what feeds what.", proof: TransformProof },
  { id: "explore", nav: "Explore", title: "Find the answer.", muted: "Like a spreadsheet", body: "Edit data together in bases, or save grid, board, gallery and pivot views over any table. When you need more, the SQL editor has autocomplete, history and query plans, and the catalog shows what each column holds.", proof: ExploreProof },
  { id: "report", nav: "Report", title: "Share the numbers.", muted: "Everyone reads the same ones", body: "Build dashboards with slicers, cross-filtering and DAX measures, then publish them as apps. A shared semantic model keeps revenue meaning the same thing on every page, and live dashboards refresh when data changes.", proof: ReportProof },
];

function Flow() {
  const [active, setActive] = useState(STEPS[0].id);
  useEffect(() => {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) setActive(e.target.id); }), { rootMargin: "-40% 0px -55% 0px" });
    STEPS.forEach((s) => { const el = document.getElementById(s.id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);
  return (
    <div className="lp-flow">
      <nav aria-label="Steps"><ol>{STEPS.map((s) => <li key={s.id}>{active === s.id && <m.span layoutId="lp-step-bar" className="lp-step-bar" />}<a href={`#${s.id}`} aria-current={active === s.id ? "step" : undefined}>{s.nav}</a></li>)}</ol></nav>
      <div className="lp-steps">{STEPS.map((s) => <article id={s.id} key={s.id}><div><h3>{s.title} <span>{s.muted}</span></h3><p>{s.body}</p></div><div className={`lp-proof-slot${active === s.id ? " on" : ""}`}>{s.proof()}</div></article>)}</div>
    </div>
  );
}

/* ---- dark section art ---- */
const CLOSE_DELAY = 140;
const MenuLink = ({ it, onGo }: { it: MenuItem; onGo: () => void }) => (
  <m.a {...PRESS} className="lpn-link" href={it.href} onClick={onGo}>
    <span className="lpn-tile">{it.logo ? <Logo name={it.logo} size={18} /> : <Icon name={it.icon ?? "file"} size={17} />}</span>
    <span><b>{it.name}{it.badge && <i>{it.badge}</i>}</b><small>{it.line}</small></span>
  </m.a>
);
const PixelCorner = () => <svg className="lpn-pixels" viewBox="0 0 40 40" aria-hidden="true">{[[0, 0, 0.5], [1, 0, 0.3], [2, 0, 0.15], [0, 1, 0.3], [1, 1, 0.18], [0, 2, 0.15], [3, 0, 0.08], [0, 3, 0.08]].map(([x, y, o]) => <rect key={`${x}${y}`} x={39 - x * 10 - 9} y={y * 10 + 1} width="8" height="8" rx="1" fill="currentColor" opacity={o} />)}</svg>;

export function Nav({ base = "" }: { base?: string }) {
  const to = (h: string) => (h.startsWith("#") ? `${base}${h}` : h);
  const [menuOpen, setMenuOpen] = useState(false), [current, setCurrent] = useState(0), [dir, setDir] = useState(0), [mobile, setMobile] = useState(false), [scrolled, setScrolled] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const triggers = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => { const on = () => setScrolled(scrollY > 8); on(); addEventListener("scroll", on, { passive: true }); return () => removeEventListener("scroll", on); }, []);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!menuOpen) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenuOpen(false); triggers.current[current]?.focus(); } };
    addEventListener("keydown", esc); return () => removeEventListener("keydown", esc);
  }, [menuOpen, current]);
  const openMenu = (i: number) => { clearTimeout(closeTimer.current); setDir(Math.sign(i - current)); setCurrent(i); setMenuOpen(true); };
  const scheduleClose = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setMenuOpen(false), CLOSE_DELAY); };
  const closeAll = () => { setMenuOpen(false); setMobile(false); };
  const [user, setUser] = useState<{ name: string; email: string } | null | undefined>(undefined);
  useEffect(() => { fetch("/api/auth").then((r) => r.json()).then((r) => setUser(r.user ?? null), () => setUser(null)); }, []);
  const signOut = async () => { await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "logout" }) }); setUser(null); };
  return (
    <Motion><header className={`lp-nav ${scrolled || mobile || menuOpen ? "solid" : ""}`} onMouseLeave={scheduleClose} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setMenuOpen(false); }}>
      <div className="lp-wrap">
        <Link href="/" className="lp-brand" onMouseEnter={scheduleClose}><Mark size={28} />Basalt</Link>
        <nav aria-label="Primary" className="lpn-links">
          {MENUS.map((m, i) => { const open = menuOpen && current === i; return (
            <button key={m.label} type="button" className="lpn-trigger" ref={(el) => { triggers.current[i] = el; }} aria-expanded={open} aria-controls="lpn-mega"
              onPointerEnter={(e) => { if (e.pointerType === "mouse") openMenu(i); }}
              onClick={(e) => { if (e.detail === 0 && open) setMenuOpen(false); else openMenu(i); }}>{m.label}<Icon name="chevDown" size={15} /></button>
          ); })}
          <Link className="lpn-trigger" href="/docs" style={{ paddingRight: 14, textDecoration: "none" }}>Docs</Link>
        </nav>
        <div className="lp-nav-end" onMouseEnter={scheduleClose}>
          {user === undefined ? null : user ? <>
            <MLink {...PRESS} className="lp-btn pri sm" href="/home">Open workspace</MLink>
            <AccountMenu user={user} onSignOut={signOut} trigger="lp-account" />
          </> : <>
            <MLink {...PRESS} className="lp-signin" href="/login">Sign in</MLink>
            <MLink {...PRESS} className="lp-btn pri sm" href="/sales">Talk to sales</MLink>
          </>}
          <m.button {...PRESS} className="lp-burger" aria-label={mobile ? "Close menu" : "Open menu"} aria-expanded={mobile} aria-controls="lpn-mobile" onClick={() => setMobile(!mobile)}><Icon name={mobile ? "x" : "menu"} size={20} /></m.button>
        </div>
      </div>

      <div className={`lpn-scrim ${menuOpen ? "open" : ""}`} aria-hidden="true" onClick={() => setMenuOpen(false)} onMouseMove={(e) => { if (e.movementX || e.movementY) scheduleClose(); }} />
      <AnimatePresence>{menuOpen && (
        <m.div key="mega" {...FADE} id="lpn-mega" className="lpn-mega" onMouseEnter={() => clearTimeout(closeTimer.current)}>
          {/* layout animates the size change with transforms, so switching menus glides without reflowing */}
          <m.div layout className="lpn-viewport">
            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              <m.div key={MENUS[current].label} layout="position" custom={dir} variants={PANEL} initial="enter" animate="on" exit="exit" className="lpn-panel">
                {MENUS[current].groups.map((g) => <div key={g.title} className="lpn-col"><h4>{g.title}</h4>{g.items.map((it) => <MenuLink key={it.name} it={{ ...it, href: to(it.href) }} onGo={closeAll} />)}</div>)}
                {MENUS[current].aside && <div className="lpn-aside-wrap"><m.a {...PRESS} className="lpn-aside" href={to(MENUS[current].aside.href)} onClick={closeAll}><PixelCorner /><b>{MENUS[current].aside.title}</b><small>{MENUS[current].aside.body}</small><span>{MENUS[current].aside.cta}<Icon name="chevRight" size={15} /></span></m.a></div>}
              </m.div>
            </AnimatePresence>
          </m.div>
        </m.div>
      )}</AnimatePresence>

      <AnimatePresence>{mobile && (
        <m.div key="mobile" {...FADE} id="lpn-mobile" className="lpn-mobile">
          <div className="lpn-mobile-in"><div className="lpn-mobile-scroll">
            {MENUS.map((menu) => <div key={menu.label} className="lpn-mgroup"><h4>{menu.label}</h4>{menu.groups.map((g) => g.items.map((it) => <MenuLink key={it.name} it={{ ...it, href: to(it.href) }} onGo={closeAll} />))}</div>)}
            <div className="lpn-mactions"><MLink {...PRESS} className="lp-btn sec" href="/docs">Docs</MLink>{user ? <><MLink {...PRESS} className="lp-btn pri" href="/home">Open workspace</MLink><m.button {...PRESS} className="lp-btn sec" onClick={signOut}>Sign out {user.name}</m.button></> : <><MLink {...PRESS} className="lp-btn sec" href="/login">Sign in</MLink><MLink {...PRESS} className="lp-btn pri" href="/sales">Talk to sales</MLink></>}</div>
          </div></div>
        </m.div>
      )}</AnimatePresence>
    </header></Motion>
  );
}

const CARDS: { title: string; body: string; proof: ReactNode }[] = [
  { title: "Three ways to transform", body: "Analysts use no-code steps, engineers write SQL, and admins add Python when a job needs it. All three share one dependency graph.", proof: <div className="lp-list">{[["mart_customer_value", "No-code steps"], ["dim_customers", "SQL"], ["customer_segments", "Python"]].map(([a, b]) => <div key={a}><code>{a}</code><Pill tone="blue">{b}</Pill></div>)}</div> },
  { title: "A check after every run", body: "Row counts are compared after each sync. Models can require unique, filled and allowed values, and any failure shows on the run.", proof: <div className="lp-list">{[["customers", "6,500 rows", "Match", "good"], ["orders", "152,185 rows", "Match", "good"], ["tickets", "22 rows behind", "Review", "warn"]].map(([a, b, c, t]) => <div key={a}><span><code>{a}</code><small>{b}</small></span><Pill tone={t as "good" | "warn"}>{c}</Pill></div>)}</div> },
  { title: "Who gets in, and what they see", body: "Your identity provider or a second factor at sign-in, limits on how long a session lasts, and roles enforced on the server.", proof: <div className="lp-list">{[["Single sign-on", "OpenID Connect"], ["Two-factor sign-in", "Authenticator apps"], ["Session limits", "Idle and maximum"]].map(([a, b]) => <div key={a}><b>{a}</b><small>{b}</small></div>)}</div> },
  { title: "An audit trail", body: "Sign-ins, rule changes and access changes are recorded, and you can export them.", proof: <div className="lp-list">{[["Changed personal data rule", "customers.phone"], ["Added member", "as Viewer"], ["Ran sync", "7 tables"]].map(([a, b]) => <div key={a}><b>{a}</b><small>{b}</small></div>)}</div> },
  { title: "Standard formats", body: "Builds save files shaped like dbt's manifest and run results, and syncs log Airbyte-style messages.", proof: <div className="lp-list">{["manifest.json", "run_results.json", "OpenLineage event"].map((a) => <div key={a}><code>{a}</code><Icon name="check" size={15} /></div>)}</div> },
];
const SIGNALS: [IconName, string, string][] = [["key", "Encrypted secrets", "AES-256-GCM at rest"], ["people", "Two-factor sign-in", "Required by your admin if you choose"]];
const JOBS: [string, string, string][] = [["Copy data out of your databases", "Airbyte, Fivetran", "Pipelines and connectors"], ["Clean and join it", "dbt, Power Query", "Models and query editor"], ["Store it and query it", "Snowflake, Databricks SQL", "DuckDB warehouse and SQL editor"], ["Edit it like a spreadsheet", "Airtable", "Bases and data views"], ["Report on it", "Power BI, Metabase", "Semantic model, dashboards and apps"]];
const STATS: [string, string][] = [["2.1 s", "To sync and mask the sample company"], ["222,740", "Rows copied in that sync"], ["0.2 s", "To build 13 models and run their checks"], ["144 ms", "Typical delay for a PostgreSQL change to be queryable, at 10,000 changes a second"]];
const FOOT: [string, [string, string][]][] = [
  ["Product", [["Pipelines", "#connect"], ["Personal data", "#protect"], ["Transformations", "#transform"], ["Data views", "#explore"], ["Dashboards", "#report"]]],
  ["Company", [["Solutions", "#solutions"], ["Connectors", "#connectors"], ["Security", "#security"], ["Compare", "#compare"]]],
  ["Get started", [["How it works", "#how"], ["Docs", "/docs"], ["Talk to sales", "/sales"], ["Sign in", "/login"]]],
  ["Legal", [["Terms of service", "/terms"], ["Privacy policy", "/privacy"]]],
];

export default function Landing() {
  return (
    <Motion><div className="lp">
      <Nav />
      <section className="lp-hero">
        <div className="lp-contour" aria-hidden="true"><ContourField /></div>
        <div className="lp-wrap lp-hero-in">
          <m.a {...settle(0)} className="lp-new lp-settle" href="#connect"><span>New</span>Real-time data<Icon name="chevRight" size={14} /></m.a>
          <m.h1 {...settle(0.04)} className="lp-settle">Report on your databases, with personal data masked first</m.h1>
          <m.p {...settle(0.1)} className="lp-settle">Basalt copies data from your databases, masks personal data before it&apos;s stored, and gives your team transformations, editable bases, SQL, dashboards and apps.</m.p>
          <m.div {...settle(0.16)} className="lp-cta lp-settle"><MLink {...PRESS} className="lp-btn pri" href="/sales">Talk to sales</MLink><m.a {...PRESS} className="lp-btn sec" href="#how">See how it works</m.a></m.div>
        </div>
        <div className="lp-wrap"><m.div {...settle(0.24)} className="lp-frame lp-settle"><HeroIso /><ol className="lp-stages">{[["db", "Your databases", "Read-only"], ["shield", "Masking", "Before storage"], ["flow", "Warehouse", "Columnar and fast"], ["model", "Transformations", "SQL, Python, no-code"], ["chart", "Dashboards", "For the whole team"]].map(([ic, l, d]) => <li key={l}><Icon name={ic as IconName} size={20} /><span>{l}<small>{d}</small></span></li>)}</ol></m.div></div>
      </section>

      <section className="lp-logos" id="connectors">
        <div className="lp-wrap"><div className="lp-rails">
          <p>Reads from your databases, cloud storage and files</p>
          <ul>{LOGOS.map(([l, n, live]) => <m.li key={n} className={live ? "" : "planned"} whileTap="press"><m.span className="lp-logo-in" variants={LIFT}>{l ? <Logo name={l} size={24} /> : <Icon name="file" size={24} />}<span>{n}</span></m.span>{!live && <small>Planned</small>}</m.li>)}<li className="more"><MLink {...PRESS} href="/docs">More connectors</MLink></li></ul>
        </div></div>
      </section>

      <section className="lp-sec" id="how"><div className="lp-wrap"><div className="lp-rails lp-pad">
        <Head tag={{ icon: "flow", label: "How it works" }} title="From raw tables to the report your CEO reads." muted="In one workspace" />
        <Flow />
      </div></div></section>

      <section className="lp-sec tint" id="platform"><div className="lp-wrap"><div className="lp-rails lp-pad">
        <Head tag={{ icon: "settings", label: "Platform" }} title="Every run checked, every access change recorded." muted="With the controls enterprises ask for" />
        <ul className="lp-bento">{CARDS.map((c) => <li key={c.title}><div><h3>{c.title}</h3><p>{c.body}</p></div><div className="lp-card-proof">{c.proof}</div></li>)}</ul>
      </div></div></section>

      <section className="lp-sec" id="solutions"><div className="lp-wrap"><div className="lp-rails lp-pad">
        <Head tag={{ icon: "people", label: "Solutions" }} title="Founders, developers, analysts and security in one workspace." muted="Each team gets what it needs" />
        <ul className="lp-solutions">{SOLUTIONS.map(([ic, a, b, c]) => <li key={a}><span className="ic"><Icon name={ic} size={20} /></span><h3>{a}</h3><b>{b}</b><p>{c}</p></li>)}</ul>
      </div></div></section>

      <section className="lp-dark" id="security"><div className="lp-wrap"><div className="lp-rails">
        <div className="lp-secure">
          <div><Tag icon="shield" label="Security" dark /><h2>Careful at every layer. <span>Because it&apos;s your data</span></h2><p>Every layer assumes the one before it could fail. Sources can&apos;t be written to, originals never reach the warehouse, and SQL can&apos;t leave the sandbox. Python models run as real code, so only admins can change them.</p></div>
          <div className="lp-sec-art"><div className="lp-drift"><SecurityIso /></div><ul className="lp-sec-list">{[["Read-only sources", "No session can write back"], ["Masking", "Originals never reach the disk"], ["Sandboxed warehouse", "SQL can't read files or the network"], ["Roles and audit", "Checked on every API call"]].map(([a, b]) => <li key={a}><b>{a}</b><span>{b}</span></li>)}</ul></div>
        </div>
        <ul className="lp-signals">{SIGNALS.map(([ic, a, b]) => <li key={a}><Icon name={ic} size={20} /><b>{a}</b><span>{b}</span></li>)}</ul>
      </div></div></section>

      <section className="lp-sec" id="speed"><div className="lp-wrap"><div className="lp-rails lp-pad lp-speed">
        <div>
          <Tag icon="chart" label="Speed" />
          <h2>Fast on large tables. <span>No cluster to manage</span></h2>
          <p>The warehouse stores data by column, so totals over many rows stay quick on ordinary hardware.</p>
          <dl>{STATS.map(([a, b]) => <div key={b}><dt>{a}</dt><dd>{b}</dd></div>)}</dl>
          <small>Measured on a Windows PC, with the sample company and a test database. Your numbers will vary.</small>
        </div>
      </div></div></section>

      <section className="lp-sec tint" id="compare"><div className="lp-wrap"><div className="lp-rails lp-pad">
        <Head tag={{ icon: "table", label: "Compare" }} title="Five subscriptions, or one workspace." muted="It covers the core of each job" />
        <div className="lp-table"><table><thead><tr><th>The job</th><th>Usually done with</th><th>In Basalt</th></tr></thead><tbody>{JOBS.map(([a, b, c]) => <tr key={a}><td data-l="The job">{a}</td><td data-l="Usually done with">{b}</td><td data-l="In Basalt"><b>{c}</b></td></tr>)}</tbody></table></div>
        <div className="lp-fit">
          <div><h3>A good fit</h3><ul><li><Icon name="check" />Your data lives in PostgreSQL, MySQL, MariaDB, cloud storage or files</li><li><Icon name="check" />You want one tool with one set of permissions, not five</li><li><Icon name="check" />Personal data has to be masked before it&apos;s stored</li></ul></div>
          <div><h3>Not a good fit yet</h3><ul><li><Icon name="x" />Data too large for one warehouse</li><li><Icon name="x" />You need live sync from Kafka or MySQL</li><li><Icon name="x" />Many teams write heavily at the same time</li></ul></div>
        </div>
      </div></div></section>

      <section className="lp-sec closing" id="start"><div className="lp-wrap"><div className="lp-rails lp-pad lp-close">
        <h2>See Basalt with your own data. <span>Bring one database and one report</span></h2>
        <div>
          <p>Tell us what you use today, and we&apos;ll show you how it would look in Basalt and whether it fits your team.</p>
          <div className="lp-cta left"><MLink {...PRESS} className="lp-btn pri" href="/sales">Talk to sales</MLink><MLink {...PRESS} className="lp-btn sec" href="/docs">Read the docs</MLink></div>
        </div>
      </div></div></section>

      <footer className="lp-foot"><div className="lp-wrap">
        <div className="lp-foot-top"><div><span className="lp-brand"><Mark size={28} />Basalt</span><p>Data sync, transformations, bases, dashboards and apps for companies.</p></div>
          <nav aria-label="Footer">{FOOT.map(([h, links]) => <div key={h}><h3>{h}</h3><ul>{links.map(([l, href]) => <li key={l}>{href.startsWith("/") ? <MLink {...PRESS} href={href}>{l}</MLink> : <m.a {...PRESS} href={href}>{l}</m.a>}</li>)}</ul></div>)}</nav></div>
        <div className="lp-foot-end"><small>&copy; {new Date().getFullYear()} Basalt. Product names and logos belong to their owners and don&apos;t imply endorsement.</small><m.a {...PRESS} href="#top" onClick={(e) => { e.preventDefault(); scrollTo({ top: 0, behavior: "smooth" }); }}>Back to top</m.a></div>
      </div></footer>
    </div></Motion>
  );
}

