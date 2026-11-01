import type { Kind } from "./types.ts";

/** Choices for showing a field, by what kind of data it holds. They change only how a value looks: filters, sorting and exports still use the real value. */
export const FIELD_FORMATS: Record<string, [string, string][]> = {
  number: [["", "Standard"], ["plain", "No separators, 1234567"], ["whole", "Whole number"], ["decimal2", "Two decimals"], ["currency", "Currency"], ["percent", "Percent, value as is"], ["percent100", "Percent, 0.5 is 50%"], ["compact", "Short, 1.2M"]],
  date: [["", "As stored"], ["date", "Date, Oct 29, 2026"], ["datetime", "Date and time"], ["iso", "2026-10-29"], ["month", "Month, Oct 2026"], ["year", "Year"], ["ago", "Time ago"]],
  text: [["", "As stored"], ["upper", "UPPERCASE"], ["lower", "lowercase"], ["title", "Title Case"], ["link", "Web link"], ["email", "Email link"]],
  bool: [["", "Yes or No"], ["truefalse", "true or false"], ["check", "Check mark"], ["number", "1 or 0"]],
};
export const formatsFor = (kind: Kind | undefined) => FIELD_FORMATS[kind ?? "text"] ?? null;

const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;
// Read and written as UTC, so a stored date never shifts a day because of where the viewer is
const parseDate = (v: unknown) => { const m = STAMP.exec(String(v)); if (!m) return null; const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)); return Number.isNaN(t) ? null : new Date(t); };

function ago(d: Date, now: number) {
  const s = Math.round((now - d.getTime()) / 1000), a = Math.abs(s);
  const [n, unit] = a < 60 ? [a, "second"] : a < 3600 ? [Math.floor(a / 60), "minute"] : a < 86400 ? [Math.floor(a / 3600), "hour"] : a < 2592000 ? [Math.floor(a / 86400), "day"] : a < 31536000 ? [Math.floor(a / 2592000), "month"] : [Math.floor(a / 31536000), "year"];
  const label = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return s >= 0 ? `${label} ago` : `in ${label}`;
}

/** The text for a value in a chosen format. A value that doesn't fit the format is shown as it is, never hidden or turned into a wrong number. */
export function formatField(v: unknown, kind: Kind | undefined, format: string | undefined, opts: { locale?: string; currency?: string; now?: number } = {}): string | null {
  if (!format || v == null) return null;
  const { locale = "en-US", currency = "USD", now = Date.now() } = opts, raw = String(v);
  if (kind === "number") {
    const n = Number(v);
    if (raw.trim() === "" || !Number.isFinite(n)) return raw;
    switch (format) {
      case "plain": return raw;
      case "whole": return Math.round(n).toLocaleString(locale);
      case "decimal2": return n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case "currency": return n.toLocaleString(locale, { style: "currency", currency });
      case "percent": return `${n.toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
      case "percent100": return `${(n * 100).toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
      case "compact": return n.toLocaleString(locale, { notation: "compact", maximumFractionDigits: 1 });
    }
    return null;
  }
  if (kind === "date") {
    const d = parseDate(v);
    if (!d) return raw;
    const utc = { timeZone: "UTC" } as const;
    switch (format) {
      case "date": return d.toLocaleDateString(locale, { ...utc, year: "numeric", month: "short", day: "numeric" });
      case "datetime": return d.toLocaleString(locale, { ...utc, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      case "iso": return d.toISOString().slice(0, 10);
      case "month": return d.toLocaleDateString(locale, { ...utc, year: "numeric", month: "short" });
      case "year": return String(d.getUTCFullYear());
      case "ago": return ago(d, now);
    }
    return null;
  }
  if (kind === "bool") {
    const on = v === true || raw === "true" || raw === "1";
    switch (format) {
      case "truefalse": return on ? "true" : "false";
      case "check": return on ? "✓" : "✗";
      case "number": return on ? "1" : "0";
    }
    return null;
  }
  switch (format) {
    case "upper": return raw.toUpperCase();
    case "lower": return raw.toLowerCase();
    case "title": return raw.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
  }
  return null;
}

/** Where a value may link to. Only ordinary web and email addresses, so a stored value can never run script when clicked. */
export function fieldHref(v: unknown, format: string | undefined): string | null {
  if (v == null) return null;
  const raw = String(v).trim();
  if (format === "link") {
    // Without a scheme it has to look like a domain, or every plain word would become a link
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    if (!hasScheme && !/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(raw)) return null;
    const withScheme = hasScheme ? raw : `https://${raw}`;
    try { const u = new URL(withScheme); return (u.protocol === "https:" || u.protocol === "http:") && !/\s/.test(raw) ? u.href : null; } catch { return null; }
  }
  if (format === "email") return /^[^\s@<>"':?&=]+@[^\s@<>"':?&=]+\.[^\s@<>"':?&=]+$/.test(raw) ? `mailto:${raw}` : null;
  return null;
}
