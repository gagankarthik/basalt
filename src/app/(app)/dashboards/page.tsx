"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import DataTable from "@/components/DataTable";
import { Avatar, Btn, Confirm, Empty, Field, IconTile, Modal, PageHead, Sel } from "@/components/ui";
import { autoWidgets } from "@/lib/autoDashboard";
import { uid, useApp, useNewHandler, useTables } from "@/lib/client";
import type { Dashboard } from "@/lib/types";

export default function Dashboards() {
  const { config, patch, can, user } = useApp(), router = useRouter();
  const [adding, setAdding] = useState(false), [name, setName] = useState(""), [del, setDel] = useState<Dashboard | null>(null), [from, setFrom] = useState(""), tables = useTables();
  useNewHandler("dashboard", () => { setName(""); setFrom(""); setAdding(true); });
  const create = () => {
    const id = uid(), source = tables?.find((t) => t.full === from);
    patch((c) => ({ ...c, dashboards: [...c.dashboards, { id, name, description: "", widgets: source ? autoWidgets(source.full, source.columns, uid) : [], filters: [], owner: user!.name }] }));
    setTimeout(() => router.push(`/dashboards/${id}${source ? "" : "?edit=1"}`), 450);
  };
  return (
    <>
      <PageHead title="Dashboards">{can("editor") && config!.dashboards.length > 0 && <Btn icon="plus" variant="primary" onClick={() => { setName(""); setFrom(""); setAdding(true); }}>New dashboard</Btn>}</PageHead>
      <div className="body">
        {!config!.dashboards.length ? <Empty icon="chart" title="No dashboards yet" editor action={<Btn variant="primary" icon="plus" onClick={() => { setName(""); setFrom(""); setAdding(true); }}>Create a dashboard</Btn>}>Start from any table and Basalt builds a first version for you.</Empty> : (
          <DataTable<Dashboard> id="dashboards" rows={config!.dashboards} rowKey={(d) => d.id} selectable={false} searchPlaceholder="Search dashboards" onRowClick={(d) => router.push(`/dashboards/${d.id}`)} initialSort={{ id: "name", dir: "asc" }}
            filters={[{ id: "owner", label: "Owner", value: (d) => d.owner }]}
            columns={[
              { id: "name", header: "Name", width: 320, hideable: false, sortValue: (d) => d.name, searchValue: (d) => `${d.name} ${d.description}`, cell: (d) => <span className="person"><IconTile icon="chart" /><span className="stack"><b>{d.name}</b><small>{d.description}</small></span></span> },
              { id: "visuals", header: "Visuals", width: 110, align: "end", sortValue: (d) => d.widgets.length, cell: (d) => d.widgets.length },
              { id: "owner", header: "Owner", width: 190, sortValue: (d) => d.owner, cell: (d) => <span className="person"><Avatar name={d.owner} size={24} />{d.owner}</span> },
              { id: "actions", header: "", width: 70, hideable: false, align: "end", cell: (d) => (can("editor") ? <span onClick={(e) => e.stopPropagation()}><Btn icon="trash" variant="ghost" aria-label={`Delete ${d.name}`} onClick={() => setDel(d)} /></span> : null) },
            ]} />
        )}
      </div>
      {adding && <Modal sheet title="New dashboard" onClose={() => setAdding(false)} foot={<><Btn onClick={() => setAdding(false)}>Cancel</Btn><Btn variant="primary" disabled={!name} onClick={create}>Create dashboard</Btn></>}><Field label="Name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Start from" hint="Basalt adds headline numbers, a trend and the main breakdowns. You can change all of them."><Sel options={[["", "An empty dashboard"], ...(tables ?? []).map((t): [string, string] => [t.full, t.full])]} value={from} onChange={setFrom} /></Field></Modal>}
      {del && <Confirm title={`Delete ${del.name}?`} action="Delete dashboard" body="Its charts are removed. The data isn't affected." onYes={() => patch((c) => ({ ...c, dashboards: c.dashboards.filter((x) => x.id !== del.id) }))} onClose={() => setDel(null)} />}
    </>
  );
}
