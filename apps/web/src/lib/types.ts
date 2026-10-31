import type { QueryParam } from "./query.ts";
import type { Sem, SemanticModel } from "./semantic.ts";
import type { Step } from "./transform.ts";

export type Role = "admin" | "editor" | "viewer";
export type Rule = "keep" | "mask" | "hash" | "month" | "drop";
export type SyncMode = "full_refresh" | "incremental_append" | "incremental_dedupe";
export type ConnectorType = "sample" | "file" | "postgres" | "mysql" | "s3" | "gcs" | "azure" | "bigquery" | "snowflake" | "airbyte" | "dynamodb" | "athena" | "redshift" | "firestore" | "spanner" | "cosmos" | "mssql" | "synapse";

export type Column = { name: string; type: string };
export type Kind = "number" | "date" | "bool" | "text" | "json";
export type Result = { columns: (Column & { kind: Kind })[]; rows: Record<string, unknown>[]; ms: number; truncated: boolean };

/** A pinned Airbyte connector. Holds no settings or secrets: those are in the encrypted secret store. */
export type AirbyteRef = { definitionId: string; name: string; repo: string; version: string; license?: string; icon?: string; routes: ("docker" | "pypi" | "manifest")[]; pypi?: string; cdk?: string; idleSeconds?: number; secretKeys: string[] };
export type Connection = {
  id: string; name: string; type: ConnectorType; slug: string;
  host?: string; port?: number; database?: string; user?: string; ssl?: boolean; createdAt: string;
  /** Bucket folder, BigQuery dataset or Snowflake schema. */
  prefix?: string; region?: string; warehouse?: string; airbyte?: AirbyteRef;
  /** Most read capacity units a second a DynamoDB read may use. `warehouse` also holds an Athena workgroup or Spanner instance. */
  capacity?: number;
  /** How storage signs in. Unset means an access key; "chain" uses the identity of the machine Basalt runs on; "role" assumes a role in the customer's AWS account; "principal" is an Azure service principal, with its client secret in the secret store; "serviceAccount" is a Google service account key for Cloud Storage. */
  auth?: "string" | "chain" | "role" | "principal" | "serviceAccount";
  roleArn?: string; tenantId?: string; clientId?: string;
  /** PEM certificates for a PostgreSQL server signed by a private CA. caOnly skips the host name check, for servers whose certificate doesn't name the host. */
  ca?: string; caOnly?: boolean;
};
export type StreamInfo = { name: string; columns: Column[]; primaryKey?: string; rowCount?: number; cursor?: string };
export type StreamCfg = { name: string; enabled: boolean; mode: SyncMode; cursor?: string; primaryKey?: string; rules: Record<string, Rule>; maxRows?: number };
export type Pipeline = {
  trackDeletes?: boolean;
  id: string; name: string; connectionId: string; schedule: number; // minutes, 0 = manual
  runModelsAfter: boolean; paused: boolean; rebuildOnChange?: boolean; retries?: number; staleHours?: number; streams: StreamCfg[];
};
export type StreamStat = { deleted?: number; name: string; status: "ok" | "failed" | "skipped"; read: number; written: number; sourceRows?: number; copyRows?: number; heldBack: string[]; error?: string };
export type LogMessage = { type: "LOG" | "CATALOG" | "RECORD" | "STATE" | "TRACE"; at: string; stream?: string; level?: "INFO" | "WARN" | "ERROR"; message?: string; records?: number; state?: unknown; catalog?: unknown };
import type { Notebook } from "./notebook.ts";
export type Run = {
  id: string; kind: "sync" | "models" | "flow" | "export" | "notebook"; refId: string; name: string; status: "running" | "succeeded" | "partial" | "failed";
  startedAt: string; endedAt?: string; trigger: "manual" | "schedule" | "setup"; actor: string;
  streams?: StreamStat[]; messages?: LogMessage[]; artifacts?: Record<string, unknown>; summary?: string;
};

export type ModelTest = { type: "not_null" | "unique" | "accepted_values" | "relationships" | "range" | "row_count" | "freshness" | "custom" | "generic"; column: string; values?: string[]; to?: string; field?: string; min?: number; max?: number; hours?: number; sql?: string; block?: boolean; macro?: string; severity?: "error" | "warn"; errorIf?: string; warnIf?: string; storeFailures?: boolean; where?: string };
export type ContractColumn = { name: string; type: string; notNull?: boolean; unique?: boolean; primaryKey?: boolean };
export type Model = { id: string; name: string; description: string; generated?: boolean; kind?: "sql" | "steps" | "python" | "seed"; base?: string; steps?: Step[]; params?: QueryParam[]; python?: string; materialized: "view" | "table" | "incremental" | "snapshot" | "ephemeral"; uniqueKey?: string; cursor?: string; /** Days before the newest row to read again, so rows that arrive late aren't missed. Needs a unique key. */ lookbackDays?: number; sql: string; tests: ModelTest[]; owner: string; columnDocs?: Record<string, string>; csv?: string; tags?: string[]; incrementalStrategy?: "append" | "merge" | "delete+insert"; onSchemaChange?: "ignore" | "append_new_columns" | "sync_all_columns" | "fail"; snapshotStrategy?: "timestamp" | "check"; updatedAt?: string; checkCols?: string; hardDeletes?: "ignore" | "invalidate"; preHook?: string[]; postHook?: string[]; contract?: ContractColumn[]; jinja?: boolean };
export type FreshnessRule = { count: number; period: "minute" | "hour" | "day" };
export type SourceDef = { source: string; table: string; description?: string; loadedAtField?: string; warnAfter?: FreshnessRule; errorAfter?: FreshnessRule; filter?: string };
export type Exposure = { name: string; type: "dashboard" | "notebook" | "analysis" | "ml" | "application"; ownerName: string; ownerEmail?: string; url?: string; description?: string; maturity?: "low" | "medium" | "high"; dependsOn: string[] };
export type Project = { vars?: Record<string, unknown>; macros?: string; sources?: SourceDef[]; exposures?: Exposure[]; dbtMacros?: string };

