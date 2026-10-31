import { canReadDashboard } from "@/server/apps";
import { api, HttpError } from "@/server/auth";
import { getSmtp } from "@/server/mail";
import { getSubscriptions, sendReport, subscribe, unsubscribe } from "@/server/subscriptions";

// People subscribe themselves, so reports only ever go to the signed-in person's own address
export const GET = api("viewer", (req, user) => {
  const d = new URL(req.url).searchParams.get("dashboard");
  return { mail: !!getSmtp()?.host, subscription: getSubscriptions().find((s) => s.userId === user.id && s.dashboard === d) ?? null };
});
export const POST = api("viewer", async (req, user) => {
  const b = await req.json(), dashboard = String(b.dashboard ?? "");
  if (b.action !== "off" && !canReadDashboard(user, dashboard)) throw new HttpError(403, "Open this dashboard from its app.");
  if (b.action === "off") { unsubscribe(user.id, dashboard); return { ok: true }; }
  const every = Number(b.every);
  if (![24, 168, 720].includes(every)) throw new HttpError(400, "Choose daily, weekly or monthly.");
  const s = subscribe(user.id, dashboard, every);
  if (b.send) await sendReport(s);
  return { subscription: s };
});
