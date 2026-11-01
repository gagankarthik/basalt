import "server-only";
import QRCode from "qrcode";
import { hashRecovery, matchCode, newRecoveryCodes, newSecret, otpUri, stepAt } from "@/lib/totp";
import { deleteSecret, getConfig, getSecret, getUsers, saveSecret, saveUsers, type StoredUser } from "./files";

const secretId = (id: string) => `mfa:${id}`, pendingId = (id: string) => `mfa-pending:${id}`;
const patch = (id: string, fn: (u: StoredUser) => StoredUser) => saveUsers(getUsers().map((u) => (u.id === id ? fn(u) : u)));

/** Starts setup. Nothing changes for sign-in until a first code proves the phone has it. */
export async function beginMfa(user: StoredUser) {
  const secret = newSecret(), uri = otpUri(secret, user.email, getConfig().settings.workspace || "Basalt");
  saveSecret(pendingId(user.id), secret);
  const svg = await QRCode.toString(uri, { type: "svg", margin: 1 });
  return { secret, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
}
export function confirmMfa(user: StoredUser, code: string) {
  const secret = getSecret(pendingId(user.id)), step = secret ? matchCode(secret, code, Date.now()) : null;
  if (!secret || step == null) return null;
  const codes = newRecoveryCodes();
  saveSecret(secretId(user.id), secret); deleteSecret(pendingId(user.id));
  patch(user.id, (u) => ({ ...u, mfa: { lastStep: step, recovery: codes.map(hashRecovery), enabledAt: new Date().toISOString() } }));
  return codes;
}
/** A code from the app, or a recovery code, which then can't be used again. */
export function checkSecondFactor(user: StoredUser, code: string): "code" | "recovery" | null {
  const secret = getSecret(secretId(user.id));
  if (!secret || !user.mfa) return null;
  const step = matchCode(secret, code, Date.now(), user.mfa.lastStep);
  if (step != null) { patch(user.id, (u) => ({ ...u, mfa: { ...u.mfa!, lastStep: step } })); return "code"; }
  const h = hashRecovery(code);
  if (user.mfa.recovery.includes(h)) { patch(user.id, (u) => ({ ...u, mfa: { ...u.mfa!, recovery: u.mfa!.recovery.filter((x) => x !== h) } })); return "recovery"; }
  return null;
}
export function newCodes(user: StoredUser) { const codes = newRecoveryCodes(); patch(user.id, (u) => ({ ...u, mfa: { ...u.mfa!, recovery: codes.map(hashRecovery) } })); return codes; }
/** Removing it also ends their sessions, so it can't be used to get past a sign-in that's been lost. */
export function removeMfa(id: string) { deleteSecret(secretId(id)); deleteSecret(pendingId(id)); patch(id, (u) => { const rest = { ...u, sessions: (u.sessions ?? 0) + 1 }; delete rest.mfa; return rest; }); }
export const signOutWithoutMfa = () => saveUsers(getUsers().map((u) => (u.mfa ? u : { ...u, sessions: (u.sessions ?? 0) + 1 })));
export const stepNow = () => stepAt(Date.now());
