"use client";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ApiSheet, Extensions, Interfaces, SnapshotSheet, SyncSheet, Timeline } from "./BaseExtras";
import { Icon, type IconName } from "./icons";
import { Btn, Empty, ErrorState, Field as FormField, LoadingTable, Modal, NoResults, Pop, Sel, Split, toast, SplitToggle, Upload } from "./ui";
import { applyOp, CHOICE_COLORS, compute, recById, isComputed, newTable, newView, ROLLUPS, summarize, TYPE_LABEL, viewRecords, type Attachment, type Automation, type Base, type BaseFilter, type BaseView, type Choice, type Computed, type Field, type FieldType, type FilterOp, type Op, type Rec, type Table, type ViewType } from "@/lib/base";
import { call, useApp, when } from "@/lib/client";
import { FORMULA_FUNCTIONS, parseFormula } from "@/lib/formula";

const uid = () => crypto.randomUUID();
const FIELD_ICON: Record<FieldType, IconName> = { text: "text", longText: "text", number: "fieldNumber", currency: "fieldNumber", percent: "fieldNumber", duration: "clock", rating: "metric", attachment: "file", button: "link", barcode: "barcode", checkbox: "fieldBool", select: "chevDown", multiSelect: "menu", date: "fieldDate", email: "text", url: "link", phone: "text", user: "people", link: "link", lookup: "search", rollup: "stacked", count: "fieldNumber", formula: "code", autonumber: "fieldNumber", createdTime: "clock", modifiedTime: "clock", createdBy: "people", modifiedBy: "people" };
const FIELD_GROUPS: [string, FieldType[]][] = [["Basic", ["text", "longText", "number", "currency", "percent", "duration", "rating", "checkbox", "date", "email", "url", "phone", "barcode", "attachment", "button"]], ["Choices and people", ["select", "multiSelect", "user"]], ["Relationships", ["link", "lookup", "rollup", "count"]], ["Computed", ["formula", "autonumber", "createdTime", "modifiedTime", "createdBy", "modifiedBy"]]];
const VIEW_TYPES: [ViewType, string, IconName][] = [["grid", "Grid", "table"], ["kanban", "Kanban", "board"], ["gallery", "Gallery", "grid"], ["calendar", "Calendar", "fieldDate"], ["timeline", "Timeline", "flow"], ["form", "Form", "file"]];
const HEIGHTS: [NonNullable<BaseView["rowHeight"]>, string, number][] = [["short", "Short", 36], ["medium", "Medium", 60], ["tall", "Tall", 88], ["extra", "Extra tall", 128]];
const FILTER_OPS: [FilterOp, string][] = [["contains", "contains"], ["notContains", "does not contain"], ["is", "is"], ["isNot", "is not"], ["anyOf", "is any of"], ["gt", "is more than"], ["gte", "is at least"], ["lt", "is less than"], ["lte", "is at most"], ["empty", "is empty"], ["notEmpty", "is not empty"]];
const SUMMARY: [string, string][] = [["", "None"], ["filled", "Filled"], ["empty", "Empty"], ["unique", "Unique"], ["sum", "Sum"], ["avg", "Average"], ["min", "Lowest"], ["max", "Highest"]];

type Ctx = { base: Base; table: Table; view: BaseView; eng: Computed; send: (ops: Op | Op[], undo?: Op[]) => void; editable: boolean; people: string[]; open: (r: Rec) => void };
const fileUrl = (base: string, a: Attachment) => `/api/bases/files?base=${encodeURIComponent(base)}&id=${encodeURIComponent(a.id)}&type=${encodeURIComponent(a.type)}&name=${encodeURIComponent(a.name)}`;
const isErr = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && "error" in (v as object);

function Chip({ c }: { c?: Choice }) { return c ? <span className={`bx-chip c-${c.color}`}>{c.name}</span> : null; }

