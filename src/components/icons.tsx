import type { SVGProps } from "react";
import { RICH_LOGOS } from "./brandLogos";
import { siApacheparquet, siApachekafka, siClickhouse, siDatabricks, siDuckdb, siGoogleanalytics, siGooglebigquery, siGooglesheets, siHubspot, siJson, siMariadb, siMongodb, siMysql, siPostgresql, siShopify, siSnowflake, siSqlite, siStripe, siZendesk, siGooglecloudstorage, siAirbyte, siMetabase, siAirtable, siApachesuperset } from "simple-icons";

const rr = (x: number, y: number, w: number, h: number, r = 2) => `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1-${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1-${r}-${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r}-${r}z`;
const ci = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0-${2 * r} 0z`;

const paths = {
  home: "M3 8.800 10 3l7 5.800V16a1 1 0 0 1-1 1h-3.500v-5h-5v5H4a1 1 0 0 1-1-1z",
  plug: "M7.500 2.500V6M12.500 2.500V6M5 6h10v3a5 5 0 0 1-10 0zM10 14v3.500",
  flow: `${rr(2.500, 3.500, 6, 4.500, 1)}${rr(11.500, 12, 6, 4.500, 1)}M8.500 5.750h2a4 4 0 0 1 4 4V12`,
  catalog: `${rr(3.500, 2.500, 13, 15)}M7 6.500h6M7 10h6M7 13.500h3.500`,
  model: "M10 2.500 16.500 6.250v7.500L10 17.500 3.500 13.750v-7.500zM3.500 6.250 10 10l6.500-3.750M10 10v7.500",
  table: `${rr(3, 4, 14, 12)}M3 8.500h14M3 12.250h14M8 8.500V16`,
  code: "M6.500 6 2.500 10l4 4M13.500 6l4 4-4 4M11.200 4.500 8.800 15.500",
  dashboard: `${rr(3, 3, 6, 8, 1.500)}${rr(11, 3, 6, 5, 1.500)}${rr(11, 10, 6, 7, 1.500)}${rr(3, 13, 6, 4, 1.500)}`,
  chart: "M3 17h14M5.500 14v-4M10 14V4M14.500 14V7.500",
  metric: "M3 14.500a7 7 0 1 1 14 0M10 14.500l3-4.500M3 17.500h14",
  shield: "M10 2.500 16.500 5v5c0 4-2.700 6.500-6.500 7.500C6.200 16.500 3.500 14 3.500 10V5zM7.300 10l1.900 1.900 3.500-3.800",
  history: "M3.500 10a6.500 6.500 0 1 0 2-4.700L3 7.500M3 3.500v4h4M10 6.500V10l2.500 1.500",
  people: "M7 9.500a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 16.500c0-3 2.200-4.500 5-4.500s5 1.500 5 4.500M13 4a3 3 0 0 1 0 5.500M14.500 12c2 .4 3.500 1.900 3.500 4.500",
  settings: `M3 6h6.500M13.500 6H17M3 14h3M10 14h7${ci(11.500, 6, 2)}${ci(8, 14, 2)}`,
  book: "M3 4h6a1 1 0 0 1 1 1v12a1 1 0 0 0-1-1H3zM17 4h-6a1 1 0 0 0-1 1v12a1 1 0 0 1 1-1h6z",
  search: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM13.500 13.500 17.500 17.500",
  plus: "M10 4v12M4 10h12",
  play: "M6 3.500 16 10 6 16.500z",
  pause: "M7 4v12M13 4v12",
  x: "M5 5l10 10M15 5 5 15",
  check: "M4 10.500 8 14.500 16 5.500",
  warn: "M8.700 3.700 2.600 14.500a1.500 1.500 0 0 0 1.300 2.200h12.200a1.500 1.500 0 0 0 1.300-2.200L11.300 3.700a1.500 1.500 0 0 0-2.600 0zM10 8v3.500M10 14.200v.1",
  info: "M10 17.500a7.500 7.500 0 1 0 0-15 7.500 7.500 0 0 0 0 15zM10 9v5M10 6v.2",
  chevDown: "M5 8l5 5 5-5",
  chevRight: "M8 5l5 5-5 5",
  arrowRight: "M4 10h12M11 5l5 5-5 5",
  arrowLeft: "M16 10H4M9 5l-5 5 5 5",
  menu: "M3 5h14M3 10h14M3 15h14",
  filter: "M3 4h14l-5.500 6.500V16l-3-1.500v-4z",
  sort: "M6 16V4M3 7l3-3 3 3M14 4v12M11 13l3 3 3-3",
  eye: "M2 10s3-5.500 8-5.500S18 10 18 10s-3 5.500-8 5.500S2 10 2 10zM10 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  palette: "M10 2.500a7.500 7.500 0 1 0 0 15c1.500 0 1.800-1.200 1.200-2-.8-1.100 0-2.500 1.300-2.500h2c1.500 0 3-1 3-3 0-4-3.500-7.500-7.500-7.500zM6.500 8v.2M10 5.500v.2M13.500 8v.2",
  density: "M3 5h14M3 9h14M3 13h14M3 17h14",
  download: "M10 3v10M6 9.500 10 13.500 14 9.500M3 17h14",
  upload: "M10 14V4M6 7.500 10 3.500 14 7.500M3 17h14",
  save: "M5 3h8.500L17 6.500V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v4h5.500V3M6.500 17v-6h7v6",
  trash: "M3.500 5.500h13M8 5.500V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.500M5 5.500l.7 10.600a1 1 0 0 0 1 .9h6.600a1 1 0 0 0 1-.9L15 5.500M8.500 9v4.500M11.500 9v4.500",
  edit: "M4 16l1-4 8.500-8.500 3 3L8 15zM12 5l3 3",
  copy: `${rr(7, 7, 10, 10)}M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2`,
  sun: `${ci(10, 10, 3.500)}M10 2.500v1.500M10 16v1.500M2.500 10H4M16 10h1.500M4.700 4.700l1 1M14.300 14.300l1 1M4.700 15.300l1-1M14.300 5.700l1-1`,
  moon: "M16.500 12A7 7 0 0 1 8 3.500 7 7 0 1 0 16.500 12z",
  refresh: "M16.500 10a6.500 6.500 0 0 1-11.300 4.400M3.500 10a6.500 6.500 0 0 1 11.300-4.400M15 2.500v3.300h-3.300M5 17.500v-3.300h3.300",
  lineage: `${rr(2.500, 7.750, 5, 4.500, 1)}${rr(12.500, 3, 5, 4.500, 1)}${rr(12.500, 12.500, 5, 4.500, 1)}M7.500 10H10M10 5.250V14.750M10 5.250h2.500M10 14.750h2.500`,
  apps: `${rr(3, 3, 6, 6, 1)}${rr(11, 3, 6, 6, 1)}${rr(3, 11, 6, 6, 1)}M14 11v6M11 14h6`,
  grid: `${rr(3, 3, 6, 6, 1.500)}${rr(11, 3, 6, 6, 1.500)}${rr(3, 11, 6, 6, 1.500)}${rr(11, 11, 6, 6, 1.500)}`,
  board: `${rr(3, 3, 4, 14, 1)}${rr(8, 3, 4, 9, 1)}${rr(13, 3, 4, 6, 1)}`,
  pivot: `${rr(3, 3, 14, 14)}M3 7.500h14M7.500 3v14`,
  bar: `${rr(3, 3.500, 9, 3, .750)}${rr(3, 8.500, 14, 3, .750)}${rr(3, 13.500, 6, 3, .750)}`,
  column: `${rr(3.500, 8, 3, 9, .750)}${rr(8.500, 3, 3, 14, .750)}${rr(13.500, 11, 3, 6, .750)}`,
  stacked: `${rr(3.500, 7, 3, 10, .750)}M3.500 11.500h3${rr(8.500, 3, 3, 14, .750)}M8.500 9h3${rr(13.500, 9, 3, 8, .750)}M13.500 13h3`,
  line: "M3 15l4-5 4 2 6-8",
  area: "M3 16v-4l4-5 4 2 6-6v13z",
  combo: "M4 12h3v5H4zM9 9h3v8H9zM14 11h3v6h-3zM3 8l5-3 4 2 5-4",
  pie: "M10 2.500a7.500 7.500 0 1 0 7.500 7.500H10z",
  donut: "M10 2.500a7.500 7.500 0 1 0 0 15 7.500 7.500 0 0 0 0-15zM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  scatter: "M3 3v14h14M7 12v.2M10 7v.2M13 10v.2M15 5v.2M6 7v.2",
  heat: "M3 3h4.500v4.500H3zM7.500 3H12v4.500H7.500zM12 3h4.500v4.500H12zM3 7.500h4.500V12H3zM7.500 7.500H12V12H7.500zM12 7.500h4.500V12H12zM3 12h4.500v4.500H3zM7.500 12H12v4.500H7.500zM12 12h4.500v4.500H12z",
  treemap: `${rr(3, 3, 14, 14)}M11 3v14M11 10h6M3 12h8`,
  funnel: "M2.500 3.500h15L13 9H7zM7 9h6l-1.500 4h-3zM8.500 13h3v3.500h-3z",
  gauge: "M3 14a7 7 0 1 1 14 0M10 14l3.500-5M2 14h2M16 14h2",
  waterfall: "M3 11h3v6H3zM7 7h3v4H7zM11 4h3v3h-3zM15 4h3v13h-3z",
  kpi: `${rr(3, 4, 14, 12)}M6.500 12.500l2-5 2 5M7.300 11h2.400M13 8v4.500`,
  slicer: "M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M9 13v4",
  text: "M4 5V3.500h12V5M10 3.500v13M7.500 16.500h5",
  logout: "M8 3H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3M13 6.500 16.500 10 13 13.500M16.500 10H8",
  sidebar: `${rr(3, 4, 14, 12)}M8 4v12`,
  bell: "M5 13.500V9a5 5 0 0 1 10 0v4.500l1.500 2h-13zM8.300 17.500a1.800 1.800 0 0 0 3.400 0",
  db: "M4 5c0-1.400 2.700-2.500 6-2.500s6 1.100 6 2.500-2.700 2.500-6 2.500S4 6.400 4 5zM4 5v10c0 1.400 2.700 2.500 6 2.500s6-1.100 6-2.500V5M4 10c0 1.400 2.700 2.500 6 2.500s6-1.100 6-2.500",
  file: "M6 2.500h6l4 4V16a1.500 1.500 0 0 1-1.500 1.500H6A1.500 1.500 0 0 1 4.500 16V4A1.500 1.500 0 0 1 6 2.500zM12 2.500v4h4",
  key: "M7 13a4 4 0 1 1 3.200-1.600L17 18M13.500 14.500l2-2",
  link: "M8 12l4-4M7 9l-2 2a3 3 0 0 0 4 4l2-2M13 11l2-2a3 3 0 0 0-4-4L9 7",
  pipeline: "M2.500 7.500h5.500a2 2 0 0 1 2 2v1a2 2 0 0 0 2 2h5.500M2.500 4.500v6M17.500 9.500v6",
  workflow: `${ci(4.500, 10, 2)}${ci(15.500, 4.500, 2)}${ci(15.500, 15.500, 2)}M6.500 10h3M9.500 4.500h4M9.500 15.500h4M9.500 4.500v11`,
  standards: "M4.500 5l1.500 1.500L8.500 4M4.500 10.500 6 12l2.500-2.500M4.500 16 6 17.500 8.500 15M11 5.500h6M11 11h6M11 16.500h6",
  base: "M10 2.500 17.500 6.250 10 10 2.500 6.250zM2.500 10 10 13.750 17.500 10M2.500 13.750 10 17.500l7.500-3.750",
  lock: `${rr(4, 9, 12, 8.500)}M6.500 9V6.500a3.500 3.500 0 0 1 7 0V9`,
  barcode: "M3 5v10M6 5v10M9 5v10M11.500 5v10M14.500 5v10M17 5v10",
  clock: "M10 17.500a7.500 7.500 0 1 0 0-15 7.500 7.500 0 0 0 0 15zM10 6v4l2.500 2",
  dots: `${ci(4, 10, .9)}${ci(10, 10, .9)}${ci(16, 10, .9)}`,
  fieldText: "M3 15 6.500 5 10 15M4.300 12h4.400M16.500 9v6M16.500 12a2.500 2.500 0 1 1-5 0 2.500 2.500 0 0 1 5 0z",
  fieldNumber: "M7.500 3.500 6 16.500M14 3.500l-1.500 13M3.500 7.500h13M3 12.500h13",
  fieldDate: `${rr(3.500, 4.500, 13, 12)}M3.500 8.500h13M7 3v3M13 3v3`,
  fieldBool: `${rr(3.500, 3.500, 13, 13)}M6.500 10l2.500 2.500 4.500-5`,
  fieldJson: "M7 3.500c-2 0-2 1-2 3s-1 3.500-2 3.500c1 0 2 1.500 2 3.500s0 3 2 3M13 3.500c2 0 2 1 2 3s1 3.500 2 3.500c-1 0-2 1.500-2 3.500s0 3-2 3",
};
export type IconName = keyof typeof paths;

export function Icon({ name, size = 18, ...p }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><path d={paths[name]} /></svg>;
}

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Basalt logo" style={{ flex: "none" }}>
      <path d="M11.30 3.10L15.41 5.47L15.41 10.22L11.30 12.60L7.19 10.22L7.19 5.47ZM20.70 3.10L24.81 5.47L24.81 10.22L20.70 12.60L16.59 10.22L16.59 5.47ZM6.60 11.25L10.71 13.62L10.71 18.38L6.60 20.75L2.49 18.38L2.49 13.62ZM25.40 11.25L29.51 13.62L29.51 18.38L25.40 20.75L21.29 18.38L21.29 13.62ZM11.30 19.40L15.41 21.77L15.41 26.52L11.30 28.90L7.19 26.52L7.19 21.77ZM20.70 19.40L24.81 21.77L24.81 26.52L20.70 28.90L16.59 26.52L16.59 21.77Z" fill="var(--logo-ink, #1f2937)" />
      <path d="M16.00 11.25L20.11 13.62L20.11 18.38L16.00 20.75L11.89 18.38L11.89 13.62Z" fill="#1457d2" />
    </svg>
  );
}

const brands = { gcs: siGooglecloudstorage, kafka: siApachekafka, postgres: siPostgresql, mysql: siMysql, mariadb: siMariadb, sqlite: siSqlite, mongodb: siMongodb, clickhouse: siClickhouse, snowflake: siSnowflake, databricks: siDatabricks, bigquery: siGooglebigquery, stripe: siStripe, hubspot: siHubspot, shopify: siShopify, ganalytics: siGoogleanalytics, zendesk: siZendesk, sheets: siGooglesheets, parquet: siApacheparquet, json: siJson, duckdb: siDuckdb, airbyte: siAirbyte, metabase: siMetabase, airtable: siAirtable, superset: siApachesuperset };
export type BrandName = keyof typeof brands | keyof typeof RICH_LOGOS;
/** Real product logos; near-black ones switch to the ink colour so they stay visible in dark mode. */
export function Logo({ name, size = 22 }: { name: BrandName; size?: number }) {
  if (name in RICH_LOGOS) { const r = RICH_LOGOS[name as keyof typeof RICH_LOGOS]; return <svg role="img" aria-label={r.title} width={size} height={size} viewBox={r.box} style={{ flex: "none" }} dangerouslySetInnerHTML={{ __html: r.body }} />; }
  const b = brands[name as keyof typeof brands], dark = parseInt(b.hex.slice(0, 2), 16) + parseInt(b.hex.slice(2, 4), 16) + parseInt(b.hex.slice(4, 6), 16) < 90;
  return <svg role="img" aria-label={b.title} width={size} height={size} viewBox="0 0 24 24" fill={dark ? "currentColor" : `#${b.hex}`} style={{ flex: "none" }}><path d={b.path} /></svg>;
}
