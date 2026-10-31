import { errorResponse, HttpError } from "@/server/auth";
import { findForm, submitForm } from "@/server/bases";

const WINDOW = 3600000, MAX = 60, FORM_MAX = 600, MAX_BODY = 256 * 1024, MAX_IPS = 10000, recent = new Map<string, number[]>(), byForm = new Map<string, number[]>();

/** Counts bytes as they arrive, because Content-Length is optional and can lie. */
async function readBody(req: Request) {
  const tooBig = () => new HttpError(413, "This submission is too large.");
  if (Number(req.headers.get("content-length")) > MAX_BODY) throw tooBig();
  const parts: Uint8Array[] = [], reader = req.body?.getReader();
  let size = 0;
  for (let r = await reader?.read(); r && !r.done; r = await reader?.read()) {
    size += r.value.length;
    if (size > MAX_BODY) { await reader?.cancel(); throw tooBig(); }
    parts.push(r.value);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

/** Public: only the form's own fields and options leave the server, never records. */
export async function GET(req: Request) {
  try {
    const m = findForm(new URL(req.url).searchParams.get("id") ?? "");
    if (!m) throw new HttpError(404, "This form is no longer available.");
    const f = m.v.form!;
    return Response.json({ title: f.title, description: f.description, thanks: f.thanks, required: f.required, fields: f.fields.map((id) => m.t.fields.find((x) => x.id === id)).filter(Boolean).map((x) => ({ id: x!.id, name: x!.name, type: x!.type, description: x!.description, choices: x!.choices, max: x!.max, includeTime: x!.includeTime })) });
  } catch (e) { return errorResponse(e); }
}

export async function POST(req: Request) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local", now = Date.now(), hits = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW);
    if (hits.length >= MAX) throw new HttpError(429, "Too many submissions. Try again later.");
    const b = await readBody(req);
    // A hidden field people never see; anything filling it is a bot, and it gets a normal-looking answer
    if (b.website) return Response.json({ ok: true });
    const m = findForm(String(b.id ?? ""));
    if (!m) throw new HttpError(404, "This form is no longer available.");
    const values = (b.values ?? {}) as Record<string, unknown>;
    for (const r of m.v.form!.required) { const v = values[r]; if (v == null || v === "" || v === false || (Array.isArray(v) && !v.length)) throw new HttpError(400, `Fill in ${m.t.fields.find((x) => x.id === r)?.name ?? "the required fields"}.`); }
    // The header can be spoofed, so this limit is the real one, and it only counts real forms so the map can't grow
    const formHits = (byForm.get(String(b.id)) ?? []).filter((t) => now - t < WINDOW);
    if (formHits.length >= FORM_MAX) throw new HttpError(429, "This form has had too many submissions. Try again later.");
    byForm.set(String(b.id), [...formHits, now]);
    // Made-up addresses would otherwise fill memory
    if (recent.size >= MAX_IPS) recent.clear();
    recent.set(ip, [...hits, now]);
    submitForm(String(b.id), values);
    return Response.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