/** Shows a value. The same view is used in the grid, cards, the record sheet and the form preview. */
function CellView({ c, r, f }: { c: Ctx; r: Rec; f: Field }) {
  const v = c.eng.value(r, f);
  if (isErr(v)) return <span className="bx-err" title={(v as { error: string }).error}><Icon name="warn" size={14} />#ERROR</span>;
  switch (f.type) {
    case "checkbox": return <button type="button" role="checkbox" aria-checked={!!v} aria-label={f.name} disabled={!c.editable} className={`bx-check ${v ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); c.send({ kind: "setCells", table: c.table.id, updates: [{ id: r.id, cells: { [f.id]: !v } }] }, [{ kind: "setCells", table: c.table.id, updates: [{ id: r.id, cells: { [f.id]: !!v } }] }]); }}>{!!v && <Icon name="check" size={13} />}</button>;
    case "attachment": return <span className="bx-chips">{((v as Attachment[]) ?? []).map((a) => { const src = fileUrl(c.base.id, a); return /^image\//.test(a.type) ? <a key={a.id} href={src} target="_blank" rel="noopener noreferrer" title={a.name} onClick={(e) => e.stopPropagation()}><img className="bx-thumb" src={src} alt={a.name} /></a> : <a key={a.id} className="bx-link" href={src} onClick={(e) => e.stopPropagation()}>{a.name}</a>; })}</span>;
    case "button": { const raw = (f.url ?? "").replace(/\{([^}]+)\}/g, (all, n) => { const x = c.table.fields.find((y) => y.name.toLowerCase() === String(n).toLowerCase()); return x ? encodeURIComponent(c.eng.display(r, x)) : all; }); return /^https?:\/\//i.test(raw) ? <a className="btn" href={raw} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{f.label || f.name}</a> : <span className="muted small">Set a web address</span>; }
    case "select": return <Chip c={f.choices?.find((x) => x.id === v)} />;
    case "multiSelect": return <span className="bx-chips">{((v as string[]) ?? []).map((id) => <Chip key={id} c={f.choices?.find((x) => x.id === id)} />)}</span>;
    case "link": { const o = c.base.tables.find((x) => x.id === f.linkTable), e = o && c.eng.other(o.id); return <span className="bx-chips">{((v as string[]) ?? []).map((id) => { const x = o && recById(o, id); return x && e ? <span key={id} className="bx-link">{e.title(x)}</span> : null; })}</span>; }
    case "lookup": return <span className="bx-chips">{((v as unknown[]) ?? []).map((x, i) => <span key={i} className="bx-link">{String(x ?? "")}</span>)}</span>;
    case "rating": return <span className="bx-rating" aria-label={`${v ?? 0} of ${f.max ?? 5}`}>{Array.from({ length: f.max ?? 5 }, (_, i) => <button type="button" key={i} tabIndex={-1} disabled={!c.editable} className={i < Number(v ?? 0) ? "on" : ""} onClick={(e) => { e.stopPropagation(); c.send({ kind: "setCells", table: c.table.id, updates: [{ id: r.id, cells: { [f.id]: i + 1 === v ? null : i + 1 } }] }); }}>★</button>)}</span>;
    case "url": return v ? <a className="link" href={/^https?:/i.test(String(v)) ? String(v) : `https://${v}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{String(v)}</a> : null;
    case "email": return v ? <a className="link" href={`mailto:${v}`} onClick={(e) => e.stopPropagation()}>{String(v)}</a> : null;
    case "phone": return v ? <a className="link" href={`tel:${v}`} onClick={(e) => e.stopPropagation()}>{String(v)}</a> : null;
    case "user": case "createdBy": case "modifiedBy": return v ? <span className="bx-link">{String(v)}</span> : null;
    default: return <>{c.eng.display(r, f)}</>;
  }
}

/** Edits a value. Choosing an option saves at once; typing saves on Enter or when focus leaves. */
function CellEdit({ c, r, f, seed, done, inline }: { c: Ctx; r: Rec; f: Field; seed?: string; done: (move?: "down" | "right") => void; inline?: boolean }) {
  const raw = r.cells[f.id], [q, setQ] = useState("");
  const startText = seed ?? (f.type === "date" ? String(raw ?? "").slice(0, f.includeTime ? 16 : 10) : raw == null ? "" : String(raw));
  const [val, setVal] = useState(startText);
  const write = (v: unknown) => c.send({ kind: "setCells", table: c.table.id, updates: [{ id: r.id, cells: { [f.id]: v } }] }, [{ kind: "setCells", table: c.table.id, updates: [{ id: r.id, cells: { [f.id]: raw ?? null } }] }]);
  const key = (e: React.KeyboardEvent, area?: boolean) => {
    e.stopPropagation();
    if (e.key === "Escape") done();
    if (e.key === "Enter" && (!area || !e.shiftKey)) { e.preventDefault(); if (val !== startText || seed !== undefined) write(val); done("down"); }
    if (e.key === "Tab") { e.preventDefault(); if (val !== startText || seed !== undefined) write(val); done("right"); }
  };
  const blur = () => { if (val !== startText || seed !== undefined) write(val); if (!inline) done(); };
  if (f.type === "select" || f.type === "multiSelect" || f.type === "user" || f.type === "link") {
    const multi = f.type === "multiSelect" || f.type === "link";
    const o = f.type === "link" ? c.base.tables.find((x) => x.id === f.linkTable) : undefined, e = o ? c.eng.other(o.id) : undefined;
    const opts: { id: string; label: string; color?: string }[] = f.type === "link" ? (o?.records ?? []).map((x) => ({ id: x.id, label: e!.title(x) })) : f.type === "user" ? c.people.map((p) => ({ id: p, label: p })) : (f.choices ?? []).map((x) => ({ id: x.id, label: x.name, color: x.color }));
    const cur = multi ? ((raw as string[]) ?? []) : raw ? [String(raw)] : [], shown = opts.filter((x) => x.label.toLowerCase().includes(q.toLowerCase())).slice(0, 100);
    const pick = (id: string) => { write(multi ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : cur[0] === id ? null : id); if (!multi && !inline) done(); };
    return <div className="bx-pick" onClick={(ev) => ev.stopPropagation()}>
      <input className="input" autoFocus={!inline} placeholder={`Find ${f.type === "link" ? "a record" : "an option"}`} aria-label={`Find an option for ${f.name}`} value={q} onChange={(ev) => setQ(ev.target.value)} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Escape") done(); if (ev.key === "Enter" && shown[0]) { ev.preventDefault(); pick(shown[0].id); } }} />
      <div className="bx-pick-list">{shown.map((x) => <button type="button" key={x.id} className={cur.includes(x.id) ? "on" : ""} onClick={() => pick(x.id)}>{x.color ? <span className={`bx-chip c-${x.color}`}>{x.label}</span> : <span>{x.label}</span>}{cur.includes(x.id) && <Icon name="check" size={14} />}</button>)}{!shown.length && <p className="muted small">No options match.</p>}</div>
      {!inline && multi && <Btn onClick={() => done()}>Done</Btn>}
    </div>;
  }
  if (f.type === "attachment") {
    const list = (raw as Attachment[]) ?? [];
    const upload = async (files: FileList) => { const out = [...list]; for (const file of Array.from(files)) { const form = new FormData(); form.append("file", file); form.append("base", c.base.id); try { out.push(await call<Attachment>("/api/bases/files", { method: "POST", body: form })); } catch (e) { toast((e as Error).message, true); } } write(out); };
    return <div className="bx-pick" onClick={(ev) => ev.stopPropagation()}>{list.map((a) => <div key={a.id} className="bx-row bx-file"><span>{a.name}</span><Btn icon="x" variant="ghost" aria-label={`Remove ${a.name}`} onClick={() => write(list.filter((x) => x.id !== a.id))} /></div>)}<Upload label="Attach files" ariaLabel={`Attach files to ${f.name}`} multiple onFiles={(files) => void upload(files)} />{!inline && <Btn onClick={() => done()}>Done</Btn>}</div>;
  }
  if (f.type === "barcode") return <BarcodeEdit value={val} set={setVal} onKey={key} blur={blur} name={f.name} scan={(code) => { write(code); done(); }} />;
  if (f.type === "longText") return <textarea className="input bx-edit" autoFocus={!inline} rows={inline ? 3 : 5} aria-label={f.name} value={val} onChange={(e) => setVal(e.target.value)} onBlur={blur} onKeyDown={(e) => key(e, true)} />;
  const type = f.type === "date" ? (f.includeTime ? "datetime-local" : "date") : ["number", "currency", "percent", "duration", "rating"].includes(f.type) && seed === undefined ? "number" : f.type === "email" ? "email" : f.type === "url" ? "url" : "text";
  return <input className="input bx-edit" autoFocus={!inline} type={type} aria-label={f.name} value={val} onChange={(e) => setVal(e.target.value)} onBlur={blur} onKeyDown={key} />;
}

/** A USB scanner types like a keyboard. Cameras need the browser's BarcodeDetector, which not every browser has. */
function BarcodeEdit({ value, set, onKey, blur, name, scan }: { value: string; set: (v: string) => void; onKey: (e: React.KeyboardEvent) => void; blur: () => void; name: string; scan: (code: string) => void }) {
  const [cam, setCam] = useState(false), video = useRef<HTMLVideoElement>(null), [err, setErr] = useState("");
  const can = typeof window !== "undefined" && "BarcodeDetector" in window;
  useEffect(() => {
    if (!cam) return;
    let live = true, stream: MediaStream | undefined;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!live || !video.current) return;
        video.current.srcObject = stream; await video.current.play();
        const det = new (window as unknown as { BarcodeDetector: new () => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector();
        while (live) { const hit = await det.detect(video.current); if (hit[0]) { scan(hit[0].rawValue); return; } await new Promise((r) => setTimeout(r, 200)); }
      } catch { if (live) setErr("The camera couldn't start. Allow camera access, or type the code."); }
    })();
    return () => { live = false; stream?.getTracks().forEach((t) => t.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam]);
  return <div className="bx-pick" onClick={(e) => e.stopPropagation()}><input className="input" autoFocus aria-label={name} value={value} onChange={(e) => set(e.target.value)} onBlur={() => { if (!cam) blur(); }} onKeyDown={onKey} />{can && <Btn icon="barcode" onMouseDown={(e) => e.preventDefault()} onClick={() => setCam(!cam)}>{cam ? "Stop scanning" : "Scan with camera"}</Btn>}{cam && <video ref={video} className="bx-video" muted playsInline />}{err && <p className="err small">{err}</p>}</div>;
}

function FieldSheet({ c, field, onClose }: { c: Ctx; field?: Field; onClose: () => void }) {
  const others = c.base.tables.filter((t) => t.id !== c.table.id), links = c.table.fields.filter((x) => x.type === "link");
  const [f, setF] = useState<Field>(field ?? { id: uid(), name: "", type: "text", choices: [] }), [err, setErr] = useState(""), [tried, setTried] = useState(false);
  const set = (p: Partial<Field>) => setF({ ...f, ...p });
  const through = c.base.tables.find((t) => t.id === links.find((l) => l.id === f.viaField)?.linkTable);
  let formulaErr = "";
  if (f.type === "formula") { try { parseFormula(f.expr ?? ""); } catch (e) { formulaErr = (e as Error).message; } }
  const nameErr = !f.name.trim() ? "Name this field." : c.table.fields.some((x) => x.id !== f.id && x.name.toLowerCase() === f.name.trim().toLowerCase()) ? "A field with this name already exists." : "";
  const save = () => {
    setTried(true);
    if (nameErr || formulaErr) return;
    if (f.type === "link" && !f.linkTable) return setErr("Choose a table to link to.");
    if ((f.type === "lookup" || f.type === "rollup") && (!f.viaField || !f.readField)) return setErr("Choose the link and the field to read.");
    if (f.type === "count" && !f.viaField) return setErr("Choose the link to count.");
    const clean = { ...f, name: f.name.trim(), choices: f.choices?.filter((x) => x.name.trim()) };
    try {
      if (field) { const { id: _id, ...patch } = clean; void _id; c.send({ kind: "updateField", table: c.table.id, id: f.id, patch }); }
      else c.send({ kind: "addField", table: c.table.id, field: clean, inverseId: uid(), inverseName: c.table.name });
      onClose();
    } catch (e) { setErr((e as Error).message); }
  };
  return <Modal sheet title={field ? `Edit ${field.name}` : "Add a field"} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={save}>{field ? "Save field" : "Create field"}</Btn></>}>
    <FormField label="Field name" error={tried ? nameErr || undefined : undefined}><input className="input" autoFocus value={f.name} onChange={(e) => set({ name: e.target.value })} /></FormField>
    <label className="field"><span className="lab">Field type</span><Sel value={f.type} disabled={field?.type === "link"} onChange={(v) => set({ type: v as FieldType })} options={FIELD_GROUPS.map(([g, ts]) => ({ group: g, options: ts.map((t): [string, string] => [t, TYPE_LABEL[t]]) }))} /></label>
    {(f.type === "select" || f.type === "multiSelect") && <div className="field"><span className="lab">Options</span><div className="bx-choices">
      {(f.choices ?? []).map((ch, i) => <div key={ch.id}><Sel aria-label={`Color for option ${i + 1}`} value={ch.color} onChange={(v) => set({ choices: f.choices!.map((x) => (x.id === ch.id ? { ...x, color: v } : x)) })} options={CHOICE_COLORS} /><input className="input" aria-label={`Option ${i + 1}`} value={ch.name} onChange={(e) => set({ choices: f.choices!.map((x) => (x.id === ch.id ? { ...x, name: e.target.value } : x)) })} /><Btn icon="x" variant="ghost" aria-label={`Remove option ${i + 1}`} onClick={() => set({ choices: f.choices!.filter((x) => x.id !== ch.id) })} /></div>)}
      <div><Btn icon="plus" onClick={() => set({ choices: [...(f.choices ?? []), { id: uid(), name: "", color: CHOICE_COLORS[(f.choices?.length ?? 0) % CHOICE_COLORS.length] }] })}>Add option</Btn></div></div></div>}
    {f.type === "currency" && <div className="form-row"><FormField label="Symbol"><input className="input" value={f.symbol ?? "$"} onChange={(e) => set({ symbol: e.target.value })} /></FormField><FormField label="Decimal places"><input className="input" type="number" min={0} max={8} value={f.precision ?? 2} onChange={(e) => set({ precision: Number(e.target.value) })} /></FormField></div>}
    {(f.type === "number" || f.type === "percent") && <FormField label="Decimal places"><input className="input" type="number" min={0} max={8} value={f.precision ?? (f.type === "percent" ? 1 : 0)} onChange={(e) => set({ precision: Number(e.target.value) })} /></FormField>}
    {f.type === "button" && <><FormField label="Button text"><input className="input" value={f.label ?? ""} onChange={(e) => set({ label: e.target.value })} /></FormField><FormField label="Web address" hint="Use {Field name} to include a value, such as https://example.com/orders/{Order}"><input className="input" value={f.url ?? ""} onChange={(e) => set({ url: e.target.value })} /></FormField></>}
    {f.type === "rating" && <FormField label="Highest rating"><input className="input" type="number" min={1} max={10} value={f.max ?? 5} onChange={(e) => set({ max: Math.min(10, Math.max(1, Number(e.target.value))) })} /></FormField>}
    {f.type === "date" && <label className="check"><input type="checkbox" checked={!!f.includeTime} onChange={(e) => set({ includeTime: e.target.checked })} />Include a time</label>}
    {f.type === "link" && !field && (others.length ? <FormField label="Link to" hint="Adds a matching field to that table, so the link works both ways."><Sel options={[["", "Choose a table"], ...others.map((t): [string, string] => [t.id, t.name])]} value={f.linkTable ?? ""} onChange={(v) => set({ linkTable: v })} /></FormField> : <div className="banner info"><Icon name="info" />Add another table first, then link to it.</div>)}
    {["lookup", "rollup", "count"].includes(f.type) && (links.length ? <FormField label="Through this link"><Sel options={[["", "Choose a link field"], ...links.map((l): [string, string] => [l.id, l.name])]} value={f.viaField ?? ""} onChange={(v) => set({ viaField: v, readField: undefined })} /></FormField> : <div className="banner info"><Icon name="info" />Add a link to another record first.</div>)}
    {(f.type === "lookup" || f.type === "rollup") && through && <FormField label="Read this field"><Sel options={[["", "Choose a field"], ...through.fields.map((x): [string, string] => [x.id, x.name])]} value={f.readField ?? ""} onChange={(v) => set({ readField: v })} /></FormField>}
    {f.type === "rollup" && <FormField label="Calculate"><Sel options={ROLLUPS} value={f.rollup ?? "SUM"} onChange={(v) => set({ rollup: v })} /></FormField>}
    {f.type === "formula" && <><FormField label="Formula" error={tried || f.expr ? formulaErr || undefined : undefined} hint="Use field names in braces, such as {Price} * {Quantity}"><textarea className="input mono" rows={4} spellCheck={false} value={f.expr ?? ""} onChange={(e) => set({ expr: e.target.value })} /></FormField>
      <details className="small"><summary>Available functions</summary><p className="muted bx-fns">{FORMULA_FUNCTIONS.join(", ")}</p></details></>}
    {err && <div className="banner bad" role="alert"><Icon name="warn" />{err}</div>}
    <FormField label="Description" hint="Optional. Shown when someone fills in this field."><input className="input" value={f.description ?? ""} onChange={(e) => set({ description: e.target.value })} /></FormField>
  </Modal>;
}

