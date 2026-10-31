import { clearCookie, currentUser, errorResponse, HttpError, sessionCookie } from "@/server/auth";
import { audit, checkPassword, createUser, getConfig, getUsers, hashPassword, publicUser, saveConfig } from "@/server/files";
import { sampleConfig } from "@/server/seed";
import { runPipeline } from "@/server/jobs";
import { getSso } from "@/server/sso";

const attempts = new Map<string, { n: number; until: number }>();
const secure = (req: Request) => new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

export async function GET(req: Request) {
  const u = currentUser(req);
  const sso = getSso();
  return Response.json({ user: u ? publicUser(u) : null, needsSetup: getUsers().length === 0, sso: sso.enabled ? { name: sso.name, enforce: sso.enforce } : null });
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (b.action === "logout") return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCookie() } });
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
      return Response.json({ user: publicUser(user) }, { headers: { "Set-Cookie": sessionCookie(user.id, secure(req)) } });
    }
    const sso = getSso();
    const a = attempts.get(email);
    if (a && a.until > Date.now()) throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.");
    const user = getUsers().find((u) => u.email === email);
    // Hashing for an unknown email too, so the response time doesn't reveal who has an account
    if (!user) hashPassword(password);
    if (!user || !checkPassword(user, password)) {
      const n = (a?.n ?? 0) + 1;
      // Made-up emails would otherwise fill memory
      if (attempts.size >= 10000) attempts.clear();
      attempts.set(email, { n, until: n >= 5 ? Date.now() + 300000 : 0 });
      throw new HttpError(401, "That email and password don't match.");
    }
    // Admins keep password access so a provider outage can't lock everyone out
    if (sso.enabled && sso.enforce && user.role !== "admin") throw new HttpError(403, `Use ${sso.name} to sign in.`);
    attempts.delete(email);
    audit(user.name, "Signed in");
    return Response.json({ user: publicUser(user) }, { headers: { "Set-Cookie": sessionCookie(user.id, secure(req)) } });
  } catch (e) {
    return errorResponse(e);
  }
}
