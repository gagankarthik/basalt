import assert from "node:assert/strict";
import { test } from "node:test";
import { DAX_FUNCTIONS } from "../dax.ts";
import { MODEL_DAX_FUNCTIONS } from "../semantic.ts";
import { DAX_REFUSED, TOPICS } from "./content.ts";
import { parse, plainText, spans } from "./markdown.ts";

test("markdown blocks and inline parts", () => {
  const b = parse("## A b\n\nText «x» **y** [z](/docs/a)\n\n- one\n- two\n\n1. first\n\n| H | I |\n|---|---|\n| 1 | a\\|b |\n\n~~~\ncode\n~~~\n\n## A b");
  assert.deepEqual(b.map((x) => x.t), ["h2", "p", "ul", "ol", "table", "code", "h2"]);
  assert.deepEqual([b[0], b[6]].map((x) => (x as { id: string }).id), ["a-b", "a-b-2"]);
  assert.deepEqual((b[4] as { rows: string[][] }).rows, [["1", "a|b"]]);
  assert.deepEqual(spans("Text «x» **y** [z](/docs/a)").map((s) => s.t), ["text", "code", "text", "b", "text", "a"]);
  assert.equal(plainText("See [z](/docs/a) «x»").trim(), "See z x");
});

test("pages are unique, linked correctly and described", () => {
  const slugs = new Set(TOPICS.map((t) => t.slug));
  assert.equal(slugs.size, TOPICS.length);
  for (const t of TOPICS) {
    assert.ok(t.description.length > 30 && t.description.length < 170, t.slug);
    for (const m of t.body.matchAll(/\]\(\/docs\/([\w-]+)\)/g)) assert.ok(slugs.has(m[1]), `${t.slug} links to ${m[1]}`);
  }
});

test("public docs say nothing about hosting, and no internal details", () => {
  const banned = /docker|self-host|npm |pip install|cargo|\.key\b|data folder|reverse proxy|\bEC2\b|default password|→|·/i;
  for (const t of TOPICS) assert.ok(!banned.test(t.body + t.title + t.description) && !/BASALT_/.test(t.body), `${t.slug}: ${banned.exec(t.body)?.[0]}`);
});

test("the refused list matches the compilers", () => {
  for (const f of DAX_REFUSED) { assert.ok(!MODEL_DAX_FUNCTIONS.includes(f), f); assert.ok(!DAX_FUNCTIONS.includes(f), f); }
  for (const f of ["ADDCOLUMNS", "SELECTCOLUMNS", "CROSSFILTER", "CALCULATETABLE", "RELATEDTABLE"]) assert.ok(!DAX_FUNCTIONS.includes(f) && MODEL_DAX_FUNCTIONS.includes(f), f);
});
