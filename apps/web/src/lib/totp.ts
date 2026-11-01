import crypto from "node:crypto";

/** Time-based one-time codes (RFC 6238), the kind authenticator apps make. Written here because it's a few lines over the standard library, and it's what sign-in rests on, so it has the standard's own test values. */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", STEP = 30;
export function base32(b: Buffer) {
  let bits = 0, value = 0, out = "";
  for (const byte of b) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } value &= (1 << bits) - 1; }
  return bits ? out + B32[(value << (5 - bits)) & 31] : out;
}
export function fromBase32(s: string) {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/[=\s]/g, "")) { const i = B32.indexOf(ch); if (i < 0) throw new Error("Not base32."); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } value &= (1 << bits) - 1; }
  return Buffer.from(out);
}
export const newSecret = () => base32(crypto.randomBytes(20));
export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP);
export function codeFor(secret: string, step: number, digits = 6) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", fromBase32(secret)).update(counter).digest(), at = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}
/**
 * The step a code belongs to, or null. One step either side allows for a phone's clock being slightly off.
 * A step at or before lastStep has been used, so a code someone saw over a shoulder can't be used again.
 */
export function matchCode(secret: string, code: string, now: number, lastStep = -1) {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const given = Buffer.from(clean), at = stepAt(now);
  let found: number | null = null;
  // All three are compared every time, so the time taken doesn't reveal which matched
  for (const step of [at - 1, at, at + 1]) if (crypto.timingSafeEqual(given, Buffer.from(codeFor(secret, step))) && step > lastStep) found = step;
  return found;
}
export const otpUri = (secret: string, email: string, issuer: string) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

/** One-time codes for a lost phone. Only their hashes are kept. They carry 50 random bits, so a plain hash is enough. */
export function newRecoveryCodes(n = 10) { return Array.from({ length: n }, () => { const c = base32(crypto.randomBytes(7)).slice(0, 10).toLowerCase(); return `${c.slice(0, 5)}-${c.slice(5)}`; }); }
export const hashRecovery = (code: string) => crypto.createHash("sha256").update(code.trim().toLowerCase().replace(/[^a-z2-7]/g, "")).digest("hex");
