"use client";
import Link from "next/link";
import { Icon, Logo, type BrandName } from "@/components/icons";
import { GoLink, PageHead } from "@/components/ui";

type Row = { tool: string; logo?: BrandName; basalt: string; href: string; status: "Built" | "Partly built" };
const ROWS: Row[] = [
  { tool: "Airbyte", logo: "airbyte", basalt: "Runs Airbyte's connectors and follows its protocol", href: "/connections", status: "Built" },
  { tool: "Fivetran", basalt: "Sync metadata columns and row checks. Connectors come from Airbyte", href: "/connections", status: "Built" },
  { tool: "dbt", logo: "dbt", basalt: "Builds models with real dbt or the built-in builder. Full Jinja and packages need real dbt", href: "/models", status: "Built" },
  { tool: "OpenLineage", basalt: "Saves and sends run events for syncs, builds, flows, notebooks and exports", href: "/runs", status: "Partly built" },
  { tool: "Snowflake", logo: "snowflake", basalt: "A warehouse on your server, with a SQL editor and a catalog", href: "/sql", status: "Partly built" },
  { tool: "Databricks", logo: "databricks", basalt: "SQL, Python and text notebooks with schedules. No co-editing or distributed processing", href: "/notebooks", status: "Partly built" },
  { tool: "Azure Blob Storage", logo: "azure", basalt: "Reads and writes CSV, JSON, Parquet, Excel, XML and Delta. Not yet run on a real Azure account", href: "/connections", status: "Partly built" },
  { tool: "AWS, Google Cloud and Azure sources", logo: "dynamodb", basalt: "Read-only cloud sources. None has run on a real cloud account yet", href: "/docs/current-limits", status: "Partly built" },
  { tool: "Airtable", logo: "airtable", basalt: "Bases with linked records, views, forms and automations. No mobile app or marketplace", href: "/bases", status: "Built" },
  { tool: "Power BI", logo: "powerbi", basalt: "Semantic model, DAX, report pages and published apps. No AI, marketplace or mobile app", href: "/dashboards", status: "Partly built" },
  { tool: "Power Query", basalt: "A no-code query editor and a working subset of M", href: "/models", status: "Built" },
  { tool: "Metabase", logo: "metabase", basalt: "Saved queries, dashboards and CSV exports", href: "/dashboards", status: "Built" },
];
export default function Standards() {
  return (
    <>
      <PageHead title="Standards and formats" />
      <div className="body">
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Tool or standard</th><th>In Basalt</th><th>Status</th></tr></thead><tbody>
          {ROWS.map((r) => <tr key={r.tool}><td style={{ whiteSpace: "nowrap" }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}>{r.logo ? <Logo name={r.logo} size={18} /> : <Icon name="plug" size={18} />}<b>{r.tool}</b></div></td><td><Link className="plain-link" href={r.href}>{r.basalt}</Link></td><td><span className={`badge ${r.status === "Built" ? "good" : "warn"}`}>{r.status}</span></td></tr>)}
        </tbody></table></div>
        <div style={{ display: "flex", gap: 16 }}><GoLink href="/docs/current-limits">Current limits</GoLink><GoLink href="/docs/how-basalt-handles-data">How Basalt handles data</GoLink></div>
      </div>
    </>
  );
}
