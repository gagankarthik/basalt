import { addComment, alertsFor, commentsFor, dashboardFor, deleteAlert, deleteComment, setAlert } from "@/server/apps";
import { api, HttpError } from "@/server/auth";
import { getSmtp } from "@/server/mail";

// Every read first proves this person can read the dashboard, so a guessed id gets nothing
export const GET = api("viewer", (req, user) => {
  const u = new URL(req.url).searchParams, dashboard = String(u.get("dashboard"));
  dashboardFor(user, dashboard, u.get("app") ?? undefined);
  return { comments: commentsFor(user, dashboard), alerts: alertsFor(user, dashboard), mail: !!getSmtp()?.host };
});
export const POST = api("viewer", async (req, user) => {
  const b = await req.json(), dashboard = String(b.dashboard ?? ""), widget = String(b.widget ?? ""), app = b.app ? String(b.app) : undefined;
  if (b.action === "deleteComment") { deleteComment(user, String(b.id)); return { ok: true }; }
  if (b.action === "deleteAlert") { deleteAlert(user, String(b.id)); return { ok: true }; }
  const w = dashboardFor(user, dashboard, app).widgets.find((x) => x.id === widget);
  if (!w) throw new HttpError(404, "This tile no longer exists.");
  if (b.action === "comment") { addComment(user, dashboard, widget, String(b.text ?? "")); return { ok: true }; }
  if (b.action === "alert") {
    if (w.type !== "kpi" && w.type !== "gauge") throw new HttpError(400, "Alerts work on number and gauge tiles.");
    if (b.value === "" || b.value == null || !Number.isFinite(Number(b.value)) || (b.op !== "gt" && b.op !== "lt")) throw new HttpError(400, "Choose above or below, and enter a number.");
    return { alert: await setAlert(user, dashboard, widget, b.op, Number(b.value), app) };
  }
  throw new HttpError(400, "Unknown action.");
});
