/* Airbyte Protocol reading and spec-to-form logic. Pure, so the browser and the tests can use it. No Airbyte source code is copied here: this only reads the published message format. */
import type { Column, StreamInfo } from "./types.ts";

export type AirbyteStream = { name: string; namespace?: string; json_schema?: JsonSchema; supported_sync_modes?: string[]; source_defined_cursor?: boolean; default_cursor_field?: string[]; source_defined_primary_key?: string[][] };
export type StateMessage = { type?: string; stream?: { stream_descriptor?: { name?: string; namespace?: string }; stream_state?: unknown }; global?: { shared_state?: unknown; stream_states?: unknown[] }; data?: unknown };
export type Message =
  | { type: "RECORD"; stream: string; data: Record<string, unknown> }
  | { type: "STATE"; state: StateMessage }
  | { type: "LOG"; level: string; message: string }
  | { type: "TRACE_ERROR"; message: string; failure?: string }
  | { type: "STREAM_INCOMPLETE"; stream: string }
  | { type: "SPEC"; schema: JsonSchema }
  | { type: "STATUS"; ok: boolean; message?: string }
  | { type: "CATALOG"; streams: AirbyteStream[] }
  | { type: "CONFIG_UPDATE"; config: Record<string, unknown> }
  | { type: "OTHER" }
  | { type: "TEXT"; line: string };

export const fullName = (name: string, namespace?: string | null) => (namespace ? `${namespace}.${name}` : name);

/** Splits stdout into lines however the chunks fall, and refuses a line too long to hold safely. */
export class LineSplitter {
  private tail = "";
  private max: number;
  constructor(max = 64 * 1024 * 1024) { this.max = max; }
  push(chunk: string): string[] {
    const parts = (this.tail + chunk).split("\n");
    this.tail = parts.pop()!;
    if (this.tail.length > this.max) throw new Error(`The connector sent a single line longer than ${Math.round(this.max / 1048576)} MB.`);
    return parts;
  }
  end(): string[] { const t = this.tail; this.tail = ""; return t.trim() ? [t] : []; }
}

