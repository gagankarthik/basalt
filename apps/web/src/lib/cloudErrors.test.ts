import assert from "node:assert/strict";
import test from "node:test";
import { cloudMessage, GUID } from "./cloudErrors.ts";

test("each cloud's refusal says what to fix", () => {
  const cases: [string, string, RegExp][] = [
    ["azure", 'Invalid Error: GetToken(): error response: 400\n\n{"error":"invalid_request","error_description":"AADSTS900021: Requested tenant identifier ... Trace ID: 3e61"}', /tenant ID/],
    ["azure", "AADSTS7000215: Invalid client secret provided.", /client secret/],
    ["azure", "AADSTS700016: Application not found", /client ID/],
    ["azure", "HTTP 403 AuthorizationPermissionMismatch", /Storage Blob Data Reader/],
    ["azure", "AuthenticationFailed: Server failed to authenticate the request", /account key/],
    ["azure", "IO Error: AzureBlobStorageFileSystem Read to az://lake/in/** failed with AuthorizationFailure Reason Phrase: Server failed to authenticate the request. Make sure the value of the Authorization header is formed correctly", /account key/],
    ["azure", "This request is not authorized to perform this operation. AuthorizationFailure", /Storage Blob Data Reader/],
    ["azure", "Invalid Error: Unexpected end of Base64 encoded string.", /account key/],
    ["azure", "Invalid Error: Error while waiting for a send to complete. Error Code: 12029: A connection with the server could not be established.", /couldn't reach/],
    ["azure", "ContainerNotFound", /container/],
    ["s3", "HTTP Error: 403 (Forbidden) AccessDenied", /refused access/],
    ["s3", "The AWS Access Key Id you provided does not exist: InvalidAccessKeyId", /refused these keys/],
    ["s3", "NoSuchBucket", /bucket doesn't exist/],
    ["s3", "301 Moved PermanentRedirect", /different region/],
    ["s3", "ExpiredToken", /expired/],
    ["gcs", "SignatureDoesNotMatch", /refused these keys/],
    ["gcs", "invalid_grant: Invalid JWT Signature.", /service account key/],
    ["gcs", "reader@x.iam.gserviceaccount.com does not have storage.objects.list access to the Google Cloud Storage bucket.", /Storage Object Viewer/],
    ["bigquery", "Access Denied: Project demo: User does not have bigquery.jobs.create permission in project demo.", /BigQuery Job User/],
    ["bigquery", "Not found: Dataset demo:shop", /dataset/],
    ["dynamodb", "The security token included in the request is invalid.", /refused these keys/],
    ["dynamodb", "User: arn:aws:iam::1:user/a is not authorized to perform: dynamodb:ListTables on resource", /AmazonDynamoDBReadOnlyAccess/],
    ["athena", "User: arn:aws:iam::1:user/a is not authorized to perform: athena:StartQueryExecution", /Athena queries/],
    ["athena", "No output location provided.", /results location/],
    ["gcs", "Could not resolve hostname", /couldn't reach/],
  ];
  for (const [t, raw, want] of cases) assert.match(cloudMessage(t as never, raw), want, raw);
});
test("raw details don't reach people, and other connections are left alone", () => {
  assert.ok(!cloudMessage("azure", "AADSTS90002 Trace ID: abc Correlation ID: def").includes("Trace"));
  assert.equal(cloudMessage("s3", "Something new\nsecret detail"), "Something new");
  assert.equal(cloudMessage("postgres", "permission denied 403\nline two"), "permission denied 403\nline two");
});
test("IDs are checked", () => {
  assert.ok(GUID.test("11111111-2222-3333-4444-555555555555"));
  assert.ok(!GUID.test("not-a-guid"));
});
