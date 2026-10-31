import { clearCookie, currentUser, errorResponse, HttpError, sessionCookie } from "@/server/auth";
import { audit, checkPassword, createUser, getConfig, getUsers, hashPassword, publicUser, saveConfig, saveUsers } from "@/server/files";
import { createThrottle } from "@/lib/loginThrottle";
import { sampleConfig } from "@/server/seed";
import { runPipeline } from "@/server/jobs";
import { getSso } from "@/server/sso";
import { beginMfa, checkSecondFactor, confirmMfa, newCodes, removeMfa } from "@/server/mfa";
import { getSecurity } from "@/server/security";

const throttle = createThrottle();
const secure = (req: Request) => new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

export async function GET(req: Request) {
  const u = currentUser(req);
  const sso = getSso();
  return Response.json({ user: u ? publicUser(u) : null, needsSetup: getUsers().length === 0, sso: sso.enabled ? { name: sso.name, enforce: sso.enforce } : null });
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (b.action === "logout") {
      const me = currentUser(req);
      if (me) saveUsers(getUsers().map((u) => (u.id === me.id ? { ...u, sessions: (u.sessions ?? 0) + 1 } : u)));
      return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCookie() } });
    }
    const email = String(b.email ?? "").trim().toLowerCase(), password = String(b.password ?? "");
    if (b.action === "setup") {
      if (getUsers().length) throw new HttpError(403, "This workspace is already set up. Sign in instead.");
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
      if (password.length < 10) throw new HttpError(400, "Use a password with at least 10 characters.");
      const user = createUser(email, String(b.name || email), "admin", password);
      const cfg = getConfig();
      saveConfig({ ...cfg, ...(b.sample ? sampleConfig() : {}), settings: { ...cfg.settings, workspace: String(b.workspace || cfg.settings.workspace) } });
      audit(user.name, "Set up workspace");
      if (b.sample) await runPipeline("pl-northfork", "setup", "Setup");
      return Response.json({ user: publicUser(user) }, { headers: { "Set-Cookie": sessionCookie(user, secure(req)) } });
    }
    const sso = getSso();
    const sender = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
    if (throttle.blocked(email, sender)) throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.");
    const user = getUsers().find((u) => u.email === email);
    // Hashing for an unknown email too, so the response time doesn't reveal who has an account
    if (!user) hashPassword(password);
    if (!user || !checkPassword(user, password)) {
      throttle.fail(email, sender);
      throw new HttpError(401, "That email and password don't match.");
    }
    // Admins keep password access so a provider outage can't lock everyone out
    if (sso.enabled && sso.enforce && user.role !== "admin") throw new HttpError(403, `Use ${sso.name} to sign in.`);
    const code = String(b.code ?? "");
    const wrongCode = () => { throttle.fail(email, sender); return new HttpError(401, "That code isn't right. Check your authenticator app and try again."); };
    // The password is checked above on every one of these, so no half-signed-in session ever exists for someone to get past
    if (b.action === "mfa-begin") {
      if (user.mfa) throw new HttpError(400, "Two-factor sign-in is already on.");
      return Response.json(await beginMfa(user));
    }
    if (b.action === "mfa-confirm") {
      if (user.mfa) throw new HttpError(400, "Two-factor sign-in is already on.");
      const recovery = confirmMfa(user, code);
      if (!recovery) throw wrongCode();
      throttle.clear(email, sender);
      audit(user.name, "Turned on two-factor sign-in", "", true);
      const fresh = getUsers().find((u) => u.id === user.id)!;
      return Response.json({ recovery, user: publicUser(fresh) }, { headers: { "Set-Cookie": sessionCookie(fresh, secure(req)) } });
    }
    if (b.action === "mfa-off" || b.action === "mfa-codes") {
      if (!user.mfa) throw new HttpError(400, "Two-factor sign-in isn't on.");
      // Refused before the code is checked, so a refusal doesn't use up a recovery code
      if (b.action === "mfa-off" && getSecurity().requireMfa) throw new HttpError(403, "Your workspace requires two-factor sign-in, so it can't be turned off.");
      if (!checkSecondFactor(user, code)) throw wrongCode();
      throttle.clear(email, sender);
      if (b.action === "mfa-codes") { audit(user.name, "Made new recovery codes", "", true); return Response.json({ recovery: newCodes(user) }); }
      removeMfa(user.id);
      audit(user.name, "Turned off two-factor sign-in", "", true);
      return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(getUsers().find((u) => u.id === user.id)!, secure(req)) } });
    }
    if (user.mfa) {
      if (!code) return Response.json({ mfaRequired: true });
      const how = checkSecondFactor(user, code);
      if (!how) throw wrongCode();
      if (how === "recovery") audit(user.name, "Signed in with a recovery code", `${user.mfa.recovery.length - 1} left`, true);
    } else if (getSecurity().requireMfa) return Response.json({ mustEnrol: true });
    throttle.clear(email, sender);
    audit(user.name, "Signed in");
    // Read again, because using a recovery code changed how many are left
    return Response.json({ user: publicUser(getUsers().find((u) => u.id === user.id)!) }, { headers: { "Set-Cookie": sessionCookie(user, secure(req)) } });
  } catch (e) {
    return errorResponse(e);
  }
}
