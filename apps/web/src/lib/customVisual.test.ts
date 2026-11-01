import assert from "node:assert/strict";
import { test } from "node:test";
import { customOption, MAX_SPEC, parseSpec, SPEC_STARTERS } from "./customVisual.ts";

const ok = (o: unknown) => { const r = parseSpec(JSON.stringify(o)); assert.ok(r.option, r.error); return r.option; };
const S = { series: [{ type: "bar" }] };

test("anything that could run HTML, load from elsewhere or open a link is removed, at any depth", () => {
  const o = ok({ ...S, title: { text: "Hi", link: "https://evil.example", sublink: "https://evil.example" }, tooltip: { formatter: "<img src=x onerror=alert(1)>", extraCssText: "x", appendToBody: true, renderMode: "html" }, graphic: [{ type: "image" }], toolbox: { feature: { dataView: {} } }, xAxis: { axisLabel: { formatter: "<b>" }, axisPointer: { label: { formatter: "<i>" } } }, backgroundColor: { image: "https://evil.example/x.png" } });
  const text = JSON.stringify(o);
  for (const bad of ["evil", "onerror", "formatter", "graphic", "toolbox", "extraCssText", "appendToBody", "image"]) assert.ok(!text.includes(bad), bad);
  assert.equal((o.title as { text: string }).text, "Hi");
});
test("remote and data addresses are dropped wherever they appear, and vector paths stay", () => {
  const o = ok({ series: [{ type: "scatter", symbol: "image://https://evil.example/a.png" }, { type: "scatter", symbol: "path://M0 0L1 1" }, { type: "bar", name: "data:text/html,x" }, { type: "bar", name: " JavaScript:x" }] });
  const s = o.series as { symbol?: string; name?: string }[];
  assert.equal(s[0].symbol, undefined);
  assert.equal(s[1].symbol, "path://M0 0L1 1");
  assert.equal(s[2].name, undefined);
  assert.equal(s[3].name, undefined);
});
test("a spec can't reach the prototype of every object", () => {
  ok(JSON.parse('{"series":[{"type":"bar"}],"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}'));
  assert.equal(({} as { polluted?: number }).polluted, undefined);
  assert.equal(Object.getPrototypeOf(parseSpec('{"__proto__":{"a":1},"series":[{"type":"bar"}]}').option), Object.prototype);
});
test("mistakes get a plain message", () => {
  assert.match(parseSpec("").error!, /Write a chart spec/);
  assert.match(parseSpec("{nope").error!, /isn't valid JSON/);
  assert.match(parseSpec("[1]").error!, /one JSON object/);
  assert.match(parseSpec("{}").error!, /series/);
  assert.match(parseSpec('{"series":[{"name":"x"}]}').error!, /needs a type/);
  assert.match(parseSpec(" ".repeat(MAX_SPEC) + "x").error!, /too long/);
});
test("the data can't be replaced by the spec, and tooltips always stay plain text", () => {
  const rows = [{ d: "a", m0: 1 }];
  const o = customOption(ok({ ...S, dataset: { source: [{ d: "fake" }] }, tooltip: { trigger: "axis" } }), rows);
  assert.deepEqual(o.dataset, { source: rows });
  assert.deepEqual(o.tooltip, { trigger: "axis", renderMode: "richText" });
});
test("a type the library can't draw from JSON is named, rather than leaving a blank tile", () => {
  assert.match(parseSpec('{"series":[{"type":"nosuchchart"}]}').error!, /can't draw the series type "nosuchchart"/);
  assert.match(parseSpec('{"series":[{"type":"custom"}]}').error!, /"custom"/);
  assert.ok(ok({ series: [{ type: "sankey" }] }));
});
test("long decimals are tidied and text and whole numbers are left alone", () => {
  const o = customOption(ok(S), [{ d: "a", m0: 292623.939999, m1: 7, s: "1.23456" }]);
  assert.deepEqual((o.dataset as { source: unknown[] }).source, [{ d: "a", m0: 292623.94, m1: 7, s: "1.23456" }]);
});
test("every starter is a valid spec", () => { for (const [name, spec] of SPEC_STARTERS) assert.ok(parseSpec(spec).option, name); });
