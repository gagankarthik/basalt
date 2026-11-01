"use client";
import { useState } from "react";
import { MfaSetup, RecoveryCodes } from "@/components/MfaSetup";
import { Btn, Field, PageHead, toast } from "@/components/ui";
import { call, useApp } from "@/lib/client";

function Profile() {
  const user = useApp((s) => s.user)!, load = useApp((s) => s.load);
  const [name, setName] = useState(user.name), [email, setEmail] = useState(user.email), [current, setCurrent] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const emailChanges = email.trim().toLowerCase() !== user.email;
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try { await call("/api/auth", { json: { action: "profile", name, email, current } }); await load(); setCurrent(""); toast("Profile saved"); } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };
  return <section className="account-sec">
    <h2>Profile</h2>
    <form onSubmit={save} style={{ display: "grid", gap: 16 }} noValidate>
      <Field label="Name"><input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Email" hint="You sign in with this."><input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      {emailChanges && <Field label="Your password" hint="Needed to change your email."><input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>}
      {error && <div className="banner bad" role="alert">{error}</div>}
      <div><Btn type="submit" variant="primary" disabled={busy || !name.trim() || (emailChanges && !current) || (name === user.name && !emailChanges)}>Save profile</Btn></div>
    </form>
  </section>;
}

function Password() {
  const [current, setCurrent] = useState(""), [next, setNext] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try { await call("/api/auth", { json: { action: "password", current, next } }); setCurrent(""); setNext(""); toast("Password changed. Other devices are signed out."); } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };
  return <section className="account-sec" style={{ marginTop: 32 }}>
    <h2>Password</h2>
    <form onSubmit={save} style={{ display: "grid", gap: 16 }} noValidate>
      <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
      <Field label="New password" hint="At least 10 characters. Other devices are signed out."><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      {error && <div className="banner bad" role="alert">{error}</div>}
      <div><Btn type="submit" variant="primary" disabled={busy || !current || next.length < 10}>Change password</Btn></div>
    </form>
  </section>;
}

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
    <div className="body"><Profile /><Password /><section className="account-sec" style={{ marginTop: 32 }}>
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
