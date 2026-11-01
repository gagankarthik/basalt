"use client";
import { Children, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import Link from "next/link";
import { useApp, useNet } from "@/lib/client";
import { filterList, first, flatten, last, step, typeAhead, type FlatOption, type SelEntry } from "@/lib/selectList";
import { Icon, type IconName } from "./icons";

export function Btn({ icon, children, variant, ...p }: { icon?: IconName; variant?: "primary" | "danger" | "ghost" | "on" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...p} className={`btn ${variant ?? ""} ${!children ? "icon" : ""} ${p.className ?? ""}`}>{icon && <Icon name={icon} />}{children}</button>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return <label className={`field ${error ? "invalid" : ""}`}><span className="lab">{label}</span>{children}{hint && !error && <span className="hint">{hint}</span>}{error && <span className="err small" role="alert"><Icon name="warn" size={14} />{error}</span>}</label>;
}

function placeSel(t: HTMLElement, p: HTMLElement) {
  const r = t.getBoundingClientRect(), list = p.querySelector<HTMLElement>("[role=listbox]")!, vw = document.documentElement.clientWidth, vh = visualViewport?.height ?? innerHeight;
  const want = list.scrollHeight + p.offsetHeight - list.clientHeight, below = vh - r.bottom - 12, above = r.top - 12, up = want > below && above > below;
  p.style.maxHeight = `${Math.max(Math.min(want, 320, up ? above : below), 80)}px`;
  p.style.left = `${Math.max(8, Math.min(r.left, vw - p.offsetWidth - 8))}px`;
  p.style.top = up ? "auto" : `${r.bottom + 4}px`;
  p.style.bottom = up ? `${innerHeight - r.top + 4}px` : "auto";
}

/**
 * Select-only combobox (WAI-ARIA APG). The list renders right after the trigger and goes in the top layer
 * through the Popover API: nothing clips or covers it, and inside a modal dialog it stays out of the inert part of the page.
 */
export function Sel({ options, value, onChange, className = "input", id, ...p }: { options: readonly SelEntry[]; value: string; onChange: (v: string) => void } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value" | "name" | "type" | "children">) {
  const auto = useId(), triggerId = id ?? `${auto}t`, listId = `${auto}l`, trigger = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), typed = useRef({ buf: "", at: 0 });
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(0);
  const all = flatten(options), list = open ? filterList(all, query) : all, filterable = all.length > 10;
  const selected = all.findIndex((o) => o.value === value), current = all[selected] ?? all[0], optId = (i: number) => `${auto}o${i}`;
  const show = (q = "", at?: number) => { const l = filterList(all, q); setQuery(q); setActive(at ?? (q ? first(l) : selected >= 0 && !all[selected].disabled ? selected : first(l))); setOpen(true); };
  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const commit = (o?: FlatOption) => { if (!o || o.disabled) return; if (o.value !== value) onChange(o.value); close(); };
  const type = (key: string, stamp: number) => { const t = typed.current; t.buf = stamp - t.at > 500 ? key : t.buf + key; t.at = stamp; return t.buf; };
  // No filter box on touch: it would raise the keyboard over the list being tapped
  const searching = () => filterable && !matchMedia("(pointer: coarse)").matches;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    if (["ArrowDown", "ArrowUp", "Enter", " ", "Home", "End"].includes(e.key) && !(e.altKey && e.key !== "ArrowDown")) { e.preventDefault(); typed.current.buf = ""; show("", e.key === "Home" ? first(all) : e.key === "End" ? last(all) : undefined); }
    else if (e.key.length === 1 && !e.altKey) {
      e.preventDefault();
      if (searching()) show(e.key);
      else { const hit = typeAhead(all, type(e.key, e.timeStamp), selected); show("", hit < 0 ? undefined : hit); }
    }
  };

  useLayoutEffect(() => {
    const t = trigger.current, el = pop.current;
    if (!open || !t || !el) return;
    el.showPopover?.();
    el.style.minWidth = `${t.getBoundingClientRect().width}px`;
    placeSel(t, el);
    el.style.width = `${Math.ceil(el.getBoundingClientRect().width)}px`; // filtering must not change the width
    search.current?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => { if (open && trigger.current && pop.current) placeSel(trigger.current, pop.current); }, [open, list.length]);
  useEffect(() => { if (open) pop.current?.querySelector(".sel-opt.on")?.scrollIntoView({ block: "nearest" }); }, [open, active]);
  useEffect(() => {
    if (!open) return;
    // Capture on window: Pop, Modal and the page's shortcuts listen on document, where React's stopPropagation can't reach them
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.isComposing) return;
      e.stopPropagation();
      const k = e.key, go = (i: number) => { e.preventDefault(); typed.current.buf = ""; setActive(i); }, inSearch = document.activeElement === search.current;
      if (k === "Escape") { e.preventDefault(); close(); }
      else if (k === "Tab") { trigger.current?.focus(); setOpen(false); }
      else if (k === "ArrowDown") go(step(list, active, 1));
      else if (k === "ArrowUp" && e.altKey) { e.preventDefault(); commit(list[active]); }
      else if (k === "ArrowUp") go(step(list, active, -1));
      else if (k === "Home") go(first(list));
      else if (k === "End") go(last(list));
      else if (k === "Enter") { e.preventDefault(); commit(list[active]); }
      else if (inSearch) return;
      else if (k === " " && !(typed.current.buf && e.timeStamp - typed.current.at <= 500)) { e.preventDefault(); commit(list[active]); }
      else if (k.length === 1 && !e.altKey) { e.preventDefault(); const hit = typeAhead(list, type(k, e.timeStamp), active); if (hit >= 0) setActive(hit); }
    };
    const out = (e: PointerEvent) => {
      const n = e.target as Node, t = trigger.current;
      if (!pop.current?.contains(n) && !t?.contains(n) && ![...(t?.labels ?? [])].some((l) => l.contains(n))) close(false);
    };
    const move = (e: Event) => { if (trigger.current && pop.current && !pop.current.contains(e.target as Node)) placeSel(trigger.current, pop.current); };
    addEventListener("keydown", key, true); addEventListener("pointerdown", out, true); addEventListener("scroll", move, true); addEventListener("resize", move); visualViewport?.addEventListener("resize", move);
    return () => { removeEventListener("keydown", key, true); removeEventListener("pointerdown", out, true); removeEventListener("scroll", move, true); removeEventListener("resize", move); visualViewport?.removeEventListener("resize", move); };
  });

  const row = (o: FlatOption, i: number) => (
    <div key={i} id={optId(i)} role="option" aria-selected={o.value === current?.value} aria-disabled={o.disabled || undefined} data-value={o.value} title={o.label} className={`sel-opt ${i === active && !o.disabled ? "on" : ""}`} onMouseMove={() => { if (!o.disabled && i !== active) setActive(i); }} onClick={() => commit(o)}>
      {o.label}{o.value === current?.value && <Icon name="check" size={14} />}
    </div>
  );
  const body: ReactNode[] = [];
  for (let i = 0; i < list.length;) {
    const g = list[i].group;
    if (!g) { body.push(row(list[i], i)); i++; continue; }
    let end = i; while (end < list.length && list[end].group === g) end++;
    const from = i;
    body.push(<div key={`g${i}`} role="group" aria-label={g}><div className="sel-group" aria-hidden="true">{g}</div>{list.slice(from, end).map((o, k) => row(o, from + k))}</div>);
    i = end;
  }
  return <>
    <button type="button" {...p} id={triggerId} ref={trigger} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-activedescendant={open && list[active] ? optId(active) : undefined} className={`sel ${className}`} onClick={() => { if (open) close(); else show(); }} onKeyDown={open ? undefined : onKeyDown} onKeyUp={(e) => { if (e.key === " ") e.preventDefault(); }}>
      <span className="sel-val"><span>{current?.label}</span>{all.map((o, i) => <i key={i} aria-hidden="true" data-l={o.label} />)}</span>
      <Icon name="chevDown" size={14} aria-hidden="true" />
    </button>
    {/* Stops the click reaching a wrapping label, which would reopen the list, and any row or sheet handler above */}
    {open && <div ref={pop} popover="manual" className="sel-pop" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {searching() && <input ref={search} className="input" role="searchbox" aria-label="Filter options" placeholder="Filter" aria-controls={listId} aria-activedescendant={list[active] ? optId(active) : undefined} autoComplete="off" value={query} onChange={(e) => { setQuery(e.target.value); setActive(first(filterList(all, e.target.value))); }} />}
      <div id={listId} role="listbox" aria-labelledby={triggerId} className="sel-list" onMouseDown={(e) => e.preventDefault()}>
        {!list.length && <div className="sel-empty">{all.length ? "No matches" : "No options"}</div>}
        {body}
      </div>
    </div>}
  </>;
}

