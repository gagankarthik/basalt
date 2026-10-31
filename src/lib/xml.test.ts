import assert from "node:assert/strict";
import test from "node:test";
import { xmlRow, xmlRows } from "./xml.ts";

test("reads the repeating element with attributes and nested fields", () => {
  const rows = xmlRows(`<?xml version="1.0"?><data><meta><n>2</n></meta><orders><order id="1"><city>Austin</city><ship><state>TX</state></ship></order><order id="2"><city>A &amp; B</city></order></orders></data>`);
  assert.deepEqual(rows, [{ city: "Austin", ship: { state: "TX" }, id: "1" }, { city: "A & B", id: "2" }]);
});

test("a single record is still one row", () => {
  assert.deepEqual(xmlRows("<order><id>7</id></order>"), [{ id: "7" }]);
});

test("written values are escaped and survive being read back", () => {
  const out = xmlRow({ a: "x<y&z", b: null, c: 3 });
  assert.equal(out, "<row><a>x&lt;y&amp;z</a><c>3</c></row>");
  assert.deepEqual(xmlRows(`<rows>${out}${out}</rows>`)[0], { a: "x<y&z", c: "3" });
});