export type FilterOp = "eq" | "neq" | "contains" | "not_contains" | "starts" | "gt" | "gte" | "lt" | "lte" | "between" | "in" | "not_in" | "in_query" | "empty" | "not_empty" | "last_days";
export type Filter = { id: string; column: string; op: FilterOp; value?: string; value2?: string; values?: string[]; group?: string };
export type Sort = { column: string; dir: "asc" | "desc" };
export type ColorRule = { id: string; column: string; op: FilterOp; value?: string; tone: "good" | "warn" | "bad" | "info" | "violet"; scope?: "cell" | "row" };
export type Agg = "sum" | "avg" | "count" | "count_distinct" | "min" | "max" | "median";
export type DataView = {
  id: string; name: string; table: string; layout: "grid" | "board" | "gallery" | "pivot";
  filters: Filter[]; match: "all" | "any"; sorts: Sort[]; hidden: string[]; order?: string[]; widths: Record<string, number>; frozen: number;
  density: "compact" | "regular" | "roomy"; groupBy?: string; titleColumn?: string; colorRules: ColorRule[];
  pivotRow?: string; pivotCol?: string; pivotValue?: string; pivotAgg?: Agg; shared: boolean; summaries?: Record<string, Agg>; labels?: Record<string, string>; formats?: Record<string, string>; chips?: string[]; colorBy?: string;
};

export type Measure = { column: string; agg: Agg; label?: string; expr?: string; dax?: string };
export type CfRule = { mode: "none" | "scale" | "bars" | "rules"; rules?: { op: "gt" | "lt"; value: number; tone: "good" | "warn" | "bad" }[] };
export type VisualType = "kpi" | "bar" | "column" | "stacked_column" | "line" | "area" | "combo" | "pie" | "donut" | "scatter" | "heatmap" | "treemap" | "funnel" | "gauge" | "waterfall" | "table" | "matrix" | "decomp" | "slicer" | "text" | "custom";
export type Widget = {
  id: string; title: string; type: VisualType; x: number; y: number; w: number; h: number;
  /** A custom visual's chart, in JSON. */
  spec?: string;
  /** Reads the semantic model: its fields are written Table[column]. semantic is added when it runs and never saved. */
  model?: boolean; semantic?: Sem;
  table: string; dimension?: string; series?: string; dateGrain?: "day" | "week" | "month" | "quarter" | "year"; measures: Measure[];
  filters: Filter[]; sort?: "value_desc" | "value_asc" | "label"; limit?: number; format?: "number" | "currency" | "percent" | "compact"; drillTo?: string; hierarchy?: string[]; tips?: Measure[]; palette?: string[]; daxMeasures?: Record<string, string>; rels?: NonNullable<Dashboard["relationships"]>; cf?: CfRule; calc?: "pct_total" | "running" | "change"; page?: string; trendDate?: string; showLabels?: boolean; showLegend?: boolean; target?: number; text?: string; pinnedFrom?: { dashboard: string; widget: string; name: string };
};
export type ReportBookmark = { id: string; name: string; page: string; slicers: Record<string, string[]>; cross: { widget: string; column: string; value: string } | null; drills: Record<string, string[]>; params: Record<string, number> };
export type Dashboard = { id: string; name: string; description: string; widgets: Widget[]; filters: Filter[]; owner: string; theme?: string; measures?: { id: string; name: string; dax: string }[]; pages?: { id: string; name: string }[]; bookmarks?: ReportBookmark[]; params?: { id: string; name: string; min: number; max: number; step: number; value: number }[]; relationships?: { id: string; fromTable: string; fromCol: string; toTable: string; toCol: string }[] };

export type Metric = { id: string; name: string; description: string; table: string; measure: Measure; dateColumn?: string; format: Widget["format"]; owner: string; folder?: string; kpi?: { target: number; higher: boolean } };
export type SavedQuery = { id: string; name: string; sql: string; owner: string; updatedAt: string };
export type Settings = { workspace: string; accent: string; theme: "light" | "dark" | "system"; density: "compact" | "regular"; currency: string; locale: string; timezone: string; buildEvery?: number };
export type Config = { notebooks?: Notebook[]; connections: Connection[]; pipelines: Pipeline[]; models: Model[]; views: DataView[]; dashboards: Dashboard[]; metrics: Metric[]; queries: SavedQuery[]; settings: Settings; project?: Project; semantic?: SemanticModel };
export type AuditEntry = { id: string; at: string; actor: string; action: string; detail: string; sensitive: boolean };
export type RlsRule = { id: string; userId: string; column: string; values: string[] };
export type SalesRequest = { id: string; at: string; name: string; email: string; company: string; teamSize: string; sources: string; message: string };
export type Member = { id: string; email: string; name: string; role: Role; createdAt: string };
