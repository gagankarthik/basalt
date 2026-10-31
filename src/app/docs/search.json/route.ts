import { TOPICS } from "@/lib/docs/content";
import { plainText } from "@/lib/docs/markdown";

/** The words of the public pages, fetched only when someone starts to search. */
export function GET() {
  return Response.json(TOPICS.map((t) => ({ slug: t.slug, title: t.title, group: t.group, description: t.description, text: plainText(t.body) })), { headers: { "cache-control": "public, max-age=3600" } });
}