export function Modal({ title, onClose, children, foot, wide, full, sheet, locked }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean; full?: boolean; sheet?: boolean; locked?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [area, setArea] = useState<React.CSSProperties>({}), titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!full) { if (!d.open) d.showModal(); return; }
    // Covers the main area only, so the sidebar and top bar stay in place and usable
    const main = document.querySelector("main.page") as HTMLElement | null;
    const fit = () => { const r = main?.getBoundingClientRect(); setArea(r ? { top: r.top, left: r.left, width: r.width, height: r.height, "--area": `${r.width}px` } as React.CSSProperties : { inset: 0, "--area": "100vw" } as React.CSSProperties); };
    fit(); d.show();
    const ro = main ? new ResizeObserver(fit) : null; if (main) ro!.observe(main);
    addEventListener("resize", fit);
    // A sheet opened on top handles its own Escape
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("dialog:modal")) onCloseRef.current(); };
    document.addEventListener("keydown", esc);
    return () => { ro?.disconnect(); removeEventListener("resize", fit); document.removeEventListener("keydown", esc); };
  }, [full]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} style={full ? area : undefined} className={`modal ${wide ? "wide" : ""} ${full ? "full" : ""} ${sheet ? "sheet" : ""}`} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (sheet && e.target === ref.current) onClose(); }}>
      <div className="modal-head"><h2 id={titleId} className="grow">{title}</h2>{!locked && <Btn icon="x" variant="ghost" aria-label="Close" onClick={onClose} />}</div>
      <div className="modal-body">{children}</div>
      {foot && <div className="modal-foot">{foot}</div>}
    </dialog>
  );
}

