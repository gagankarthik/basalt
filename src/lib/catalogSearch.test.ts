import assert from "node:assert/strict";
import test from "node:test";
import { searchCatalog, type Searchable } from "./catalogSearch.ts";

const items: (Searchable & { id: string })[] = [
  { id: "dynamo", name: "Amazon DynamoDB", groups: ["AWS", "Databases"], terms: "nosql amazon" },
  { id: "rds", name: "RDS for PostgreSQL", groups: ["AWS", "Databases"], terms: "amazon sql" },
  { id: "pg", name: "PostgreSQL", groups: ["Databases"], terms: "sql" },
  { id: "cosmos", name: "Cosmos DB", groups: ["Azure", "Databases"], terms: "nosql microsoft" },
  { id: "csv", name: "CSV or TSV", groups: ["Files"], terms: "file import" },
  { id: "ab-pg", name: "Postgres", groups: ["Apps"], terms: "airbyte source-postgres", airbyte: true },
  { id: "ab-pg2", name: "PostgreSQL", groups: ["Apps"], terms: "airbyte", airbyte: true },
];
const ids = (q: string, g: Parameters<typeof searchCatalog>[2] = "All") => searchCatalog(items, q, g).map((x) => x.id);

test("matches names, cloud and category", () => {
  assert.deepEqual(ids("aws"), ["dynamo", "rds"]);
  assert.deepEqual(ids("nosql"), ["dynamo", "cosmos"]);
  assert.deepEqual(ids("AZURE nosql"), ["cosmos"]);
  assert.deepEqual(ids("nothing like this"), []);
});

test("a filter narrows, and a connector can sit under more than one", () => {
  assert.deepEqual(ids("", "Files"), ["csv"]);
  assert.ok(ids("", "Databases").includes("dynamo") && ids("", "AWS").includes("dynamo"));
  assert.deepEqual(ids("aws", "Files"), []);
  assert.equal(ids("").length, items.length);
});

test("a native connector leads an Airbyte one of the same name", () => {
  const r = ids("postgres");
  assert.equal(r.indexOf("pg"), 0);
  assert.ok(r.indexOf("ab-pg2") > r.indexOf("rds"), "every native match comes before any Airbyte match");
});

test("searching stays quick at the size of the Airbyte registry and leaves the list alone", () => {
  const many = Array.from({ length: 600 }, (_, i): Searchable => ({ name: `Connector ${i}`, groups: ["Apps"], terms: "airbyte", airbyte: true }));
  const before = many[0], t = performance.now();
  for (let i = 0; i < 100; i++) searchCatalog(many, "connector 59", "All");
  assert.ok(performance.now() - t < 500);
  assert.equal(many[0], before);
});
