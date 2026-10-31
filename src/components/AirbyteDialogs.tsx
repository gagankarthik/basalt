"use client";
/* eslint-disable @next/next/no-img-element -- connector logos come from Airbyte's registry at runtime */
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { Btn, Field, Modal, Sel, Spinner } from "@/components/ui";
import { initialConfig, licenseName, missingFields, optionFor, discriminator, orderedProps, plainText, type ConfigValue, type JsonSchema } from "@/lib/airbyte";
import { call, useApp } from "@/lib/client";

export type AirbyteEntry = { id: string; name: string; repo: string; version: string; license?: string; support?: string; icon?: string; docs?: string; routes: string[] };
export type AirbyteList = { runtime: { docker: boolean; python: string | null }; connectors: AirbyteEntry[] };
type Spec = { id: string; name: string; repo: string; version: string; license?: string; docs?: string; schema: JsonSchema };
type Inspect = { checks: string[]; streams: { name: string; columns: { pii: string | null }[] }[] };

export function AirbyteLogo({ src, size = 22 }: { src?: string; size?: number }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <Icon name="plug" size={size} />;
  return <img src={src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" style={{ flex: "none", objectFit: "contain" }} onError={() => setBad(true)} />;
}

const typesOf = (p: JsonSchema) => (Array.isArray(p.type) ? p.type : [p.type]);
/** A value that can't be expressed as a simple field, edited as JSON. */
function JsonField({ label, hint, value, onChange }: { label: string; hint?: string; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value, null, 1)), [bad, setBad] = useState(false);
  return <Field label={label} hint={hint} error={bad ? "This isn't valid JSON." : undefined}><textarea className="input mono" rows={4} spellCheck={false} value={text} onChange={(e) => { setText(e.target.value); try { onChange(e.target.value.trim() ? JSON.parse(e.target.value) : undefined); setBad(false); } catch { setBad(true); } }} /></Field>;
}

export function SchemaFields({ schema, value, onChange }: { schema: JsonSchema; value: ConfigValue; onChange: (v: ConfigValue) => void }) {
  return <>{orderedProps(schema).map(([key, p]) => {
    const cur = value[key], set = (v: unknown) => { const n = { ...value }; if (v === undefined || v === "") delete n[key]; else n[key] = v; onChange(n); };
    const need = schema.required?.includes(key), label = `${p.title ?? key}${need ? "" : " (optional)"}`, hint = plainText(p.description)?.slice(0, 280);
    const options = p.oneOf ?? p.anyOf, types = typesOf(p);
    if (p.const !== undefined) return null;
    if (options?.length && options.every((o) => o.properties) && discriminator(options)) {
      const chosen = optionFor(options, cur as ConfigValue | undefined), idx = String(options.indexOf(chosen));
      return <div key={key} style={{ display: "grid", gap: 12 }}>
        <Field label={label} hint={hint}><Sel options={[...(need ? [] : [["", "Not set"] as [string, string]]), ...options.map((o, i): [string, string] => [String(i), o.title ?? `Option ${i + 1}`])]} value={cur === undefined && !need ? "" : idx} onChange={(v) => set(v === "" ? undefined : initialConfig(options[Number(v)]))} /></Field>
        {(cur !== undefined || need) && <div style={{ display: "grid", gap: 12, paddingLeft: 12, borderLeft: "1px solid var(--line-2)" }}><SchemaFields schema={chosen} value={(cur ?? {}) as ConfigValue} onChange={set} /></div>}
      </div>;
    }
    if (p.properties) return <div key={key} style={{ display: "grid", gap: 12, paddingLeft: 12, borderLeft: "1px solid var(--line-2)" }}><span className="lab">{label}</span><SchemaFields schema={p} value={(cur ?? {}) as ConfigValue} onChange={set} /></div>;
    if (types.includes("boolean")) return <label key={key} className="check"><input type="checkbox" checked={!!cur} onChange={(e) => set(e.target.checked)} />{p.title ?? key}</label>;
    if (p.enum?.length) return <Field key={key} label={label} hint={hint}><Sel options={[...(need ? [] : [["", "Not set"] as [string, string]]), ...p.enum.map((e): [string, string] => [String(e), String(e)])]} value={String(cur ?? "")} onChange={(v) => set(types.includes("integer") || types.includes("number") ? Number(v) : v)} /></Field>;
    if (types.includes("integer") || types.includes("number")) return <Field key={key} label={label} hint={hint}><input className="input" type="number" value={cur == null ? "" : String(cur)} onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))} /></Field>;
    if (types.includes("array") && (p.items?.type === "string" || !p.items)) return <Field key={key} label={label} hint={hint ?? "Separate values with commas"}><input className="input" value={Array.isArray(cur) ? cur.join(", ") : ""} onChange={(e) => set(e.target.value.trim() ? e.target.value.split(",").map((s) => s.trimStart()) : undefined)} /></Field>;
    if (types.includes("string") && !options) {
      const place = p.examples?.[0] !== undefined ? String(p.examples[0]) : p.pattern_descriptor;
      if (p.multiline) return <Field key={key} label={label} hint={hint}><textarea className="input mono" rows={5} spellCheck={false} placeholder={place} value={String(cur ?? "")} onChange={(e) => set(e.target.value)} /></Field>;
      return <Field key={key} label={label} hint={hint}><input className="input" type={p.airbyte_secret ? "password" : "text"} autoComplete={p.airbyte_secret ? "new-password" : "off"} placeholder={p.airbyte_secret ? undefined : place} value={String(cur ?? "")} onChange={(e) => set(e.target.value)} /></Field>;
    }
    return <JsonField key={key} label={label} hint={hint} value={cur} onChange={set} />;
  })}</>;
}

