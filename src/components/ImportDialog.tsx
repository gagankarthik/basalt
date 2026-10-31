"use client";
import { useRef, useState } from "react";
import { Icon } from "./icons";
import { Btn, Field, Modal, Sel, Spinner, toast } from "./ui";
import { call, fmt, refreshTables, useApp } from "@/lib/client";
import { cellText } from "@/lib/nested";
import { prettyField } from "@/lib/sql";
import type { Run } from "@/lib/types";

type PreviewCol = { name: string; type: string; pii: string | null; nested: boolean; children: string[] };
type Preview = { columns: PreviewCol[]; rows: Record<string, unknown>[]; total: number };
type Target = { name: string; to: string; type: string; include: boolean; pii: string | null; flatten: boolean };
const TYPES: [string, string][] = [["", "Detected"], ["VARCHAR", "Text"], ["BIGINT", "Whole number"], ["DOUBLE", "Decimal"], ["BOOLEAN", "Yes or no"], ["DATE", "Date"], ["TIMESTAMP", "Date and time"], ["JSON", "JSON"]];
const friendlyType = (t: string) => (/^JSON$/.test(t) ? "JSON" : /^STRUCT|^MAP/.test(t) ? "Nested" : /\[\d*\]$/.test(t) ? "List" : /INT/.test(t) ? "Whole number" : /DOUBLE|DECIMAL|FLOAT/.test(t) ? "Decimal" : /BOOL/.test(t) ? "Yes or no" : t === "DATE" ? "Date" : /TIME/.test(t) ? "Date and time" : "Text");
const fieldKey = (s: string) => s.trim().toLowerCase().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
const MAX_MB = 500, MAX_XML_MB = 100;

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null), [header, setHeader] = useState(true), [preview, setPreview] = useState<Preview | null>(null), [fields, setFields] = useState<Target[]>([]), [name, setName] = useState("");
  const [busy, setBusy] = useState<"" | "reading" | "importing">(""), [error, setError] = useState(""), [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const isCsv = !!file && /\.(csv|tsv)$/i.test(file.name);

  const read = async (fl: File, hasHeader = header) => {
    if (fl.size > MAX_MB * 1024 * 1024) { setError(`This file is larger than ${MAX_MB} MB. Split it, or load it through a database connection.`); return; }
    if (/\.xml$/i.test(fl.name) && fl.size > MAX_XML_MB * 1024 * 1024) { setError(`XML files can be up to ${MAX_XML_MB} MB, because they're read into memory. Split this file, or convert it to JSON lines, which can be up to ${MAX_MB} MB.`); return; }
    setFile(fl); setBusy("reading"); setError(""); setPreview(null);
    const fd = new FormData(); fd.append("file", fl); fd.append("mode", "preview"); fd.append("header", String(hasHeader));
    try {
      const p = await call<Preview>("/api/connections", { method: "POST", body: fd });
      setPreview(p);
      setFields(p.columns.map((c) => ({ name: c.name, to: fieldKey(c.name) || c.name, type: "", include: true, pii: c.pii, flatten: c.children.length > 0 && /\.xml$/i.test(fl.name) })));
      setName((n) => n || prettyField(fl.name.replace(/\.[^.]+$/, "")));
    } catch (e) { setError((e as Error).message); }
    setBusy("");
  };
  const up = (i: number, p: Partial<Target>) => setFields((f) => f.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const kept = fields.filter((f) => f.include), keys = kept.map((f) => f.to);
  const problem = !kept.length ? "Keep at least one field." : keys.some((k) => !/^[A-Za-z_]\w*$/.test(k)) ? "Field names need letters, numbers and underscores, and can't start with a number." : new Set(keys).size !== keys.length ? "Two fields have the same name." : !name.trim() ? "Name this import." : "";
  const doImport = async () => {
    if (!file || problem) return;
    setBusy("importing"); setError("");
    const fd = new FormData(); fd.append("file", file); fd.append("name", name.trim()); fd.append("header", String(header));
    fd.append("fields", JSON.stringify(kept.map((f) => ({ name: f.name, to: f.to, type: f.flatten ? "" : f.type, flatten: f.flatten }))));
    try {
      const r = await call<{ pipeline: { id: string }; connection: { slug: string }; table: string; conversionIssues: number }>("/api/connections", { method: "POST", body: fd });
      const run = await call<Run>("/api/runs", { json: { kind: "sync", id: r.pipeline.id } });
      await useApp.getState().load(); await refreshTables();
      const held = run.streams?.flatMap((s) => s.heldBack) ?? [];
      if (r.conversionIssues) toast(`${fmt(r.conversionIssues)} values couldn't be converted and were left empty.`, true);
      if (held.length) toast(`Held back as personal data until you choose a rule: ${held.join(", ")}.`);
      window.location.assign(`/explore?table=${encodeURIComponent(`raw_${r.connection.slug}.${r.table}`)}`);
    } catch (e) { setError((e as Error).message); setBusy(""); }
  };

  return (
    <Modal full wide title="Import data" onClose={onClose} foot={preview ? <>{problem && <span className="err small grow">{problem}</span>}<Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" disabled={!!busy || !!problem} onClick={doImport}>{busy === "importing" ? <><Spinner />Importing</> : `Import ${fmt(preview.total)} rows`}</Btn></> : undefined}>
      {!preview && <button type="button" className={`drop ${over ? "over" : ""}`} disabled={busy === "reading"} onClick={() => input.current?.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void read(f); }}>
        {busy === "reading" ? <Spinner /> : <Icon name="upload" size={26} />}<b>{busy === "reading" ? `Reading ${file?.name}` : "Drop a file here, or click to choose"}</b><small>CSV, TSV, JSON, Parquet, Avro, YAML, Excel or XML, up to {MAX_MB} MB. XML up to {MAX_XML_MB} MB</small>
      </button>}
      <input ref={input} type="file" hidden accept=".csv,.tsv,.json,.jsonl,.ndjson,.parquet,.avro,.yaml,.yml,.xlsx,.xml" aria-label="Choose a data file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }} />
      {error && <div className="banner bad" role="alert"><Icon name="warn" />{error}</div>}
      {preview && <>
        <div className="form-row"><Field label="Import name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="field"><span className="lab">File</span><div className="small" style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32 }}><Icon name="file" /><span style={{ overflowWrap: "anywhere" }}>{file?.name}</span><button type="button" className="link small" onClick={() => { setPreview(null); setFile(null); }}>Change</button></div>
            {isCsv && <label className="check small"><input type="checkbox" checked={header} onChange={(e) => { setHeader(e.target.checked); if (file) void read(file, e.target.checked); }} />First row has field names</label>}</div></div>
        <h3>Fields</h3>
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th style={{ width: 40 }}>Keep</th><th>In your file</th><th>Field name</th><th>Type</th><th>Nested data</th><th>Sample values</th></tr></thead><tbody>
          {fields.map((f, i) => { const col = preview.columns[i]; return <tr key={f.name} style={{ opacity: f.include ? 1 : 0.5 }}>
            <td><input type="checkbox" aria-label={`Keep ${f.name}`} checked={f.include} onChange={(e) => up(i, { include: e.target.checked })} /></td>
            <td><span className="mono small">{f.name}</span>{f.pii && <div><span className="badge warn"><Icon name="shield" size={12} />{f.pii}</span></div>}</td>
            <td><input className="input mono" aria-label={`Field name for ${f.name}`} value={f.to} disabled={!f.include} onChange={(e) => up(i, { to: e.target.value })} /></td>
            <td><Sel aria-label={`Type for ${f.name}`} value={f.type} disabled={!f.include || f.flatten} onChange={(v) => up(i, { type: v })} options={TYPES.map(([v, l]): [string, string] => [v, v ? l : `${l}: ${friendlyType(col.type)}`])} /></td>
            <td>{col.nested && col.children.length > 0 && <Sel aria-label={`Nested data in ${f.name}`} value={f.flatten ? "flatten" : "keep"} disabled={!f.include} onChange={(v) => up(i, { flatten: v === "flatten" })} options={[["keep", "Keep as JSON"], ["flatten", "Flatten into columns"]]} />}</td>
            <td className="small muted mono" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.flatten ? col.children.map((c) => `${f.to}_${c}`).join(", ") : preview.rows.slice(0, 3).map((r) => r[f.name]).filter((v) => v != null).map(cellText).join(", ")}</td>
          </tr>; })}
        </tbody></table></div>
        <p className="small muted">The file is stored on this server. Fields flagged as personal data stay out of the warehouse until you choose a rule.</p>
      </>}
    </Modal>
  );
}