function RecordSheet({ c, r, onClose }: { c: Ctx; r: Rec; onClose: () => void }) {
  const [tab, setTab] = useState<"Fields" | "Comments" | "History">("Fields"), [text, setText] = useState(""), [edit, setEdit] = useState<string | null>(null);
  const send = () => { if (text.trim()) { c.send({ kind: "comment", table: c.table.id, record: r.id, id: uid(), text }); setText(""); } };
  return <Modal sheet title={c.eng.title(r)} onClose={onClose} foot={c.editable ? <Btn variant="danger" icon="trash" onClick={() => { c.send({ kind: "deleteRecords", table: c.table.id, ids: [r.id] }, [{ kind: "restoreRecords", table: c.table.id, records: [r] }]); toast("Record deleted. Press Ctrl+Z to undo."); onClose(); }}>Delete record</Btn> : undefined}>
    <div className="seg bx-tabs" role="tablist">{(["Fields", "Comments", "History"] as const).map((t) => <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}>{t}{t === "Comments" && r.comments.length ? ` (${r.comments.length})` : ""}</button>)}</div>
    {tab === "Fields" && <div className="bx-rec">{c.table.fields.map((f) => { const can = c.editable && !isComputed(f.type) && f.type !== "checkbox" && f.type !== "rating"; const inlinePick = f.type === "select" || f.type === "multiSelect" || f.type === "user" || f.type === "link"; return <div key={f.id} className="bx-rec-f">
      <span className="lab"><Icon name={FIELD_ICON[f.type]} size={14} />{f.name}</span>
      {can && edit === f.id ? <CellEdit c={c} r={r} f={f} done={() => setEdit(null)} /> : <div role={can ? "button" : undefined} tabIndex={can ? 0 : undefined} className={`bx-rec-v ${can ? "can" : ""}`} onClick={() => can && setEdit(f.id)} onKeyDown={(e) => { if (can && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setEdit(f.id); } }} aria-label={can ? `Edit ${f.name}` : undefined}>{c.eng.display(r, f) || f.type === "checkbox" || f.type === "rating" ? <CellView c={c} r={r} f={f} /> : <span className="muted">{can ? (inlinePick ? "Choose" : "Add a value") : ""}</span>}</div>}
      {f.description && <small className="muted">{f.description}</small>}
    </div>; })}<p className="small muted">Created {when(r.createdAt)} by {r.createdBy}. Last changed {when(r.modifiedAt)} by {r.modifiedBy}.</p></div>}
    {tab === "Comments" && <div className="bx-log">{!r.comments.length && <Empty compact icon="text" title="No comments yet">Start the conversation about this record.</Empty>}{r.comments.map((x) => <div key={x.id}><b>{x.by}</b><small className="muted">{when(x.at)}</small><p>{x.text}</p></div>)}
      <textarea className="input" rows={3} placeholder="Add a comment" aria-label="Add a comment" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); }} /><div><Btn variant="primary" disabled={!text.trim()} onClick={send}>Post comment</Btn></div></div>}
    {tab === "History" && <div className="bx-log">{!r.history.length && <Empty compact icon="history" title="No changes yet">Edits to this record appear here.</Empty>}{r.history.map((x, i) => <div key={i}><b>{x.by}</b><small className="muted">{when(x.at)}</small><p>{x.field}: {x.from || "empty"} to {x.to || "empty"}</p></div>)}</div>}
  </Modal>;
}

/** The toolbar's filter editor. Filters narrow the view and never change the records. */
function ViewControls({ c, search, setSearch, onAddRecord, views, onPick }: { c: Ctx; search: string; setSearch: (s: string) => void; onAddRecord: () => void; views: BaseView[]; onPick: (id: string) => void }) {
  const [tools, setTools] = useState(false);
  const { view: v, table: t } = c, up = (patch: Partial<BaseView>) => c.send({ kind: "updateView", table: t.id, id: v.id, patch });
  const hideable = t.fields.slice(1), opts = t.fields.map((f): [string, string] => [f.id, f.name]), dated = t.fields.filter((f) => ["date", "createdTime", "modifiedTime"].includes(f.type)), stack = t.fields.filter((f) => f.type === "select");
  const filter = (id: string, p: Partial<BaseFilter>) => up({ filters: v.filters.map((x) => (x.id === id ? { ...x, ...p } : x)) });
  return <div className="toolbar bx-bar">
    <div className={`bx-tools phone-fold ${tools ? "open" : ""}`}>
      <Btn className="keep fold-btn" icon="filter" aria-expanded={tools} onClick={() => setTools(!tools)}>Options</Btn>
      <span className="keep"><SplitToggle /></span>
      <span className="bx-viewpick"><Pop width={240} trigger={(_, tog) => <Btn icon={VIEW_TYPES.find((x) => x[0] === v.type)![2]} onClick={tog}><span className="bx-vname">{v.name}</span><Icon name="chevDown" size={14} /></Btn>}>{(close) => <div className="menu">{views.map((x) => <button key={x.id} type="button" aria-current={x.id === v.id ? "true" : undefined} onClick={() => { close(); onPick(x.id); }}><Icon name={VIEW_TYPES.find((y) => y[0] === x.type)![2]} />{x.name}</button>)}</div>}</Pop></span>
    {v.type !== "form" && <>
      <i className="bx-sep" aria-hidden="true" />
      <Pop width={620} trigger={(_, tog) => <Btn icon="filter" className={v.filters.length ? "on" : ""} onClick={tog}>{v.filters.length ? `Filter (${v.filters.length})` : "Filter"}</Btn>}><div className="bx-pop">
        {v.filters.length > 1 && <label className="bx-row small">Show records matching <Sel aria-label="Match" value={v.match} onChange={(m) => up({ match: m as "all" })} options={[["all", "all of these"], ["any", "any of these"]]} /></label>}
        {!v.filters.length && <p className="muted small">No filters. Every record is showing.</p>}
        {v.filters.map((x) => <div key={x.id} className="bx-filter"><Sel aria-label="Field" options={opts} value={x.field} onChange={(val) => filter(x.id, { field: val })} /><Sel aria-label="Condition" options={FILTER_OPS} value={x.op} onChange={(val) => filter(x.id, { op: val as FilterOp })} />{x.op !== "empty" && x.op !== "notEmpty" ? <input className="input" aria-label="Value" placeholder="Value" value={x.value ?? ""} onChange={(e) => filter(x.id, { value: e.target.value })} /> : <span />}<Btn icon="x" variant="ghost" aria-label="Remove filter" onClick={() => up({ filters: v.filters.filter((y) => y.id !== x.id) })} /></div>)}
        <div><Btn icon="plus" onClick={() => up({ filters: [...v.filters, { id: uid(), field: t.fields[0].id, op: "contains", value: "" }] })}>Add filter</Btn></div></div></Pop>
      <Pop width={440} trigger={(_, tog) => <Btn icon="sort" className={v.sorts.length ? "on" : ""} onClick={tog}>{v.sorts.length ? `Sort (${v.sorts.length})` : "Sort"}</Btn>}><div className="bx-pop">
        {!v.sorts.length && <p className="muted small">Records are in the order they were added.</p>}
        {v.sorts.map((s, i) => <div key={i} className="bx-sort"><Sel aria-label="Sort field" options={opts} value={s.field} onChange={(val) => up({ sorts: v.sorts.map((y, k) => (k === i ? { ...y, field: val } : y)) })} /><Sel aria-label="Direction" options={[["asc", "First to last"], ["desc", "Last to first"]]} value={s.dir} onChange={(val) => up({ sorts: v.sorts.map((y, k) => (k === i ? { ...y, dir: val as "asc" } : y)) })} /><Btn icon="x" variant="ghost" aria-label="Remove sort" onClick={() => up({ sorts: v.sorts.filter((_, k) => k !== i) })} /></div>)}
        <div><Btn icon="plus" onClick={() => up({ sorts: [...v.sorts, { field: t.fields[0].id, dir: "asc" }] })}>Add sort</Btn></div></div></Pop>
      <i className="bx-sep" aria-hidden="true" />
      {v.type === "grid" && <Sel aria-label="Group by" className={`input ${v.groupBy ? "on" : ""}`} options={[["", "No grouping"], ...opts.map(([a, l]): [string, string] => [a, `Group: ${l}`])]} value={v.groupBy ?? ""} onChange={(val) => up({ groupBy: val || undefined })} />}
      <Pop width={280} trigger={(_, tog) => <Btn icon="eye" className={v.hidden.length ? "on" : ""} onClick={tog}>{v.hidden.length ? `${v.hidden.length} hidden` : "Hide fields"}</Btn>}><div className="bx-pop"><div className="bx-list">{hideable.map((f) => <label key={f.id} className="check"><input type="checkbox" checked={!v.hidden.includes(f.id)} onChange={(e) => up({ hidden: e.target.checked ? v.hidden.filter((x) => x !== f.id) : [...v.hidden, f.id] })} />{f.name}</label>)}</div><div className="bx-row"><Btn onClick={() => up({ hidden: hideable.map((f) => f.id) })}>Hide all</Btn><Btn onClick={() => up({ hidden: [] })}>Show all</Btn></div></div></Pop>
      {v.type === "kanban" && <Sel aria-label="Stack by" options={[["", "Choose a stack field"], ...stack.map((f): [string, string] => [f.id, `Stack: ${f.name}`])]} value={v.stackBy ?? ""} onChange={(val) => up({ stackBy: val || undefined })} />}
      {v.type === "timeline" && <><Sel aria-label="Start date" options={[["", "Choose a start date"], ...dated.map((f): [string, string] => [f.id, `Start: ${f.name}`])]} value={v.dateField ?? ""} onChange={(val) => up({ dateField: val || undefined })} /><Sel aria-label="End date" options={[["", "No end date"], ...dated.map((f): [string, string] => [f.id, `End: ${f.name}`])]} value={v.endField ?? ""} onChange={(val) => up({ endField: val || undefined })} /></>}
      {v.type === "calendar" && <Sel aria-label="Date field" options={[["", "Choose a date field"], ...dated.map((f): [string, string] => [f.id, `Date: ${f.name}`])]} value={v.dateField ?? ""} onChange={(val) => up({ dateField: val || undefined })} />}
      {v.type === "gallery" && <Sel aria-label="Cover image" options={[["", "No cover image"], ...t.fields.filter((f) => f.type === "url" || f.type === "attachment").map((f): [string, string] => [f.id, `Cover: ${f.name}`])]} value={v.coverField ?? ""} onChange={(val) => up({ coverField: val || undefined })} />}
      <input className="input bx-search keep" type="search" placeholder="Find in this view" aria-label="Find in this view" value={search} onChange={(e) => setSearch(e.target.value)} />
    </>}
    </div>
    <div className="bx-acts">
      {v.type !== "form" && (stack.length > 0 || v.type === "grid") && <Pop align="right" width={240} trigger={(_, tog) => <Btn icon="settings" onClick={tog}>Display</Btn>}><div className="bx-pop">
        {stack.length > 0 && <FormField label="Color"><Sel aria-label="Color records" options={[["", "No color"], ...stack.map((f): [string, string] => [f.id, `Color: ${f.name}`])]} value={v.colorBy ?? ""} onChange={(val) => up({ colorBy: val || undefined })} /></FormField>}
        {v.type === "grid" && <FormField label="Row height"><Sel aria-label="Row height" options={HEIGHTS.map(([a, l]): [string, string] => [a, l])} value={v.rowHeight ?? "short"} onChange={(val) => up({ rowHeight: val as BaseView["rowHeight"] })} /></FormField>}
      </div></Pop>}
    {c.editable && v.type !== "form" && t.records.length > 0 && <Btn icon="plus" variant="primary" onClick={onAddRecord}>Add record</Btn>}
    </div>
  </div>;
}

const tone = (c: Ctx, r: Rec) => { const f = c.table.fields.find((x) => x.id === c.view.colorBy); return f?.choices?.find((x) => x.id === r.cells[f.id])?.color; };

