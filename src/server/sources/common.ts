import type { Column, Connection, StreamInfo } from "../../lib/types.ts";
import type { Source } from "../connectors.ts";

/** Region, credentials and optional endpoint for an AWS SDK client. Throttling is left to the SDK's adaptive retry, which follows the service's backoff. */
export function awsConfig(conn: Connection, secret: string) {
  if (!conn.region) throw new Error("Enter the region.");
  return {
    region: conn.region, maxAttempts: 8, retryMode: "adaptive" as const,
    ...(conn.host ? { endpoint: conn.host } : {}),
    // Left unset, the SDK looks for the IAM role or instance identity of this server
    ...(conn.auth === "chain" ? {} : { credentials: { accessKeyId: conn.user ?? "", secretAccessKey: secret } }),
  };
}

/** A JSON parse error quotes the text it read, and this text is a private key, so the error never goes further. */
export function gcpKey(secret: string) {
  let key: { project_id?: string; client_email?: string; private_key?: string };
  try { key = JSON.parse(secret); } catch { throw new Error("Paste the service account key as JSON."); }
  if (!key.client_email || !key.private_key || !key.project_id) throw new Error("This service account key is missing its project, email or private key.");
  return { projectId: key.project_id, credentials: { client_email: key.client_email, private_key: key.private_key } };
}

export const NOT_COUNTED = "This source has no way to count rows without reading them.";

/** Every field the catalog knows of, which a read needs to tell an unseen field from one left out on purpose. */
export async function knownFields(stream: string, catalog: Map<string, StreamInfo>, columns: Column[], src: Pick<Source, "discover">) {
  if (!catalog.has(stream)) await src.discover();
  return new Set([...(catalog.get(stream)?.columns ?? []), ...columns].map((c) => c.name));
}
