import assert from "node:assert/strict";
import test from "node:test";
import { applyDelta, configDelta, configProblem, emptyDelta } from "./configCheck.ts";

const good = () => ({ settings: {}, pipelines: [{ id: "p", name: "P", streams: [{ name: "s", rules: {} }] }], models: [{ id: "m", name: "M" }], views: [], dashboards: [{ id: "d", name: "D", widgets: [{}], filters: [] }], metrics: [], queries: [], notebooks: [{ id: "n", name: "N", cells: [{}] }] });

const d = (id: string, name = id) => ({ id, name });
const cfg = (over = {}) => ({ settings: { a: 1, b: 2 }, pipelines: [], models: [d("m1"), d("m2")], views: [], dashboards: [d("x"), d("y")], metrics: [], queries: [], connections: [d("c")], ...over });

test("two people's changes both survive, whoever saves last", () => {
  const opened = cfg();
  // Both opened the same copy. One renames x and adds z, the other renames y and deletes m1
  const one = configDelta(opened, cfg({ dashboards: [d("x", "X2"), d("y"), d("z")] }));
  const two = configDelta(opened, cfg({ dashboards: [d("x"), d("y", "Y2")], models: [d("m2")] }));
  const saved = applyDelta(applyDelta(opened, one), two);
  assert.deepEqual(saved.dashboards, [d("x", "X2"), d("y", "Y2"), d("z")]);
  assert.deepEqual(saved.models, [d("m2")]);
});
test("a stale tab can't undo what it never touched", () => {
  const stale = cfg(), latest = cfg({ pipelines: [d("new")], settings: { a: 9, b: 2 } });
  const saved = applyDelta(latest, configDelta(stale, cfg({ settings: { a: 1, b: 5 }, metrics: [d("k")] })));
  assert.deepEqual(saved.pipelines, [d("new")]);
  assert.deepEqual(saved.settings, { a: 9, b: 5 }, "each setting merges on its own");
  assert.deepEqual(saved.metrics, [d("k")]);
});
test("no change means an empty delta, order is kept, and connections can't change here", () => {
  assert.ok(emptyDelta(configDelta(cfg(), cfg())));
  const moved = configDelta(cfg(), cfg({ dashboards: [d("y"), d("x")] }));
  assert.deepEqual(applyDelta(cfg({ dashboards: [d("x"), d("n"), d("y")] }), moved).dashboards.map((x) => x.id), ["y", "x", "n"]);
  const smuggled = configDelta(cfg(), cfg({ connections: [] }));
  assert.ok(emptyDelta(smuggled));
  assert.throws(() => applyDelta(cfg(), { lists: { connections: { upsert: [], remove: ["c"] } }, objects: {} }));
  assert.throws(() => applyDelta(cfg(), { lists: { models: {} }, objects: {} } as never));
  assert.equal(configProblem(applyDelta(cfg(), { lists: { dashboards: { upsert: [null], remove: [] } }, objects: {} } as never)), "dashboards");
  const unset = configDelta(cfg(), cfg({ settings: { a: 1 } }));
  assert.deepEqual(applyDelta(cfg(), unset).settings, { a: 1 });
});

test("a sound config passes, and notebooks may be missing from older ones", () => {
  assert.equal(configProblem(good()), null);
  const { notebooks, ...older } = good();
  assert.ok(notebooks);
  assert.equal(configProblem(older), null);
  assert.equal(configProblem({ ...good(), somethingNew: 1 }), null);
});

test("anything that would break a page is named", () => {
  for (const [what, c] of Object.entries({
    "the configuration": [null, [], "x"],
    settings: [{ ...good(), settings: undefined }, { ...good(), settings: [] }],
    dashboards: [{ ...good(), dashboards: undefined }, { ...good(), dashboards: [null] }, { ...good(), dashboards: [{ id: "d", name: "D" }] }, { ...good(), dashboards: [{ id: "d", name: "D", widgets: [null], filters: [] }] }],
    models: [{ ...good(), models: "x" }, { ...good(), models: [{ name: "no id" }] }, { ...good(), models: [{ id: "", name: "x" }] }],
    pipelines: [{ ...good(), pipelines: [{ id: "p", name: "P" }] }, { ...good(), pipelines: [{ id: "p", name: "P", streams: [{ name: "s" }] }] }],
    notebooks: [{ ...good(), notebooks: {} }, { ...good(), notebooks: [{ id: "n", name: "N" }] }],
  })) for (const x of c) assert.equal(configProblem(x), what);
});
