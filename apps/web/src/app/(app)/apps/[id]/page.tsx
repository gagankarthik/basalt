"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, use, useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { ReportView } from "@/components/ReportView";
import { Btn, Empty, ErrorState, PermissionDenied, Sk } from "@/components/ui";
import { NO_APP_ACCESS, NO_PAGE_ACCESS, type AppItem } from "@/lib/apps";
import { call, useApp } from "@/lib/client";
import type { Dashboard } from "@/lib/types";
import { AppEditor } from "../AppEditor";
import "@/components/report.css";

type Read = { id: string; name: string; logo?: string; unpublished?: boolean; version?: { n: number; at: string }; items?: AppItem[]; pageId?: string; dashboard?: Dashboard };

function Reader({ id }: { id: string }) {
  const sp = useSearchParams(), router = useRouter(), author = useApp((s) => s.can("editor")), page = sp.get("page");
  const [data, setData] = useState<Read | null>(null), [error, setError] = useState(""), [edit, setEdit] = useState(sp.get("edit") === "1");
  const load = useCallback(() => { setError(""); call<Read>(`/api/apps/${id}${page ? `?page=${encodeURIComponent(page)}` : ""}`).then(setData, (e) => setError(e.message)); }, [id, page]);
  useEffect(load, [load]);
  const closeEdit = () => { setEdit(false); router.replace(`/apps/${id}`); load(); };
  const editor = edit && author ? <AppEditor id={id} onClose={closeEdit} onChanged={load} /> : null;

  if (error === NO_APP_ACCESS) return <PermissionDenied title="You don't have access to this app">Ask the person who published it to add you to an audience.</PermissionDenied>;
  if (error === NO_PAGE_ACCESS) return <PermissionDenied title="You don't have access to this page"><Link href={`/apps/${id}`}>Back to the app</Link></PermissionDenied>;
  if (error) return <ErrorState retry={load}>{error}</ErrorState>;
  if (!data) return <div className="body"><Sk h={240} /></div>;
  if (data.unpublished) return <><Empty icon="apps" title={`${data.name} isn't published yet`} action={<Btn variant="primary" icon="edit" onClick={() => setEdit(true)}>Edit app</Btn>}>Add its pages, then publish it so readers can open it.</Empty>{editor}</>;
  const item = data.items?.find((x) => x.id === data.pageId);
  return <div className="app-shell">
    <nav className="app-nav" aria-label={data.name}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <div className="app-brand">{data.logo ? <img src={data.logo} alt="" /> : <Icon name="apps" size={22} />}<span>{data.name}</span></div>
      {data.items?.map((x) => x.kind === "link"
        ? <a key={x.id} href={x.url} target="_blank" rel="noopener noreferrer">{x.label}<Icon name="link" size={14} /></a>
        : <Link key={x.id} href={`/apps/${id}?page=${x.id}`} aria-current={x.id === data.pageId ? "page" : undefined}>{x.label}</Link>)}
      {author && <Btn icon="edit" style={{ marginTop: 12, flex: "none" }} className="report-edit-btn" onClick={() => setEdit(true)}>Edit app</Btn>}
    </nav>
    {data.dashboard && item ? <ReportView key={data.dashboard.id + data.pageId + (data.version?.n ?? "")} d={data.dashboard} app={id} items={data.items ?? []} title={item.label} /> : <div className="app-main"><Empty icon="link" title="This app has only links" /></div>}
    {editor}
  </div>;
}
export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <Suspense><Reader id={id} /></Suspense>; }
