"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import { Btn, Confirm, Empty, ErrorState, Field, LoadingTable, Modal, PageHead, PermissionDenied, Sel, toast } from "@/components/ui";
import { call, useApp, useNewHandler, when } from "@/lib/client";

type Row = { id: string; name: string; tables: number; records: number; updatedAt: string; createdBy: string; publish: boolean };

export default function Bases() {
  const can = useApp((s) => s.can), router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null), [err, setErr] = useState(""), [adding, setAdding] = useState(false), [name, setName] = useState(""), [template, setTemplate] = useState("starter"), [tried, setTried] = useState(false), [busy, setBusy] = useState(false), [del, setDel] = useState<Row | null>(null);
  const load = () => { setErr(""); call<{ bases: Row[] }>("/api/bases").then((r) => setRows(r.bases), (e) => setErr(e.message)); };
  useEffect(load, []);
  const start = () => { setName(""); setTemplate("starter"); setTried(false); setAdding(true); };
  useNewHandler("base", start);
  const create = async () => {
    setTried(true); if (!name.trim()) return;
    setBusy(true);
    try { const r = await call<{ id: string }>("/api/bases", { json: { action: "create", name, template } }); router.push(`/bases/${r.id}`); } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  const remove = async (r: Row) => { try { await call("/api/bases", { json: { action: "delete", id: r.id } }); toast(`Deleted ${r.name}`); load(); } catch (e) { toast((e as Error).message, true); } };
  if (err.includes("limited to certain rows")) return <><PageHead title="Bases" /><PermissionDenied title="Bases aren't available with your access">{err}</PermissionDenied></>;
  return <>
    <PageHead title="Bases">{can("editor") && !!rows?.length && <Btn icon="plus" variant="primary" onClick={start}>New base</Btn>}</PageHead>
    <div className="body">
      {err ? <ErrorState title="Bases couldn't load" retry={load}>{err}</ErrorState> : !rows ? <LoadingTable label="Loading bases" /> : !rows.length ? <Empty icon="grid" title="Create your first base" editor action={<Btn variant="primary" icon="plus" onClick={start}>New base</Btn>}>A base holds the data your team edits together, with linked tables, grids, boards, calendars and forms.</Empty> : (
        <DataTable<Row> id="bases" rows={rows} rowKey={(r) => r.id} selectable={false} searchPlaceholder="Search bases" onRowClick={(r) => router.push(`/bases/${r.id}`)} initialSort={{ id: "updated", dir: "desc" }}
          columns={[
            { id: "name", header: "Name", width: 340, hideable: false, sortValue: (r) => r.name, searchValue: (r) => r.name, cell: (r) => <b className="cell-strong">{r.name}</b> },
            { id: "tables", header: "Tables", width: 100, align: "end", sortValue: (r) => r.tables, cell: (r) => r.tables },
            { id: "records", header: "Records", width: 110, align: "end", sortValue: (r) => r.records, cell: (r) => r.records.toLocaleString("en-US") },
            { id: "updated", header: "Last changed", width: 180, sortValue: (r) => r.updatedAt, cell: (r) => when(r.updatedAt) },
            { id: "owner", header: "Created by", width: 180, sortValue: (r) => r.createdBy, cell: (r) => r.createdBy },
            { id: "actions", header: "", width: 70, hideable: false, align: "end", cell: (r) => (can("admin") ? <span onClick={(e) => e.stopPropagation()}><Btn icon="trash" variant="ghost" aria-label={`Delete ${r.name}`} onClick={() => setDel(r)} /></span> : null) },
          ]} />
      )}
    </div>
    {adding && <Modal sheet title="New base" onClose={() => setAdding(false)} foot={<><Btn onClick={() => setAdding(false)}>Cancel</Btn><Btn variant="primary" disabled={busy} onClick={create}>{busy ? "Creating" : "Create base"}</Btn></>}>
      <Field label="Name" error={tried && !name.trim() ? "Name this base." : undefined}><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Start with"><Sel options={[["starter", "A project tracker with sample tasks"], ["blank", "A blank table"]]} value={template} onChange={setTemplate} /></Field>
    </Modal>}
    {del && <Confirm title={`Delete ${del.name}?`} action="Delete base" body="All of its tables, records, forms and automations are removed. This can't be undone." onYes={() => remove(del)} onClose={() => setDel(null)} />}
  </>;
}
