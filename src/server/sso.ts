import "server-only";
import crypto from "node:crypto";
import { readJson, writeJson } from "./files";
import type { Role } from "@/lib/types";

export type SsoConfig = { enabled: boolean; name: string; issuer: string; clientId: string; publicUrl: string; defaultRole: Role; allowedDomain: string; enforce: boolean };
const DEFAULTS: SsoConfig = { enabled: false, name: "single sign-on", issuer: "", clientId: "", publicUrl: "", defaultRole: "viewer", allowedDomain: "", enforce: false };
export const getSso = () => ({ ...DEFAULTS, ...readJson<Partial<SsoConfig>>("sso.json", {}) });
export const saveSso = (s: SsoConfig) => writeJson("sso.json", s);

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
const isLocal = (u: URL) => u.hostname === "localhost" || u.hostname === "127.0.0.1";
const secureUrl = (raw: string) => { const u = new URL(raw); if (u.protocol !== "https:" && !isLocal(u)) throw new Error("Single sign-on addresses must use https."); return u; };

export async function discover(issuer: string): Promise<Discovery> {
  const base = issuer.replace(/\/+$/, "");
  secureUrl(base);
  const res = await fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`The identity provider answered with status ${res.status}.`);
  const d = (await res.json()) as Discovery;
  if (d.issuer?.replace(/\/+$/, "") !== base) throw new Error("The identity provider reported a different issuer.");
  [d.authorization_endpoint, d.token_endpoint, d.jwks_uri].forEach(secureUrl);
  return d;
}

const b64 = (s: string) => Buffer.from(s, "base64url");
export const randomToken = () => crypto.randomBytes(32).toString("base64url");
export const pkceChallenge = (verifier: string) => crypto.createHash("sha256").update(verifier).digest("base64url");

const HASHES: Record<string, string> = { RS256: "sha256", RS384: "sha384", RS512: "sha512", ES256: "sha256", ES384: "sha384" };
/** Checks the signature against the provider's keys, then who issued it, who it's for, when it expires, and the nonce from this sign-in. */
export async function verifyIdToken(token: string, d: Discovery, clientId: string, nonce: string) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("The sign-in token is malformed.");
  const header = JSON.parse(b64(h).toString()), claims = JSON.parse(b64(p).toString());
  const hash = HASHES[header.alg];
  if (!hash) throw new Error("The sign-in token uses an unsupported algorithm.");
  const res = await fetch(d.jwks_uri, { signal: AbortSignal.timeout(8000) });
  const { keys } = (await res.json()) as { keys: (crypto.JsonWebKey & { kid?: string })[] };
  const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) throw new Error("The identity provider's signing key wasn't found.");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const ok = crypto.verify(hash, Buffer.from(`${h}.${p}`), header.alg.startsWith("ES") ? { key, dsaEncoding: "ieee-p1363" } : key, b64(s));
  if (!ok) throw new Error("The sign-in token's signature isn't valid.");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud], now = Date.now() / 1000;
  if (String(claims.iss).replace(/\/+$/, "") !== d.issuer.replace(/\/+$/, "")) throw new Error("The sign-in token came from a different issuer.");
  if (!aud.includes(clientId)) throw new Error("The sign-in token was issued for a different application.");
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("The sign-in token has expired.");
  if (claims.nonce !== nonce) throw new Error("The sign-in couldn't be matched to this browser. Try again.");
  return claims as { sub: string; email?: string; email_verified?: boolean; name?: string; preferred_username?: string };
}
