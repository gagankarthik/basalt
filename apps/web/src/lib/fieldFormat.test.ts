import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldHref, FIELD_FORMATS, formatField, formatsFor } from "./fieldFormat.ts";

const num = (v: unknown, f: string, o = {}) => formatField(v, "number", f, o);
test("numbers show as chosen", () => {
  assert.equal(num(1234567.891, "plain"), "1234567.891");
  assert.equal(num(1234.5, "whole"), "1,235");
  assert.equal(num(1234.5, "decimal2"), "1,234.50");
  assert.equal(num(1234.5, "currency"), "$1,234.50");
  assert.equal(num(1234.5, "currency", { currency: "EUR", locale: "de-DE" }), "1.234,50 €");
  assert.equal(num(12.5, "percent"), "12.5%");
  assert.equal(num(0.125, "percent100"), "12.5%");
  assert.equal(num(1234567, "compact"), "1.2M");
  assert.equal(num(-3, "currency"), "-$3.00");
  assert.equal(num(0, "currency"), "$0.00");
});
test("something that isn't a number is shown as it is, never as NaN or 0", () => {
  assert.equal(num("abc", "currency"), "abc");
  assert.equal(num("", "whole"), "");
  assert.equal(formatField(null, "number", "currency"), null);
});
test("big IDs aren't rounded by the plain format", () => assert.equal(num("9007199254740993", "plain"), "9007199254740993"));
const date = (v: unknown, f: string, o = {}) => formatField(v, "date", f, o);
test("dates show as chosen and don't shift a day with the viewer's zone", () => {
  assert.equal(date("2026-10-29", "date"), "Oct 29, 2026");
  assert.equal(date("2026-01-01 00:30:00", "date"), "Jan 1, 2026");
  assert.equal(date("2026-10-29 13:34:00", "iso"), "2026-10-29");
  assert.equal(date("2026-10-29", "month"), "Oct 2026");
  assert.equal(date("2026-12-31", "year"), "2026");
  assert.match(date("2026-10-29 13:34:00", "datetime")!, /Oct 29, 2026.*01:34 PM/);
});
test("time ago counts both ways", () => {
  const now = Date.UTC(2026, 9, 31, 12);
  assert.equal(date("2026-10-31 11:59:00", "ago", { now }), "1 minute ago");
  assert.equal(date("2026-10-29 12:00:00", "ago", { now }), "2 days ago");
  assert.equal(date("2026-11-02 12:00:00", "ago", { now }), "in 2 days");
  assert.equal(date("2024-10-31", "ago", { now }), "2 years ago");
});
test("a value that isn't a date stays as it is", () => assert.equal(date("not a date", "date"), "not a date"));
test("true and false show as chosen", () => {
  assert.equal(formatField(true, "bool", "check"), "✓");
  assert.equal(formatField(false, "bool", "check"), "✗");
  assert.equal(formatField(true, "bool", "number"), "1");
  assert.equal(formatField(false, "bool", "truefalse"), "false");
});
test("text changes case, including accents", () => {
  assert.equal(formatField("hello", "text", "upper"), "HELLO");
  assert.equal(formatField("HELLO", "text", "lower"), "hello");
  assert.equal(formatField("new york-city élan", "text", "title"), "New York-City Élan");
});
test("no format means the normal display", () => assert.equal(formatField(5, "number", ""), null));
test("only ordinary web and email addresses become links", () => {
  assert.equal(fieldHref("https://x.io/a", "link"), "https://x.io/a");
  assert.equal(fieldHref("x.io", "link"), "https://x.io/");
  assert.equal(fieldHref("Austin", "link"), null);
  assert.equal(fieldHref("x.io/a?b=1", "link"), "https://x.io/a?b=1");
  assert.equal(fieldHref("javascript:alert(1)", "link"), null);
  assert.equal(fieldHref("JaVaScRiPt:alert(1)", "link"), null);
  assert.equal(fieldHref("data:text/html,x", "link"), null);
  assert.equal(fieldHref("not a link", "link"), null);
  assert.equal(fieldHref("a@b.io", "email"), "mailto:a@b.io");
  assert.equal(fieldHref("a@b.io?bcc=x", "email"), null);
  assert.equal(fieldHref('a"><script>@b.io', "email"), null);
  assert.equal(fieldHref("x", "upper"), null);
});
test("every kind of field has its choices, and JSON has none", () => {
  for (const k of ["number", "date", "text", "bool"] as const) assert.ok(formatsFor(k)!.length > 1 && FIELD_FORMATS[k][0][0] === "");
  assert.equal(formatsFor("json"), null);
});
