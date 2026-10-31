import dns from "node:dns/promises";
import net from "node:net";
import { isInternal } from "./webhook.ts";
import type { Connection } from "./types.ts";

/** Set when Basalt runs on our servers for customers, rather than on a customer's own machine. Things that are fine on your own server aren't fine on ours. */
export const isHosted = (env: Record<string, string | undefined> = process.env) => env.BASALT_HOSTED === "1";

const NOT_HOSTED = "isn't available on hosted workspaces";
/** Connections whose address someone types. A Snowflake account or BigQuery location isn't an address on a network. */
const ADDRESSED = new Set(["postgres", "mysql", "redshift", "mssql", "synapse", "cosmos", "s3", "gcs", "dynamodb", "athena", "azure"]);

/** The host names a connection will reach, including one inside an Azure connection string. */
export function connectionHosts(conn: Pick<Connection, "type" | "host" | "auth">, secret = ""): string[] {
  if (!ADDRESSED.has(conn.type)) return [];
  const raw = [conn.host ?? "", ...(conn.type === "azure" && conn.auth === "string" ? [...secret.matchAll(/(?:Blob|Dfs)Endpoint=([^;]+)/gi)].map((m) => m[1]) : [])];
  return raw.map((h) => h.trim()).filter(Boolean).map((h) => { try { return new URL(/:\/\//.test(h) ? h : `https://${h}`).hostname.replace(/^\[|\]$/g, ""); } catch { return h; } });
}

/**
 * What stops a connection on a hosted workspace. On our servers, "this server's identity" would hand a customer our cloud account, and an internal address would let them reach our network.
 * shortcut: a name is checked when the connection opens, so one that later changes to an internal address could slip through; add a network rule blocking internal ranges from customer containers when hosting starts.
 */
export async function hostedProblem(conn: Pick<Connection, "type" | "host" | "auth">, secret = "", resolve: (h: string) => Promise<{ address: string }[]> = (h) => dns.lookup(h, { all: true })): Promise<string | null> {
  if (conn.type === "airbyte") return `Airbyte connectors run code on the server, so they ${NOT_HOSTED} yet.`;
  if (conn.auth === "chain") return `Signing in with this server's own identity ${NOT_HOSTED}. Use a role in your own account, or a key.`;
  for (const h of connectionHosts(conn, secret)) {
    const list = net.isIP(h) ? [{ address: h }] : await resolve(h).catch(() => []);
    if (list.some((a) => isInternal(a.address))) return "This address points to an internal network, which a hosted workspace can't reach.";
  }
  return null;
}
export async function assertHostedAllowed(conn: Pick<Connection, "type" | "host" | "auth">, secret = "") {
  if (!isHosted()) return;
  const why = await hostedProblem(conn, secret);
  if (why) throw new Error(why);
}
/** Python runs as code on the server, with nothing yet to contain it from other customers on the same machine. */
export function assertCodeAllowed() { if (isHosted()) throw new Error(`Running Python ${NOT_HOSTED} yet.`); }

/** Keeps the newest entries to hand. What falls off goes to the archive, oldest first, so nothing in the audit trail is ever lost. */
export function rotateAudit<T>(entries: T[], keep: number) { return { recent: entries.slice(0, keep), archive: entries.slice(keep).reverse() }; }
