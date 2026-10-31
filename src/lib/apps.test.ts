import assert from "node:assert/strict";
import test from "node:test";
import { alertMet, cleanDoc, liveVersion, publish, restrictedDashboards, rollback, statusOf, visibleItems, type AppDoc, type StoredApp } from "./apps.ts";
import { arrange } from "./layout.ts";
import { pinTile } from "./report.ts";
import type { Dashboard, Widget } from "./types.ts";

const tile = (id: string, y = 0, extra: Partial<Widget> = {}): Widget => ({ id, title: id, type: "kpi", x: 0, y, w: 6, h: 3, table: "a.b", measures: [], filters: [], ...extra });
const dash = (id: string, widgets: Widget[] = [], extra: Partial<Dashboard> = {}): Dashboard => ({ id, name: id, description: "", widgets, filters: [], owner: "x", ...extra });
const doc: AppDoc = { name: "Sales", items: [{ id: "p1", kind: "dashboard", dashboard: "d1", label: "One" }, { id: "p2", kind: "dashboard", dashboard: "d2", label: "Two" }, { id: "l", kind: "link", url: "https://example.com", label: "Wiki" }], audiences: [{ id: "a", name: "Team", roles: [], members: ["ann"], items: ["p1"] }, { id: "b", name: "All", roles: ["viewer"], members: [], items: ["l"] }] };
const app = (d = doc): StoredApp => ({ id: "x", owner: "o", createdAt: "t", updatedAt: "t", draft: d, versions: [] });

test("an audience shows viewers only its pages, and editors see all", () => {
  assert.deepEqual(visibleItems(doc, { id: "ann", role: "viewer" }).map((i) => i.id), ["p1", "l"]);
  assert.deepEqual(visibleItems(doc, { id: "bob", role: "viewer" }).map((i) => i.id), ["l"]);
  assert.equal(visibleItems(doc, { id: "e", role: "editor" }).length, 3);
  assert.deepEqual(visibleItems({ ...doc, audiences: [] }, { id: "ann", role: "viewer" }), []);
});

test("edits don't reach readers until published, and rollback restores the old copy", () => {
  const all = [dash("d1", [tile("t")]), dash("d2")];
  const v1 = publish(app(), all, "me", "t1");
  assert.equal(statusOf(v1, all), "live");
  const edited = [dash("d1", [tile("t"), tile("new", 3)]), dash("d2")];
  assert.equal(statusOf(v1, edited), "changed");
  assert.equal(liveVersion(v1)!.dashboards[0].widgets.length, 1, "the published copy is frozen");
  const v2 = publish(v1, edited, "me", "t2");
  assert.equal(liveVersion(v2)!.dashboards[0].widgets.length, 2);
  const back = rollback(v2, 1, "me", "t3");
  assert.equal(back.live, 3);
  assert.equal(liveVersion(back)!.dashboards[0].widgets.length, 1);
  assert.equal(back.versions.length, 3);
});

test("publishing refuses an empty app, one nobody can read, and a missing dashboard", () => {
  assert.throws(() => publish(app({ ...doc, items: [] }), [], "me", "t"), /at least one page/);
  assert.throws(() => publish(app({ ...doc, audiences: [] }), [dash("d1"), dash("d2")], "me", "t"), /audience/);
  assert.throws(() => publish(app(), [dash("d1")], "me", "t"), /Two points to a dashboard/);
});

test("only dashboards in a live version are restricted", () => {
  assert.equal(restrictedDashboards([app()]).size, 0);
  assert.deepEqual([...restrictedDashboards([publish(app(), [dash("d1"), dash("d2")], "me", "t")])].sort(), ["d1", "d2"]);
});

test("links and logos are checked on the server", () => {
  assert.throws(() => cleanDoc({ ...doc, items: [{ id: "l", kind: "link", url: "javascript:alert(1)", label: "x" }] }), /must start with/);
  assert.throws(() => cleanDoc({ ...doc, logo: "data:image/svg+xml;base64,AAAA" }), /logo/);
  assert.deepEqual(cleanDoc({ ...doc, audiences: [{ id: "a", name: "T", roles: ["admin"], members: [], items: ["gone", "p1"] }] }).audiences[0], { id: "a", name: "T", roles: [], members: [], items: ["p1"] });
});

test("alerts compare in the chosen direction", () => {
  assert.equal(alertMet({ op: "gt", value: 10 }, 11), true);
  assert.equal(alertMet({ op: "gt", value: 10 }, 10), false);
  assert.equal(alertMet({ op: "lt", value: 10 }, 9), true);
});

test("pinning lands below existing tiles, carries what the tile needs and links back", () => {
  const source = dash("s", [tile("k")], { measures: [{ id: "m", name: "Sales", dax: "SUM(a[b])" }], params: [{ id: "p", name: "g", min: 0, max: 1, step: 1, value: 1 }] });
  const target = dash("t", [tile("x", 0), tile("y", 3)], { pages: [{ id: "pg", name: "Main" }] });
  const out = pinTile(target, source, source.widgets[0], [{ id: "f", column: "c", op: "eq", value: "v" }], "new");
  const added = out.widgets.find((w) => w.id === "new")!;
  assert.equal(added.y, 6);
  assert.equal(added.page, "pg");
  assert.equal(added.filters.length, 1);
  assert.deepEqual(added.pinnedFrom, { dashboard: "s", widget: "k", name: "s" });
  assert.equal(out.measures![0].name, "Sales");
  assert.equal(out.params![0].name, "g");
  const placed = arrange(out.widgets);
  for (const a of placed) for (const b of placed) if (a !== b) assert.ok(a.y + a.h <= b.y || b.y + b.h <= a.y || a.x + a.w <= b.x || b.x + b.w <= a.x);
  assert.throws(() => pinTile(dash("t2", [], { measures: [{ id: "n", name: "Sales", dax: "1" }] }), source, source.widgets[0], [], "n"), /different formula/);
  assert.throws(() => pinTile(source, source, source.widgets[0], [], "n"), /already/);
  assert.throws(() => pinTile(target, source, tile("s", 0, { type: "slicer" }), [], "n"), /slicer/i);
});
