/* The small part of Markdown the docs use. Inline code is «like this» and code blocks are fenced with ~~~, because content.ts holds pages in template strings, where backticks would end the string. */
export type Block =
  | { t: "h2" | "h3"; text: string; id: string }
  | { t: "p"; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "code"; text: string }
  | { t: "table"; head: string[]; rows: string[][] };
export type Span = { t: "text" | "code" | "b"; text: string } | { t: "a"; text: string; href: string };

export const slugify = (s: string) => s.toLowerCase().replace(/[«»*]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const cells = (line: string) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

export function parse(md: string): Block[] {
  const lines = md.split("\n"), out: Block[] = [], seen = new Map<string, number>();
  const id = (text: string) => { const s = slugify(text), n = seen.get(s) ?? 0; seen.set(s, n + 1); return n ? `${s}-${n + 1}` : s; };
  const run = (i: number, re: RegExp) => { const got: string[] = []; while (i < lines.length && re.test(lines[i])) got.push(lines[i++]); return got; };
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith("~~~")) { const end = lines.indexOf("~~~", i + 1), stop = end < 0 ? lines.length : end; out.push({ t: "code", text: lines.slice(i + 1, stop).join("\n") }); i = stop + 1; continue; }
    const h = /^(##|###) (.+)$/.exec(l);
    if (h) { out.push({ t: h[1] === "##" ? "h2" : "h3", text: h[2], id: id(h[2]) }); i++; continue; }
    if (l.startsWith("|")) { const t = run(i, /^\|/); out.push({ t: "table", head: cells(t[0]), rows: t.slice(2).map(cells) }); i += t.length; continue; }
    if (l.startsWith("- ")) { const t = run(i, /^- /); out.push({ t: "ul", items: t.map((x) => x.slice(2)) }); i += t.length; continue; }
    if (/^\d+\. /.test(l)) { const t = run(i, /^\d+\. /); out.push({ t: "ol", items: t.map((x) => x.replace(/^\d+\. /, "")) }); i += t.length; continue; }
    const t = run(i, /^(?!\s*$|~~~|## |### |\||- |\d+\. )/);
    out.push({ t: "p", text: t.join(" ") }); i += t.length;
  }
  return out;
}

export function spans(text: string): Span[] {
  const out: Span[] = [], re = /«([^»]+)»|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ t: "text", text: text.slice(at, m.index) });
    if (m[1] != null) out.push({ t: "code", text: m[1] }); else if (m[2] != null) out.push({ t: "b", text: m[2] }); else out.push({ t: "a", text: m[3], href: m[4] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ t: "text", text: text.slice(at) });
  return out;
}

/** Plain words of a page, for search. */
export function plainText(md: string) {
  return parse(md).flatMap((b): string[] => { switch (b.t) { case "ul": case "ol": return b.items; case "table": return [...b.head, ...b.rows.flat()]; default: return [b.text]; } }).map((s) => s.replace(/[«»]|\*\*/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")).join(" ");
}