/** Sorting and summing every record is too slow to repeat each time a cell is selected. */
function useGridRows(rows: Rec[], eng: Computed, group: Field | undefined, folded: Set<string>, limit: number, summaries: BaseView["summaries"], fields: Field[]) {
  const visible = useMemo(() => (group ? [...rows].sort((a, b) => eng.display(a, group).localeCompare(eng.display(b, group))) : rows), [rows, group, eng]);
  const shown = useMemo(() => (group ? visible.filter((r) => !folded.has(eng.display(r, group))) : visible).slice(0, limit), [visible, group, folded, eng, limit]);
  const groupSizes = useMemo(() => { const n = new Map<string, number>(); if (group) for (const r of visible) { const g = eng.display(r, group); n.set(g, (n.get(g) ?? 0) + 1); } return n; }, [visible, group, eng]);
  const sums = useMemo(() => Object.fromEntries(Object.entries(summaries ?? {}).map(([id, fn]) => { const f = fields.find((x) => x.id === id); return [id, f ? summarize(fn, rows.map((r) => eng.value(r, f))) : ""]; })), [summaries, fields, rows, eng]);
  return { visible, shown, groupSizes, sums };
}

function Grid({ c, rows, addRecord }: { c: Ctx; rows: Rec[]; addRecord: () => void }) {
  const { view: v, table: t } = c, cols = (() => { const order = v.order, rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? 1e6 : i; }; const [first, ...rest] = t.fields; return [first, ...rest.filter((f) => !v.hidden.includes(f.id)).sort((a, b) => rank(a.id) - rank(b.id) || t.fields.indexOf(a) - t.fields.indexOf(b))]; })();
  const [cell, setCell] = useState<{ r: number; c: number } | null>(null), [anchor, setAnchor] = useState<{ r: number; c: number } | null>(null), [editing, setEditing] = useState<{ seed?: string } | null>(null), [limit, setLimit] = useState(200), [picked, setPicked] = useState<Set<string>>(new Set()), [fieldEdit, setFieldEdit] = useState<Field | "new" | null>(null), [folded, setFolded] = useState<Set<string>>(new Set()), [dragField, setDragField] = useState<string | null>(null), [dragOver, setDragOver] = useState<string | null>(null), [fillTo, setFillTo] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null), height = HEIGHTS.find(([h]) => h === (v.rowHeight ?? "short"))![2], frozen = Math.max(1, v.frozen ?? 1);
  const widthOf = (f: Field) => v.widths[f.id] ?? (f === t.fields[0] ? 220 : f.type === "checkbox" ? 90 : f.type === "longText" ? 280 : 170);
  const group = t.fields.find((f) => f.id === v.groupBy);
  const { eng } = c;
  const { visible, shown, groupSizes, sums } = useGridRows(rows, eng, group, folded, limit, v.summaries, t.fields);
  const up = (patch: Partial<BaseView>) => c.send({ kind: "updateView", table: t.id, id: v.id, patch });
  const rect = () => { if (!cell) return null; const a = anchor ?? cell; return { r1: Math.min(a.r, cell.r), r2: Math.max(a.r, cell.r), c1: Math.min(a.c, cell.c), c2: Math.max(a.c, cell.c) }; };
  const inRect = (r: number, k: number) => { const x = rect(); return !!x && r >= x.r1 && r <= x.r2 && k >= x.c1 && k <= x.c2; };
  const move = (dr: number, dc: number, extend = false) => { if (!cell) return; const n = { r: Math.max(0, Math.min(shown.length - 1, cell.r + dr)), c: Math.max(0, Math.min(cols.length - 1, cell.c + dc)) }; if (extend && !anchor) setAnchor(cell); if (!extend) setAnchor(null); setCell(n); };
  useEffect(() => { box.current?.querySelector<HTMLElement>(".bx-cell.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [cell]);
  const editableCell = (f: Field) => c.editable && !isComputed(f.type) && f.type !== "checkbox" && f.type !== "rating";
  const key = async (e: React.KeyboardEvent) => {
    if (editing || !cell) return;
    const r = shown[cell.r], f = cols[cell.c];
    if (!r || !f) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "ArrowDown") { e.preventDefault(); move(1, 0, e.shiftKey); } else if (e.key === "ArrowUp") { e.preventDefault(); move(-1, 0, e.shiftKey); } else if (e.key === "ArrowRight") { e.preventDefault(); move(0, 1, e.shiftKey); } else if (e.key === "ArrowLeft") { e.preventDefault(); move(0, -1, e.shiftKey); } else if (e.key === "Tab") { e.preventDefault(); move(0, e.shiftKey ? -1 : 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (editableCell(f)) setEditing({}); }
    else if (e.key === " " && !e.shiftKey) { e.preventDefault(); if (f.type === "checkbox" && c.editable) c.send({ kind: "setCells", table: t.id, updates: [{ id: r.id, cells: { [f.id]: !r.cells[f.id] } }] }); else c.open(r); }
    else if (e.key === " " && e.shiftKey) { e.preventDefault(); c.open(r); }
    else if ((e.key === "Delete" || e.key === "Backspace") && c.editable) {
      e.preventDefault(); const x = rect()!, updates: { id: string; cells: Record<string, unknown> }[] = [], back: typeof updates = [];
      for (let i = x.r1; i <= x.r2; i++) { const cells: Record<string, unknown> = {}, old: Record<string, unknown> = {}; for (let k = x.c1; k <= x.c2; k++) if (!isComputed(cols[k].type)) { cells[cols[k].id] = null; old[cols[k].id] = shown[i].cells[cols[k].id] ?? null; } updates.push({ id: shown[i].id, cells }); back.push({ id: shown[i].id, cells: old }); }
      c.send({ kind: "setCells", table: t.id, updates }, [{ kind: "setCells", table: t.id, updates: back }]);
    } else if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault(); const x = rect()!, lines: string[] = [];
      for (let i = x.r1; i <= x.r2; i++) { const p: string[] = []; for (let k = x.c1; k <= x.c2; k++) p.push(c.eng.display(shown[i], cols[k]).replace(/[\t\n]/g, " ")); lines.push(p.join("\t")); }
      try { await navigator.clipboard.writeText(lines.join("\n")); toast(`Copied ${(x.r2 - x.r1 + 1) * (x.c2 - x.c1 + 1)} cell${(x.r2 - x.r1 + 1) * (x.c2 - x.c1 + 1) === 1 ? "" : "s"}`); } catch { toast("Your browser blocked copying.", true); }
    } else if (mod && e.key.toLowerCase() === "v" && c.editable) {
      e.preventDefault(); let raw = ""; try { raw = await navigator.clipboard.readText(); } catch { toast("Your browser blocked pasting. Allow clipboard access and try again.", true); return; }
      const grid = raw.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t")), updates: { id: string; cells: Record<string, unknown> }[] = [], back: typeof updates = [], extra: { id: string; cells: Record<string, unknown> }[] = [];
      grid.forEach((line, i) => { const cells: Record<string, unknown> = {}, old: Record<string, unknown> = {}; line.forEach((val, k) => { const col = cols[cell.c + k]; if (col && !isComputed(col.type)) { cells[col.id] = val; const rr = shown[cell.r + i]; if (rr) old[col.id] = rr.cells[col.id] ?? null; } }); const rr = shown[cell.r + i]; if (rr) { updates.push({ id: rr.id, cells }); back.push({ id: rr.id, cells: old }); } else extra.push({ id: uid(), cells }); });
      c.send([...(updates.length ? [{ kind: "setCells" as const, table: t.id, updates }] : []), ...(extra.length ? [{ kind: "addRecords" as const, table: t.id, records: extra }] : [])], [...(updates.length ? [{ kind: "setCells" as const, table: t.id, updates: back }] : []), ...(extra.length ? [{ kind: "deleteRecords" as const, table: t.id, ids: extra.map((x) => x.id) }] : [])]);
      toast(`Pasted ${grid.length} row${grid.length === 1 ? "" : "s"}`);
    } else if (e.key.length === 1 && !mod && !e.altKey && editableCell(f)) { e.preventDefault(); setEditing({ seed: ["select", "multiSelect", "user", "link"].includes(f.type) ? undefined : e.key }); }
  };
  const drag = (e: React.PointerEvent, f: Field) => {
    e.stopPropagation(); e.preventDefault(); const el = e.currentTarget as HTMLElement, sx = e.clientX, w = widthOf(f); let last = w;
    el.setPointerCapture(e.pointerId);
    const th = el.closest("th") as HTMLElement;
    const mv = (m: PointerEvent) => { last = Math.max(80, Math.min(800, w + m.clientX - sx)); th.style.width = th.style.minWidth = `${last}px`; };
    const fin = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", fin); up({ widths: { ...v.widths, [f.id]: last } }); };
    el.addEventListener("pointermove", mv); el.addEventListener("pointerup", fin);
  };
  const lefts = (() => { const out: number[] = []; let x = 64; cols.forEach((f, i) => { out[i] = x; if (i < frozen) x += widthOf(f); }); return out; })();
  const reorder = (i: number, d: number) => { const ids = cols.slice(1).map((x) => x.id), k = i - 1, j = k + d; if (j < 0 || j >= ids.length) return; [ids[k], ids[j]] = [ids[j], ids[k]]; up({ order: ids }); };
  // Copies the cell down, as in a spreadsheet. Dragging from two selected dates or numbers isn't a series here; it repeats the value.
  const startFill = (e: React.PointerEvent, from: number, f: Field) => {
    e.preventDefault(); e.stopPropagation();
    let last = from;
    const move = (m: PointerEvent) => { const tr = document.elementFromPoint(m.clientX, m.clientY)?.closest("tr[data-row]"); if (tr) { last = Math.max(from, Number(tr.getAttribute("data-row"))); setFillTo(last); } };
    const fin = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", fin); setFillTo(null); const val = shown[from].cells[f.id] ?? null, targets = shown.slice(from + 1, last + 1); if (targets.length) { c.send({ kind: "setCells", table: t.id, updates: targets.map((x) => ({ id: x.id, cells: { [f.id]: val } })) }, [{ kind: "setCells", table: t.id, updates: targets.map((x) => ({ id: x.id, cells: { [f.id]: x.cells[f.id] ?? null } })) }]); setCell({ r: last, c: cell!.c }); } };
    addEventListener("pointermove", move); addEventListener("pointerup", fin);
  };
  const del = (ids: string[]) => { const recs = t.records.filter((r) => ids.includes(r.id)); c.send({ kind: "deleteRecords", table: t.id, ids }, [{ kind: "restoreRecords", table: t.id, records: recs }]); setPicked(new Set()); setCell(null); toast(`Deleted ${ids.length} record${ids.length === 1 ? "" : "s"}. Press Ctrl+Z to undo.`); };
  return <>
    {picked.size > 0 && <div className="bx-bulk" role="status"><b>{picked.size} selected</b><Btn onClick={() => setPicked(new Set())}>Clear</Btn>{c.editable && <Btn variant="danger" icon="trash" onClick={() => del([...picked])}>Delete</Btn>}</div>}
    <div className="bx-scroll" ref={box} style={{ scrollPaddingLeft: 64 + cols.slice(0, frozen).reduce((n, f) => n + widthOf(f), 0), scrollPaddingTop: 36, scrollPaddingBottom: 36 }} tabIndex={0} role="grid" aria-rowcount={rows.length} aria-label={`${t.name}, ${v.name}`} onKeyDown={key}>
      <table className={`bx-grid h-${v.rowHeight ?? "short"}`}>
        <thead><tr>
          <th className="bx-num fz" style={{ left: 0 }}><input type="checkbox" aria-label="Select all records" checked={rows.length > 0 && picked.size === rows.length} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
          {cols.map((f, i) => { const sorted = v.sorts.find((s) => s.field === f.id); return <th key={f.id} className={`${i < frozen ? "fz" : ""} ${dragOver === f.id ? "drop" : ""}`} style={{ width: widthOf(f), minWidth: widthOf(f), left: i < frozen ? lefts[i] : undefined }} onDragOver={(e) => { if (dragField && i > 0) { e.preventDefault(); setDragOver(f.id); } }} onDragLeave={() => setDragOver(null)} onDrop={(e) => { e.preventDefault(); setDragOver(null); if (dragField && dragField !== f.id && i > 0) { const ids = cols.slice(1).map((x) => x.id).filter((x) => x !== dragField); ids.splice(ids.indexOf(f.id), 0, dragField); up({ order: ids }); } setDragField(null); }}><div className="bx-th" draggable={i > 0} onDragStart={() => setDragField(f.id)} onDragEnd={() => { setDragField(null); setDragOver(null); }}>
            <Icon name={FIELD_ICON[f.type]} size={14} /><span title={f.description || f.name}>{f.name}</span>{sorted && <Icon name="sort" size={13} />}
            <Pop width={230} align={i > cols.length - 3 ? "right" : "left"} trigger={(_, tog) => <button type="button" className="bx-th-menu" aria-label={`Options for ${f.name}`} onClick={tog}><Icon name="chevDown" size={14} /></button>}>{(close) => <div className="menu">
              {c.editable && <button onClick={() => { close(); setFieldEdit(f); }}><Icon name="edit" />Edit field</button>}
              <button onClick={() => { close(); up({ sorts: [{ field: f.id, dir: "asc" }] }); }}><Icon name="sort" />Sort first to last</button>
              <button onClick={() => { close(); up({ sorts: [{ field: f.id, dir: "desc" }] }); }}><Icon name="sort" />Sort last to first</button>
              <button onClick={() => { close(); up({ filters: [...v.filters, { id: uid(), field: f.id, op: "contains", value: "" }] }); }}><Icon name="filter" />Filter by this field</button>
              <button onClick={() => { close(); up({ groupBy: f.id }); }}><Icon name="board" />Group by this field</button>
              <button onClick={() => { close(); up({ frozen: i + 1 }); }}><Icon name="sidebar" />Freeze up to here</button>
              {i > 1 && <button onClick={() => { close(); reorder(i, -1); }}><Icon name="chevRight" style={{ transform: "rotate(180deg)" }} />Move left</button>}
              {i > 0 && i < cols.length - 1 && <button onClick={() => { close(); reorder(i, 1); }}><Icon name="chevRight" />Move right</button>}
              {i > 0 && <button onClick={() => { close(); up({ hidden: [...v.hidden, f.id] }); }}><Icon name="eye" />Hide field</button>}
              {c.editable && i > 0 && <button onClick={() => { close(); try { c.send({ kind: "deleteField", table: t.id, id: f.id }); } catch (e) { toast((e as Error).message, true); } }}><Icon name="trash" />Delete field</button>}
            </div>}</Pop>
          </div><span className="bx-resize" role="separator" aria-label={`Resize ${f.name}`} onPointerDown={(e) => drag(e, f)} /></th>; })}
          {c.editable && <th className="bx-add"><button type="button" aria-label="Add a field" title="Add a field" onClick={() => setFieldEdit("new")}><Icon name="plus" /></button></th>}
          <th className="bx-fill" />
        </tr></thead>
        <tbody>
          {shown.map((r, rowIndex) => {
            const g = group ? c.eng.display(r, group) : undefined, head = group && (rowIndex === 0 || c.eng.display(shown[rowIndex - 1], group) !== g), col = tone(c, r);
            return [head ? <tr key={`g-${g}`} className="bx-group"><td colSpan={cols.length + 3}><button type="button" aria-expanded={!folded.has(g!)} onClick={() => { const n = new Set(folded); if (n.has(g!)) n.delete(g!); else n.add(g!); setFolded(n); setCell(null); }}><Icon name="chevDown" size={14} /><span className="muted small">{group!.name}</span><b>{g || "Empty"}</b><span className="badge">{groupSizes.get(g!)}</span></button></td></tr> : null,
              <tr key={r.id} data-row={rowIndex} className={`${picked.has(r.id) ? "picked" : ""} ${fillTo != null && cell && rowIndex > cell.r && rowIndex <= fillTo ? "filling" : ""}`} style={{ height }}>
                <td className={`bx-num fz ${col ? `band-${col}` : ""}`} style={{ left: 0 }}><span className="n">{rowIndex + 1}</span><input type="checkbox" aria-label={`Select ${c.eng.title(r)}`} checked={picked.has(r.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(r.id); else n.delete(r.id); setPicked(n); }} /><button type="button" className="bx-open" aria-label={`Open ${c.eng.title(r)}`} onClick={() => c.open(r)}><Icon name="chevRight" size={13} /></button></td>
                {cols.map((f, k) => { const on = cell?.r === rowIndex && cell.c === k; return <td key={f.id} role="gridcell" className={`bx-cell ${on ? "active" : ""} ${inRect(rowIndex, k) ? "ranged" : ""} ${k < frozen ? "fz" : ""} ${isComputed(f.type) ? "comp" : ""} t-${f.type}`} style={k < frozen ? { left: lefts[k] } : undefined}
                  onMouseDown={(e) => { if (e.shiftKey && cell) { if (!anchor) setAnchor(cell); setCell({ r: rowIndex, c: k }); } else { setAnchor(null); if (!(on && editing)) { if (on && editableCell(f)) setEditing({}); else { setCell({ r: rowIndex, c: k }); setEditing(null); } } } }} onDoubleClick={() => { if (editableCell(f)) setEditing({}); else c.open(r); }}>
                  {on && editing ? <div className="bx-editor"><CellEdit c={c} r={r} f={f} seed={editing.seed} done={(m) => { setEditing(null); if (m === "down") move(1, 0); if (m === "right") move(0, 1); box.current?.focus(); }} /></div> : <div className="bx-val"><CellView c={c} r={r} f={f} /></div>}{on && !editing && c.editable && !isComputed(f.type) && <span className="bx-fill-h" role="presentation" title="Drag to fill" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => startFill(e, rowIndex, f)} />}
                </td>; })}
                {c.editable && <td className="bx-add" />}<td className="bx-fill" />
              </tr>];
          })}
          {c.editable && <tr className="bx-addrow"><td className="bx-num fz" style={{ left: 0 }}><button type="button" aria-label="Add a record" onClick={addRecord}><Icon name="plus" size={15} /></button></td><td colSpan={cols.length + 2}><button type="button" onClick={addRecord}>Add record</button></td></tr>}
          <tr className="bx-filler" aria-hidden="true"><td colSpan={cols.length + 3} /></tr>
        </tbody>
        <tfoot><tr><td className="bx-num fz" style={{ left: 0 }} />{cols.map((f, k) => { const s = v.summaries?.[f.id]; return <td key={f.id} className={k < frozen ? "fz" : ""} style={k < frozen ? { left: lefts[k] } : undefined}>
          <label className="bx-sum">{s ? <b>{sums[f.id]}</b> : k === 0 ? <span className="muted">{rows.length.toLocaleString("en-US")} record{rows.length === 1 ? "" : "s"}</span> : null}<Sel className="" aria-label={`Summary for ${f.name}`} value={s ?? ""} onChange={(a) => { const n = { ...(v.summaries ?? {}) }; if (a) n[f.id] = a; else delete n[f.id]; up({ summaries: n }); }} options={SUMMARY} /></label></td>; })}{c.editable && <td className="bx-add" />}<td className="bx-fill" /></tr></tfoot>
      </table>
      {visible.length > limit && <div className="bx-more"><Btn onClick={() => setLimit(limit + 500)}>Show more records</Btn></div>}
    </div>
    {fieldEdit && <FieldSheet c={c} field={fieldEdit === "new" ? undefined : fieldEdit} onClose={() => setFieldEdit(null)} />}
  </>;
}

