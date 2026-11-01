"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { Nav } from "./Landing";
import { Sel } from "./ui";
import "./landing.css";

const POINTS = ["See it with your own kind of data", "Check whether it fits your databases and team", "Talk through security and access"];

export default function SalesPage() {
  const [f, setF] = useState({ name: "", email: "", company: "", teamSize: "1 to 10", sources: "", message: "", website: "" });
  // Signed-in people don't retype what we already know
  useEffect(() => { fetch("/api/auth").then((r) => r.json()).then((r) => { if (r.user) setF((x) => ({ ...x, name: x.name || r.user.name, email: x.email || r.user.email })); }, () => {}); }, []);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const res = await fetch("/api/sales", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Your request couldn't be sent. Try again.");
      setDone(true);
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };
  return (
    <div className="lp">
      <Nav base="/" />
      <section className="lp-sales"><div className="lp-wrap lp-sales-in">
        <div>
          <h1>Talk to sales</h1>
          <p>Tell us about your data and your team, and we&apos;ll get back to you by email.</p>
          <ul>{POINTS.map((t) => <li key={t}><Icon name="check" size={18} />{t}</li>)}</ul>
        </div>
        {done ? (
          <div className="lp-sales-form" role="status"><span className="lp-sales-ok"><Icon name="check" size={22} /></span><h2>Thanks, we have your request.</h2><p>We&apos;ll reply to {f.email}.</p><Link className="lp-btn sec" href="/">Back to home</Link></div>
        ) : (
          <form className="lp-sales-form" onSubmit={submit}>
            <div className="lp-sales-row"><label>Your name<input required value={f.name} onChange={set("name")} autoComplete="name" /></label><label>Work email<input required type="email" value={f.email} onChange={set("email")} autoComplete="email" /></label></div>
            <div className="lp-sales-row"><label>Company<input required value={f.company} onChange={set("company")} autoComplete="organization" /></label><label>Team size<Sel className="" value={f.teamSize} onChange={(teamSize) => setF({ ...f, teamSize })} options={["1 to 10", "11 to 50", "51 to 200", "201 to 1,000", "More than 1,000"]} /></label></div>
            <label>Where your data lives<input value={f.sources} onChange={set("sources")} placeholder="PostgreSQL, MySQL, spreadsheets" /></label>
            <label>How can we help?<textarea rows={4} value={f.message} onChange={set("message")} /></label>
            <label className="lp-sales-trap" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} /></label>
            {error && <p className="lp-sales-err" role="alert">{error}</p>}
            <button className="lp-btn pri" disabled={busy}>{busy ? "Sending" : "Talk to sales"}</button>
          </form>
        )}
      </div></section>
    </div>
  );
}
