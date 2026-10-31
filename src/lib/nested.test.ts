import assert from "node:assert/strict";
import nodeModule, { createRequire } from "node:module";
import test from "node:test";
import { asTextSql, cellText, collectLeaves, flattenSql, fromTextSql, isNestedType, jsonPath, pgArrayJson, prettyNested, type Leaves } from "./nested.ts";
import { detectPii, findInNested, maskExpr, piiLabel, scanStructured } from "./pii.ts";
import { compileSteps, type Step } from "./transform.ts";
import { MAX_XML_BYTES, XML_TOO_LARGE, xmlRows } from "./xml.ts";

const { DuckDBInstance } = createRequire(import.meta.url)("@duckdb/node-api");
type Row = Record<string, unknown>;
const withDb = async <T,>(fn: (run: (sql: string) => Promise<Row[]>) => Promise<T>) => {
  const db = await DuckDBInstance.create(":memory:"), c = await db.connect();
  try { return await fn(async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Row[]); } finally { c.closeSync(); db.closeSync(); }
};

/* ---- personal data in nested values ---- */
test("a nested email is found by key, at any depth, in any array", () => {
  assert.deepEqual(findInNested("doc", '{"a":{"b":[{"c":1},{"email":null}]}}'), { kind: "Email address", rule: "drop", path: "doc.a.b[].email" });
  assert.equal(findInNested("doc", '{"billingFirstName":"Ann"}')?.kind, "Person name");
  assert.equal(findInNested("customer", '{"name":"Ann"}')?.path, "customer.name");
  assert.equal(findInNested("doc", '{"ns:ssn":"x"}')?.kind, "Government ID");
});
test("a nested email is found by value, whatever the key is called", () => {
  assert.deepEqual(findInNested("doc", '{"x":{"y":["z","a.b@c.io"]}}'), { kind: "Email address", rule: "drop", path: "doc.x.y[]" });
  assert.equal(findInNested("doc", '{"note":"reach me at a.b@c.io today"}')?.kind, "Email address");
  assert.equal(findInNested("doc", '{"x":"123-45-6789"}')?.kind, "Government ID");
  assert.equal(findInNested("doc", '{"x":"4111 1111 1111 1111"}')?.kind, "Financial account");
  assert.equal(findInNested("doc", '{"x":"(212) 555-0142"}')?.kind, "Phone number");
  assert.equal(findInNested("doc", '{"x":2125550142}')?.kind, "Phone number");
  assert.equal(findInNested("doc", '{"payload":"{\\"email\\":\\"hidden\\"}"}')?.path, "doc.payload.email", "JSON inside a JSON string");
});
test("text that isn't JSON is still read: DuckDB prints, XML, hstore, array literals", () => {
  assert.equal(findInNested("c", "{'email': NULL, 'n': 1}")?.kind, "Email address");
  assert.equal(findInNested("c", "<a><b>x@y.co</b></a>")?.kind, "Email address");
  assert.equal(findInNested("c", "<a><ns:email>hidden</ns:email></a>")?.kind, "Email address");
  assert.equal(findInNested("c", '"phone"=>"x"')?.kind, "Phone number");
  assert.equal(findInNested("c", "{x@y.co,z}")?.kind, "Email address");
});
test("clean nested data passes, and what can't be finished counts as found", () => {
  assert.equal(findInNested("doc", '{"sku":"A-1","qty":3,"tags":["x","y"],"ok":true,"id":1712345678,"z":null}'), null);
  assert.equal(findInNested("doc", "[1, 2, 3]"), null);
  const deep = "[".repeat(5000) + "]".repeat(5000);
  assert.equal(findInNested("doc", deep)?.kind, "Nested too deeply to check");
});
test("detectPii looks inside samples, and one nested match is enough", () => {
  const f = detectPii("doc", ['{"a":1}', null, '{"contact":{"home":"a@b.co"}}']);
  assert.deepEqual(f, { kind: "Email address", rule: "drop", path: "doc.contact.home" });
  assert.equal(piiLabel(f), "Email address in doc.contact.home");
  assert.equal(detectPii("doc", ['{"a":1}', '{"b":[2]}']), null);
  assert.equal(detectPii("field_7", ["(212) 555-0142", "312-555-0199", "5125550173"])?.rule, "mask", "plain values keep their old rule");
  assert.equal(detectPii("contact", ["call (212) 555-0142"]), null, "plain text isn't nested");
  assert.equal(scanStructured("x", "plain a@b.co"), null);
});
test("every rule hides a nested email in real DuckDB", () => withDb(async (run) => {
  await run(`CREATE TABLE t AS SELECT {'email': 'a@b.co', 'n': 1} AS "c"`);
  for (const rule of ["hash", "mask", "month"] as const) {
    // A rule that can't apply to this type fails the sync, which also keeps the value out
    const rows = await run(`SELECT ${maskExpr("c", rule, "salt")} FROM t`).catch(() => []);
    assert.doesNotMatch(JSON.stringify(rows), /a@b\.co/, rule);
  }
  assert.equal(maskExpr("c", "drop", "salt"), null);
}));