function Card({ c, r, drag, cover }: { c: Ctx; r: Rec; drag?: boolean; cover?: Field }) {
  const fields = c.table.fields.slice(1).filter((f) => !c.view.hidden.includes(f.id) && f.id !== c.view.stackBy && f.id !== cover?.id && (c.eng.display(r, f) || f.type === "checkbox")).slice(0, 5), col = tone(c, r), att = cover?.type === "attachment" ? ((r.cells[cover.id] as Attachment[]) ?? []).find((a) => /^image\//.test(a.type)) : undefined, src = att ? fileUrl(c.base.id, att) : cover && String(r.cells[cover.id] ?? "");
  return <article className={`bx-card ${col ? `band-${col}` : ""}`} draggable={drag} onDragStart={(e) => { e.dataTransfer.setData("text/plain", r.id); e.dataTransfer.effectAllowed = "move"; }}>
    {cover && (att || /^https?:/i.test(src ?? "") ? <div className="bx-cover" style={{ backgroundImage: `url("${encodeURI(src!)}")` }} role="img" aria-label="" /> : <div className="bx-cover none"><Icon name="grid" size={22} /></div>)}
    <button type="button" className="bx-card-open" onClick={() => c.open(r)}>{c.eng.title(r)}</button>
    {fields.map((f) => <div key={f.id} className="bx-card-f"><small>{f.name}</small><div><CellView c={c} r={r} f={f} /></div></div>)}
  </article>;
}

function Kanban({ c, rows }: { c: Ctx; rows: Rec[] }) {
  const f = c.table.fields.find((x) => x.id === c.view.stackBy), [over, setOver] = useState<string | null>(null);
  if (!f) return <Empty icon="board" title="Choose a field to stack by">Each option in a single select field becomes a column. Pick one in the toolbar.</Empty>;
  const lanes = [{ id: "", name: "No option", color: "gray" }, ...(f.choices ?? [])];
  return <div className="bx-lanes">{lanes.map((l) => { const inLane = rows.filter((r) => (r.cells[f.id] ?? "") === l.id); if (!l.id && !inLane.length) return null; return <section key={l.id || "none"} className={`bx-lane ${over === l.id ? "over" : ""}`} aria-label={l.name} onDragOver={(e) => { if (c.editable) { e.preventDefault(); setOver(l.id); } }} onDragLeave={() => setOver(null)} onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/plain"), rec = rows.find((x) => x.id === id); if (rec && (rec.cells[f.id] ?? "") !== l.id) c.send({ kind: "setCells", table: c.table.id, updates: [{ id, cells: { [f.id]: l.id || null } }] }, [{ kind: "setCells", table: c.table.id, updates: [{ id, cells: { [f.id]: rec.cells[f.id] ?? null } }] }]); }}>
    <header><span className={`bx-chip c-${l.color}`}>{l.name}</span><small>{inLane.length}</small>{c.editable && <button type="button" aria-label={`Add a record to ${l.name}`} onClick={() => { const id = uid(); c.send({ kind: "addRecords", table: c.table.id, records: [{ id, cells: l.id ? { [f.id]: l.id } : {} }] }, [{ kind: "deleteRecords", table: c.table.id, ids: [id] }]); }}><Icon name="plus" size={15} /></button>}</header>
    <div>{inLane.slice(0, 200).map((r) => <Card key={r.id} c={c} r={r} drag={c.editable} />)}</div></section>; })}</div>;
}

function Calendar({ c, rows }: { c: Ctx; rows: Rec[] }) {
  const f = c.table.fields.find((x) => x.id === c.view.dateField), [cur, setCur] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  if (!f) return <Empty icon="fieldDate" title="Choose a date field">Records appear on the calendar by this date. Pick one in the toolbar.</Empty>;
  const first = new Date(Date.UTC(cur.y, cur.m, 1)), start = new Date(first.getTime() - first.getUTCDay() * 86400000), days = Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10)), today = new Date().toISOString().slice(0, 10), canDrop = c.editable && f.type === "date";
  const byDay = new Map<string, Rec[]>(); for (const r of rows) { const v = c.eng.value(r, f); if (v) { const k = String(v).slice(0, 10); byDay.set(k, [...(byDay.get(k) ?? []), r]); } }
  return <div className="bx-cal">
    <div className="bx-cal-head"><Btn icon="chevRight" aria-label="Previous month" style={{ transform: "rotate(180deg)" }} onClick={() => setCur(cur.m ? { ...cur, m: cur.m - 1 } : { y: cur.y - 1, m: 11 })} /><h2>{first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</h2><Btn icon="chevRight" aria-label="Next month" onClick={() => setCur(cur.m === 11 ? { y: cur.y + 1, m: 0 } : { ...cur, m: cur.m + 1 })} /><Btn onClick={() => { const d = new Date(); setCur({ y: d.getFullYear(), m: d.getMonth() }); }}>Today</Btn></div>
    <div className="bx-cal-grid">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <b key={d}>{d}</b>)}{days.map((d) => <div key={d} className={`${d.slice(5, 7) === String(cur.m + 1).padStart(2, "0") ? "" : "out"} ${d === today ? "today" : ""}`} onDragOver={(e) => { if (canDrop) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); if (id && canDrop) c.send({ kind: "setCells", table: c.table.id, updates: [{ id, cells: { [f.id]: d } }] }); }}>
      <span className="d">{Number(d.slice(8))}{canDrop && <button type="button" aria-label={`Add a record on ${d}`} onClick={() => { const id = uid(); c.send({ kind: "addRecords", table: c.table.id, records: [{ id, cells: { [f.id]: d } }] }, [{ kind: "deleteRecords", table: c.table.id, ids: [id] }]); c.open({ id, cells: { [f.id]: d } } as unknown as Rec); }}><Icon name="plus" size={13} /></button>}</span>
      {(byDay.get(d) ?? []).slice(0, 4).map((r) => { const col = tone(c, r); return <button type="button" key={r.id} draggable={canDrop} onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)} className={`bx-ev ${col ? `c-${col}` : ""}`} onClick={() => c.open(r)}>{c.eng.title(r)}</button>; })}{(byDay.get(d)?.length ?? 0) > 4 && <small className="muted">{byDay.get(d)!.length - 4} more</small>}
    </div>)}</div></div>;
}