/** Popover anchored under its trigger; closes on outside click or Escape. */
export function Pop({ trigger, children, align = "left", width }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: ReactNode | ((close: () => void) => ReactNode); align?: "left" | "right"; width?: number }) {
  const [open, setOpen] = useState(false), ref = useRef<HTMLDivElement>(null), box = useRef<HTMLDivElement>(null);
  // Stays inside the window, whichever side it opens from
  useLayoutEffect(() => { const el = box.current; if (!open || !el) return; const r = el.getBoundingClientRect(), over = r.right - (document.documentElement.clientWidth - 8); el.style.translate = over > 0 ? `${-over}px` : r.left < 8 ? `${8 - r.left}px` : ""; }, [open]);
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", out); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", out); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      {trigger(open, () => setOpen(!open))}
      {open && <div ref={box} className="pop" style={{ top: "calc(100% + 4px)", [align]: 0, width: width && `min(${width}px, calc(100vw - 24px))` }}>{typeof children === "function" ? children(() => setOpen(false)) : children}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: (T | [T, ReactNode])[]; value: T; onChange: (v: T) => void }) {
  return <div className="tabs" role="tablist">{tabs.map((t) => { const [k, l] = Array.isArray(t) ? t : [t, t]; return <button key={k} role="tab" aria-selected={k === value} onClick={() => onChange(k)}>{l}</button>; })}</div>;
}
export function Seg<T extends string>({ options, value, onChange, label }: { options: [T, ReactNode, string?][]; value: T; onChange: (v: T) => void; label: string }) {
  return <div className="seg" role="group" aria-label={label}>{options.map(([k, l, title]) => <button key={k} title={title} aria-label={title} aria-pressed={k === value} onClick={() => onChange(k)}>{l}</button>)}</div>;
}
/** The "…" button with less-used actions. */
export const MoreMenu = ({ children, label = "More actions", width }: { children: (close: () => void) => ReactNode; label?: string; width?: number }) => (
  <Pop align="right" width={width} trigger={(_, t) => <Btn icon="dots" aria-label={label} title={label} onClick={t} />}>{(close) => <div className="menu">{children(close)}</div>}</Pop>
);
/** The house file picker: a normal button that opens the browser's file dialog. */
export const Upload = ({ label, ariaLabel, onFiles, accept, multiple }: { label: string; ariaLabel?: string; onFiles: (files: FileList) => void; accept?: string; multiple?: boolean }) => (
  <label className="btn upload"><Icon name="upload" />{label}<input type="file" aria-label={ariaLabel ?? label} accept={accept} multiple={multiple} onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ""; }} /></label>
);
/** A text link that goes to another page: an arrow shows it leaves, pointing back for a back link. */
export const GoLink = ({ href, back, onClick, children }: { href: string; back?: boolean; onClick?: () => void; children: ReactNode }) => (
  <Link className={`link go ${back ? "back" : ""}`} href={href} onClick={onClick}>{back && <Icon name="arrowLeft" size={14} />}{children}{!back && <Icon name="arrowRight" size={14} />}</Link>
);
export const Sk = ({ w = "100%", h = 14 }: { w?: number | string; h?: number | string }) => <span className="sk" style={{ width: w, height: h }} aria-hidden="true" />;
const EDITOR_ONLY = "An editor or admin can do this.";
const useCanEdit = () => useApp((s) => s.user ? s.can("editor") : true);
export const Empty = ({ title, children, action, icon = "info", compact, editor }: { title: string; children?: ReactNode; action?: ReactNode; icon?: IconName; compact?: boolean; editor?: boolean }) => {
  const canEdit = useCanEdit(), allowed = !editor || canEdit;
  return (
  <div className={`empty ${compact ? "compact" : ""}`}><span className="empty-ic"><Icon name={icon} size={32} /></span><h2>{title}</h2>{(children || !allowed) && <p className="muted">{children}{!allowed && <>{children ? " " : ""}{EDITOR_ONLY}</>}</p>}{action && allowed && <div className="empty-act">{action}</div>}</div>
  );
};
export const ErrorState = ({ title = "This couldn't load", children, retry }: { title?: string; children?: ReactNode; retry?: () => void }) => (
  <div className="empty bad" role="alert"><span className="empty-ic"><Icon name="warn" size={32} /></span><h2>{title}</h2>{children && <p className="muted">{children}</p>}{retry && <div className="empty-act"><Btn icon="refresh" onClick={retry}>Try again</Btn></div>}</div>
);
export const NoResults = ({ what = "results", onClear }: { what?: string; onClear?: () => void }) => (
  <div className="no-match"><h2>{`No ${what} match`}</h2>{onClear && <Btn onClick={onClear}>Clear</Btn>}</div>
);
export const PermissionDenied = ({ title = "You don't have access to this page", children = "Ask a workspace admin if you need access." }: { title?: string; children?: ReactNode }) => (
  <Empty icon="shield" title={title}>{children}</Empty>
);
export const SuccessState = ({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) => (
  <div className="empty good" role="status"><span className="empty-ic"><Icon name="check" size={32} /></span><h2>{title}</h2>{children && <p className="muted">{children}</p>}{action && <div className="empty-act">{action}</div>}</div>
);
/** Offline, slow network and expired session, for every signed-in page. */
export function ConnectionStatus() {
  const slow = useNet((s) => s.slow), expired = useNet((s) => s.expired), [offline, setOffline] = useState(false);
  useEffect(() => {
    setOffline(!navigator.onLine);
    const off = () => setOffline(true), on = () => { setOffline(false); toast("You're back online"); };
    addEventListener("offline", off); addEventListener("online", on);
    return () => { removeEventListener("offline", off); removeEventListener("online", on); };
  }, []);
  return <>
    {offline ? <div className="net-bar bad" role="alert"><Icon name="warn" />You&apos;re offline. You&apos;re seeing the last data loaded, and new changes won&apos;t save until you reconnect.</div>
      : slow ? <div className="net-bar" role="status"><Spinner />This is taking longer than usual. Your connection may be slow.</div> : null}
    {expired && <div className="session-shield" aria-hidden="true" />}
    {expired && <Modal locked title="Your session has ended" onClose={() => {}} foot={<a className="btn primary" href={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}>Sign in again</a>}><p>For your security, you were signed out. Sign in again to return to this page. Changes you hadn&apos;t saved may need to be made again.</p></Modal>}
  </>;
}
export const LoadingTable = ({ rows = 6, cols = 4, label = "Loading" }: { rows?: number; cols?: number; label?: string }) => (
  <div className="sk-table" role="status" aria-label={label}>{Array.from({ length: rows + 1 }, (_, r) => <div key={r} className={r ? "" : "head"}>{Array.from({ length: cols }, (_, c) => <Sk key={c} h={r ? 12 : 10} w={`${88 - ((r + c * 3) % 4) * 14}%`} />)}</div>)}</div>
);
export const LoadingCards = ({ count = 4, h = 92, label = "Loading" }: { count?: number; h?: number; label?: string }) => (
  <div className="sk-cards" role="status" aria-label={label}>{Array.from({ length: count }, (_, i) => <Sk key={i} h={h} />)}</div>
);
export const SectionHead = ({ title, desc, children }: { title: string; desc?: ReactNode; children?: ReactNode }) => (
  <div className="section-head"><div><h2>{title}</h2>{desc && <p className="muted small">{desc}</p>}</div>{children}</div>
);
/** The product's main path, left to right, with each stage linked to where it's managed. */
export const FlowStrip = ({ steps }: { steps: { label: string; value: ReactNode; sub: string; href: string; icon: IconName; todo?: boolean }[] }) => (
  <ol className="flow-strip">{steps.map((s) => <li key={s.label} className={s.todo ? "todo" : ""}><Link href={s.href}><IconTile icon={s.icon} /><span><small>{s.label}</small><b>{s.value}</b><small>{s.sub}</small></span></Link></li>)}</ol>
);
export const Spinner = () => <Icon name="refresh" className="spin" />;

export const IconTile = ({ icon }: { icon: IconName }) => <span className="tile-icon"><Icon name={icon} size={20} /></span>;
/** What a page is for, one click away from its title, so a new person doesn't have to guess. */
const PAGE_HELP: Record<string, [string, string]> = {
  Connections: ["Where your data comes from: databases, cloud storage, files and event streams.", "connections"],
  Pipelines: ["Choose which tables to copy from a connection, and how often.", "pipelines"],
  "ETL flow": ["Everything from sources through models to dashboards, on one page.", "etl-flow"],
  "Run history": ["Every sync, build, flow, export and notebook run, and how it went.", "pipelines"],
  Models: ["Clean and combine copied data into tables your team can trust, with SQL, Python or no-code steps.", "models"],
  "Data catalog": ["Every table in the warehouse, with its columns, a preview and where it comes from.", "data-views-and-catalog"],
  Bases: ["Tables your team edits together, stored right here. Nothing else to set up.", "bases"],
  "Data views": ["Filter, sort and group any table, then save the view to reuse it.", "data-views-and-catalog"],
  Notebooks: ["A page of SQL, Python and notes that runs top to bottom, on demand or on a schedule.", "notebooks"],
  Dashboards: ["Charts and numbers to share, built from any table.", "dashboards"],
  Apps: ["Package dashboards for a chosen audience.", "apps"],
  Metrics: ["Define a number once, such as revenue, so everyone uses the same one.", "semantic-model"],
  "Personal data": ["Choose how each column of personal data is treated before it's stored.", "personal-data"],
};
function PageHelp({ title }: { title: string }) {
  const help = PAGE_HELP[title];
  if (!help) return null;
  return <Pop width={320} trigger={(_, t) => <Btn icon="info" variant="ghost" aria-label={`What ${title} is for`} title={`What ${title} is for`} onClick={t} />}><p style={{ marginBottom: 8 }}>{help[0]}</p><Link className="link" href={`/docs/${help[1]}`}>Read more</Link></Pop>;
}
export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return <header className="page-head"><div className="page-title"><h1>{title}</h1><PageHelp title={title} /></div>{children && <div className="actions">{children}</div>}<SplitToggle /></header>;
}
export const AccountMenu = ({ user, onSignOut, trigger = "tb-account" }: { user: { name: string; email: string; role?: string }; onSignOut: () => void; trigger?: string }) => (
  <Pop align="right" width={280} trigger={(_, t) => <button className={trigger} aria-label="Account menu" onClick={t}><Avatar name={user.name} size={32} /></button>}>
    {(close) => <div className="acct">
      <div className="acct-head"><Avatar name={user.name} size={42} /><div><b>{user.name}</b><span>{user.email}</span>{user.role && <em>{user.role[0].toUpperCase() + user.role.slice(1)}</em>}</div></div>
      <div className="acct-items"><Link href="/home" onClick={close}><Icon name="home" />Workspace</Link><Link href="/account" onClick={close}><Icon name="shield" />Your account</Link><Link href="/settings" onClick={close}><Icon name="settings" />Settings</Link></div>
      <div className="acct-items"><button onClick={onSignOut}><Icon name="logout" />Sign out</button></div>
    </div>}
  </Pop>
);

