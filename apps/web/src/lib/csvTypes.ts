import { q } from "./sql.ts";

/** Formats the CSV reader leaves as text, because the same characters mean different things in different countries. */
export const CONVERSIONS = ["DECIMAL_COMMA", "DATE_MDY", "DATE_DMY"] as const;
export type Conversion = (typeof CONVERSIONS)[number];
export const CONVERSION_LABELS: [Conversion, string][] = [["DECIMAL_COMMA", "Decimal with a comma, 10,50"], ["DATE_MDY", "Date, month first, 01/31/2026"], ["DATE_DMY", "Date, day first, 31/01/2026"]];

const DATE = /^(\d{1,2})[/-](\d{1,2})[/-]\d{4}$/;
/**
 * The conversion these values clearly need, or "" when they don't all fit one or could mean two things.
 * "1,234" could be a thousand or a decimal, and 01/05/2026 could be January or May, so those are left for a person to choose: a wrong guess would change the data without anyone noticing.
 */
export function suggestConversion(values: (string | null)[]): Conversion | "" {
  const v = values.filter((x): x is string => x != null && x.trim() !== "").map((x) => x.trim());
  if (!v.length) return "";
  if (v.every((x) => /^-?(\d+|\d{1,3}(\.\d{3})+),\d+$/.test(x)) && v.some((x) => !/^-?\d{1,3},\d{3}$/.test(x))) return "DECIMAL_COMMA";
  const parts = v.map((x) => DATE.exec(x));
  if (parts.every(Boolean)) {
    const a = parts.map((m) => Number(m![1])), b = parts.map((m) => Number(m![2]));
    if (a.some((n) => n > 12) && b.every((n) => n <= 12)) return "DATE_DMY";
    if (b.some((n) => n > 12) && a.every((n) => n <= 12)) return "DATE_MDY";
  }
  return "";
}

/** A value that doesn't fit comes out empty, so the import can count and report it. */
export function convertSql(column: string, to: string) {
  const c = `trim(CAST(${q(column)} AS VARCHAR))`;
  if (to === "DECIMAL_COMMA") return `CASE WHEN regexp_full_match(${c}, '-?[0-9.]*,?[0-9]+') THEN TRY_CAST(replace(replace(${c}, '.', ''), ',', '.') AS DOUBLE) END`;
  if (to === "DATE_MDY" || to === "DATE_DMY") {
    const f = to === "DATE_MDY" ? "%m" + "{s}%d{s}%Y" : "%d{s}%m{s}%Y";
    // A four-digit year is required, because the reader would otherwise turn 26 into the year 26
    return `CASE WHEN regexp_full_match(${c}, '[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{4}') THEN CAST(COALESCE(TRY_STRPTIME(${c}, '${f.replaceAll("{s}", "/")}'), TRY_STRPTIME(${c}, '${f.replaceAll("{s}", "-")}')) AS DATE) END`;
  }
  return `TRY_CAST(${q(column)} AS ${to})`;
}