function FormBuilder({ c }: { c: Ctx }) {
  const { view: v, table: t } = c, form = v.form!, set = (p: Partial<NonNullable<BaseView["form"]>>) => c.send({ kind: "updateView", table: t.id, id: v.id, patch: { form: { ...form, ...p } } }), usable = t.fields.filter((f) => !isComputed(f.type) && f.type !== "link" && f.type !== "user" && f.type !== "attachment");
  const link = form.shareId ? `${typeof location === "undefined" ? "" : location.origin}/form/${form.shareId}` : "";
  return <div className="bx-form">
    <section className="side-panel bx-form-side"><h2>Fields on this form</h2>
      <div className="bx-list">{usable.map((f) => { const on = form.fields.includes(f.id); return <div key={f.id} className="bx-form-f"><label className="check"><input type="checkbox" disabled={!c.editable} checked={on} onChange={(e) => set({ fields: e.target.checked ? [...form.fields, f.id] : form.fields.filter((x) => x !== f.id), required: form.required.filter((x) => e.target.checked || x !== f.id) })} />{f.name}</label>{on && <label className="check small"><input type="checkbox" disabled={!c.editable} checked={form.required.includes(f.id)} onChange={(e) => set({ required: e.target.checked ? [...form.required, f.id] : form.required.filter((x) => x !== f.id) })} />Required</label>}</div>; })}</div>
      <h2 style={{ marginTop: 16 }}>Share</h2>
      {link ? <><p className="small muted">Anyone with this link can add a record. They can&apos;t see existing records.</p><code className="token-box">{link}</code><div className="bx-row"><Btn icon="copy" onClick={() => navigator.clipboard.writeText(link).then(() => toast("Link copied"), () => toast("Your browser blocked copying.", true))}>Copy link</Btn><a className="btn" href={link} target="_blank" rel="noopener noreferrer">Open form</a>{c.editable && <Btn onClick={() => set({ shareId: undefined })}>Turn off</Btn>}</div></> : <>{c.editable ? <Btn variant="primary" onClick={() => set({ shareId: crypto.randomUUID().replace(/-/g, "") })}>Create a shared link</Btn> : <p className="small muted">This form isn&apos;t shared.</p>}</>}
    </section>
    <div className="pub-card">
      <input className="input bx-form-title" disabled={!c.editable} aria-label="Form title" value={form.title} onChange={(e) => set({ title: e.target.value })} />
      <textarea className="input" rows={2} disabled={!c.editable} placeholder="Describe this form" aria-label="Form description" value={form.description} onChange={(e) => set({ description: e.target.value })} />
      {!form.fields.length && <Empty compact icon="file" title="Add a field">Choose which fields people fill in.</Empty>}
      {form.fields.map((id) => t.fields.find((x) => x.id === id)).filter(Boolean).map((f) => <FormField key={f!.id} label={`${f!.name}${form.required.includes(f!.id) ? " (required)" : ""}`} hint={TYPE_LABEL[f!.type]}><input className="input" disabled aria-label={`Preview of ${f!.name}`} /></FormField>)}
      <FormField label="Message after sending" hint="Optional"><input className="input" disabled={!c.editable} value={form.thanks ?? ""} onChange={(e) => set({ thanks: e.target.value })} /></FormField>
    </div>
  </div>;
}