/* ---- staying typed through text ---- */
test("nested types survive the trip through text exactly", () => withDb(async (run) => {
  await run(`CREATE TABLE s AS SELECT {'first name': 'it''s, "x"', 'n': [1, 2], 'big': 9007199254740993} AS st, [{'k': 1}, {'k': 2}] AS ls, map {'x': 1} AS m, map {1: 'a'} AS mi, '{"a":[1,{"b":null}],"s":"x"}'::JSON AS j, ['a,b', 'c d', NULL] AS strs, [[1], [2, 3]] AS deep, CAST(NULL AS INTEGER[]) AS none`);
  const cols = await run(`SELECT column_name n, data_type t FROM information_schema.columns WHERE table_name = 's' ORDER BY ordinal_position`);
  assert.ok(cols.every((c) => isNestedType(String(c.t))), JSON.stringify(cols));
  const text = cols.map((c) => asTextSql(String(c.n), String(c.t))).join(", ");
  await run(`CREATE TABLE l AS SELECT ${text} FROM s`);
  const back = cols.map((c) => `${fromTextSql(String(c.n), String(c.t))} AS ${c.n}`).join(", ");
  await run(`CREATE TABLE b AS SELECT ${back} FROM l`);
  assert.deepEqual(await run(`SELECT data_type t FROM information_schema.columns WHERE table_name = 'b' ORDER BY ordinal_position`), cols.map((c) => ({ t: c.t })));
  assert.deepEqual(await run("SELECT * FROM b"), await run("SELECT * FROM s"));
}));
test("a value that doesn't fit is empty, not an error", () => withDb(async (run) => {
  await run(`CREATE TABLE l AS SELECT 'nope' AS a, '[1,"x"]' AS b`);
  assert.deepEqual(await run(`SELECT ${fromTextSql("a", "JSON")} a, ${fromTextSql("b", "INTEGER[]")} b FROM l`), [{ a: null, b: [1, null] }]);
}));
test("PostgreSQL array literals", () => withDb(async (run) => {
  assert.equal(pgArrayJson("{1,2}"), '["1","2"]');
  assert.equal(pgArrayJson(`{a,"b,c","d\\"e",NULL}`), '["a","b,c","d\\"e",null]');
  assert.equal(pgArrayJson("{{1,2},{3,4}}"), '[["1","2"],["3","4"]]');
  assert.equal(pgArrayJson("{}"), "[]");
  assert.equal(pgArrayJson("[1,2]"), null);
  assert.equal(pgArrayJson("{1,2"), null);
  assert.deepEqual(await run(`SELECT TRY_CAST('["1","2"]' AS INTEGER[]) a, TRY_CAST('[["1"],["2"]]' AS INTEGER[][]) b`), [{ a: [1, 2], b: [[1], [2]] }]);
}));

