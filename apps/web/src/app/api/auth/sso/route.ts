import { signValue } from "@/server/auth";
import { discover, getSso, pkceChallenge, randomToken } from "@/server/sso";

const back = (origin: string, msg: string) => Response.redirect(`${origin}/login?error=${encodeURIComponent(msg)}`, 302);

export async function GET(req: Request) {
  const sso = getSso(), origin = (sso.publicUrl || new URL(req.url).origin).replace(/\/+$/, "");
  if (!sso.enabled) return back(origin, "Single sign-on isn't turned on.");
  try {
    const d = await discover(sso.issuer);
    const state = randomToken(), nonce = randomToken(), verifier = randomToken();
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({ response_type: "code", client_id: sso.clientId, redirect_uri: `${origin}/api/auth/sso/callback`, scope: "openid email profile", state, nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" }).toString();
    const cookie = `basalt_oidc=${signValue(`${state}.${nonce}.${verifier}`)}; Path=/api/auth/sso; HttpOnly; SameSite=Lax; Max-Age=600${origin.startsWith("https:") ? "; Secure" : ""}`;
    return new Response(null, { status: 302, headers: { location: url.toString(), "set-cookie": cookie } });
  } catch (e) { return back(origin, e instanceof Error ? e.message : "Single sign-on couldn't start."); }
}