/** The connection form, generated from the connector's own spec. Settings go to the server only; nothing is read back from it. */
export function AddAirbyte({ entry, onClose }: { entry: AirbyteEntry; onClose: () => void }) {
  const [spec, setSpec] = useState<Spec | null>(null), [config, setConfig] = useState<ConfigValue>({}), [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "testing" | "saving">("idle"), [error, setError] = useState(""), [result, setResult] = useState<Inspect | null>(null);
  useEffect(() => { call<Spec>(`/api/connections/airbyte?spec=${encodeURIComponent(entry.id)}`).then((s) => { setSpec(s); setConfig(initialConfig(s.schema)); }, (e) => setError(e.message)); }, [entry.id]);
  const body = { type: "airbyte", definitionId: entry.id, name: name || entry.name, config };
  const missing = spec ? missingFields(spec.schema, config) : [];
  const edit = (v: ConfigValue) => { setConfig(v); setResult(null); };
  const test = async () => {
    setState("testing"); setError(""); setResult(null);
    try { setResult(await call<Inspect>("/api/connections", { json: { ...body, action: "test" } })); } catch (e) { setError((e as Error).message); }
    setState("idle");
  };
  const save = async () => {
    setState("saving"); setError("");
    try { const r = await call<{ pipeline: { id: string } }>("/api/connections", { json: body }); await useApp.getState().load(); window.location.assign(`/pipelines?p=${r.pipeline.id}`); }
    catch (e) { setError((e as Error).message); setState("idle"); }
  };
  const pii = result?.streams.reduce((a, s) => a + s.columns.filter((c) => c.pii).length, 0) ?? 0;
  return (
    <Modal full title={`Connect ${entry.name}`} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn onClick={test} disabled={state !== "idle" || !spec || missing.length > 0}>{state === "testing" ? <><Spinner />Installing and testing</> : "Test connection"}</Btn><Btn variant="primary" onClick={save} disabled={!result || state !== "idle"}>{state === "saving" ? <><Spinner />Saving</> : "Save and set up pipeline"}</Btn></>}>
      <div className="banner info"><Icon name="info" /><span>{entry.repo} version {entry.version}, licence {licenseName(entry.license)}. Testing installs and runs this third-party connector on this server, and is recorded in the audit log. The settings are encrypted and never shown again.{entry.docs && <> <a className="plain-link" href={entry.docs} target="_blank" rel="noreferrer">Airbyte&apos;s setup guide</a></>}</span></div>
      <Field label="Connection name" hint="Shown in Basalt and used to name the copied schema"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={entry.name} /></Field>
      {spec ? <SchemaFields schema={spec.schema} value={config} onChange={edit} /> : !error && <p className="small muted"><Spinner /> Loading the settings</p>}
      {missing.length > 0 && <p className="small muted">Still needed: {missing.join(", ")}.</p>}
      {error && <div className="banner bad" role="alert"><Icon name="warn" /><span>{error}</span></div>}
      {result && <div style={{ display: "grid", gap: 4 }}>
        {result.checks.map((c) => <div key={c} className="banner good"><Icon name="check" />{c}</div>)}
        <div className="banner info"><Icon name="table" />Found {result.streams.length} streams. {pii} columns look like personal data by name, and values are checked on each sync before anything is copied.</div>
      </div>}
    </Modal>
  );
}
