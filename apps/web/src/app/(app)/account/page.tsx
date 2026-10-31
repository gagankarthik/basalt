"use client";
import { useState } from "react";
import { MfaSetup, RecoveryCodes } from "@/components/MfaSetup";
import { Btn, Field, PageHead, toast } from "@/components/ui";
import { call, useApp } from "@/lib/client";

/** Everything here asks for the password again, so a browser left open can't change how someone signs in. */
export default function Account() {
  const user = useApp((s) => s.user), load = useApp((s) => s.load);
  const [mode, setMode] = useState<"" | "setup" | "off" | "codes">(""), [password, setPassword] = useState(""), [code, setCode] = useState(""), [ready, setReady] = useState(false), [codes, setCodes] = useState<string[] | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  if (!user) return null;
  const reset = () => { setMode(""); setPassword(""); setCode(""); setReady(false); setCodes(null); setError(""); setBusy(false); void load(); };
  const act = async (e: React.FormEvent) => {
    e.preventDefault(); setError("");
    if (mode === "setup") { setReady(true); return; }
    setBusy(true);
    try {
      const r = await call<{ recovery?: string[] }>("/api/auth", { json: { action: mode === "off" ? "mfa-off" : "mfa-codes", email: user.email, password, code } });
      if (r.recovery) { setCodes(r.recovery); setBusy(false); return; }
      toast("Two-factor sign-in is off"); reset();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return <>
    <PageHead title="Your account" />
    <div className="body"><section className="account-sec">
      <h2>Two-factor sign-in</h2>
      <p className="small muted">{user.mfaOn ? `On. ${user.mfaCodesLeft ?? 0} recovery codes left.` : "Off. Add a code from your phone, so a stolen password isn't enough to sign in."}</p>
      {codes && <RecoveryCodes codes={codes} onDone={reset} />}
      {ready && <MfaSetup email={user.email} password={password} onDone={reset} onCancel={reset} />}
      {!mode && <div style={{ display: "flex", gap: 8 }}>{user.mfaOn ? <><Btn onClick={() => setMode("codes")}>New recovery codes</Btn><Btn variant="danger" onClick={() => setMode("off")}>Turn off</Btn></> : <Btn variant="primary" onClick={() => setMode("setup")}>Set up</Btn>}</div>}
      {mode && !ready && !codes && <form onSubmit={act} style={{ display: "grid", gap: 16 }} noValidate>
        <Field label="Your password"><input className="input" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {mode !== "setup" && <Field label="Code from your app, or a recovery code"><input className="input" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></Field>}
        {error && <div className="banner bad" role="alert">{error}</div>}
        <div style={{ display: "flex", gap: 8 }}><Btn type="submit" variant={mode === "off" ? "danger" : "primary"} disabled={busy || !password || (mode !== "setup" && !code.trim())}>{mode === "off" ? "Turn off" : mode === "codes" ? "Make new codes" : "Continue"}</Btn><Btn type="button" onClick={reset}>Cancel</Btn></div>
      </form>}
    </section>
    <section className="account-sec" style={{ marginTop: 32 }}>
      <h2>Sessions</h2>
      <p className="small muted">Signs you out on every device, including this one. Use it if you left yourself signed in somewhere, or lost a laptop.</p>
      <div><Btn onClick={() => call("/api/auth", { json: { action: "logout" } }).then(() => window.location.assign("/login"))}>Sign out of all devices</Btn></div>
    </section></div>
  </>;
}
