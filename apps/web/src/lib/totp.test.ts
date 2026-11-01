import assert from "node:assert/strict";
import test from "node:test";
import { base32, codeFor, fromBase32, hashRecovery, matchCode, newRecoveryCodes, newSecret, otpUri, stepAt } from "./totp.ts";

const RFC = base32(Buffer.from("12345678901234567890"));
test("codes match the published RFC 6238 test values", () => {
  for (const [secs, want] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]] as const) assert.equal(codeFor(RFC, stepAt(secs * 1000), 8), want, String(secs));
  assert.equal(codeFor(RFC, stepAt(59000)), "287082");
});
test("base32 round-trips, including the known example", () => {
  assert.equal(base32(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.equal(fromBase32("MZXW6YTBOI").toString(), "foobar");
  assert.equal(fromBase32("mzxw 6ytb oi======").toString(), "foobar");
  assert.equal(fromBase32(newSecret()).length, 20);
  assert.throws(() => fromBase32("not!base32"));
});
test("a code works around its moment and not away from it", () => {
  const s = newSecret(), now = 1_700_000_000_000, step = stepAt(now);
  assert.equal(matchCode(s, codeFor(s, step), now), step);
  assert.equal(matchCode(s, codeFor(s, step - 1), now), step - 1, "a phone slightly behind");
  assert.equal(matchCode(s, codeFor(s, step + 1), now), step + 1, "a phone slightly ahead");
  assert.equal(matchCode(s, codeFor(s, step - 2), now), null);
  assert.equal(matchCode(s, codeFor(s, step + 2), now), null);
  assert.equal(matchCode(newSecret(), codeFor(s, step), now), null, "another person's secret");
});
test("a used code can't be used again", () => {
  const s = newSecret(), now = 1_700_000_000_000, step = stepAt(now), code = codeFor(s, step);
  assert.equal(matchCode(s, code, now, step), null);
  assert.equal(matchCode(s, code, now, step - 1), step);
  assert.equal(matchCode(s, codeFor(s, step - 1), now, step), null, "nor an older one after it");
});
test("bad input is refused without a crash", () => {
  const s = newSecret(), now = 1_700_000_000_000;
  for (const bad of ["", "12345", "1234567", "abcdef", "12345a", "' OR 1=1"]) assert.equal(matchCode(s, bad, now), null, bad);
  assert.equal(matchCode(s, codeFor(s, stepAt(now)).replace(/(...)/, "$1 "), now), stepAt(now), "the space apps show is fine");
});
test("recovery codes are unique, and match however they're typed", () => {
  const c = newRecoveryCodes();
  assert.equal(new Set(c).size, 10);
  assert.match(c[0], /^[a-z2-7]{5}-[a-z2-7]{5}$/);
  assert.equal(hashRecovery(c[0]), hashRecovery(` ${c[0].toUpperCase().replace("-", " ")} `));
  assert.notEqual(hashRecovery(c[0]), hashRecovery(c[1]));
});
test("the setup link is what apps expect, with odd characters escaped", () => {
  assert.equal(otpUri("ABC", "a+b@x.io", "My Co"), "otpauth://totp/My%20Co:a%2Bb%40x.io?secret=ABC&issuer=My%20Co&algorithm=SHA1&digits=6&period=30");
});
