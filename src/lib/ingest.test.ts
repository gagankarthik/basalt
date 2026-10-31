import assert from "node:assert/strict";
import test from "node:test";
import { columnName, flatten, mergeKind, parseEvents, storedType, streamName } from "./ingest.ts";
import { detectLive } from "./pii.ts";

test("reads one object, a list, and one object per line", () => {
  assert.deepEqual(parseEvents('{"a":1}'), [{ a: 1 }]);
  assert.deepEqual(parseEvents('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseEvents('{"a":1}\n\n{"a":2}\r\n'), [{ a: 1 }, { a: 2 }]);
});

test("refuses bodies it can't turn into events", () => {
  assert.throws(() => parseEvents("  "), /at least one/);
  assert.throws(() => parseEvents("[]"), /at least one/);
  assert.throws(() => parseEvents("[1]"), /Event 1 isn't a JSON object/);
  assert.throws(() => parseEvents('{"a":1}\nnope'), /Line 2/);
  assert.throws(() => parseEvents("[{"), /valid JSON/);
  assert.throws(() => parseEvents("null"), /Event 1/);
  assert.throws(() => parseEvents(JSON.stringify(Array.from({ length: 50001 }, () => ({})))), /at most 50,000/);
});

test("column names can be read by the personal data checks", () => {
  assert.equal(columnName("firstName"), "first_name");
  assert.equal(columnName("Full Name"), "full_name");
  assert.equal(columnName("1st"), "f_1st");
  assert.equal(columnName("!!!"), "field");
  assert.throws(() => columnName("_basalt_synced_at"), /reserved/);
});

test("nested fields become columns, so a nested email is seen by name", () => {
  const f = flatten({ id: 7, customer: { email: "a@x.com", address: { zip: "10001" } }, ok: true, price: 1.5, at: "2026-01-02T03:04:05Z", day: "2026-01-02", gone: null, tags: ["a"] });
  assert.deepEqual(f.row, { id: "7", customer_email: "a@x.com", customer_address_zip: "10001", ok: "true", price: "1.5", at: "2026-01-02T03:04:05Z", day: "2026-01-02", gone: null, tags: '["a"]' });
  assert.deepEqual(f.kinds, { id: "int", customer_email: "text", customer_address_zip: "text", ok: "bool", price: "float", at: "time", day: "time", tags: "list" });
  assert.ok(detectLive("customer_email", []));
  assert.ok(detectLive("customer_address_zip", []));
});

test("objects past the depth limit stay one column the checks read inside", () => {
  let deep: Record<string, unknown> = { email: "a@x.com" };
  for (let i = 0; i < 8; i++) deep = { n: deep };
  const f = flatten(deep);
  assert.deepEqual(Object.values(f.kinds), ["list"]);
  assert.equal(detectLive(Object.keys(f.row)[0], Object.values(f.row))?.kind, "Email address");
});

test("kinds widen without losing values", () => {
  assert.equal(mergeKind(undefined, "int"), "int");
  assert.equal(mergeKind("int", "float"), "float");
  assert.equal(mergeKind("int", "text"), "text");
  assert.equal(mergeKind("time", "text"), "text");
  assert.equal(mergeKind("text", "list"), "list");
  assert.equal(storedType("int", "hash"), "VARCHAR");
  assert.equal(storedType("time", "month"), "DATE");
  assert.equal(storedType("float", "keep"), "DOUBLE");
});

test("stream names are safe table names", () => {
  assert.equal(streamName(" Web Events! "), "web_events");
  assert.equal(streamName("***"), "");
});

test("live values are checked the way a sync checks its sample, and fail closed when there are few", () => {
  assert.equal(detectLive("contact", ["a@x.com"])?.kind, "Email address");
  assert.equal(detectLive("contact", ["a@x.com", "b@x.com", "c@x.com"])?.kind, "Email address");
  assert.equal(detectLive("note", ["hello", "world", "there", "a@x.com"]), null);
  assert.equal(detectLive("note", []), null);
  assert.equal(detectLive("ssn", ["anything"])?.rule, "drop");
});
