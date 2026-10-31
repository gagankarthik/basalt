import Link from "next/link";
import { Icon } from "@/components/icons";
import { parse, spans, type Block } from "@/lib/docs/markdown";
import { CopyButton } from "./DocsClient";

function Inline({ text }: { text: string }) {
  return <>{spans(text).map((s, i) => s.t === "code" ? <code key={i}>{s.text}</code> : s.t === "b" ? <b key={i}>{s.text}</b> : s.t === "a" ? <Link key={i} href={s.href}>{s.text}</Link> : s.text)}</>;
}

function Render({ b }: { b: Block }) {
  switch (b.t) {
    case "h2": case "h3": { const H = b.t; return <H id={b.id}><a className="docs-anchor" href={`#${b.id}`} aria-label={`Link to ${b.text}`}><Icon name="link" size={14} /></a><Inline text={b.text} /></H>; }
    case "p": return <p><Inline text={b.text} /></p>;
    case "ul": return <ul>{b.items.map((x, i) => <li key={i}><Inline text={x} /></li>)}</ul>;
    case "ol": return <ol>{b.items.map((x, i) => <li key={i}><Inline text={x} /></li>)}</ol>;
    case "code": return <div className="docs-code"><pre tabIndex={0}><code>{b.text}</code></pre><CopyButton text={b.text} /></div>;
    case "table": return <div className="docs-table" tabIndex={0} role="region" aria-label="Table"><table><thead><tr>{b.head.map((h, i) => <th key={i} scope="col"><Inline text={h} /></th>)}</tr></thead><tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, k) => <td key={k}><Inline text={c} /></td>)}</tr>)}</tbody></table></div>;
  }
}

export const Markdown = ({ source }: { source: string }) => <>{parse(source).map((b, i) => <Render key={i} b={b} />)}</>;
