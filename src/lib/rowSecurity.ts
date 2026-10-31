import type { DuckDBConnection } from "@duckdb/node-api";
import { lit, q } from "./sql.ts";
import type { RlsRule } from "./types.ts";

export const SAFE_FUNCTIONS = new Set(["range", "generate_series", "unnest", "json_each", "json_tree"]);
const CATALOG_SCHEMAS = new Set(["information_schema", "pg_catalog"]);
export type Node = Record<string, unknown>;

export function walk(n: unknown, f: (o: Node) => void) {
  if (Array.isArray(n)) n.forEach((x) => walk(x, f));
  else if (n && typeof n === "object") { f(n as Node); Object.values(n).forEach((x) => walk(x, f)); }
}
// JSON numbers past 2^53 (query positions, large literals) must survive the round trip digit for digit
const rawJson = JSON as unknown as { rawJSON(s: string): unknown; parse(t: string, r: (k: string, v: unknown, ctx: { source?: string }) => unknown): unknown };
export const parseExact = (t: string) => rawJson.parse(t, (_k, v, ctx) => (typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v) && ctx.source ? rawJson.rawJSON(ctx.source) : v)) as Node & { error?: boolean; statements?: unknown[] };
export const rows = async (c: DuckDBConnection, sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];

/** Failing rows copied by dbt's store_failures. They aren't modelled output and can hold rows from a table someone was refused, so only editors read them. */
export const STORED_FAILURES = /_dbt_test__audit$/i;
const VIEW_SOURCE = new Set(["pg_views", "sqlite_master", "sqlite_schema", "sqlite_temp_master", "sqlite_temp_schema", "duckdb_views", "duckdb_functions"]);
const NOT_FOR_VIEWERS = new Set(["query", "query_table", "duckdb_views", "duckdb_functions"]);
// Plans, descriptions and summaries don't serialize, so they're checked as text. Identifiers can't be escaped in DuckDB, so a name can't be hidden from this.
const NOT_FOR_VIEWERS_TEXT = /dbt_test__audit|\bquery(_table)?\b|\bviews\b|pg_views|duckdb_views|duckdb_functions|sqlite_(temp_)?(master|schema)|view_definition/i;
export type ViewerLimits = { revoked: Set<string>; stageClosed: (schema: string, name: string) => boolean; limited: boolean };

/** What a viewer's query has to pass before it runs. Someone with no limits keeps plans, descriptions and other table functions. */
export async function checkViewerRead(c: DuckDBConnection, sql: string, { revoked, stageClosed, limited }: ViewerLimits, denied: (msg: string) => Error = (msg) => new Error(msg)) {
  const parsed = parseExact(String((await rows(c, `SELECT json_serialize_sql(${lit(sql)}) AS s`))[0].s));
  if (parsed.error) {
    if (limited) throw denied("Your access allows SELECT queries only.");
    if (NOT_FOR_VIEWERS_TEXT.test(sql)) throw denied("Your access doesn't allow this query.");
    return;
  }
  const ctes = new Set<string>();
  walk(parsed, (o) => { const m = (o.cte_map as { map?: { key: string }[] } | undefined)?.map; m?.forEach((e) => ctes.add(e.key.toLowerCase())); });
  walk(parsed, (o) => {
    if (o.type === "TABLE_FUNCTION") {
      const fn = String((o.function as Node | undefined)?.function_name ?? "").toLowerCase();
      if (limited ? !SAFE_FUNCTIONS.has(fn) : NOT_FOR_VIEWERS.has(fn)) throw denied("Your access doesn't allow this function in a query.");
    }
    if (typeof o.table_name !== "string") return;
    const schema = String(o.schema_name || "").toLowerCase(), name = o.table_name.toLowerCase();
    if (STORED_FAILURES.test(schema)) throw denied("Only editors can read stored check failures.");
    if (VIEW_SOURCE.has(name) || (schema === "information_schema" && name === "views")) throw denied("Only editors can read how views are built.");
    if (revoked.has(`${schema || "main"}.${name}`)) throw denied(`You don't have access to ${schema || "main"}.${name}.`);
    // A name with no schema is either a CTE or a table in main, and closing a layer must cover main too
    if (!CATALOG_SCHEMAS.has(schema) && !(!schema && ctes.has(name)) && stageClosed(schema || "main", name)) throw denied(`You don't have access to ${schema || "main"}.${name}.`);
  });
}

