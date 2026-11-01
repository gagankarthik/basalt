"use client";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AirbyteLogo, type AirbyteEntry, type AirbyteList } from "@/components/AirbyteDialogs";
import type { CloudKind } from "@/components/CloudDialogs";
import { Icon, Logo, type BrandName } from "@/components/icons";
import { Btn, Modal, NoResults, Spinner } from "@/components/ui";
import { licenseName } from "@/lib/airbyte";
import { CATALOG_GROUPS, searchCatalog, type CatalogGroup, type Searchable } from "@/lib/catalogSearch";
import { call, useApp } from "@/lib/client";

export type Live = { id: string; engine: "postgres" | "mysql"; name: string; logo: BrandName; port: number; caHelp?: string };
export type Pick = { db: Live } | { cloud: CloudKind } | { airbyte: AirbyteEntry } | { file: true };
type Item = Searchable & { key: string; logo: React.ReactNode; note: string; preview?: boolean; pick: Pick };

const db = (groups: CatalogGroup[], id: string, engine: Live["engine"], name: string, logo: BrandName, terms: string, caHelp?: string): Item =>
  // MySQL's code hasn't run against a real server
  ({ key: id, name, groups, terms: `${terms} sql relational ${engine}`, logo: <Logo name={logo} />, note: "Read-only", preview: engine === "mysql", pick: { db: { id, engine, name, logo, port: engine === "postgres" ? 5432 : 3306, caHelp } } });
const src = (groups: CatalogGroup[], id: CloudKind["id"], name: string, logo: BrandName, terms: string, preview: boolean, note = "Read-only"): Item =>
  ({ key: id, name, groups, terms, logo: <Logo name={logo} />, note, preview, pick: { cloud: { id, name } } });
const file = (name: string, logo: BrandName | null, terms: string): Item =>
  ({ key: `file-${name}`, name, groups: ["Files"], terms: `file import upload ${terms}`, logo: logo ? <Logo name={logo} /> : <Icon name="upload" size={22} />, note: "Preview, then import", pick: { file: true } });

const RDS_CA = "Paste the AWS RDS CA bundle, global-bundle.pem.", CLOUD_SQL_CA = "Paste the server CA from this instance's Connections page in Google Cloud.", AZURE_CA = "Leave empty: Azure's certificate is signed by a public CA.";
const AWS = "amazon aws", GCP = "google gcp cloud", AZ = "microsoft azure";
// A connector is Preview until it has run on the real service, or on an emulator or database engine that truly executes what it sends. Each one is listed on the Current limits page.
const NATIVE: Item[] = [
  src(["AWS", "Files"], "s3", "Amazon S3", "s3", `${AWS} storage object bucket lake minio r2`, false, "Read and write"),
  src(["AWS", "Databases"], "dynamodb", "Amazon DynamoDB", "dynamodb", `${AWS} nosql key value document`, false),
  src(["AWS", "Warehouses"], "redshift", "Amazon Redshift", "redshift", `${AWS} sql serverless`, true),
  src(["AWS", "Warehouses"], "athena", "Amazon Athena", "athena", `${AWS} sql query lake glue`, true),
  db(["AWS", "Databases"], "rds-postgres", "postgres", "RDS for PostgreSQL", "rds", AWS, RDS_CA),
  db(["AWS", "Databases"], "rds-mysql", "mysql", "RDS for MySQL or MariaDB", "rds", `${AWS} mariadb`, RDS_CA),
  db(["AWS", "Databases"], "aurora-postgres", "postgres", "Aurora PostgreSQL", "aurora", AWS, RDS_CA),
  db(["AWS", "Databases"], "aurora-mysql", "mysql", "Aurora MySQL", "aurora", AWS, RDS_CA),
  src(["Google Cloud", "Warehouses"], "bigquery", "BigQuery", "bigquery", `${GCP} sql`, false, "Read and write"),
  src(["Google Cloud", "Files"], "gcs", "Cloud Storage", "gcs", `${GCP} storage object bucket lake gcs`, false, "Read and write"),
  src(["Google Cloud", "Databases"], "firestore", "Firestore", "firestore", `${GCP} firebase nosql document`, true),
  src(["Google Cloud", "Databases"], "spanner", "Spanner", "spanner", `${GCP} sql relational`, true),
  db(["Google Cloud", "Databases"], "cloudsql-postgres", "postgres", "Cloud SQL for PostgreSQL", "cloudsql", GCP, CLOUD_SQL_CA),
  db(["Google Cloud", "Databases"], "cloudsql-mysql", "mysql", "Cloud SQL for MySQL", "cloudsql", GCP, CLOUD_SQL_CA),
  src(["Azure", "Files"], "azure", "Blob Storage and ADLS Gen2", "azure", `${AZ} storage object container lake`, false, "Read and write"),
  src(["Azure", "Databases"], "azuresql", "Azure SQL Database", "azuresql", `${AZ} sql server mssql relational`, true),
  src(["Azure", "Warehouses"], "synapse", "Synapse Analytics", "azure", `${AZ} sql`, true),
  src(["Azure", "Databases"], "cosmos", "Cosmos DB", "cosmos", `${AZ} nosql document`, false),
  db(["Azure", "Databases"], "azure-postgres", "postgres", "Azure Database for PostgreSQL", "postgres", AZ, AZURE_CA),
  db(["Azure", "Databases"], "azure-mysql", "mysql", "Azure Database for MySQL", "mysql", AZ, AZURE_CA),
  db(["Databases"], "postgres", "postgres", "PostgreSQL", "postgres", "postgres"),
  db(["Databases"], "mysql", "mysql", "MySQL", "mysql", ""),
  db(["Databases"], "mariadb", "mysql", "MariaDB", "mariadb", ""),
  src(["Databases"], "mssql", "SQL Server", "sqlserver", "microsoft sql mssql relational", true),
  src(["Warehouses"], "snowflake", "Snowflake", "snowflake", "sql cloud", false, "Read and write"),
  file("File import", null, "csv tsv json parquet excel xml avro yaml"),
  file("CSV or TSV", "csv", ""), file("JSON", "json", ""), file("Parquet", "parquet", ""), file("Excel", "excel", "xlsx spreadsheet"), file("XML", "xml", ""),
];
/** Rendering all 590 logos at once is what would slow this down; searching them isn't. */
const PAGE = 120;