function Automations({ c, onClose }: { c: Pick<Ctx, "base" | "send" | "editable">; onClose: () => void }) {
  const { base } = c, [sel, setSel] = useState<Automation | null>(null), [tried, setTried] = useState(false), isAdmin = useApp((s) => s.can)("admin");
  const blank = (): Automation => ({ id: uid(), name: "", on: true, table: base.tables[0].id, trigger: "created", actions: [{ id: uid(), type: "alert", message: "" }], runs: [] });
  const t = base.tables.find((x) => x.id === sel?.table), act = (id: string, p: Partial<Automation["actions"][number]>) => setSel({ ...sel!, actions: sel!.actions.map((x) => (x.id === id ? { ...x, ...p } : x)) });
  const save = () => { setTried(true); if (!sel?.name.trim()) return; if (sel.trigger === "matches" && !sel.condition) return; c.send({ kind: "saveAutomation", automation: sel }); toast("Automation saved"); setSel(null); setTried(false); };
  const live = sel && base.automations.find((a) => a.id === sel.id);
  return <Modal full wide title="Automations" onClose={onClose} foot={sel ? <><Btn onClick={() => setSel(null)}>Back</Btn>{c.editable && live && <Btn variant="danger" onClick={() => { c.send({ kind: "deleteAutomation", id: sel.id }); setSel(null); }}>Delete</Btn>}{c.editable && <Btn variant="primary" onClick={save}>Save automation</Btn>}</> : undefined}>
    {!sel ? <>{c.editable && base.automations.length > 0 && <div><Btn icon="plus" variant="primary" onClick={() => { setSel(blank()); setTried(false); }}>New automation</Btn></div>}
      {!base.automations.length ? <Empty icon="flow" title="No automations yet" editor action={<Btn icon="plus" variant="primary" onClick={() => { setSel(blank()); setTried(false); }}>New automation</Btn>}>Run actions when a record is created, changed or submitted through a form.</Empty> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Status</th><th>When</th><th>Last run</th></tr></thead><tbody>{base.automations.map((a) => <tr key={a.id} className="click" onClick={() => setSel(a)}><td><b className="cell-strong">{a.name}</b></td><td>{a.on ? "On" : "Off"}</td><td>{{ created: "A record is created", updated: "A record is updated", matches: "A record matches conditions", form: "A form is submitted", schedule: `Every ${a.every ?? 60} minutes`, webhook: "A webhook is received" }[a.trigger]}</td><td>{a.runs[0] ? `${a.runs[0].ok ? "Succeeded" : "Failed"}, ${when(a.runs[0].at)}` : "Not yet"}</td></tr>)}</tbody></table></div>}</>
      : <div className="bx-auto">
        <FormField label="Name" error={tried && !sel.name.trim() ? "Name this automation." : undefined}><input className="input" value={sel.name} onChange={(e) => setSel({ ...sel, name: e.target.value })} /></FormField>
        <label className="check"><input type="checkbox" checked={sel.on} onChange={(e) => setSel({ ...sel, on: e.target.checked })} />Turned on</label>
        <section className="side-panel"><h2>When</h2><div className="form-row"><FormField label="Table"><Sel options={base.tables.map((x): [string, string] => [x.id, x.name])} value={sel.table} onChange={(v) => setSel({ ...sel, table: v, condition: undefined })} /></FormField><FormField label="Trigger"><Sel options={[["created", "A record is created"], ["updated", "A record is updated"], ["matches", "A record matches conditions"], ["form", "A form is submitted"], ["schedule", "At a scheduled time"], ["webhook", "A webhook is received"]]} value={sel.trigger} onChange={(v) => setSel({ ...sel, trigger: v as Automation["trigger"], ...(v === "schedule" && !sel.every ? { every: 60 } : {}), ...(v === "webhook" && !sel.hookId ? { hookId: crypto.randomUUID().replace(/-/g, "") } : {}) })} /></FormField></div>
          {sel.trigger === "schedule" && <div style={{ marginTop: 12 }}><FormField label="Run every" hint="The server must be running. The first run is one interval after turning this on."><Sel options={[["15", "15 minutes"], ["60", "Hour"], ["360", "6 hours"], ["1440", "Day"], ["10080", "Week"]]} value={String(sel.every ?? 60)} onChange={(v) => setSel({ ...sel, every: Number(v) })} /></FormField></div>}
          {sel.trigger === "webhook" && sel.hookId && <div style={{ marginTop: 12, display: "grid", gap: 6 }}><p className="small muted">Send a JSON POST to this address. Anyone with it can run this automation. Use {"{key}"} in actions to read a value from what&apos;s sent.</p><code className="token-box">{`${location.origin}/api/hooks/${sel.hookId}`}</code></div>}
          {(sel.trigger === "matches" || sel.condition) && t && <div className="bx-filter" style={{ marginTop: 12 }}><Sel aria-label="Field" options={t.fields.map((f): [string, string] => [f.id, f.name])} value={sel.condition?.field ?? t.fields[0].id} onChange={(v) => setSel({ ...sel, condition: { id: "c", op: "is", value: "", ...sel.condition, field: v } })} /><Sel aria-label="Condition" options={FILTER_OPS} value={sel.condition?.op ?? "is"} onChange={(v) => setSel({ ...sel, condition: { id: "c", field: t.fields[0].id, value: "", ...sel.condition, op: v as FilterOp } })} /><input className="input" aria-label="Value" placeholder="Value" value={sel.condition?.value ?? ""} onChange={(e) => setSel({ ...sel, condition: { id: "c", field: t.fields[0].id, op: "is", ...sel.condition, value: e.target.value } })} /><span /></div>}
          {tried && sel.trigger === "matches" && !sel.condition && <p className="err small">Set the condition to match.</p>}</section>
        <section className="side-panel"><h2>Do this</h2><div className="bx-auto">{sel.actions.map((a) => { const target = a.type === "create" ? base.tables.find((x) => x.id === a.table) ?? t : t; return <div key={a.id} className="bx-auto-a">
          <div className="bx-row"><Sel aria-label="Action" options={[["alert", "Send an alert"], ["email", "Send an email"], ["find", "Find records"], ["webhook", "Send to a webhook"], ["update", "Update this record"], ["create", "Create a record"], ...(isAdmin || a.type === "script" ? [["script", "Run a script"] as [string, string]] : [])]} value={a.type} onChange={(v) => act(a.id, { type: v as "alert" })} /><Btn icon="x" variant="ghost" aria-label="Remove action" onClick={() => setSel({ ...sel, actions: sel.actions.filter((x) => x.id !== a.id) })} /></div>
          {a.type === "email" && <><FormField label="To" hint="Use {Field name} to send to an address on the record."><input className="input" value={a.to ?? ""} onChange={(e) => act(a.id, { to: e.target.value })} /></FormField><FormField label="Subject"><input className="input" value={a.subject ?? ""} onChange={(e) => act(a.id, { subject: e.target.value })} /></FormField><FormField label="Message" hint="Use {Field name} to include a value."><textarea className="input" rows={3} value={a.message ?? ""} onChange={(e) => act(a.id, { message: e.target.value })} /></FormField></>}
          {a.type === "find" && (() => { const ft = base.tables.find((x) => x.id === a.table) ?? t; return <><FormField label="In table"><Sel options={base.tables.map((x): [string, string] => [x.id, x.name])} value={ft?.id ?? ""} onChange={(v) => act(a.id, { table: v, find: undefined })} /></FormField>{ft && <div className="bx-filter"><Sel aria-label="Find field" options={ft.fields.map((f): [string, string] => [f.id, f.name])} value={a.find?.field ?? ft.fields[0].id} onChange={(v) => act(a.id, { find: { id: "f", op: "is", value: "", ...a.find, field: v } })} /><Sel aria-label="Find condition" options={FILTER_OPS} value={a.find?.op ?? "is"} onChange={(v) => act(a.id, { find: { id: "f", field: ft.fields[0].id, value: "", ...a.find, op: v as FilterOp } })} /><input className="input" aria-label="Find value" value={a.find?.value ?? ""} onChange={(e) => act(a.id, { find: { id: "f", field: ft.fields[0].id, op: "is", ...a.find, value: e.target.value } })} /><span /></div>}<p className="small muted">Later actions can use {"{found_count}"} and {"{found_names}"}.</p></>; })()}
          {a.type === "script" && <FormField label="JavaScript" hint="Only admins can edit scripts. Read fields with record.Name, read webhook values with payload, and return an object of fields to update this record. Scripts stop after 2 seconds."><textarea className="input mono" rows={7} spellCheck={false} disabled={!isAdmin} value={a.code ?? ""} onChange={(e) => act(a.id, { code: e.target.value })} placeholder={'console.log(record.Name);\nreturn { Status: "Done" };'} /></FormField>}
          {a.type === "webhook" && <FormField label="Webhook address" hint="Works with Slack, Microsoft Teams and tools that accept webhooks."><input className="input" type="url" value={a.url ?? ""} onChange={(e) => act(a.id, { url: e.target.value })} /></FormField>}
          {(a.type === "alert" || a.type === "webhook") && <FormField label="Message" hint="Use {Field name} to include a value."><input className="input" value={a.message ?? ""} onChange={(e) => act(a.id, { message: e.target.value })} /></FormField>}
          {a.type === "create" && <FormField label="In table"><Sel options={base.tables.map((x): [string, string] => [x.id, x.name])} value={a.table ?? sel.table} onChange={(v) => act(a.id, { table: v, cells: {} })} /></FormField>}
          {(a.type === "update" || a.type === "create") && target && target.fields.filter((f) => !isComputed(f.type) && f.type !== "link").map((f) => <FormField key={f.id} label={f.name}><input className="input" placeholder={f.type === "select" ? (f.choices ?? []).map((x) => x.name).join(", ") : "Leave empty to skip"} value={a.cells?.[f.id] ?? ""} onChange={(e) => { const cells = { ...(a.cells ?? {}) }; if (e.target.value) cells[f.id] = e.target.value; else delete cells[f.id]; act(a.id, { cells }); }} /></FormField>)}
        </div>; })}<div><Btn icon="plus" onClick={() => setSel({ ...sel, actions: [...sel.actions, { id: uid(), type: "alert", message: "" }] })}>Add action</Btn></div></div></section>
        {live && <section><h2 style={{ marginBottom: 8 }}>Run history</h2>{!live.runs.length ? <p className="muted small">This automation hasn&apos;t run yet.</p> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>When</th><th>Result</th><th>Detail</th></tr></thead><tbody>{live.runs.slice(0, 20).map((x, i) => <tr key={i}><td>{when(x.at)}</td><td>{x.ok ? "Succeeded" : "Failed"}</td><td className="muted">{x.detail}</td></tr>)}</tbody></table></div>}</section>}
      </div>}
  </Modal>;
}

/** Reads a CSV into headers and rows. Handles quoted commas, quotes and line breaks. */
export function parseCsv(text: string) {
  const out: string[][] = []; let row: string[] = [], cell = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x !== "")) out.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((x) => x !== "")) out.push(row);
  return out;
}
function tableFromCsv(name: string, text: string): Table {
  const [head = [], ...rows] = parseCsv(text); if (!head.length) throw new Error("This file has no rows.");
  const names = new Set<string>();
  const fields: Field[] = head.map((h, i) => {
    let n = h.trim() || `Field ${i + 1}`; while (names.has(n.toLowerCase())) n += " 2"; names.add(n.toLowerCase());
    const vals = rows.map((r) => (r[i] ?? "").trim()).filter(Boolean), uniq = [...new Set(vals)];
    let type: FieldType = "text"; let choices: Choice[] | undefined;
    if (i > 0 && vals.length) {
      if (vals.every((v) => /^-?[\d,]*\.?\d+$/.test(v))) type = "number";
      else if (vals.every((v) => /^(true|false|yes|no)$/i.test(v))) type = "checkbox";
      else if (vals.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v))) type = "date";
      else if (vals.every((v) => /^\S+@\S+\.\S+$/.test(v))) type = "email";
      else if (vals.every((v) => /^https?:\/\//.test(v))) type = "url";
      else if (uniq.length <= 12 && vals.length >= uniq.length * 2) { type = "select"; choices = uniq.map((u, k) => ({ id: uid(), name: u, color: CHOICE_COLORS[k % CHOICE_COLORS.length] })); }
    }
    return { id: uid(), name: n, type, choices };
  });
  const t: Table = { id: uid(), name: name.trim() || "Imported", fields, views: [newView(uid(), "Grid view", "grid")], records: [] };
  return Object.assign(t, { pending: rows.map((r) => ({ id: uid(), cells: Object.fromEntries(fields.map((f, i) => [f.id, r[i] ?? ""])) })) });
}

