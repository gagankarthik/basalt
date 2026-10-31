import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/icons";
import { DocsShell } from "@/components/docs/DocsShell";
import { Markdown } from "@/components/docs/Markdown";
import { TOPICS } from "@/lib/docs/content";
import { parse, spans } from "@/lib/docs/markdown";

type Props = { params: Promise<{ topic: string }> };
export const dynamicParams = false;
export const generateStaticParams = () => TOPICS.map((t) => ({ topic: t.slug }));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { topic } = await params, t = TOPICS.find((x) => x.slug === topic);
  return t ? { title: `${t.title} - Basalt docs`, description: t.description } : {};
}

export default async function TopicPage({ params }: Props) {
  const { topic } = await params, at = TOPICS.findIndex((t) => t.slug === topic), t = TOPICS[at];
  if (!t) notFound();
  const heads = parse(t.body).flatMap((b) => (b.t === "h2" || b.t === "h3" ? [b] : []));
  const prev = TOPICS[at - 1], next = TOPICS[at + 1];
  const toc = heads.length > 1 && <nav className="docs-toc" aria-label="On this page"><h2>On this page</h2><ul>{heads.map((h) => <li key={h.id} className={h.t === "h3" ? "sub" : undefined}><a href={`#${h.id}`}>{spans(h.text).map((s) => s.text).join("")}</a></li>)}</ul></nav>;
  return <DocsShell slug={t.slug} toc={toc}>
    <article className="docs-article">
      <p className="docs-crumb">{t.group}</p>
      <h1>{t.title}</h1>
      <Markdown source={t.body} />
      <nav className="docs-pager" aria-label="Previous and next">
        {prev && <Link href={`/docs/${prev.slug}`} rel="prev"><Icon className="docs-back" name="chevRight" size={16} /><span><small>Previous</small>{prev.title}</span></Link>}
        {next && <Link href={`/docs/${next.slug}`} rel="next" className="end"><span><small>Next</small>{next.title}</span><Icon name="chevRight" size={16} /></Link>}
      </nav>
    </article>
  </DocsShell>;
}
