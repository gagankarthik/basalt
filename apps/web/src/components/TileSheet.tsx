"use client";
import { useCallback, useEffect, useState } from "react";
import { Btn, Empty, Field, Modal, Sel, Tabs, toast } from "@/components/ui";
import { Icon } from "@/components/icons";
import type { DataAlert, TileComment } from "@/lib/apps";
import { call, download, sql, useApp, when } from "@/lib/client";
import { pinTile, withParams } from "@/lib/report";
import { toCsv, widgetSql } from "@/lib/sql";
import { resultSheet, toXlsx } from "@/lib/xlsx";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
import { tilesPng } from "@/lib/tilePng";
import type { Dashboard, Filter, Widget } from "@/lib/types";
import "./report.css";

type Notes = { comments: TileComment[]; alerts: DataAlert[]; mail: boolean };
const NONE: Notes = { comments: [], alerts: [], mail: false };

/** Comments and the signed-in person's alerts for one dashboard. Refused access simply shows none. */
export function useTileNotes(dashboard: string | undefined, app?: string) {
  const [notes, setNotes] = useState<Notes>(NONE);
  const reload = useCallback(() => { if (dashboard) call<Notes>(`/api/apps/tile?dashboard=${encodeURIComponent(dashboard)}${app ? `&app=${encodeURIComponent(app)}` : ""}`).then(setNotes, () => setNotes(NONE)); }, [dashboard, app]);
  useEffect(() => { reload(); }, [reload]);
  return { notes, reload };
}

/** The tile's status and its menu button. Alert state comes from the server's last real check. */
export function TileMarks({ w, notes, onOpen }: { w: Widget; notes: Notes; onOpen: () => void }) {
  const firing = notes.alerts.some((a) => a.widget === w.id && a.firing), n = notes.comments.filter((c) => c.widget === w.id).length;
  return <>
    {firing && <span className="tile-mark bad" title="Your alert on this tile has been reached"><Icon name="bell" size={14} /><span className="sr">Alert reached</span></span>}
    {n > 0 && <span className="tile-mark" title={`${n} comments`}>{n}</span>}
    <button type="button" className="tile-menu" aria-label={`More for ${w.title}`} onClick={(e) => { e.stopPropagation(); onOpen(); }} onPointerDown={(e) => e.stopPropagation()}><Icon name="dots" size={16} /></button>
  </>;
}

