"use client";
import { useEffect, useState } from "react";
import { Mark } from "@/components/icons";
import { Btn, Field } from "@/components/ui";
import { MfaSetup } from "@/components/MfaSetup";
import { call } from "@/lib/client";

// Only same-site paths, so a crafted link can't send someone elsewhere after they sign in
const nextPath = () => { const n = new URLSearchParams(location.search).get("next") ?? ""; return /^\/(?![/\\])/.test(n) ? n : "/home"; };

export default function Login() {
  const [setup, setSetup] = useState<boolean | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [f, setF] = useState({ workspace: "", name: "", email: "", password: "", sample: true });
  const on = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: k === "sample" ? e.target.checked : e.target.value });
  const [sso, setSso] = useState<{ name: string; enforce: boolean } | null>(null);
  useEffect(() => { setError(new URLSearchParams(location.search).get("error") ?? ""); call<{ user: unknown; needsSetup: boolean; sso: { name: string; enforce: boolean } | null }>("/api/auth").then((r) => { if (r.user) window.location.assign(nextPath()); else { setSetup(r.needsSetup); setSso(r.sso); } }); }, []);
  const [tried, setTried] = useState(false), [step, setStep] = useState<"password" | "code" | "enrol">("password"), [code, setCode] = useState("");
  const errors = {
    workspace: setup && !f.workspace.trim() ? "Enter your company or workspace name." : "",
    name: setup && !f.name.trim() ? "Enter your name." : "",
    email: !f.email.trim() ? "Enter your work email." : !/^\S+@\S+\.\S+$/.test(f.email) ? "Enter a valid email, such as you@company.com." : "",
    password: !f.password ? "Enter your password." : setup && f.password.length < 10 ? "Use at least 10 characters." : "",
  };
  const show = (k: keyof typeof errors) => (tried ? errors[k] || undefined : undefined);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setTried(true);
    if (Object.values(errors).some(Boolean)) return;
    setBusy(true); setError("");
    try {
      const r = await call<{ mfaRequired?: boolean; mustEnrol?: boolean }>("/api/auth", { json: { action: setup ? "setup" : "login", ...f, ...(step === "code" ? { code } : {}) } });
      if (r.mfaRequired) { setStep("code"); setBusy(false); return; }
      if (r.mustEnrol) { setStep("enrol"); setBusy(false); return; }
      window.location.assign(nextPath());
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  if (setup === null) return <div className="auth" />;
  if (step === "enrol") return <div className="auth"><div className="auth-card"><div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 700, fontSize: 18 }}><Mark size={26} />Basalt</div><p className="small muted">Your workspace requires two-factor sign-in.</p><MfaSetup email={f.email} password={f.password} onDone={() => window.location.assign(nextPath())} /></div></div>;
  if (step === "code") return <div className="auth"><form onSubmit={submit} noValidate>
    <div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 700, fontSize: 18 }}><Mark size={26} />Basalt</div>
    <div><h1>Enter your code</h1><p className="muted">From your authenticator app, or one of your recovery codes.</p></div>
    <Field label="Code"><input className="input" autoFocus autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
    {error && <div className="banner bad" role="alert">{error}</div>}
    <Btn type="submit" variant="primary" disabled={busy || !code.trim()}>{busy ? "Checking" : "Sign in"}</Btn>
    <Btn type="button" variant="ghost" onClick={() => { setStep("password"); setCode(""); setError(""); }}>Back</Btn>
  </form></div>;
  return (
    <div className="auth">
      <form onSubmit={submit} noValidate>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 700, fontSize: 18 }}><Mark size={26} />Basalt</div>
        <div><h1>{setup ? "Set up your workspace" : "Sign in"}</h1>{setup && <p className="muted">You&apos;ll be the admin. Everything stays on this server.</p>}</div>
        {!setup && sso && <><a className="btn primary" style={{ justifyContent: "center" }} href="/api/auth/sso">Continue with {sso.name}</a><div className="sso-or">{sso.enforce ? "Admins can also use a password" : "or"}</div></>}
        {setup && <Field label="Company or workspace name" error={show("workspace")}><input className="input" required value={f.workspace} onChange={on("workspace")} /></Field>}
        {setup && <Field label="Your name" error={show("name")}><input className="input" required value={f.name} onChange={on("name")} autoComplete="name" /></Field>}
        <Field label="Work email" error={show("email")}><input className="input" type="email" required value={f.email} onChange={on("email")} autoComplete="email" /></Field>
        <Field label="Password" error={show("password")} hint={setup ? "At least 10 characters" : undefined}><input className="input" type="password" required value={f.password} onChange={on("password")} autoComplete={setup ? "new-password" : "current-password"} /></Field>
        {setup && <label className="check"><input type="checkbox" checked={f.sample} onChange={on("sample")} />Load the sample company so there&apos;s data to explore</label>}
        {error && <div className="banner bad" role="alert">{error}</div>}
        <Btn type="submit" variant={!setup && sso ? undefined : "primary"} disabled={busy}>{busy ? (setup ? "Setting up and syncing sample data" : "Signing in") : setup ? "Create workspace" : "Sign in"}</Btn>
      </form>
    </div>
  );
}
