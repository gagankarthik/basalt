import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { JWT } from "google-auth-library";
import type { Column, Connection, StreamInfo } from "../../lib/types.ts";
import type { Source } from "../connectors.ts";

const asUrl = (host: string) => (/:\/\//.test(host) ? host : `https://${host}`);
type Sts = Pick<STSClient, "send">;
const stsFor = (conn: Pick<Connection, "region" | "host">): Sts => new STSClient({ region: conn.region || "us-east-1", ...(conn.host ? { endpoint: asUrl(conn.host) } : {}) });
const isDenied = (e: unknown) => /AccessDenied|not authorized/i.test(`${(e as Error)?.name} ${(e as Error)?.message}`);

export const ROLE_ARN = /^arn:aws[\w-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;

/** Temporary keys for a role in the customer's account. The caller is this server's own AWS identity, and the external ID is what ties the role to this workspace. */
export function roleCredentials(conn: Connection, externalId: string, sts: Sts = stsFor(conn)) {
  return async () => {
    try {
      const { Credentials: k } = await sts.send(new AssumeRoleCommand({ RoleArn: conn.roleArn, ExternalId: externalId, RoleSessionName: `basalt-${conn.slug || "test"}`.slice(0, 64), DurationSeconds: 3600 }));
      if (!k?.AccessKeyId || !k.SecretAccessKey) throw new Error("AWS returned no credentials for this role.");
      return { accessKeyId: k.AccessKeyId, secretAccessKey: k.SecretAccessKey, sessionToken: k.SessionToken, expiration: k.Expiration };
    } catch (e) {
      if (isDenied(e)) throw new Error("AWS refused to let Basalt use this role. Check the role's trust policy names Basalt's AWS account and this external ID, and that the role ARN is right.");
      if (/Could not load credentials|Credential/i.test(String((e as Error)?.message))) throw new Error("This server has no AWS identity of its own to assume a role with. Contact your administrator.");
      throw e;
    }
  };
}
/**
 * AWS's advice for reaching customer accounts: check the role can't be assumed without the external ID, and don't keep it if it can.
 * Otherwise anyone else using this service could reach this customer's data by naming the same role.
 */
export async function requireExternalId(conn: Connection, sts: Sts = stsFor(conn)) {
  try { await sts.send(new AssumeRoleCommand({ RoleArn: conn.roleArn, RoleSessionName: "basalt-check", DurationSeconds: 900 })); }
  catch (e) { if (isDenied(e)) return; throw e; }
  throw new Error("This role can be used without the external ID, which isn't safe. Add the sts:ExternalId condition to its trust policy, then test again.");
}
/** The AWS account a customer's trust policy has to name, or null when this server has no AWS identity. */
export async function awsAccount(sts: Sts = stsFor({})) {
  try { return (await sts.send(new GetCallerIdentityCommand({}))).Account ?? null; } catch { return null; }
}

/** Region, credentials and optional endpoint for an AWS SDK client. Throttling is left to the SDK's adaptive retry, which follows the service's backoff. */
export function awsConfig(conn: Connection, secret: string) {
  if (!conn.region) throw new Error("Enter the region.");
  return {
    region: conn.region, maxAttempts: 8, retryMode: "adaptive" as const,
    ...(conn.host ? { endpoint: conn.host } : {}),
    // Left unset, the SDK looks for the IAM role or instance identity of this server
    ...(conn.auth === "chain" ? {} : conn.auth === "role" ? { credentials: roleCredentials(conn, secret) } : { credentials: { accessKeyId: conn.user ?? "", secretAccessKey: secret } }),
  };
}

/** A short-lived token for Cloud Storage from a service account key. Read and write here, because what it can really do is set by the roles the customer gives the account. */
export async function gcsToken(secret: string, mint = (email: string, key: string) => new JWT({ email, key, scopes: ["https://www.googleapis.com/auth/devstorage.read_write"] }).getAccessToken()) {
  const { credentials: c } = gcpKey(secret);
  const { token } = await mint(c.client_email, c.private_key);
  if (!token) throw new Error("Google returned no token for this service account.");
  return token;
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