export default function BaseApp({ id }: { id: string }) {
  const can = useApp((s) => s.can);
  const [base, setBase] = useState<Base | null>(null), [people, setPeople] = useState<string[]>([]), [err, setErr] = useState(""), [tid, setTid] = useState(""), [vid, setVid] = useState(""), [search, setSearch] = useState(""), [rec, setRec] = useState<string | null>(null), [autos, setAutos] = useState(false), [pages, setPages] = useState(false), [apiOpen, setApiOpen] = useState(false), [syncing, setSyncing] = useState(false), [exts, setExts] = useState(false), [tick, setTick] = useState(0), [rename, setRename] = useState<{ kind: "table" | "view" | "base"; id: string; name: string } | null>(null);
  const [snaps, setSnaps] = useState(false), editable = can("editor"), ref = useRef<Base | null>(null), queue = useRef<Promise<unknown>>(Promise.resolve()), pending = useRef(0), undo = useRef<Op[][]>([]), csv = useRef<HTMLInputElement>(null), name = useApp((s) => s.user?.name ?? "");
  const load = useCallback(() => call<{ base: Base; people: string[] }>(`/api/bases?id=${id}`).then((r) => { ref.current = r.base; setBase(r.base); setPeople(r.people); setTick((x) => x + 1); setErr(""); }, (e) => setErr(e.message)), [id]);
  useEffect(() => { void load(); }, [load]);
  // Others' edits arrive here; while this browser is still saving, its own copy is ahead and stays
  useEffect(() => { const i = setInterval(() => { if (pending.current || !ref.current || document.hidden) return; call<{ version: number }>(`/api/bases?id=${id}&check=1`).then((r) => { if (!pending.current && ref.current && r.version !== ref.current.version) void load(); }).catch(() => {}); }, 30000); return () => clearInterval(i); }, [id, load]);
  useEffect(() => { const ev = new EventSource(`/api/bases/events?id=${id}`); let wait: ReturnType<typeof setTimeout> | undefined; ev.onmessage = (m) => { const v = JSON.parse(m.data).version; if (pending.current || !ref.current || v === ref.current.version) return; clearTimeout(wait); wait = setTimeout(() => { if (!pending.current) void load(); }, 1500); }; return () => { clearTimeout(wait); ev.close(); }; }, [id, load]);
  const send = useCallback((o: Op | Op[], back?: Op[]) => {
    const b = ref.current; if (!b) return; const ops = Array.isArray(o) ? o : [o], at = new Date().toISOString();
    for (const op of ops) applyOp(b, op, name, at);
    if (back) { undo.current.push(back); if (undo.current.length > 100) undo.current.shift(); }
    setTick((x) => x + 1); pending.current++;
    queue.current = queue.current.then(() => call<{ version: number }>("/api/bases", { json: { action: "ops", id, ops } })).then((r) => { if (ref.current) ref.current.version = Math.max(ref.current.version, r.version); }).catch((e) => { toast(e.message, true); return load(); }).finally(() => { pending.current--; });
  }, [id, load, name]);
  useEffect(() => { const k = (e: KeyboardEvent) => { const el = e.target as HTMLElement; if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !/INPUT|TEXTAREA|SELECT/.test(el.tagName)) { const back = undo.current.pop(); if (back) { e.preventDefault(); send(back); toast("Undone"); } } }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [send]);

  const table = base?.tables.find((t) => t.id === tid) ?? base?.tables[0], view = table?.views.find((v) => v.id === vid && (!v.owner || v.owner === name)) ?? table?.views.find((v) => !v.owner || v.owner === name) ?? table?.views[0];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const eng = useMemo(() => (base && table ? compute(base, table) : null), [base, table, tick]);
  const findText = useDeferredValue(search);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (eng && table && view ? viewRecords(eng, table, view, findText) : []), [eng, table, view, findText, tick]);
  if (err && !base) return <ErrorState title="This base couldn't load" retry={load}>{err}</ErrorState>;
  if (!base || !table || !view || !eng) return <div className="body"><LoadingTable cols={6} rows={8} label="Loading base" /></div>;
  const open = (r: Rec) => setRec(r.id), c: Ctx = { base, table, view, eng, send: (o, b) => { try { send(o, b); } catch (e) { toast((e as Error).message, true); } }, editable: editable && !table.sync, people, open };
  const addRecord = () => { const nid = uid(); c.send({ kind: "addRecords", table: table.id, records: [{ id: nid, cells: {} }] }, [{ kind: "deleteRecords", table: table.id, ids: [nid] }]); };
  const addTable = () => { const t = newTable(uid(), `Table ${base.tables.length + 1}`, uid); c.send({ kind: "addTable", table: t }); setTid(t.id); setVid(""); };
  const importCsv = async (file: File) => { try { const t = tableFromCsv(file.name.replace(/\.\w+$/, ""), await file.text()) as Table & { pending: { id: string; cells: Record<string, unknown> }[] }; const { pending: list, ...plain } = t; c.send({ kind: "addTable", table: plain as Table }); for (let i = 0; i < list.length; i += 1000) c.send({ kind: "addRecords", table: t.id, records: list.slice(i, i + 1000) }); setTid(t.id); setVid(""); toast(`Imported ${list.length.toLocaleString("en-US")} records into ${t.name}`); } catch (e) { toast((e as Error).message, true); } };
  const addView = (type: ViewType) => { const label = VIEW_TYPES.find((v) => v[0] === type)![1], v = newView(uid(), `${label} ${table.views.filter((x) => x.type === type).length + 1}`, type, table); if (type === "kanban") v.stackBy = table.fields.find((f) => f.type === "select")?.id; if (type === "calendar" || type === "timeline") v.dateField = table.fields.find((f) => f.type === "date")?.id; c.send({ kind: "addView", table: table.id, view: v }); setVid(v.id); };
  const record = table.records.find((r) => r.id === rec);
  const publish = async () => { try { const on = !base.publish, r = await call<{ schema: string }>("/api/bases", { json: { action: "publish", id, on } }); ref.current!.publish = on; setTick((x) => x + 1); toast(on ? `Available in SQL and dashboards as ${r.schema}` : "No longer updating the warehouse copy"); } catch (e) { toast((e as Error).message, true); } };
  const saveRename = () => { if (!rename) return; const n = rename.name.trim(); if (!n) return; if (rename.kind === "base") c.send({ kind: "renameBase", name: n, color: base.color }); else if (rename.kind === "table") c.send({ kind: "renameTable", id: rename.id, name: n }); else c.send({ kind: "updateView", table: table.id, id: rename.id, patch: { name: n } }); setRename(null); };
  return <div className="bx">
    <header className="page-head">
      <div><h1><button type="button" disabled={!editable} onClick={() => setRename({ kind: "base", id, name: base.name })}>{base.name}</button></h1></div>
      <div className="actions"><Pop align="right" width={260} trigger={(_, t) => <Btn icon="chevDown" onClick={t}>More</Btn>}>{(close) => <div className="menu">
        <button onClick={() => { close(); setPages(true); }}><Icon name="grid" />Interfaces{base.interfaces?.length ? ` (${base.interfaces.length})` : ""}</button>
        {editable && <button onClick={() => { close(); setAutos(true); }}><Icon name="flow" />Automations{base.automations.length ? ` (${base.automations.length})` : ""}</button>}
        {editable && <button onClick={() => { close(); setExts(true); }}><Icon name="grid" />Extensions</button>}
        {editable && <button onClick={() => { close(); setApiOpen(true); }}><Icon name="code" />API</button>}
        {editable && <button onClick={() => { close(); setSnaps(true); }}><Icon name="history" />Snapshots</button>}
        {editable && <button onClick={() => { close(); void publish(); }}><Icon name="db" />{base.publish ? "Stop using in dashboards" : "Use in dashboards"}</button>}
      </div>}</Pop></div>
    </header>
    <nav className="bx-tables" aria-label="Tables">{base.tables.map((t) => <span key={t.id} className={t.id === table.id ? "on" : ""}><button type="button" aria-current={t.id === table.id ? "page" : undefined} onClick={() => { setTid(t.id); setVid(""); setSearch(""); }}>{t.name}</button>
      {t.id === table.id && editable && <Pop width={190} trigger={(_, tog) => <button type="button" className="bx-mini" aria-label={`Options for ${t.name}`} onClick={tog}><Icon name="chevDown" size={14} /></button>}>{(close) => <div className="menu"><button onClick={() => { close(); setRename({ kind: "table", id: t.id, name: t.name }); }}><Icon name="edit" />Rename table</button>{base.tables.length > 1 && <button onClick={() => { close(); c.send({ kind: "deleteTable", id: t.id }); setTid(""); }}><Icon name="trash" />Delete table</button>}</div>}</Pop>}</span>)}
      {editable && <Pop width={200} trigger={(_, tog) => <button type="button" className="bx-mini" aria-label="Add a table" title="Add a table" onClick={tog}><Icon name="plus" size={16} /></button>}>{(close) => <div className="menu"><button onClick={() => { close(); addTable(); }}><Icon name="table" />Blank table</button><button onClick={() => { close(); csv.current?.click(); }}><Icon name="upload" />Import a CSV</button><button onClick={() => { close(); setSyncing(true); }}><Icon name="refresh" />Sync from another base</button></div>}</Pop>}
      <input ref={csv} type="file" accept=".csv" hidden aria-label="Import a CSV" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsv(f); e.target.value = ""; }} />
    </nav>
    <Split id="base-views" width={220} label="Views">
      <aside className="tree" aria-label="Views">
        
        {table.views.filter((v) => !v.owner || v.owner === name).map((v) => <div key={v.id} className={`bx-view ${v.id === view.id ? "on" : ""}`}><button type="button" className={v.id === view.id ? "on" : ""} onClick={() => { setVid(v.id); setSearch(""); }}><Icon name={VIEW_TYPES.find((x) => x[0] === v.type)![2]} size={15} /><span>{v.name}</span>{v.locked && <Icon name="lock" size={13} aria-label="Locked" />}{v.owner && <Icon name="eye" size={13} aria-label="Personal" />}</button>
          {editable && v.id === view.id && <Pop align="right" width={170} trigger={(_, tog) => <button type="button" className="bx-mini" aria-label={`Options for ${v.name}`} onClick={tog}><Icon name="dots" size={16} /></button>}>{(close) => <div className="menu"><button onClick={() => { close(); c.send({ kind: "updateView", table: table.id, id: v.id, patch: { locked: !v.locked } }); }}><Icon name="lock" />{v.locked ? "Unlock view" : "Lock view"}</button>{!v.locked && <button onClick={() => { close(); c.send({ kind: "updateView", table: table.id, id: v.id, patch: { owner: v.owner ? undefined : name } }); }}><Icon name="eye" />{v.owner ? "Share with everyone" : "Make personal"}</button>}{!v.locked && <button onClick={() => { close(); setRename({ kind: "view", id: v.id, name: v.name }); }}><Icon name="edit" />Rename view</button>}{table.views.length > 1 && <button onClick={() => { close(); c.send({ kind: "deleteView", table: table.id, id: v.id }); setVid(""); }}><Icon name="trash" />Delete view</button>}</div>}</Pop>}</div>)}
        {editable && <Pop width={200} trigger={(_, t) => <button type="button" aria-label="Create a view" onClick={t}><Icon name="plus" size={15} /><span>Create a view</span></button>}>{(close) => <div className="menu">{VIEW_TYPES.map(([t, l, ic]) => <button type="button" key={t} onClick={() => { close(); addView(t); }}><Icon name={ic} />{l}</button>)}</div>}</Pop>}
      </aside>
      <section className="bx-main">
        {table.sync && <div className="banner info bx-sync"><Icon name="refresh" /><span>Synced from another base, and updated when that table changes{table.sync.at ? `. Last updated ${when(table.sync.at)}` : ""}. Edit records in the original.</span></div>}
        {table.sync?.error && <div className="banner bad"><Icon name="warn" />{table.sync.error}</div>}
        <ViewControls c={c} search={search} setSearch={setSearch} onAddRecord={addRecord} views={table.views.filter((v) => !v.owner || v.owner === name)} onPick={(x) => { setVid(x); setSearch(""); }} />
        {err && <div className="banner bad"><Icon name="warn" />{err}</div>}
        {view.type !== "form" && !table.records.length && !search ? <Empty icon="table" title="This table has no records yet" editor action={<Btn variant="primary" icon="plus" onClick={addRecord}>Add a record</Btn>}>Add a record, or import a CSV with the + next to the table names.</Empty>
          : view.type !== "form" && !rows.length ? <div className="body"><NoResults what="records" onClear={() => { setSearch(""); c.send({ kind: "updateView", table: table.id, id: view.id, patch: { filters: [] } }); }} /></div>
            : view.type === "grid" ? <Grid key={view.id} c={c} rows={rows} addRecord={addRecord} />
              : view.type === "kanban" ? <Kanban c={c} rows={rows} />
                : view.type === "gallery" ? <div className="bx-gallery">{rows.slice(0, 300).map((r) => <Card key={r.id} c={c} r={r} cover={table.fields.find((f) => f.id === view.coverField)} />)}</div>
                  : view.type === "calendar" ? <Calendar c={c} rows={rows} /> : view.type === "timeline" ? <Timeline t={table} view={view} eng={eng} rows={rows} open={open} editable={c.editable} send={(o, b) => c.send(o, b)} /> : <FormBuilder c={c} />}
      </section>
    </Split>
    {record && <RecordSheet c={c} r={record} onClose={() => setRec(null)} />}
    {autos && <Automations c={c} onClose={() => setAutos(false)} />}
    {pages && <Interfaces base={base} editable={editable} send={(o) => c.send(o)} onClose={() => setPages(false)} onOpen={(t, r) => { setPages(false); setTid(t.id); setVid(""); setRec(r.id); }} />}
    {apiOpen && <ApiSheet base={base} onClose={() => setApiOpen(false)} />}
    {snaps && <SnapshotSheet base={base} onClose={() => setSnaps(false)} onRestored={() => { undo.current = []; void load(); }} />}
    {syncing && <SyncSheet base={base} onClose={() => setSyncing(false)} onDone={async (t) => { setSyncing(false); await load(); setTid(t); setVid(""); }} />}
    {exts && <Extensions base={base} table={table} eng={eng} editable={c.editable} send={(o) => c.send(o)} onClose={() => setExts(false)} />}
    {rename && <Modal sheet title={`Rename ${rename.kind}`} onClose={() => setRename(null)} foot={<><Btn onClick={() => setRename(null)}>Cancel</Btn><Btn variant="primary" disabled={!rename.name.trim()} onClick={saveRename}>Save name</Btn></>}><FormField label="Name"><input className="input" autoFocus value={rename.name} onChange={(e) => setRename({ ...rename, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") saveRename(); }} /></FormField></Modal>}
  </div>;
}
