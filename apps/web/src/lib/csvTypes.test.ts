import assert from "node:assert/strict";
import test from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { convertSql, suggestConversion } from "./csvTypes.ts";

test("only a clear format is suggested", () => {
  assert.equal(suggestConversion(["10,50", "20,25", null, ""]), "DECIMAL_COMMA");
  assert.equal(suggestConversion(["1.234,50", "-3,5"]), "DECIMAL_COMMA");
  assert.equal(suggestConversion(["1,234", "5,678"]), "", "could be thousands");
  assert.equal(suggestConversion(["10,50", "text"]), "");
  assert.equal(suggestConversion(["01/31/2026", "02/06/2026"]), "DATE_MDY");
  assert.equal(suggestConversion(["31-01-2026", "06-02-2026"]), "DATE_DMY");
  assert.equal(suggestConversion(["01/05/2026", "02/06/2026"]), "", "could be either");
  assert.equal(suggestConversion(["13/14/2026"]), "", "fits neither");
  assert.equal(suggestConversion(["01/31/26"]), "");
  assert.equal(suggestConversion(["2026-01-31"]), "");
  assert.equal(suggestConversion([null, " "]), "");
});
test("conversions give the right values, and what doesn't fit comes out empty", async () => {
  const c = await (await DuckDBInstance.create(":memory:")).connect();
  const run = async (to: string, values: string[]) => { await c.run("CREATE OR REPLACE TABLE t (v VARCHAR)"); for (const x of values) await c.run(`INSERT INTO t VALUES ('${x}')`); return (await c.runAndReadAll(`SELECT CAST(${convertSql("v", to)} AS VARCHAR) r FROM t`)).getRowObjectsJson().map((r) => r.r); };
  assert.deepEqual(await run("DECIMAL_COMMA", ["10,50", "1.234,5", " -3,25 ", "7", "abc", "1,2,3"]), ["10.5", "1234.5", "-3.25", "7.0", null, null]);
  assert.deepEqual(await run("DATE_MDY", ["01/31/2026", "2-6-2026", "13/01/2026", "01/05/26"]), ["2026-01-31", "2026-02-06", null, null]);
  assert.deepEqual(await run("DATE_DMY", ["31/01/2026", "06-02-2026", "01/13/2026"]), ["2026-01-31", "2026-02-06", null]);
  assert.deepEqual(await run("BIGINT", ["5", "x"]), ["5", null]);
  c.closeSync();
});
