import type { Metadata } from "next";
import Link from "next/link";
import { DocsShell } from "@/components/docs/DocsShell";
import { TOPICS } from "@/lib/docs/content";

export const metadata: Metadata = { title: "Basalt documentation", description: "How to connect sources, protect personal data, build models and share dashboards and apps in Basalt." };

const POPULAR = ["get-started", "connections", "personal-data", "models", "dashboards", "current-limits"];

export default function DocsHome() {
  return <DocsShell>
    <article className="docs-article">
      <h1>Basalt documentation</h1>
      <p className="docs-lede">How to connect your data, protect personal data, build models and share reports in Basalt. New here? Start with <Link href="/docs/get-started">Get started</Link>.</p>
      <section className="docs-index"><h2>Most used</h2><dl>{TOPICS.filter((t) => POPULAR.includes(t.slug)).map((t) => <div key={t.slug}><dt><Link href={`/docs/${t.slug}`}>{t.title}</Link></dt><dd>{t.description}</dd></div>)}</dl></section>
    </article>
  </DocsShell>;
}