/** A side panel and main area. The panel can be dragged wider or narrower, or collapsed, and it stays that way. */
const SplitCtx = createContext<ReactNode>(null);
/** The button that brings a collapsed side panel back. Each page puts it in its own header row, and it sits at the end. */
export const SplitToggle = () => <>{useContext(SplitCtx)}</>;

export function Split({ id, width = 240, label = "Panel", children }: { id: string; width?: number; label?: string; children: ReactNode }) {
  const key = `basalt-split-${id}`, [w, setW] = useState(width), [closed, setClosed] = useState(false), box = useRef<HTMLDivElement>(null);
  useEffect(() => { try { const s = JSON.parse(localStorage.getItem(key) ?? "null"); if (s) { setW(s.w); setClosed(s.closed); } } catch { /* a preference only */ } }, [key]);
  const save = (nw: number, c: boolean) => { const v = Math.min(560, Math.max(160, nw)); setW(v); setClosed(c); try { localStorage.setItem(key, JSON.stringify({ w: v, closed: c })); } catch { /* a preference only */ } };
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const left = box.current!.getBoundingClientRect().left, el = e.currentTarget; let last = w;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => { last = Math.min(560, Math.max(160, m.clientX - left)); setW(last); };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); save(last, false); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  };
  const [side, ...main] = Children.toArray(children);
  return <div ref={box} className={`split ${closed ? "closed" : ""}`} style={{ "--side": `${w}px` } as React.CSSProperties}>
    {closed
      ? null
      : <div className="split-side"><div className="split-head"><b>{label}</b><button type="button" aria-label={`Hide ${label}`} aria-expanded title={`Hide ${label}`} onClick={() => save(w, true)}><Icon name="sidebar" size={18} /></button></div>{side}</div>}
    {!closed && <div className="split-handle" role="separator" aria-orientation="vertical" aria-label={`Resize ${label}`} aria-valuenow={w} aria-valuemin={160} aria-valuemax={560} tabIndex={0} onPointerDown={drag} onKeyDown={(e) => { if (e.key === "ArrowLeft") save(w - 24, false); if (e.key === "ArrowRight") save(w + 24, false); }} />}
    <SplitCtx.Provider value={closed ? <button type="button" className="btn split-show" aria-label={`Show ${label}`} aria-expanded={false} title={`Show ${label}`} onClick={() => save(w, false)}><Icon name="sidebar" size={18} /><span>{label}</span></button> : null}>{main}</SplitCtx.Provider>
  </div>;
}