export function ConnectionCatalog({ start = "All", onPick, onClose }: { start?: CatalogGroup | "All"; onPick: (p: Pick) => void; onClose: () => void }) {
  const admin = useApp((s) => s.can)("admin");
  const [q, setQ] = useState(""), [group, setGroup] = useState<CatalogGroup | "All">(start), [shown, setShown] = useState(PAGE);
  const [list, setList] = useState<AirbyteList | null>(null), [error, setError] = useState("");
  const box = useRef<HTMLInputElement>(null), query = useDeferredValue(q);
  useEffect(() => { box.current?.focus(); }, []);
  // The registry is admin-only: a connector is third-party code running on this server
  useEffect(() => { if (admin) call<AirbyteList>("/api/connections/airbyte").then(setList, (e) => setError(e.message)); }, [admin]);
  const apps = useMemo<Item[]>(() => {
    if (!list) return [];
    const run = list.runtime;
    return list.connectors.filter((c) => run.docker || (!!run.python && c.routes.some((r) => r !== "docker"))).sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ key: `airbyte-${c.id}`, name: c.name, groups: ["Apps"], terms: `airbyte ${c.repo}`, airbyte: true, logo: <AirbyteLogo src={c.icon} />, note: `Airbyte, ${licenseName(c.license)}`, pick: { airbyte: c } }));
  }, [list]);
  const all = useMemo(() => [...NATIVE, ...apps], [apps]);
  const found = useMemo(() => searchCatalog(all, query, group), [all, query, group]);
  const clear = () => { setQ(""); setGroup("All"); setShown(PAGE); box.current?.focus(); };
  const chips: (CatalogGroup | "All")[] = ["All", ...CATALOG_GROUPS.filter((g) => g !== "Apps" || admin)];
  // Headings only help while browsing. A search result is ranked, so its order isn't by group
  const headed = group === "All" && !query.trim();
  return (
    <Modal full wide title="Add a connection" onClose={onClose}>
      <div className="catalog-bar">
        <input ref={box} className="input" type="search" aria-label="Search connectors" placeholder="Search connectors" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--gap-1)" }}>{chips.map((c) => <button key={c} type="button" className={`chip${group === c ? " on" : ""}`} style={{ height: 36, padding: "0 12px" }} aria-pressed={group === c} onClick={() => { setGroup(c); setShown(PAGE); }}>{c}</button>)}</div>
      </div>
      {group === "Apps" && list && <div className="banner info"><Icon name="info" /><span>
        {list.runtime.docker ? "Connectors run in isolated containers." : list.runtime.python ? "Connectors run as separate processes with no server secrets and outside its data folder. This isn't a sandbox: they can still reach the server's files and network. Connectors published only as container images aren't available." : "Connectors aren't available on this server. Contact your administrator."}
        {" "}Connectors are third-party code from Airbyte, installed when you test one. Some include custom Python and run only in containers.</span></div>}
      {error && <div className="banner bad" role="alert"><Icon name="warn" /><span>{error}</span></div>}
      {admin && !list && !error && <p className="small muted"><Spinner /> Reading Airbyte&apos;s connector list</p>}
      {found.length === 0 ? (admin && !list && !error ? null : <NoResults what="connectors" onClear={clear} />) : (headed ? CATALOG_GROUPS.filter((g) => found.slice(0, shown).some((x) => x.groups[0] === g)).map((g) => <div key={g}><h3>{g}</h3><Grid items={found.slice(0, shown).filter((x) => x.groups[0] === g)} onPick={onPick} /></div>) : <Grid items={found.slice(0, shown)} onPick={onPick} />)}
      {found.length > shown && <div><Btn onClick={() => setShown(shown + PAGE)}>Show more</Btn> <span className="small muted">{shown} of {found.length}</span></div>}
    </Modal>
  );
}

function Grid({ items, onPick }: { items: Item[]; onPick: (p: Pick) => void }) {
  return <div className="conn-grid">{items.map((t) => <button key={t.key} className="conn" onClick={() => onPick(t.pick)}>{t.logo}<div><b>{t.name}</b><div className="small muted">{t.note}{t.preview && <> <span className="badge warn">Preview</span></>}</div></div></button>)}</div>;
}
