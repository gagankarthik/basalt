"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Mark } from "@/components/icons";
import { Btn, ErrorState, Field, LoadingTable, Sel, SuccessState } from "@/components/ui";
import type { Field as BField } from "@/lib/base";

type Form = { title: string; description: string; thanks?: string; required: string[]; fields: BField[] };

export default function PublicForm() {
  const { id } = useParams<{ id: string }>();
  const [form, setForm] = useState<Form | null>(null), [err, setErr] = useState(""), [values, setValues] = useState<Record<string, unknown>>({}), [tried, setTried] = useState(false), [done, setDone] = useState(false), [busy, setBusy] = useState(false), [problem, setProblem] = useState(""), [trap, setTrap] = useState("");
  useEffect(() => { fetch(`/api/forms?id=${encodeURIComponent(id)}`).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setForm(d); }).catch((e) => setErr(e.message || "This form couldn't load.")); }, [id]);
  const set = (k: string, v: unknown) => setValues({ ...values, [k]: v });
  const missing = (f: BField) => { const v = values[f.id]; return tried && form!.required.includes(f.id) && (v == null || v === "" || v === false || (Array.isArray(v) && !v.length)) ? `Fill in ${f.name}.` : undefined; };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setTried(true); setProblem("");
    if (form!.fields.some((f) => { const v = values[f.id]; return form!.required.includes(f.id) && (v == null || v === "" || v === false || (Array.isArray(v) && !v.length)); })) return;
    setBusy(true);
    try { const r = await fetch("/api/forms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, values, website: trap }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error); setDone(true); }
    catch (x) { setProblem(navigator.onLine ? (x as Error).message : "You're offline. Reconnect, then try again."); }
    setBusy(false);
  };
  return (
    <main className="pub-form">
      <div className="pub-card">
        {err ? <ErrorState title="This form isn't available">{err}</ErrorState> : !form ? <LoadingTable rows={4} cols={1} label="Loading form" /> : done ? <SuccessState title="Thanks, your response was sent" action={<Btn onClick={() => { setValues({}); setTried(false); setDone(false); }}>Send another response</Btn>}>{form.thanks}</SuccessState> : (
          <form onSubmit={submit} noValidate>
            <h1>{form.title}</h1>
            {form.description && <p className="muted">{form.description}</p>}
            <input tabIndex={-1} autoComplete="off" aria-hidden="true" className="pub-trap" value={trap} onChange={(e) => setTrap(e.target.value)} />
            {form.fields.map((f) => <Field key={f.id} label={`${f.name}${form.required.includes(f.id) ? " (required)" : ""}`} hint={f.description} error={missing(f)}>
              {f.type === "longText" ? <textarea className="input" rows={4} value={String(values[f.id] ?? "")} onChange={(e) => set(f.id, e.target.value)} />
                : f.type === "select" ? <Sel options={[["", "Choose"], ...(f.choices ?? []).map((c): [string, string] => [c.id, c.name])]} value={String(values[f.id] ?? "")} onChange={(v) => set(f.id, v)} />
                  : f.type === "multiSelect" ? <span className="pub-multi">{(f.choices ?? []).map((c) => { const on = ((values[f.id] as string[]) ?? []).includes(c.id); return <label key={c.id} className="check"><input type="checkbox" checked={on} onChange={(e) => set(f.id, e.target.checked ? [...((values[f.id] as string[]) ?? []), c.id] : ((values[f.id] as string[]) ?? []).filter((x) => x !== c.id))} />{c.name}</label>; })}</span>
                    : f.type === "checkbox" ? <input type="checkbox" checked={!!values[f.id]} onChange={(e) => set(f.id, e.target.checked)} style={{ justifySelf: "start" }} />
                      : <input className="input" type={f.type === "date" ? (f.includeTime ? "datetime-local" : "date") : f.type === "email" ? "email" : f.type === "url" ? "url" : ["number", "currency", "percent", "rating", "duration"].includes(f.type) ? "number" : f.type === "phone" ? "tel" : "text"} value={String(values[f.id] ?? "")} onChange={(e) => set(f.id, e.target.value)} />}
            </Field>)}
            {problem && <div className="banner bad" role="alert">{problem}</div>}
            <Btn type="submit" variant="primary" disabled={busy}>{busy ? "Sending" : "Submit"}</Btn>
          </form>
        )}
      </div>
      <p className="pub-brand"><Mark size={18} />Made with Basalt</p>
    </main>
  );
}
