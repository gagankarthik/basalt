import assert from "node:assert/strict";
import test from "node:test";
import { parseSession, sessionVerdict, validPolicy } from "./sessionPolicy.ts";

const H = 36e5, M = 6e4, now = 1_700_000_000_000;
const s = (ageHours: number, left = 100) => ({ issued: now - ageHours * H, expires: now + left * H });
test("a session ends at its maximum length, even if someone is active", () => {
  const p = { idleMinutes: 0, maxHours: 8 };
  assert.equal(sessionVerdict(s(7.9), now, now, p), "ok");
  assert.equal(sessionVerdict(s(8.1), now, now, p), "expired");
});
test("tightening the rule applies to sessions already running", () => {
  assert.equal(sessionVerdict(s(30), now, now, { idleMinutes: 0, maxHours: 168 }), "ok");
  assert.equal(sessionVerdict(s(30), now, now, { idleMinutes: 0, maxHours: 24 }), "expired");
});
test("the cookie's own expiry always holds", () => {
  assert.equal(sessionVerdict(s(1, -1), now, now, { idleMinutes: 0, maxHours: 168 }), "expired");
});
test("idle time ends a session, and only when turned on", () => {
  const p = { idleMinutes: 15, maxHours: 168 };
  assert.equal(sessionVerdict(s(1), now - 14 * M, now, p), "ok");
  assert.equal(sessionVerdict(s(1), now - 16 * M, now, p), "idle");
  assert.equal(sessionVerdict(s(1), now - 999 * M, now, { idleMinutes: 0, maxHours: 168 }), "ok");
  assert.equal(sessionVerdict(s(1), undefined, now, p), "ok", "just restarted: nothing known yet");
});
test("old cookies stay valid, and new ones read back", () => {
  const old = parseSession(`user.${now + H}.3`);
  assert.deepEqual([old.id, old.sessions, old.issued], ["user", 3, now + H - 7 * 24 * H]);
  const fresh = parseSession(`user.${now + H}.2.${now}.abc`);
  assert.deepEqual([fresh.id, fresh.sessions, fresh.issued, fresh.sid], ["user", 2, now, "abc"]);
});
test("only offered values are accepted", () => {
  assert.equal(validPolicy({ idleMinutes: 15, maxHours: 8 }), true);
  assert.equal(validPolicy({ idleMinutes: 1, maxHours: 8 }), false);
  assert.equal(validPolicy({ idleMinutes: 0, maxHours: 99999 }), false);
});