/* ---- flatten ---- */
test("flatten makes a typed column per field, across rows that differ", () => withDb(async (run) => {
  await run(`CREATE TABLE t AS SELECT * FROM (VALUES ('{"a":1,"b":{"c":"x","d":[1,2]},"m":1}'::JSON), ('{"a":2.5,"b":{"c":3,"e":true},"m":"s","w\\":x":1}'::JSON), ('{"z":null}'::JSON)) v(doc)`);
  const leaves: Leaves = new Map();
  for (const r of await run("SELECT CAST(to_json(doc) AS VARCHAR) d FROM t")) collectLeaves(leaves, JSON.parse(String(r.d)));
  const sql = flattenSql("doc", "doc", leaves, new Set(["doc_m"]));
  const rows = await run(`SELECT ${sql.join(", ")} FROM t`);
  assert.deepEqual(rows[1], { doc_a: 2.5, doc_b_c: "3", doc_b_d: null, doc_m_2: "s", doc: '{"a":2.5,"b":{"c":3,"e":true},"m":"s","w\\":x":1}', doc_b_e: true, doc_z: null });
  assert.equal(rows[0].doc_b_d, "[1,2]");
  assert.equal(rows[0].doc_a, 1);
}));
test("an email inside flattens into a column detectPii catches by name", () => {
  const leaves: Leaves = new Map();
  collectLeaves(leaves, { customer: { email: "a@b.co" } });
  assert.match(flattenSql("doc", "doc", leaves, new Set())[0], /AS "doc_customer_email"$/);
  assert.equal(detectPii("doc_customer_email")?.kind, "Email address");
});