const fitGrow = (v: number, reserve: number) => Math.round(Math.max(96, Math.min(innerHeight - reserve, v)));
/** A panel docked at the bottom of the screen that's dragged taller from its top edge. `reserve` is the height everything else on the screen needs, so it can't push itself off screen, even when the window shrinks. */
export function GrowUp({ id, label, height = 160, reserve, children }: { id: string; label: string; height?: number; reserve: number; children: ReactNode }) {
  const key = `basalt-grow-${id}`, [h, setH] = useState(height);
  const fit = (v: number) => fitGrow(v, reserve);
  const keep = (v: number) => { setH(v); try { localStorage.setItem(key, String(v)); } catch { /* a preference only */ } };
  useEffect(() => { try { const s = Number(localStorage.getItem(key)); if (s) setH(fitGrow(s, reserve)); } catch { /* a preference only */ } }, [key, reserve]);
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget, from = e.clientY, start = h; let last = h;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => { last = fit(start + from - m.clientY); setH(last); };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); keep(last); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  };
  return <div className="grow-up" style={{ height: h, maxHeight: `max(96px, calc(100dvh - ${reserve}px))` }}>
    <div className="grow-handle" role="separator" aria-orientation="horizontal" aria-label={`Resize ${label}`} aria-valuenow={h} tabIndex={0} onPointerDown={drag} onKeyDown={(e) => { if (e.key === "ArrowUp") keep(fit(h + 24)); if (e.key === "ArrowDown") keep(fit(h - 24)); }} />
    {children}
  </div>;
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const letters = name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return <span className="avatar" aria-hidden="true" style={{ width: size, height: size }}>{letters}</span>;
}
const STATUS: Record<string, [string, string, IconName?]> = { waiting: ["warn", "Waiting"], connected: ["good", "Connected"],
  succeeded: ["good", "Succeeded", "check"], ok: ["good", "Synced", "check"], partial: ["warn", "Partly failed", "warn"], failed: ["bad", "Failed", "warn"], running: ["info", "Running", "refresh"], skipped: ["", "Skipped"],
  success: ["good", "Built", "check"], pass: ["good", "Passed", "check"], fail: ["bad", "Failed", "warn"], error: ["bad", "Error", "warn"], warn: ["warn", "Warning", "warn"], "runtime error": ["bad", "Error", "warn"],
};
export const StatusBadge = ({ s }: { s: string }) => { const [c, l, i] = STATUS[s] ?? ["", s]; return <span className={`badge ${c} ${i ? "" : "dot"}`}>{i && <Icon name={i} size={12} />}{l}</span>; };

type T = { id: number; msg: string; bad?: boolean };
const useToasts = create<{ list: T[] }>(() => ({ list: [] }));
export function toast(msg: string, bad = false) {
  const id = Date.now() + Math.random();
  useToasts.setState((s) => ({ list: [...s.list, { id, msg, bad }] }));
  setTimeout(() => useToasts.setState((s) => ({ list: s.list.filter((x) => x.id !== id) })), bad ? 7000 : 3500);
}
export function Toasts() {
  const list = useToasts((s) => s.list);
  return <div className="toasts" role="status" aria-live="polite">{list.map((t) => <div key={t.id} className={`toast ${t.bad ? "bad" : ""}`}><Icon name={t.bad ? "warn" : "check"} /><span>{t.msg}</span></div>)}</div>;
}

export function Confirm({ title, body, action, onYes, onClose }: { title: string; body: ReactNode; action: string; onYes: () => void; onClose: () => void }) {
  return <Modal title={title} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="danger" onClick={() => { onYes(); onClose(); }}>{action}</Btn></>}><p>{body}</p></Modal>;
}
