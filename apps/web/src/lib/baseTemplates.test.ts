import assert from "node:assert/strict";
import test from "node:test";
import { BASE_TEMPLATES, templateTables } from "./baseTemplates.ts";

let n = 0;
const id = () => `id${n++}`;
test("each built template has its sample rows, with choices and dates stored properly", () => {
  for (const name of ["crm", "content", "inventory"]) {
    assert.ok(BASE_TEMPLATES.some((t) => t.id === name));
    const [t] = templateTables(name, id, "Me", "2026-01-10T00:00:00.000Z")!;
    assert.equal(t.records.length, 3, name);
    assert.ok(t.views.some((v) => v.type === "kanban"), name);
    for (const f of t.fields.filter((x) => x.type === "select")) for (const r of t.records) assert.ok(f.choices!.some((c) => c.id === r.cells[f.id]), `${name} ${f.name}`);
  }
  const [crm] = templateTables("crm", id, "Me", "2026-01-10T00:00:00.000Z")!;
  assert.equal(crm.records[0].cells[crm.fields.find((f) => f.name === "Close date")!.id], "2026-01-22");
});
test("an unknown template builds nothing, even a name every object has", () => {
  assert.equal(templateTables("blank", id, "Me", "2026-01-10T00:00:00.000Z"), null);
  assert.equal(templateTables("constructor", id, "Me", "2026-01-10T00:00:00.000Z"), null);
});
