import Link from "next/link";
import { Icon, Mark } from "@/components/icons";
import { GROUPS, TOPICS } from "@/lib/docs/content";
import { DocsSearch, ThemeButton } from "./DocsClient";

function TopicNav({ slug }: { slug?: string }) {
  return <>{GROUPS.map((g) => <div key={g} className="docs-group"><h2>{g}</h2><ul>{TOPICS.filter((t) => t.group === g).map((t) => <li key={t.slug}><Link href={`/docs/${t.slug}`} aria-current={t.slug === slug ? "page" : undefined}>{t.title}</Link></li>)}</ul></div>)}</>;
}

/** Header, topic list and page columns. Each page renders it, so the current topic is marked with no browser code. */
export function DocsShell({ slug, toc, children }: { slug?: string; toc?: React.ReactNode; children: React.ReactNode }) {
  const cur = TOPICS.find((t) => t.slug === slug);
  return <div className="docs">
    <a className="docs-skip" href="#docs-main">Skip to content</a>
    <header className="docs-head">
      {/* Full page loads out of the docs, so their theme choice doesn't carry into pages with their own */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a className="docs-brand" href="/"><Mark size={24} /><span>Basalt</span></a>
      <Link className="docs-title" href="/docs">Docs</Link>
      <DocsSearch />
      <ThemeButton />
      {/* Sign-in sends someone already signed in straight to the app, and this page stays static */}
      <a className="docs-open" href="/login">Open app</a>
    </header>
    <details className="docs-menu" key={slug ?? "home"}>
      <summary><Icon name="menu" size={16} />{cur?.title ?? "Topics"}<Icon className="docs-chev" name="chevDown" size={16} /></summary>
      <nav aria-label="Topics menu"><TopicNav slug={slug} /></nav>
    </details>
    <div className="docs-cols">
      <nav className="docs-side" aria-label="Topics"><TopicNav slug={slug} /></nav>
      <main id="docs-main" className="docs-main">{children}</main>
      <div className="docs-toc-col">{toc}</div>
    </div>
  </div>;
}