// JSON numbers past 2^53 would silently change value in a JS number, so they're kept as their original text
const BIG = /[:[,]\s*-?\d{16,}/;
const parseJson = (line: string): unknown => BIG.test(line)
  ? JSON.parse(line, ((_k: string, v: unknown, ctx?: { source?: string }) => (typeof v === "number" && !Number.isSafeInteger(v) && Number.isInteger(v) && ctx?.source ? ctx.source : v)) as (k: string, v: unknown) => unknown)
  : JSON.parse(line);

/** One line of connector output. Anything that isn't a protocol message comes back as TEXT rather than failing the sync. */
export function parseMessage(line: string): Message {
  const s = line.trim();
  if (!s) return { type: "OTHER" };
  let m: Record<string, never> & { type?: unknown };
  if (s[0] !== "{") return { type: "TEXT", line: s };
  try { m = parseJson(s) as typeof m; } catch { return { type: "TEXT", line: s }; }
  if (!m || typeof m !== "object" || typeof m.type !== "string") return { type: "TEXT", line: s };
  const o = m as unknown as Record<string, Record<string, unknown> | undefined>;
  switch (m.type) {
    case "RECORD": {
      const r = o.record;
      if (!r || typeof r.stream !== "string" || !r.data || typeof r.data !== "object" || Array.isArray(r.data)) throw new Error("The connector sent a malformed RECORD message.");
      return { type: "RECORD", stream: fullName(r.stream, r.namespace as string | undefined), data: r.data as Record<string, unknown> };
    }
    case "STATE": if (!o.state) throw new Error("The connector sent a malformed STATE message."); return { type: "STATE", state: o.state as StateMessage };
    case "LOG": return { type: "LOG", level: String(o.log?.level ?? "INFO"), message: String(o.log?.message ?? "") };
    case "TRACE": {
      const t = o.trace as { type?: string; error?: { message?: string; internal_message?: string; failure_type?: string }; stream_status?: { status?: string; stream_descriptor?: { name?: string; namespace?: string } } } | undefined;
      if (t?.type === "ERROR") return { type: "TRACE_ERROR", message: String(t.error?.message ?? t.error?.internal_message ?? "The connector reported an error."), failure: t.error?.failure_type };
      if (t?.type === "STREAM_STATUS" && t.stream_status?.status === "INCOMPLETE") return { type: "STREAM_INCOMPLETE", stream: fullName(String(t.stream_status.stream_descriptor?.name), t.stream_status.stream_descriptor?.namespace) };
      return { type: "OTHER" };
    }
    case "SPEC": return { type: "SPEC", schema: (o.spec?.connectionSpecification ?? {}) as JsonSchema };
    case "CONNECTION_STATUS": return { type: "STATUS", ok: o.connectionStatus?.status === "SUCCEEDED", message: o.connectionStatus?.message as string | undefined };
    case "CATALOG": return { type: "CATALOG", streams: (o.catalog?.streams ?? []) as AirbyteStream[] };
    case "CONTROL": {
      const c = o.control as { type?: string; connectorConfig?: { config?: Record<string, unknown> } } | undefined;
      return c?.type === "CONNECTOR_CONFIG" && c.connectorConfig?.config ? { type: "CONFIG_UPDATE", config: c.connectorConfig.config } : { type: "OTHER" };
    }
    default: return { type: "OTHER" };
  }
}

/** The state to hand back next time for this stream: the latest GLOBAL, per-stream or older whole-source state. Returns null if the message is about another stream. */
export function stateFor(stream: string, state: StateMessage): StateMessage | null {
  if (state.type === "STREAM") {
    const d = state.stream?.stream_descriptor;
    return d?.name && fullName(d.name, d.namespace) === stream ? state : null;
  }
  return state.type === "GLOBAL" || state.data !== undefined ? state : null;
}

/** Record values as text in column order. Nested values become JSON text, the form a JSON column needs. */
export const recordRow = (data: Record<string, unknown>, cols: Column[]) => cols.map((c) => {
  const v = data[c.name];
  return v == null ? null : c.type === "JSON" || typeof v === "object" ? JSON.stringify(v) : String(v);
});

/* ---- catalog to columns ---- */
export type JsonSchema = {
  type?: string | string[]; format?: string; airbyte_type?: string; title?: string; description?: string; default?: unknown; const?: unknown; enum?: unknown[]; examples?: unknown[];
  properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; oneOf?: JsonSchema[]; anyOf?: JsonSchema[]; order?: number; airbyte_secret?: boolean; airbyte_hidden?: boolean; multiline?: boolean; pattern_descriptor?: string;
};
const plainType = (s: JsonSchema) => (Array.isArray(s.type) ? s.type.filter((t) => t !== "null") : [s.type]);
export function duckType(s: JsonSchema | undefined): string {
  if (!s || s.oneOf || s.anyOf) return "VARCHAR";
  const t = plainType(s);
  if (t.length !== 1) return "VARCHAR";
  if (t[0] === "integer") return "BIGINT";
  if (t[0] === "number") return s.airbyte_type === "integer" ? "BIGINT" : "DOUBLE";
  if (t[0] === "boolean") return "BOOLEAN";
  if (t[0] === "string" && s.format === "date") return "DATE";
  if (t[0] === "string" && s.format === "date-time") return "TIMESTAMP";
  if (t[0] === "object" || t[0] === "array") return "JSON";
  return "VARCHAR";
}
export const streamColumns = (s: AirbyteStream): Column[] => Object.entries(s.json_schema?.properties ?? {}).map(([name, p]) => ({ name, type: duckType(p) }));
/** Basalt only updates by a single top-level column, the same rule as its database connectors. */
export const streamInfo = (s: AirbyteStream): StreamInfo => {
  const pk = s.source_defined_primary_key, cur = s.default_cursor_field;
  return { name: fullName(s.name, s.namespace), columns: streamColumns(s), primaryKey: pk?.length === 1 && pk[0].length === 1 ? pk[0][0] : undefined, cursor: s.source_defined_cursor && cur?.length === 1 ? cur[0] : undefined };
};

/** What a connector is told to run for one stream. Throws when the mode can't work, rather than quietly copying everything. */
export function configuredStream(s: AirbyteStream, incremental: boolean, cursor: string | undefined) {
  const modes = s.supported_sync_modes ?? ["full_refresh"], name = fullName(s.name, s.namespace);
  if (incremental && !modes.includes("incremental")) throw new Error(`${name} doesn't support incremental sync in this connector. Use full refresh.`);
  const useInc = incremental || !modes.includes("full_refresh");
  const field = s.source_defined_cursor ? s.default_cursor_field ?? [] : cursor ? [cursor] : s.default_cursor_field ?? [];
  if (incremental && !field.length) throw new Error(`Choose a cursor column for ${name}.`);
  return { stream: s, sync_mode: useInc ? "incremental" : "full_refresh", destination_sync_mode: useInc ? "append" : "overwrite", cursor_field: useInc ? field : [], primary_key: s.source_defined_primary_key ?? [] };
}

/* ---- secrets ---- */
const SECRET_NAME = /(password|passwd|secret|token|api_?key|private_?key|credentials_?json|service_?account)/i;
/** Property names the spec marks airbyte_secret, anywhere in the schema. */
export function secretKeys(s: JsonSchema | undefined, out = new Set<string>()) {
  if (!s) return out;
  for (const [k, p] of Object.entries(s.properties ?? {})) { if (p.airbyte_secret) out.add(k); secretKeys(p, out); }
  for (const x of [...(s.oneOf ?? []), ...(s.anyOf ?? []), ...(s.items ? [s.items] : [])]) secretKeys(x, out);
  return out;
}
/** Every string in a config under a secret-marked or secret-looking key. */
export function secretValues(config: unknown, keys: Iterable<string>, under = false, out = new Set<string>()) {
  const set = keys instanceof Set ? keys : new Set(keys);
  if (typeof config === "string") { if (under && config) out.add(config); }
  else if (Array.isArray(config)) for (const v of config) secretValues(v, set, under, out);
  else if (config && typeof config === "object") for (const [k, v] of Object.entries(config)) secretValues(v, set, under || set.has(k) || SECRET_NAME.test(k), out);
  return out;
}
/** Removes known secret values from text, including how they look when JSON-escaped or URL-encoded. */
export function scrubber(values: Iterable<string>) {
  const forms = [...new Set([...values].flatMap((v) => [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)]))].filter(Boolean).sort((a, b) => b.length - a.length);
  return (text: string) => { let t = text; for (const f of forms) t = t.split(f).join("[hidden]"); return t; };
}