/**
 * Row-level security for restricted users. DuckDB has none built in, so the query is parsed and every table it reads is swapped for a filtered
 * temporary view on this connection. It fails closed: a table without a rule column, and anything this code doesn't recognise, is refused.
 */
export async function applyRowSecurity(c: DuckDBConnection, sql: string, rules: RlsRule[], denied: (msg: string) => Error = (msg) => new Error(msg)): Promise<string> {
  const parsed = parseExact(String((await rows(c, `SELECT json_serialize_sql(${lit(sql)}) AS s`))[0].s));
  if (parsed.error || parsed.statements?.length !== 1) throw denied("Your access allows one SELECT query at a time.");
  const ctes = new Set<string>();
  walk(parsed, (o) => { const m = (o.cte_map as { map?: { key: string }[] } | undefined)?.map; m?.forEach((e) => ctes.add(e.key.toLowerCase())); });

  const columns = new Map<string, string[]>();
  for (const r of await rows(c, `SELECT table_schema s, table_name t, column_name n FROM information_schema.columns WHERE table_schema NOT IN ('information_schema','pg_catalog')`)) {
    const k = `${r.s}.${r.t}`.toLowerCase(); columns.set(k, [...(columns.get(k) ?? []), String(r.n)]);
  }
  const views = new Map<string, string>();
  const refs: Node[] = [];
  walk(parsed, (o) => {
    if (o.type === "TABLE_FUNCTION") {
      const fn = String((o.function as Node | undefined)?.function_name ?? "").toLowerCase();
      if (!SAFE_FUNCTIONS.has(fn)) throw denied("Your access doesn't allow this function in a query.");
    }
    if (typeof o.table_name === "string") {
      if (o.type !== "BASE_TABLE") throw denied("Your access doesn't allow this kind of query.");
      refs.push(o);
    }
  });
  for (const o of refs) {
    const schema = String(o.schema_name ?? "").toLowerCase(), name = String(o.table_name).toLowerCase();
    // CTE names aren't tracked by scope, so a name that's also a real table is refused below rather than trusted
    if (!schema && ctes.has(name) && !columns.has(`main.${name}`)) continue;
    if (CATALOG_SCHEMAS.has(schema)) continue;
    if (!schema || o.catalog_name) throw denied("Refer to tables by schema and name, such as analytics.orders.");
    const cols = columns.get(`${schema}.${name}`);
    if (!cols) throw denied(`You don't have access to ${schema}.${name}.`);
    const lower = new Map(cols.map((x) => [x.toLowerCase(), x]));
    const applicable = rules.filter((r) => lower.has(r.column.toLowerCase()));
    if (!applicable.length) throw denied(`You don't have access to ${schema}.${name}, because it can't be limited to the data you're allowed to see.`);
    const key = `${schema}.${name}`;
    if (!views.has(key)) {
      const view = `__rls_${views.size}`;
      const byColumn = new Map<string, string[]>();
      for (const r of applicable) { const col = lower.get(r.column.toLowerCase())!; byColumn.set(col, [...(byColumn.get(col) ?? []), ...r.values]); }
      // values for one field widen access; different fields narrow it
      const where = [...byColumn].map(([col, vals]) => (vals.length ? `CAST(${q(col)} AS VARCHAR) IN (${vals.map(lit).join(", ")})` : "FALSE")).join(" AND ");
      await c.run(`CREATE OR REPLACE TEMP VIEW ${view} AS SELECT * FROM ${q(String(o.schema_name))}.${q(String(o.table_name))} WHERE ${where}`);
      views.set(key, view);
    }
    const view = views.get(key)!;
    if (!o.alias) o.alias = o.table_name; // keeps "orders.city" valid in the rewritten query
    o.schema_name = ""; o.catalog_name = ""; o.table_name = view;
    // DuckDB also keeps the name here, and rendering from the stale copy would run the query unfiltered
    if (o.qualified_name) o.qualified_name = { path: [view] };
  }
  const out = String((await rows(c, `SELECT json_deserialize_sql(${lit(JSON.stringify(parsed))}) AS s`))[0].s);
  // Last check: the rewritten query must not name a protected table directly
  const check = parseExact(String((await rows(c, `SELECT json_serialize_sql(${lit(out)}) AS s`))[0].s));
  walk(check, (o) => { if (typeof o.table_name === "string" && o.schema_name && !CATALOG_SCHEMAS.has(String(o.schema_name).toLowerCase())) throw denied("This query couldn't be limited to the data you're allowed to see."); });
  return out;
}
