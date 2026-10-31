"use client";
import { useEffect, useState } from "react";
import { Btn, Field, toast } from "./ui";
import { call } from "@/lib/client";

/** Shows recovery codes once. They're never available again, so the person has to say they've kept them. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [kept, setKept] = useState(false);
  const copy = () => navigator.clipboard.writeText(codes.join("\n")).then(() => toast("Codes copied"));
  return <div style={{ display: "grid", gap: 16 }}>
    <div><h2 style={{ fontSize: 16 }}>Save your recovery codes</h2><p className="small muted">If you lose your phone, each code gets you in once. They won&apos;t be shown again.</p></div>
    <code className="token-box mfa-codes">{codes.join("\n")}</code>
    <div><Btn icon="copy" type="button" onClick={copy}>Copy codes</Btn></div>
    <label className="check"><input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />I&apos;ve saved these somewhere safe</label>
    <Btn type="button" variant="primary" disabled={!kept} onClick={onDone}>Continue</Btn>
  </div>;
}

/** Connects an authenticator app. A first good code turns it on, so a mistaken scan can't lock anyone out. */
export function MfaSetup({ email, password, onDone, onCancel }: { email: string; password: string; onDone: () => void; onCancel?: () => void }) {
  const [start, setStart] = useState<{ secret: string; qr: string } | null>(null), [code, setCode] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [codes, setCodes] = useState<string[] | null>(null);
  useEffect(() => { call<{ secret: string; qr: string }>("/api/auth", { json: { action: "mfa-begin", email, password } }).then(setStart, (e) => setError(e.message)); }, [email, password]);
  const confirm = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try { setCodes((await call<{ recovery: string[] }>("/api/auth", { json: { action: "mfa-confirm", email, password, code } })).recovery); }
    catch (err) { setError((err as Error).message); }
    setBusy(false);
  };
  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;
  return <form onSubmit={confirm} style={{ display: "grid", gap: 16 }} noValidate>
    <div><h2 style={{ fontSize: 16 }}>Connect an authenticator app</h2><p className="small muted">Scan this with an app such as Google Authenticator, Microsoft Authenticator or 1Password, then enter the code it shows.</p></div>
    {/* eslint-disable-next-line @next/next/no-img-element -- a small inline QR code, with nothing for the image optimizer to do */}
    {start && <img className="mfa-qr" src={start.qr} alt="QR code for your authenticator app" width={176} height={176} />}
    {start && <div className="small"><span className="muted">Can&apos;t scan it? Enter this key:</span> <code>{start.secret}</code></div>}
    <Field label="Code from the app"><input className="input" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} /></Field>
    {error && <div className="banner bad" role="alert">{error}</div>}
    <div style={{ display: "flex", gap: 8 }}><Btn type="submit" variant="primary" disabled={busy || !start || !code.trim()}>{busy ? "Checking" : "Turn on"}</Btn>{onCancel && <Btn type="button" onClick={onCancel}>Cancel</Btn>}</div>
  </form>;
}