/* ---- connection form ---- */
export type ConfigValue = Record<string, unknown>;
const oneOfOf = (s: JsonSchema) => s.oneOf ?? s.anyOf;
/** The property that tells oneOf options apart, such as auth_type. */
export function discriminator(options: JsonSchema[]): string | undefined {
  const first = options[0]?.properties ?? {};
  return Object.keys(first).find((k) => options.every((o) => o.properties?.[k]?.const !== undefined || o.properties?.[k]?.enum?.length === 1));
}
const constOf = (p?: JsonSchema) => p?.const ?? p?.enum?.[0];
export const optionFor = (options: JsonSchema[], value: ConfigValue | undefined) => {
  const d = discriminator(options);
  return (d && options.find((o) => constOf(o.properties?.[d]) === value?.[d])) || options[0];
};
export const orderedProps = (s: JsonSchema) => Object.entries(s.properties ?? {}).filter(([, p]) => !p.airbyte_hidden).sort(([a, x], [b, y]) => (x.order ?? 1e6) - (y.order ?? 1e6) || a.localeCompare(b));
export function initialConfig(s: JsonSchema): ConfigValue {
  const out: ConfigValue = {};
  for (const [k, p] of Object.entries(s.properties ?? {})) {
    const opts = oneOfOf(p);
    if (p.const !== undefined || p.enum?.length === 1) out[k] = constOf(p);
    else if (p.default !== undefined) out[k] = p.default;
    else if (opts?.length && (p.type === "object" || !p.type) && s.required?.includes(k)) out[k] = initialConfig(optionFor(opts, undefined));
    else if (p.properties && s.required?.includes(k)) out[k] = initialConfig(p);
  }
  return out;
}
/** Labels of required fields left empty, in form order. The connector's own check does the rest of the validation. */
export function missingFields(s: JsonSchema, v: ConfigValue | undefined, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, p] of orderedProps(s)) {
    const label = `${prefix}${p.title ?? k}`, val = v?.[k], need = s.required?.includes(k), opts = oneOfOf(p);
    if (opts?.length && val && typeof val === "object") out.push(...missingFields(optionFor(opts, val as ConfigValue), val as ConfigValue, `${label}: `));
    else if (p.properties && (need || val)) out.push(...missingFields(p, val as ConfigValue, `${label}: `));
    else if (need && (val == null || val === "" || (Array.isArray(val) && !val.length))) out.push(label);
  }
  return out;
}
export const plainText = (html?: string) => html?.replace(/<a [^>]*>([^<]*)<\/a>/gi, "$1").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
export const licenseName = (l?: string) => (l && /^elv2$/i.test(l) ? "ELv2" : l ?? "Not stated");
