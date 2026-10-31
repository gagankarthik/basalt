import assert from "node:assert/strict";
import test from "node:test";
import { filterList, first, flatten, last, step, typeAhead } from "./selectList.ts";

const list = flatten(["Apple", ["b", "Banana", true], { group: "More", options: [["c", "Avocado"], ["d", "Cherry"], ["e", "Date", true]] }]);

test("options, pairs and groups flatten in order", () => {
  assert.deepEqual(list.map((o) => o.value), ["Apple", "b", "c", "d", "e"]);
  assert.equal(list[2].group, "More");
  assert.equal(list[1].disabled, true);
});

test("arrows skip disabled options and stop at the ends", () => {
  assert.equal(step(list, 0, 1), 2);
  assert.equal(step(list, 2, -1), 0);
  assert.equal(step(list, 0, -1), 0);
  assert.equal(step(list, 3, 1), 3);
  assert.equal(first(flatten([["a", "A", true], "B"])), 1);
  assert.equal(last(list), 3);
  assert.equal(last(flatten([["a", "A", true]])), 0);
});

test("type-ahead cycles on one letter, follows a word, skips disabled", () => {
  assert.equal(typeAhead(list, "a", 0), 2);
  assert.equal(typeAhead(list, "a", 2), 0);
  assert.equal(typeAhead(list, "aa", 2), 0);
  assert.equal(typeAhead(list, "av", 0), 2);
  assert.equal(typeAhead(list, "CH", 0), 3);
  assert.equal(typeAhead(list, "b", 0), -1);
  assert.equal(typeAhead(list, "d", 0), -1);
  assert.equal(typeAhead([], "a", -1), -1);
});

test("the filter matches anywhere in the label, ignoring case", () => {
  assert.deepEqual(filterList(list, " ANA ").map((o) => o.value), ["b"]);
  assert.equal(filterList(list, "").length, 5);
});
