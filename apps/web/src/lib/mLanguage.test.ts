import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { MError, parseM, toM } from "./mLanguage.ts";
import { compileSteps, type Step } from "./transform.ts";

let n = 0;
const id = () => `s${n++}`;
let c: DuckDBConnection;
const runM = async (body: string) => {
  const { base, steps } = parseM(`let\n Source = Basalt.Table("model:o"),\n ${body}`, id);
  const sql = compileSteps(base, steps).replace(/\{\{ ref\('o'\) \}\}/g, "o");
  return (await c.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
};
const withTables = (sql: string) => sql.replace(/\{\{ ref\('(\w+)'\) \}\}/g, "$1");
const runFull = async (src: string) => { const { base, steps } = parseM(src, id); return (await c.runAndReadAll(withTables(compileSteps(base, steps)))).getRowObjectsJson() as Record<string, unknown>[]; };
before(async () => {
  c = await (await DuckDBInstance.create(":memory:")).connect();
  await c.run(`CREATE TABLE o (id INT, city VARCHAR, amount DOUBLE, day DATE)`);
  await c.run(`INSERT INTO o VALUES (1,'Oslo',10,'2026-01-01'),(2,'Rome',20,'2026-02-01'),(3,'Oslo',30,'2026-03-01'),(3,NULL,NULL,NULL)`);
  await c.run("CREATE TABLE k (city_name VARCHAR, country VARCHAR, secret VARCHAR)");
  await c.run("INSERT INTO k VALUES ('Oslo','NO','x'),('Rome','IT','y'),('Lima','PE','z')");
  await c.run("CREATE TABLE o2 (id INT, city VARCHAR, amount DOUBLE, day DATE)");
  await c.run("INSERT INTO o2 VALUES (9,'Lima',5,'2026-04-01')");
});
after(() => c.closeSync());

const JOIN = (kind: string) => `let
  Source = Basalt.Table("model:o"),
  Cities = Basalt.Table("model:k"),
  Joined = Table.NestedJoin(Source, {"city"}, Cities, {"city_name"}, "C", JoinKind.${kind}),
  Expanded = Table.ExpandTableColumn(Joined, "C", {"country"}, {"Country"})
in Expanded`;
test("a join as Power Query writes it keeps only the columns it expands, under their new names", async () => {
  const r = await runFull(JOIN("LeftOuter"));
  assert.equal(r.length, 4);
  assert.equal(r.find((x) => x.id === 2)!.Country, "IT");
  assert.ok(!("secret" in r[0]) && !("city_name" in r[0]));
  assert.equal(r.find((x) => x.city === null)!.Country, null);
});
test("each join kind gives the right rows", async () => {
  assert.equal((await runFull(JOIN("Inner"))).length, 3);
  assert.equal((await runFull(JOIN("RightOuter"))).length, 4);
  assert.equal((await runFull(JOIN("FullOuter"))).length, 5);
  const anti = await runFull(`let Source = Basalt.Table("model:o"), Cities = Basalt.Table("model:k"),
    J = Table.NestedJoin(Source, {"city"}, Cities, {"city_name"}, "C", JoinKind.LeftAnti), R = Table.RemoveColumns(J, {"C"}) in R`);
  assert.deepEqual(anti.map((x) => x.city), [null]);
});
test("Table.Combine stacks tables, and a joined query reads back from M unchanged", async () => {
  const r = await runFull(`let Source = Basalt.Table("model:o"), More = Basalt.Table("model:o2"), All = Table.Combine({Source, More}) in All`);
  assert.equal(r.length, 5);
  const first = parseM(JOIN("Inner"), id);
  const again = parseM(toM(first.base, first.steps).text, id);
  const strip = (l: Step[]) => JSON.stringify(l.map(({ id: _i, name: _n, ...s }) => { void _i; void _n; return s; }));
  assert.equal(strip(again.steps), strip(first.steps));
  const stacked = parseM(`let Source = Basalt.Table("model:o"), More = Basalt.Table("model:o2"), All = Table.Combine({Source, More}) in All`, id);
  assert.equal(strip(parseM(toM(stacked.base, stacked.steps).text, id).steps), strip(stacked.steps));
  const anti = parseM(`let Source = Basalt.Table("model:o"), C = Basalt.Table("model:k"), J = Table.NestedJoin(Source, {"city"}, C, {"city_name"}, "X", JoinKind.LeftAnti), R = Table.RemoveColumns(J, {"X"}) in R`, id);
  assert.equal(strip(parseM(toM(anti.base, anti.steps).text, id).steps), strip(anti.steps));
});
test("a join made in the editor without chosen columns can't be said in M, so it's listed rather than lost", () => {
  const { missing } = toM("model:o", [{ id: "a", type: "merge", base: "model:k", columns: ["city"], rightKeys: ["city_name"], how: "left", prefix: "r_" }], () => "Merge");
  assert.deepEqual(missing, ["Merge"]);
});
test("joins that aren't finished or don't add up are refused", () => {
  const head = 'let Source = Basalt.Table("model:o"), C = Basalt.Table("model:k"), ';
  const fail = (body: string, re: RegExp) => assert.throws(() => parseM(head + body, id), (e: Error) => e instanceof MError && re.test(e.message), body);
  fail('J = Table.NestedJoin(Source, {"a"}, C, {"b"}, "X", JoinKind.Inner) in J', /Finish the join/);
  fail('J = Table.NestedJoin(Source, {"a"}, C, {"b"}, "X", JoinKind.Inner), S = Table.FirstN(J, 1) in S', /Finish the join/);
  fail('J = Table.NestedJoin(Source, {"a"}, Nope, {"b"}, "X", JoinKind.Inner) in J', /Nope isn't a table/);
  fail('J = Table.NestedJoin(Source, {"a", "c"}, C, {"b"}, "X", JoinKind.Inner) in J', /same number of key columns/);
  fail('J = Table.NestedJoin(Source, {"a"}, C, {"b"}, "X", JoinKind.Fuzzy) in J', /join kind/);
  fail('J = Table.NestedJoin(Source, {"a"}, C, {"b"}, "X", JoinKind.Inner), E = Table.ExpandTableColumn(J, "Y", {"z"}) in E', /isn't a join's result/);
  fail('A = Table.Combine({Source}) in A', /at least two/);
  fail('A = Table.Combine({Source, Nope}) in A', /Nope isn't a table/);
});

test("real M with quoted step names, comments and types runs and gives the right rows", async () => {
  const r = await runM(`// Only big orders
    #"Filtered Rows" = Table.SelectRows(Source, each [amount] > 15 and [city] <> null),
    #"Kept" = Table.SelectColumns(#"Filtered Rows", {"id", "city", "amount"}),
    #"Sorted" = Table.Sort(Kept, {{"amount", Order.Descending}})
  in #"Sorted"`);
  assert.deepEqual(r.map((x) => x.id), [3, 2]);
  assert.deepEqual(Object.keys(r[0]), ["id", "city", "amount"]);
});
test("grouping counts and sums, as Power Query writes it", async () => {
  const r = await runM(`G = Table.Group(Source, {"city"}, {{"Orders", each Table.RowCount(_), Int64.Type}, {"Total", each List.Sum([amount]), type number}, {"Ids", each List.Count(List.Distinct([id]))}}),
    S = Table.Sort(G, {{"Total", Order.Descending}}) in S`);
  const oslo = r.find((x) => x.city === "Oslo")!;
  assert.equal(Number(oslo.Orders), 2);
  assert.equal(Number(oslo.Total), 40);
  assert.equal(Number(oslo.Ids), 2);
});
test("added columns, renames, replacing, types and text cleanup all run", async () => {
  const r = await runM(`A = Table.AddColumn(Source, "Double", each if [amount] > 15 then [amount] * 2 else 0, type number),
    B = Table.AddColumn(A, "Label", each Text.Upper([city]) & "!"),
    C = Table.RenameColumns(B, {{"city", "Town"}}),
    D = Table.ReplaceValue(C, "Os", "Xx", Replacer.ReplaceText, {"Town"}),
    E = Table.TransformColumnTypes(D, {{"id", type text}}),
    F = Table.TransformColumns(E, {{"Label", Text.Lower}}),
    G = Table.FirstN(F, 2) in G`);
  assert.equal(r.length, 2);
  assert.equal(r[0].Town, "Xxlo");
  assert.equal(r[0].Label, "oslo!");
  assert.equal(r[1].Double, 40);
  assert.equal(r[0].id, "1");
});
test("or, null, Text.Contains, dates, Distinct and row ranges", async () => {
  assert.deepEqual((await runM(`F = Table.SelectRows(Source, each Text.Contains([city], "om") or [city] = null) in F`)).map((x) => x.id), [2, 3]);
  assert.equal((await runM(`F = Table.SelectRows(Source, each [day] >= #date(2026, 2, 1)) in F`)).length, 2);
  assert.equal((await runM(`F = Table.Distinct(Source, {"id"}) in F`)).length, 3);
  assert.deepEqual((await runM(`F = Table.Range(Source, 1, 2) in F`)).map((x) => x.id), [2, 3]);
  assert.equal((await runM(`F = Table.LastN(Source, 1) in F`)).length, 1);
});
test("steps written as M read back to the same query", () => {
  const steps: Step[] = [
    { id: "a", type: "filter", name: "Big ones", filters: [{ id: "f", column: "my col", op: "gte", value: "5" }], match: "all" },
    { id: "b", type: "keep", columns: ["x", 'q"uote'] },
    { id: "c", type: "custom", to: "t", expr: "{a} + 1" },
    { id: "d", type: "group", columns: ["x"], aggs: [{ as: "s", column: "y", agg: "sum" }, { as: "n", column: "*", agg: "count" }] },
    { id: "e", type: "sort", sorts: [{ column: "s", dir: "desc" }] },
  ];
  const { text, missing } = toM("source:shop.orders", steps);
  assert.deepEqual(missing, []);
  const back = parseM(text, id);
  assert.equal(back.base, "source:shop.orders");
  const strip = (l: Step[]) => JSON.stringify(l.map(({ id: _i, name: _n, filters, ...s }) => { void _i; void _n; return { ...s, filters: filters?.map(({ id: _f, ...f }) => { void _f; return f; }) }; }));
  assert.equal(strip(back.steps), strip(steps));
  assert.equal(back.steps[0].name, "Big ones");
});
test("steps M can't say are listed, not lost silently", () => {
  const { text, missing } = toM("model:o", [{ id: "a", type: "pivot" }, { id: "b", type: "keep", columns: ["x"] }, { id: "c", type: "keep", columns: ["y"], disabled: true }]);
  assert.deepEqual(missing, ["pivot", "keep"]);
  assert.match(text, /Not shown in M: pivot/);
  assert.equal(parseM(text, id).steps.length, 1);
});
test("anything outside the subset is refused by name, with a line number", () => {
  const fail = (src: string, re: RegExp) => assert.throws(() => parseM(src, id), (e: Error) => e instanceof MError && re.test(e.message), src);
  fail(`let\n Source = Sql.Database("x", "y")\nin Source`, /Line 2: .*can't read Sql\.Database/);
  fail(`let\n Source = Basalt.Table("model:o"),\n J = Table.Buffer(Source, {"a"})\nin J`, /Line 3: .*doesn't have Table.Buffer/);
  fail(`let Source = Basalt.Table("../etc"), in Source`, /Basalt\.Table needs/);
  fail(`let Source = Basalt.Table("model:o"), A = Table.FirstN(Other, 1) in A`, /must start from Source/);
  fail(`let Source = Basalt.Table("model:o"), A = Table.SelectRows(Source, each [a] > 1 and [b] > 1 or [c] > 1) in A`, /not both/);
  fail(`let Source = Basalt.Table("model:o"), A = Table.AddColumn(Source, "x", each Web.Contents("http://x")) in A`, /doesn't have Web\.Contents/);
  fail(`let Source = Basalt.Table("model:o") in Nope`, /must end with its last step/);
  fail(`let Source = Basalt.Table("oops`, /never ends/);
  fail(`Source`, /Expected the word|Expected "let"/);
});
test("unpivot, pivot and fill work from pasted M and survive being written back", async () => {
  const other = await runM(`S = Table.SelectColumns(Source, {"id", "amount"}), U = Table.UnpivotOtherColumns(S, {"id"}, "Attribute", "Value") in U`);
  assert.deepEqual(other.filter((x) => String(x.id) === "1"), [{ id: 1, Attribute: "amount", Value: 10 }]);
  const named = await runM(`S = Table.SelectColumns(Source, {"id", "amount"}), U = Table.Unpivot(S, {"amount"}, "A", "V") in U`);
  assert.equal(named.length, 3, "like Power Query, an empty value makes no row");
  const piv = await runM(`S = Table.SelectColumns(Source, {"id", "city", "amount"}), P = Table.Pivot(S, {"Oslo", "Rome"}, "city", "amount", List.Sum), T = Table.Sort(P, {{"id", Order.Ascending}}) in T`);
  assert.deepEqual(piv[0], { id: 1, Oslo: 10, Rome: null });
  const down = await runM(`S = Table.Sort(Source, {{"amount", Order.Ascending}}), F = Table.FillDown(S, {"city", "amount"}) in F`);
  assert.equal(down.filter((x) => x.city == null).length, 0);
  const src = `let Source = Basalt.Table("model:o"), U = Table.UnpivotOtherColumns(Source, {"id"}, "A", "V"), P = Table.Pivot(U, {"x"}, "A", "V", List.Max), F = Table.FillUp(P, {"id"}) in F`;
  const a = parseM(src, id), back = parseM(toM(a.base, a.steps).text, id);
  assert.equal(toM(a.base, a.steps).missing.length, 0);
  assert.deepEqual(back.steps.map(({ type, mode, columns, values, agg }) => ({ type, mode, columns, values, agg })), a.steps.map(({ type, mode, columns, values, agg }) => ({ type, mode, columns, values, agg })));
  assert.throws(() => parseM(`let Source = Basalt.Table("model:o"), P = Table.Pivot(Source, List.Distinct(Source[a]), "a", "b", List.Sum) in P`, id), /needs its new columns listed/);
  assert.throws(() => parseM(`let Source = Basalt.Table("model:o"), P = Table.Pivot(Source, {"x"}, "a", "b", List.Nope) in P`, id), /can use/);
});
test("a column or text value can't inject SQL through M", async () => {
  const r = await runM(`F = Table.SelectRows(Source, each [city] = "x' OR 1=1 --") in F`);
  assert.equal(r.length, 0);
  await assert.rejects(runM(`F = Table.SelectColumns(Source, {"id\\" FROM o; DROP TABLE o; --"}) in F`));
  assert.equal((await c.runAndReadAll("SELECT count(*) n FROM o")).getRowObjectsJson()[0].n, "4");
});