/* ---- no-code steps ---- */
test("JSON paths are quoted, and anything else is refused", () => {
  assert.equal(jsonPath("customer.email"), '$."customer"."email"');
  assert.equal(jsonPath("$.items[0].sku"), '$."items"[0]."sku"');
  assert.equal(jsonPath('"first name".x'), '$."first name"."x"');
  assert.equal(jsonPath("[1]"), "$[1]");
  assert.equal(jsonPath("$"), "$");
  assert.equal(jsonPath("a'); DROP TABLE x; --"), null);
  assert.equal(jsonPath("a[*]"), null);
  assert.equal(jsonPath("a b"), null);
});
const stepsOn = (run: (sql: string) => Promise<Row[]>, steps: Step[]) => run(compileSteps("model:t", steps).replace(/\{\{ ref\('(\w+)'\) \}\}/g, "$1"));
test("extract reads STRUCT, JSON and JSON in text, and bad rows are empty", () => withDb(async (run) => {
  await run(`CREATE TABLE t AS SELECT * FROM (VALUES (1, {'a': {'b': 7}}, '{"a":{"b":8}}'::JSON, '{"a":{"b":9}}'), (2, NULL, '{"x":1}'::JSON, 'not json')) v(id, s, j, v)`);
  const e = (column: string, to: string, dataType?: string): Step => ({ id: to, type: "extract", column, value: "a.b", to, dataType });
  assert.deepEqual(await stepsOn(run, [e("s", "x", "INTEGER"), e("j", "y"), e("v", "z", "JSON")]).then((r) => r.map(({ x, y, z }) => ({ x, y, z }))), [{ x: 7, y: "8", z: "9" }, { x: null, y: null, z: null }]);
  assert.doesNotMatch(compileSteps("model:t", [{ id: "1", type: "extract", column: "j", value: "x'); --", to: "y" }]), /x'\)/);
}));
test("unnest makes a row per item and keeps rows with no items", () => withDb(async (run) => {
  await run(`CREATE TABLE t AS SELECT * FROM (VALUES (1, ['a', 'b'], '[{"k":1},{"k":2}]'::JSON), (2, [], '[]'::JSON), (3, NULL, NULL)) v(id, l, j)`);
  const list = await stepsOn(run, [{ id: "1", type: "unnest", column: "l", dataType: "VARCHAR" }]);
  assert.deepEqual(list.map((r) => [r.id, r.l]), [[1, "a"], [1, "b"], [2, null], [3, null]]);
  assert.deepEqual(Object.keys(list[0]), ["id", "l", "j"]);
  const objs = await stepsOn(run, [{ id: "1", type: "unnest", column: "j" }, { id: "2", type: "extract", column: "j", value: "k", to: "k", dataType: "INTEGER" }]);
  assert.deepEqual(objs.filter((r) => r.id === 1).map((r) => r.k), [1, 2]);
}));

/* ---- XML ---- */
test("XML keeps nesting, attributes, repeats, namespaces and CDATA", () => {
  assert.deepEqual(xmlRows(`<?xml version="1.0"?><data><meta><n>2</n></meta><orders>
    <order id="1"><city>Austin</city><ship><state>TX</state></ship></order>
    <order id="2"><city>A &amp; B</city></order></orders></data>`), [{ city: "Austin", ship: { state: "TX" }, id: "1" }, { city: "A & B", id: "2" }]);
  assert.deepEqual(xmlRows(`<r><i id="1"><id>2</id></i><i id="3"/></r>`), [{ id: "2", attr_id: "1" }, { id: "3" }]);
  assert.deepEqual(xmlRows(`<a:r xmlns:a="u"><a:i b:k="1"><a:email>e@x.co</a:email></a:i><a:i/></a:r>`)[0], { a_email: "e@x.co", b_k: "1" });
  assert.deepEqual(xmlRows(`<r><i><n><![CDATA[<b>x</b> & y]]></n></i><i><n>z</n></i></r>`), [{ n: "<b>x</b> & y" }, { n: "z" }]);
  assert.deepEqual(xmlRows(`<r><p>hello <b>big</b> world</p><p>x</p></r>`), [{ b: "big", value: "hello world" }, { value: "x" }]);
  assert.deepEqual(xmlRows(`<r><i>t<value>v</value></i><i>z</i></r>`), [{ value: "v", text_value: "t" }, { value: "z" }]);
});
test("the record is the element that holds the document, not its busiest child", () => {
  const rows = xmlRows(`<os><o id="1"><n>x</n><l><s>1</s></l><l><s>2</s></l><l><s>3</s></l></o><o id="2"><n>y</n></o></os>`);
  assert.deepEqual(rows, [{ n: "x", l: [{ s: "1" }, { s: "2" }, { s: "3" }], id: "1" }, { n: "y", id: "2" }]);
  assert.deepEqual(xmlRows(`<f><a><x>1</x></a><a><x>2</x></a><es>${"<e><v>1</v><w>2</w></e>".repeat(5)}</es></f>`).length, 5);
  assert.deepEqual(xmlRows(`<r><tag>a</tag><tag>b</tag></r>`), [{ tag: ["a", "b"] }]);
  assert.deepEqual(xmlRows("<order><id>7</id></order>"), [{ id: "7" }]);
});
test("XML that could read files or expand is refused before parsing", () => {
  assert.throws(() => xmlRows(`<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r><i>&x;</i></r>`), /declares its own entities/);
  assert.throws(() => xmlRows(`<!doctype r [<!ENTITY x "y">]><r>&x;</r>`), /declares its own entities/);
  const bomb = `<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><r><i>&b;</i></r>`;
  assert.throws(() => xmlRows(bomb), /declares its own entities/);
  assert.deepEqual(xmlRows(`<!-- <!DOCTYPE x [ --><r><i>a</i></r>`), [{ i: "a" }], "a comment isn't a declaration");
  assert.deepEqual(xmlRows(`<r><![CDATA[<!DOCTYPE x [ <!ENTITY]]></r>`), [], "nor is CDATA");
  assert.deepEqual(xmlRows(`<!DOCTYPE r SYSTEM "r.dtd"><r><i>a</i></r>`), [{ i: "a" }], "an external DTD is ignored, never fetched");
});
test("XML that's broken, too deep or too large says so", () => {
  assert.throws(() => xmlRows("<r><i></r>"), /isn't valid.*line 1/);
  assert.throws(() => xmlRows("not xml"), /isn't valid/);
  assert.throws(() => xmlRows("<r><__proto__><p>1</p></__proto__><i/></r>"), /can't be read/);
  assert.throws(() => xmlRows("<a>".repeat(200) + "</a>".repeat(200)), /more than 100 levels/);
  assert.throws(() => xmlRows(" ".repeat(MAX_XML_BYTES + 1)), (e: Error) => e.message === XML_TOO_LARGE);
  assert.ok(!({} as Row).polluted);
});

/* ---- viewing ---- */
test("cells never read [object Object]", () => {
  assert.equal(cellText({ a: [1] }), '{"a":[1]}');
  assert.equal(cellText(null), "");
  assert.equal(cellText(5), "5");
  assert.equal(prettyNested({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(prettyNested('[1,2]'), "[\n  1,\n  2\n]");
  assert.equal(prettyNested("[not json"), null);
  assert.equal(prettyNested("plain"), null);
  assert.equal(prettyNested(5), null);
});

/* ---- row security: the real code, with its server-only imports stubbed ---- */
test("JSON functions work for a restricted viewer, and row rules still hold", async () => {
  const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
  type Next = (s: string, c: { parentURL?: string }) => unknown;
  const hooks = (nodeModule as unknown as { registerHooks(h: { resolve(s: string, c: { parentURL?: string }, n: Next): unknown }): { deregister(): void } }).registerHooks({ resolve(spec, ctx, next) {
    if (spec === "server-only") return stub("");
    if (spec === "./auth") return stub("export class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }");
    if (spec === "./files") return stub("export const getRevoked = () => []; export const getRls = () => []; export const getConfig = () => ({ models: [] });");
    if (spec.startsWith("@/lib/")) return next(new URL(`../lib/${spec.slice(6)}.ts`, ctx.parentURL).href, ctx);
    return next(spec, ctx);
  } });
  const { applyRowSecurity } = await import("../server/rls.ts");
  hooks.deregister();
  const db = await DuckDBInstance.create(":memory:"), c = await db.connect();
  const all = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Row[];
  await c.run(`CREATE SCHEMA a; CREATE TABLE a.t AS SELECT * FROM (VALUES ('TX', '{"k":"tx","l":[1,2]}'::JSON, {'p': 1}, [1, 2]), ('NY', '{"k":"ny","l":[3]}'::JSON, {'p': 2}, [3])) v(state, doc, st, ls)`);
  const as = async (sql: string) => all(await applyRowSecurity(c as never, sql, [{ userId: "u", column: "state", values: ["TX"] }] as never));
  assert.deepEqual(await as(`SELECT doc->>'$.k' k, st.p p, ls[1] one FROM a.t`), [{ k: "tx", p: 1, one: 1 }]);
  assert.deepEqual(await as(`SELECT json_extract_string(doc, '$.l[1]') x FROM a.t`), [{ x: "2" }]);
  assert.deepEqual(await as(`SELECT e.key FROM a.t x, json_each(x.doc) e ORDER BY 1`), [{ key: "k" }, { key: "l" }]);
  assert.deepEqual(await as(`SELECT unnest(ls) v FROM a.t ORDER BY 1`), [{ v: 1 }, { v: 2 }]);
  assert.deepEqual(await as(`SELECT e.value FROM json_each((SELECT doc FROM a.t WHERE state = 'NY')) e`), [], "a subquery in the argument is filtered too");
  await assert.rejects(as(`SELECT * FROM json_execute_serialized_sql('x')`), /doesn't allow this function/);
  await assert.rejects(as(`SELECT * FROM read_json('x.json')`), /doesn't allow this function/);
  c.closeSync(); db.closeSync();
});
