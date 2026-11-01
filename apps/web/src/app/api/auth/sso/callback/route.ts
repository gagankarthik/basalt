import crypto from "node:crypto";
import { readSigned, sessionCookie } from "@/server/auth";
import { audit, createUser, getSecret, getUsers, saveUsers } from "@/server/files";
import { discover, getSso, verifyIdToken } from "@/server/sso";

const clear = "basalt_oidc=; Path=/api/auth/sso; HttpOnly; SameSite=Lax; Max-Age=0";

export async function GET(req: Request) {
  const sso = getSso(), url = new URL(req.url), origin = (sso.publicUrl || url.origin).replace(/\/+$/, "");
  const fail = (msg: string) => new Response(null, { status: 302, headers: { location: `${origin}/login?error=${encodeURIComponent(msg)}`, "set-cookie": clear } });
  try {
    if (!sso.enabled) return fail("Single sign-on isn't turned on.");
    if (url.searchParams.get("error")) return fail("The identity provider didn't complete the sign-in.");
    const raw = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith("basalt_oidc="))?.slice(12);
    const [state, nonce, verifier] = (raw && readSigned(raw))?.split(".") ?? [];
    if (!state || state !== url.searchParams.get("state")) return fail("The sign-in couldn't be matched to this browser. Try again.");
    const d = await discover(sso.issuer);
    const res = await fetch(d.token_endpoint, { method: "POST", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", redirect_uri: `${origin}/api/auth/sso/callback`, client_id: sso.clientId, client_secret: getSecret("sso") ?? "", code_verifier: verifier }) });
    const tokens = (await res.json().catch(() => ({}))) as { id_token?: string };
    if (!res.ok || !tokens.id_token) return fail("The identity provider refused the sign-in.");
    const claims = await verifyIdToken(tokens.id_token, d, sso.clientId, nonce);
    const email = String(claims.email ?? "").toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail("The identity provider didn't share an email address.");
    if (claims.email_verified === false) return fail("Verify your email with your identity provider first.");
    const verified = claims.email_verified === true || sso.trustEmails, ssoId = `${d.issuer}|${claims.sub}`;
    if (sso.allowedDomain && !verified) return fail("Your identity provider didn't confirm this email address. Ask your admin to check the single sign-on settings.");
    if (sso.allowedDomain && email.split("@")[1] !== sso.allowedDomain.toLowerCase().replace(/^@/, "")) return fail("This email domain isn't allowed in this workspace.");
    let user = getUsers().find((u) => u.email === email), created = false;
    // An unconfirmed email mustn't take over an existing account, and once linked an account only answers to that identity
    if (user && (user.ssoId ? user.ssoId !== ssoId : !verified)) return fail("This email belongs to an account that can't be linked to this sign-in. Ask your admin.");
    // No one can sign in with this password; it only fills the field for accounts that come from the provider
    if (!user) { user = createUser(email, String(claims.name || claims.preferred_username || email), sso.defaultRole, crypto.randomBytes(32).toString("hex")); created = true; }
    if (user.ssoId !== ssoId) { const id = user.id; user = { ...user, ssoId }; saveUsers(getUsers().map((u) => (u.id === id ? { ...u, ssoId } : u))); }
    audit(user.name, created ? "Joined through single sign-on" : "Signed in with single sign-on", email, created);
    const headers = new Headers({ location: `${origin}/home` });
    headers.append("set-cookie", clear);
    headers.append("set-cookie", sessionCookie(user, origin.startsWith("https:")));
    return new Response(null, { status: 302, headers });
  } catch (e) { return fail(e instanceof Error ? e.message : "Single sign-on failed."); }
}