export function TileSheet({ d, w, app, extra, values, notes, reload, pageFilters, onClose }: { d: Dashboard; w: Widget; app?: string; extra: Filter[]; values: Record<string, number>; notes: Notes; reload: () => void; pageFilters: Filter[]; onClose: () => void }) {
  const { config, patch, can, user } = useApp();
  const alertable = w.type === "kpi" || w.type === "gauge", pinnable = !app && can("editor") && w.type !== "slicer";
  type Tab = "comments" | "alert" | "export" | "pin";
  const [tab, setTab] = useState<Tab>("comments"), [text, setText] = useState(""), [busy, setBusy] = useState(false);
  const mine = notes.alerts.find((a) => a.widget === w.id);
  const [op, setOp] = useState<"gt" | "lt">(mine?.op ?? "gt"), [value, setValue] = useState(mine ? String(mine.value) : ""), [target, setTarget] = useState("");
  const post = async (json: object, done?: string) => { setBusy(true); try { await call("/api/apps/tile", { json: { dashboard: d.id, widget: w.id, app, ...json } }); if (done) toast(done); reload(); return true; } catch (e) { toast((e as Error).message, true); return false; } finally { setBusy(false); } };
  const query = widgetSql(w, extra);
  const excel = async () => { try { download(`${w.title}.xlsx`, new Uint8Array(toXlsx(resultSheet(await sql(withParams(query!, values), 100000)), w.title)), XLSX_TYPE); } catch (e) { toast((e as Error).message, true); } };
  const csv = async () => { try { download(`${w.title}.csv`, toCsv(await sql(withParams(query!, values), 100000))); } catch (e) { toast((e as Error).message, true); } };
  // The tile's element is found at click time, because the sheet opens over the live board
  const png = () => { const el = document.querySelector<HTMLElement>(`.tile[data-tile="${CSS.escape(w.id)}"]`); if (el) tilesPng([el], w.title).catch((e) => toast(e.message, true)); };
  const pin = () => { try { const to = config!.dashboards.find((x) => x.id === target)!, next = pinTile(to, d, w, pageFilters, crypto.randomUUID()); patch((c) => ({ ...c, dashboards: c.dashboards.map((x) => (x.id === to.id ? next : x)) })); toast(`Pinned to ${to.name}`); onClose(); } catch (e) { toast((e as Error).message, true); } };
  const tabs: [Tab, string][] = [["comments", "Comments"], ...(alertable ? [["alert", "Alert"] as [Tab, string]] : []), ["export", "Export"], ...(pinnable ? [["pin", "Pin"] as [Tab, string]] : [])];
  const list = notes.comments.filter((c) => c.widget === w.id);
  return <Modal sheet title={w.title} onClose={onClose}>
    <Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === "comments" && <>
      {!list.length ? <Empty compact icon="text" title="No comments yet" /> : <ul className="tile-comments">{list.map((c) => <li key={c.id}><div><b>{c.name}</b><span className="small muted">{when(c.at)}</span>{(c.userId === user?.id || can("admin")) && <Btn icon="x" variant="ghost" aria-label="Delete comment" onClick={() => post({ action: "deleteComment", id: c.id })} />}</div><p>{c.text}</p></li>)}</ul>}
      <Field label="Add a comment"><textarea className="input" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <div><Btn variant="primary" disabled={busy || !text.trim()} onClick={async () => { if (await post({ action: "comment", text })) setText(""); }}>Post comment</Btn></div>
    </>}
    {tab === "alert" && <>
      {!notes.mail && <div className="banner info"><Icon name="info" /><span>No email server is set up, so this alert shows on the tile only.</span></div>}
      <div className="form-row"><Field label="When the value is"><Sel options={[["gt", "Above"], ["lt", "Below"]]} value={op} onChange={(v) => setOp(v as "gt")} /></Field><Field label="Limit"><input className="input" type="number" value={value} onChange={(e) => setValue(e.target.value)} /></Field></div>
      {mine && <dl className="tile-alert"><dt>Last checked</dt><dd>{when(mine.lastAt)}</dd><dt>Value</dt><dd>{mine.lastValue == null ? "None" : mine.lastValue.toLocaleString("en-US")}</dd><dt>Status</dt><dd>{mine.lastError ? <span className="err small">{mine.lastError}</span> : mine.firing ? `Reached ${when(mine.firedAt)}` : "Not reached"}</dd></dl>}
      <div className="tile-row"><Btn variant="primary" disabled={busy || value === ""} onClick={() => post({ action: "alert", op, value }, "Alert saved")}>Save alert</Btn>{mine && <Btn disabled={busy} onClick={() => post({ action: "deleteAlert", id: mine.id }, "Alert removed")}>Remove</Btn>}</div>
    </>}
    {tab === "export" && <div className="tile-row"><Btn icon="download" onClick={png}>PNG</Btn>{query && <><Btn icon="download" onClick={excel}>Excel</Btn><Btn icon="download" onClick={csv}>CSV</Btn></>}</div>}
    {tab === "pin" && <>
      <Field label="Pin to dashboard"><Sel options={[["", "Choose a dashboard"], ...config!.dashboards.filter((x) => x.id !== d.id).map((x): [string, string] => [x.id, x.name])]} value={target} onChange={setTarget} /></Field>
      <div><Btn variant="primary" icon="plus" disabled={!target} onClick={pin}>Pin tile</Btn></div>
    </>}
  </Modal>;
}
