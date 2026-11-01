import assert from "node:assert/strict";
import { test } from "node:test";
import { createThrottle } from "./loginThrottle.ts";

test("a guesser is locked out and the real person on another address isn't", () => {
  const t = createThrottle({ perSender: 5, perAccount: 100 });
  for (let i = 0; i < 5; i++) t.fail("admin@x.io", "attacker", 1000);
  assert.equal(t.blocked("admin@x.io", "attacker", 1000), true);
  assert.equal(t.blocked("admin@x.io", "office", 1000), false);
});
test("changing address doesn't allow unlimited guesses at one account", () => {
  const t = createThrottle({ perSender: 5, perAccount: 20 });
  for (let i = 0; i < 20; i++) t.fail("admin@x.io", `fake-${i}`, 1000);
  assert.equal(t.blocked("admin@x.io", "new-fake", 1000), true);
});
test("a lock ends, and a success clears the count", () => {
  const t = createThrottle({ perSender: 2, lockMs: 100 });
  t.fail("a@x.io", "s", 0); t.fail("a@x.io", "s", 0);
  assert.equal(t.blocked("a@x.io", "s", 50), true);
  assert.equal(t.blocked("a@x.io", "s", 100), false);
  t.fail("a@x.io", "s", 200); t.clear("a@x.io", "s"); t.fail("a@x.io", "s", 200);
  assert.equal(t.blocked("a@x.io", "s", 200), false);
});
test("made-up emails can't grow memory without limit", () => {
  const t = createThrottle({ maxKeys: 10 });
  for (let i = 0; i < 1000; i++) t.fail(`e${i}@x.io`, "s", 0);
  assert.equal(t.blocked("e999@x.io", "other", 0), false);
});
