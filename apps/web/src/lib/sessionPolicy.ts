export type SessionPolicy = { idleMinutes: number; maxHours: number };
export const DEFAULT_POLICY: SessionPolicy = { idleMinutes: 0, maxHours: 168 };
export const IDLE_OPTIONS: [number, string][] = [[0, "Never"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [240, "4 hours"]];
export const MAX_OPTIONS: [number, string][] = [[8, "8 hours"], [12, "12 hours"], [24, "1 day"], [72, "3 days"], [168, "7 days"]];
export const validPolicy = (p: SessionPolicy) => IDLE_OPTIONS.some(([v]) => v === p.idleMinutes) && MAX_OPTIONS.some(([v]) => v === p.maxHours);

/** Sent by the browser only when a person has used the page lately, because the app polls by itself and that mustn't count as someone being there. */
export const ACTIVE_HEADER = "x-basalt-active";
const LEGACY_DAYS = 7;

/** id.expires.sessions.issued.sid. Cookies made before this format have no issue time, so it's worked out from their expiry and they stay valid. */
export function parseSession(payload: string) {
  const [id, exp, sessions, issued, sid] = payload.split(".");
  const expires = Number(exp);
  return { id, expires, sessions: Number(sessions ?? 0), issued: Number(issued) || expires - LEGACY_DAYS * 864e5, sid: sid || payload };
}
/** Judged against the current policy, not the one at sign-in, so tightening the rule applies to people already signed in. */
export function sessionVerdict(s: { expires: number; issued: number }, lastSeen: number | undefined, now: number, policy: SessionPolicy): "ok" | "expired" | "idle" {
  if (s.expires < now || now - s.issued > policy.maxHours * 36e5) return "expired";
  if (policy.idleMinutes && lastSeen !== undefined && now - lastSeen > policy.idleMinutes * 6e4) return "idle";
  return "ok";
}
