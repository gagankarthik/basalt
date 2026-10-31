"use client";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* the text stays there to select by hand */ } };
  return <button type="button" className="docs-copy" onClick={copy}><Icon name={done ? "check" : "copy"} size={14} /><span aria-live="polite">{done ? "Copied" : "Copy"}</span></button>;
}

/** CSS picks the icon, so this holds no state and can't disagree with the theme script. */
export function ThemeButton() {
  const flip = () => {
    const r = document.documentElement, t = r.dataset.theme, dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches), next = dark ? "light" : "dark";
    r.dataset.theme = next;
    try { localStorage.setItem("basalt-docs-theme", next); } catch { /* a preference only */ }
  };
  return <button type="button" className="docs-icon-btn" aria-label="Switch light or dark theme" onClick={flip}><Icon className="docs-sun" name="sun" /><Icon className="docs-moon" name="moon" /></button>;
}

type Entry = { slug: string; title: string; group: string; description: string; text: string };
const rank = (e: Entry, terms: string[]) => {
  const title = e.title.toLowerCase(), desc = e.description.toLowerCase(), hay = `${title} ${desc} ${e.text.toLowerCase()}`;
  if (!terms.every((t) => hay.includes(t))) return 0;
  return terms.reduce((n, t) => n + (title.includes(t) ? 10 : 0) + (desc.includes(t) ? 3 : 0) + 1, 0);
};
const snippet = (e: Entry, terms: string[]) => {
  const at = terms.map((t) => e.text.toLowerCase().indexOf(t)).find((i) => i >= 0);
  if (at == null) return e.description;
  const from = Math.max(0, e.text.lastIndexOf(" ", Math.max(0, at - 40)));
  return `${from ? "..." : ""}${e.text.slice(from, at + 80).trim()}...`;
};

export function DocsSearch() {
  const [all, setAll] = useState<Entry[] | null>(null), [q, setQ] = useState(""), [open, setOpen] = useState(false), [i, setI] = useState(0), [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null), box = useRef<HTMLDivElement>(null), router = useRouter();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName);
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) { e.preventDefault(); input.current?.focus(); }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  const load = () => { setOpen(true); if (!all) fetch("/docs/search.json").then((r) => r.json()).then(setAll, () => setFailed(true)); };
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = terms.length && all ? all.map((e) => [rank(e, terms), e] as const).filter(([n]) => n).sort((a, b) => b[0] - a[0]).slice(0, 8).map(([, e]) => e) : [];
  const go = (e: Entry) => { setOpen(false); setQ(""); input.current?.blur(); router.push(`/docs/${e.slug}`); };
  const showing = open && terms.length > 0;
  return <div className="docs-search" ref={box} onBlur={(e) => { if (!box.current?.contains(e.relatedTarget)) setOpen(false); }}>
    <Icon name="search" size={15} />
    <input ref={input} type="search" placeholder="Search the docs" aria-label="Search the docs" role="combobox" aria-expanded={showing} aria-controls="docs-results" aria-autocomplete="list" aria-activedescendant={showing && hits[i] ? `docs-hit-${i}` : undefined} value={q} onFocus={load}
      onChange={(e) => { setQ(e.target.value); setI(0); setOpen(true); }}
      onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); return; } if (e.key === "ArrowDown") { e.preventDefault(); setI(Math.min(i + 1, hits.length - 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setI(Math.max(i - 1, 0)); } if (e.key === "Enter" && hits[i]) go(hits[i]); }} />
    <kbd>Ctrl K</kbd>
    {showing && <div id="docs-results" role="listbox" aria-label="Search results" className="docs-results">
      {hits.map((e, k) => <button type="button" id={`docs-hit-${k}`} role="option" aria-selected={k === i} tabIndex={-1} key={e.slug} onMouseEnter={() => setI(k)} onClick={() => go(e)}><b>{e.title}</b><small>{e.group}</small><span>{snippet(e, terms)}</span></button>)}
      {!hits.length && <p>{failed ? "Search isn't available right now." : all ? "No page matches that search." : "Loading"}</p>}
    </div>}
  </div>;
}

/** The root layout's script only runs on a full load, so arriving by a link applies the saved theme here, and leaving puts back what the rest of the site uses. */
export function DocsTheme() {
  useLayoutEffect(() => {
    const r = document.documentElement, before = r.dataset.theme;
    let saved: string | null = null;
    try { saved = localStorage.getItem("basalt-docs-theme"); } catch { /* a preference only */ }
    if (saved === "light" || saved === "dark") r.dataset.theme = saved;
    // On a full load the script has already applied the saved theme, so it isn't what the rest of the site had
    const restore = before === saved ? "system" : before;
    return () => { if (restore) r.dataset.theme = restore; };
  }, []);
  return null;
}
