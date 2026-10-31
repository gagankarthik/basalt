import assert from "node:assert/strict";
import test from "node:test";
import { compileForDbt, compileModel, effectiveOf, makeCtx, meets, testStatus } from "./dbt-compile.ts";
import { selectNodes } from "./dbt-select.ts";
import { createGate } from "./gate.ts";
import type { Model, ModelTest, Project } from "./types.ts";

const model = (name: string, sql: string, p: Partial<Model> = {}): Model => ({ id: name, name, description: "", materialized: "view", sql, tests: [], owner: "", ...p });
const one = (sql: string, project: Project = {}, others: Model[] = [], inc = false) => { const m = model("m", sql); return compileModel(m, makeCtx([m, ...others], project), inc); };

test("plain ref and source compile as they always did", () => {
  assert.equal(one(`from {{ source('app','t') }} join {{ref("x")}}`, {}, [model("x", "SELECT 1")]), 'from "raw_app"."t" join "analytics"."x"');
});
test("SQL that only looks like a template stays exact", () => {
  assert.equal(one("SELECT 1 WHERE a LIKE '{%' OR b = '{#' OR c = '{'"), "SELECT 1 WHERE a LIKE '{%' OR b = '{#' OR c = '{'");
  assert.equal(one(`SELECT {'a': {'b': 1}} AS s`), `SELECT {'a': {'b': 1}} AS s`);
});
test("var, defaults and a missing var", () => {
  assert.equal(one("{{ var('a') }} {{ var('b', 7) }}", { vars: { a: "x" } }), "x 7");
  assert.throws(() => one("{{ var('nope') }}"), /nope isn't set/);
});
test("if, for, set, filters and whitespace control", () => {
  assert.equal(one("{% set c = ['a','b'] %}{% for x in c %}{{ x | upper }}{% if not loop.last %},{% endif %}{% endfor %}"), "A,B");
  assert.equal(one("a  {%- if 1 == 2 %}x{% elif 2 > 1 %}y{% else %}z{% endif -%}   b"), "ayb");
  assert.equal(one("{# gone #}{{ 'v' ~ (1 + 2) }}"), "v3");
  assert.equal(one("{% raw %}{{ left }}{% endraw %}"), "{{ left }}");
});
test("macros and is_incremental", () => {
  const p = { macros: "{% macro cents(c, scale=100) %}({{ c }} * {{ scale }}){% endmacro %}" };
  assert.equal(one("SELECT {{ cents('x') }}, {{ cents('y', scale=2) }}", p), "SELECT (x * 100), (y * 2)");
  assert.equal(one("a{% if is_incremental() %}b{{ this }}{% endif %}", {}, [], true), 'ab"analytics"."m"');
  assert.equal(one("a{% if is_incremental() %}b{% endif %}", {}, [], false), "a");
  assert.throws(() => makeCtx([], { macros: "SELECT 1" }), /only/);
});
test("templates can't reach anything outside themselves", () => {
  for (const bad of ["{{ ''.constructor }}", "{{ range.constructor('return 1')() }}", "{{ {}.__proto__ }}", "{{ cycler.__init__ }}", "{{ env_var('PATH') }}", "{{ run_query('x') }}", "{{ modules.os }}", "{{ load_file('x') }}"]) assert.throws(() => one(bad), /isn't|can't|Only named/, bad);
  assert.throws(() => one("{{ ['a'] | join('x') | attr('y') }}"), /isn't available/);
  assert.throws(() => one("{% for i in range(100000) %}x{% endfor %}"), /limited/);
  assert.throws(() => one("{% macro a() %}{{ a() }}{% endmacro %}{{ a() }}"), /too many/);
  assert.throws(() => one("{% for i in range(10000) %}{% for j in range(10000) %}x{% endfor %}{% endfor %}"), /too much/);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
});
test("ephemeral models inline, nest and detect cycles", () => {
  const a = model("a", "SELECT 1 AS x", { materialized: "ephemeral" }), b = model("b", "SELECT * FROM {{ ref('a') }}", { materialized: "ephemeral" }), c = model("c", "SELECT * FROM {{ ref('b') }} t");
  assert.equal(compileModel(c, makeCtx([a, b, c])), "SELECT * FROM (\nSELECT * FROM (\nSELECT 1 AS x\n)\n) t");
  const p = model("p", "SELECT * FROM {{ ref('q') }}", { materialized: "ephemeral" }), r = model("q", "SELECT * FROM {{ ref('p') }}", { materialized: "ephemeral" });
  assert.throws(() => compileModel(p, makeCtx([p, r])), /depend on each other/);
});
test("config() in SQL wins and dependencies found through macros and branches", () => {
  const a = model("a", "SELECT 1"), b = model("b", "SELECT 1");
  const m = model("m", "{{ config(materialized='incremental', unique_key=['a','b'], incremental_strategy='merge', tags=['x']) }}{{ dep() }}{% if is_incremental() %}{{ ref('b') }}{% endif %}", { tags: ["y"] });
  const e = effectiveOf(m, makeCtx([a, b, m], { macros: "{% macro dep() %}{{ ref('a') }}{% endmacro %}" }));
  assert.equal(e.materialized, "incremental"); assert.equal(e.uniqueKey, "a,b"); assert.equal(e.incrementalStrategy, "merge");
  assert.deepEqual(e.tags, ["y", "x"]); assert.deepEqual(e.deps.sort(), ["a", "b"]);
  assert.match(effectiveOf(model("z", "{{ config(materialized='nope') }}"), makeCtx([])).compileError ?? "", /Unknown materialized/);
});
test("what dbt receives holds no user Jinja", () => {
  const m = model("m", "SELECT '{{ \"{% do x %}\" }}', '{#' {% if is_incremental() %}, {{ this }}{% endif %} FROM {{ ref('a') }} WHERE v = {{ var('n') }}");
  const ctx = makeCtx([m, model("a", "")], { vars: { n: "{{ env_var('S') }}" } });
  assert.equal(compileForDbt(m, ctx),
    `{% if is_incremental() %}SELECT '{{ '{%' }} do x %}', '{{ '{#' }}' , {{ this }} FROM {{ ref("a") }} WHERE v = {{ '{{' }} env_var('S') }}{% else %}SELECT '{{ '{%' }} do x %}', '{{ '{#' }}'  FROM {{ ref("a") }} WHERE v = {{ '{{' }} env_var('S') }}{% endif %}`);
  const steps = model("s", "SELECT '{{ env_var(\"S\") }}' FROM {{ ref('a') }}", { kind: "steps" });
  assert.equal(compileForDbt(steps, makeCtx([steps, model("a", "")])), `SELECT '{{ '{{' }} env_var("S") }}' FROM {{ ref("a") }}`);
});
test("severity: dbt's documented example, and warn never errors", () => {
  const t = { type: "unique", column: "x", errorIf: ">1000", warnIf: ">10" } as ModelTest;
  assert.deepEqual([0, 10, 50, 1000, 1001].map((n) => testStatus(n, t)), ["pass", "pass", "warn", "warn", "fail"]);
  const w = { ...t, severity: "warn" } as ModelTest;
  assert.equal(testStatus(5000, w), "warn"); assert.equal(testStatus(1, { type: "unique", column: "x" }), "fail"); assert.equal(testStatus(0, { type: "unique", column: "x" }), "pass");
  assert.equal(testStatus(0, { type: "unique", column: "x", errorIf: "<1", warnIf: "<0" }), "fail");
  assert.equal(meets(5, "between 5 and 10"), true); assert.equal(meets(4, "BETWEEN 5 AND 10"), false);
  assert.throws(() => meets(1, "!=0; DROP TABLE x"), /Can't read/);
});
test("selection follows dbt's syntax", () => {
  const ms = [
    model("a", "SELECT * FROM {{ source('app','t') }}", { tags: ["x"] }), model("b", "SELECT * FROM {{ ref('a') }}"), model("c", "SELECT * FROM {{ ref('b') }}", { tags: ["x"], materialized: "table" }),
    model("d", "SELECT * FROM {{ ref('b') }} JOIN {{ ref('e') }} USING (i)"), model("e", "SELECT 1", {}), model("seed1", "", { kind: "seed", materialized: "table", csv: "a\n1" }),
  ];
  const ctx = makeCtx(ms, { exposures: [{ name: "board", type: "dashboard", ownerName: "x", dependsOn: ["c"] }] });
  const s = (sel?: string, ex?: string) => selectNodes(ctx, sel, ex).sort().join(",");
  assert.equal(s("b"), "b"); assert.equal(s("+b"), "a,b"); assert.equal(s("b+"), "b,c,d"); assert.equal(s("1+c"), "b,c"); assert.equal(s("a+1"), "a,b"); assert.equal(s("+c+"), "a,b,c");
  assert.equal(s("@d"), "a,b,d,e"); assert.equal(s("@b"), "a,b,c,d,e"); assert.equal(s("tag:x"), "a,c"); assert.equal(s("tag:x,config.materialized:table"), "c");
  assert.equal(s("a e"), "a,e"); assert.equal(s("*"), "a,b,c,d,e,seed1"); assert.equal(s("s*"), "seed1"); assert.equal(s("source:app+"), "a,b,c,d");
  assert.equal(s("+exposure:board"), "a,b,c"); assert.equal(s("resource_type:seed"), "seed1"); assert.equal(s("a+", "d c"), "a,b"); assert.equal(s(undefined, "tag:x"), "b,d,e,seed1"); assert.equal(s("nothing"), "");
  assert.throws(() => s("@a+"), /both/); assert.throws(() => s("path:x"), /isn't available/);
});
test("the gate holds everyone during exclusive work and survives failure", async () => {
  const gate = createGate(), log: string[] = [];
  let finish!: () => void; const long = gate.run(() => new Promise<void>((r) => { finish = () => { log.push("reader done"); r(); }; }));
  const ex = gate.exclusive(async () => { log.push("exclusive"); });
  const later = gate.run(async () => { log.push("later"); });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log, []);
  finish(); await Promise.all([long, ex, later]);
  assert.deepEqual(log, ["reader done", "exclusive", "later"]);
  await assert.rejects(gate.exclusive(async () => { throw new Error("dbt crashed"); }), /crashed/);
  assert.equal(await gate.run(async () => "open again"), "open again");
  assert.equal(await gate.run(() => gate.run(async () => "nested")), "nested");
  let hold!: () => void; const busy = gate.run(() => new Promise<void>((r) => { hold = r; }));
  await assert.rejects(gate.exclusive(async () => {}, 10), /stayed busy/);
  hold(); await busy;
  assert.equal(await gate.run(async () => "after timeout"), "after timeout");
});
