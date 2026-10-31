import type { ConnectorType } from "./types.ts";

const RULES: [RegExp, string][] = [
  // Google sign-in and roles
  [/invalid_grant|Invalid JWT|account not found/i, "Google refused this service account key. It may have been deleted, or the account disabled. Create a new key and paste it again."],
  [/bigquery\.[\w.]+ permission|Access Denied: (Project|Dataset|Table)/i, "Google signed you in, but this account can't use BigQuery here. Give it BigQuery Data Viewer on the dataset and BigQuery Job User on the project."],
  [/storage\.(objects|buckets)\.[\w]+/i, "Google signed you in, but this account can't read this bucket. Give it Storage Object Viewer on the bucket, or Storage Object User to export there."],
  [/Not found: Dataset/i, "BigQuery can't find that dataset. Check the project ID and dataset name."],
  // DynamoDB and Athena report these through the AWS SDK
  [/security token included in the request is (invalid|expired)|UnrecognizedClientException/i, "AWS refused these keys. Check the access key and secret, and that the key is still active."],
  [/not authorized to perform: dynamodb:/i, "AWS signed you in, but this login can't read DynamoDB. Attach the AWS policy AmazonDynamoDBReadOnlyAccess to it."],
  [/not authorized to perform: (athena|glue):/i, "AWS signed you in, but this login can't use Athena. Allow Athena queries and Glue read access."],
  [/ResourceNotFoundException/i, "AWS can't find that table. Check its name and the region."],
  [/output location|OutputLocation/i, "Athena needs somewhere to put query results. Enter a results location, or set one on the workgroup."],
  // Azure sign-in, by Microsoft's published error codes
  [/AADSTS7000215|AADSTS7000222/, "Azure refused the client secret. It may be wrong or expired, and it must be the secret's value rather than its ID."],
  [/AADSTS700016/, "Azure can't find this client ID in that tenant. Check both, and that the app is registered there."],
  [/AADSTS90002|AADSTS900021|AADSTS900023/, "Azure can't find that tenant. Check the tenant ID."],
  [/AADSTS\d+/, "Azure refused this sign-in. Check the tenant ID, client ID and client secret."],
  // First, because a bad key also carries the code AuthorizationFailure
  [/AuthenticationFailed|Server failed to authenticate|Base64/i, "Azure refused the account key or connection string. Check it's complete and hasn't been rotated."],
  [/AuthorizationPermissionMismatch|AuthorizationFailure|This request is not authorized/i, "Azure signed you in, but this login can't read the data. Give it the Storage Blob Data Reader role on the container, or Storage Blob Data Contributor to export there. Reader or Contributor alone isn't enough, and a new role can take up to 10 minutes to apply."],
  [/ContainerNotFound|container does not exist/i, "Azure can't find that container. Check its name and the storage account."],
  // S3 and Cloud Storage share these codes
  [/InvalidAccessKeyId|SignatureDoesNotMatch|InvalidSecurity|invalid.*access key/i, "The cloud refused these keys. Check the access key and secret, and that the key is still active."],
  [/ExpiredToken|token.*expired/i, "These temporary credentials have expired. Run it again to get new ones."],
  [/NoSuchBucket|bucket does not exist/i, "That bucket doesn't exist, or is in another account. Check its name."],
  [/PermanentRedirect|AuthorizationHeaderMalformed|\b301\b/, "This bucket is in a different region. Enter its region."],
  [/AccessDenied|\b403\b|Forbidden/i, "The cloud refused access. Allow this login to list the folder and read its files, and to write there if you export to it. A bucket policy or firewall can also block it."],
  [/Could not resolve|name resolution|Could not connect|could not be established|Connection refused|timed out|Timeout/i, "Basalt couldn't reach this storage. Check the address, and that its firewall allows this server."],
];

/** A storage error someone can act on. Raw ones are long, hold trace IDs and sometimes request details, so a known one is replaced whole and an unknown one keeps only its first line. */
export function cloudMessage(type: ConnectorType, message: string) {
  if (!["s3", "gcs", "azure", "bigquery", "dynamodb", "athena"].includes(type)) return message;
  return RULES.find(([re]) => re.test(message))?.[1] ?? message.split("\n")[0];
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
