"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import { Icon } from "@/components/icons";
import { Btn, Empty, ErrorState, Field, LoadingTable, Modal, PageHead, toast } from "@/components/ui";
import type { AppSummary } from "@/lib/apps";
import { call, useApp, useNewHandler, when } from "@/lib/client";
import { STATUS_LABEL, STATUS_TONE } from "./AppEditor";

export default function Apps() {
  const { can } = useApp(), router = useRouter(), author = can("editor");
  const [items, setItems] = useState<AppSummary[] | null>(null), [error, setError] = useState(""), [adding, setAdding] = useState(false), [name, setName] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(() => { setError(""); call<{ items: AppSummary[] }>("/api/apps").then((r) => setItems(r.items), (e) => setError(e.message)); }, []);
  useEffect(load, [load]);
  const open = () => { setName(""); setAdding(true); };
  useNewHandler("app", open);
  const create = async () => { setBusy(true); try { const r = await call<{ id: string }>("/api/apps", { json: { name } }); router.push(`/apps/${r.id}?edit=1`); } catch (e) { toast((e as Error).message, true); setBusy(false); } };
  return <>
    <PageHead title="Apps">{author && !!items?.length && <Btn icon="plus" variant="primary" onClick={open}>New app</Btn>}</PageHead>
    <div className="body">
      {error ? <ErrorState retry={load}>{error}</ErrorState> : !items ? <LoadingTable /> : !items.length ? <Empty icon="apps" title={author ? "No apps yet" : "No apps have been shared with you"} action={author ? <Btn variant="primary" icon="plus" onClick={open}>New app</Btn> : undefined}>{author ? "An app packages dashboards and links for the people who read them. Create one and choose its pages." : "Apps you can open appear here once someone shares one with you."}</Empty> : (
        <DataTable<AppSummary> id="apps" rows={items} rowKey={(a) => a.id} selectable={false} searchPlaceholder="Search apps" onRowClick={(a) => router.push(`/apps/${a.id}`)} initialSort={{ id: "name", dir: "asc" }}
          columns={[
            // eslint-disable-next-line @next/next/no-img-element
            { id: "name", header: "Name", width: 320, hideable: false, sortValue: (a) => a.name, searchValue: (a) => a.name, cell: (a) => <span className="person">{a.logo ? <img src={a.logo} alt="" width={24} height={24} style={{ objectFit: "contain" }} /> : <Icon name="apps" size={20} />}<b>{a.name}</b></span> },
            { id: "status", header: "Status", width: 220, sortValue: (a) => a.status, cell: (a) => <span className={`badge dot ${STATUS_TONE[a.status]}`}>{STATUS_LABEL[a.status]}</span> },
            { id: "pages", header: "Pages", width: 90, align: "end", sortValue: (a) => a.pages, cell: (a) => a.pages },
            ...(author ? [{ id: "audiences", header: "Audiences", width: 110, align: "end" as const, sortValue: (a: AppSummary) => a.audiences ?? 0, cell: (a: AppSummary) => a.audiences ?? 0 }] : []),
            { id: "version", header: "Version", width: 90, align: "end", sortValue: (a) => a.version ?? 0, cell: (a) => a.version ?? "" },
            { id: "at", header: "Published", width: 170, sortValue: (a) => a.at ?? "", cell: (a) => when(a.at) },
          ]} />
      )}
    </div>
    {adding && <Modal sheet title="New app" onClose={() => setAdding(false)} foot={<><Btn onClick={() => setAdding(false)}>Cancel</Btn><Btn variant="primary" disabled={!name.trim() || busy} onClick={create}>Create app</Btn></>}><Field label="Name"><input className="input" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field></Modal>}
  </>;
}
