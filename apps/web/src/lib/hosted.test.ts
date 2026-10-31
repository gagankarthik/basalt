import assert from "node:assert/strict";
import test from "node:test";
import { connectionHosts, hostedProblem, isHosted, rotateAudit } from "./hosted.ts";

const pub = async () => [{ address: "8.8.8.8" }];
test("hosted mode is opt-in", () => {
  assert.equal(isHosted({}), false);
  assert.equal(isHosted({ BASALT_HOSTED: "1" }), true);
  assert.equal(isHosted({ BASALT_HOSTED: "0" }), false);
});
test("addresses are found wherever a connection keeps them", () => {
  assert.deepEqual(connectionHosts({ type: "postgres", host: "db.example.com" }), ["db.example.com"]);
  assert.deepEqual(connectionHosts({ type: "s3", host: "http://10.0.0.5:9000" }), ["10.0.0.5"]);
  assert.deepEqual(connectionHosts({ type: "azure", auth: "string" }, "AccountName=a;BlobEndpoint=http://169.254.169.254/x;"), ["169.254.169.254"]);
  assert.deepEqual(connectionHosts({ type: "cosmos", host: "https://[::1]:8081" }), ["::1"]);
  assert.deepEqual(connectionHosts({ type: "snowflake", host: "abc-123" }), []);
  assert.deepEqual(connectionHosts({ type: "s3" }), []);
});
test("our own identity and our network are out of reach", async () => {
  for (const type of ["s3", "dynamodb", "athena", "azure"]) assert.match((await hostedProblem({ type: type as never, auth: "chain" }, "", pub))!, /own identity/);
  assert.match((await hostedProblem({ type: "airbyte" as never }, "", pub))!, /Airbyte/);
  for (const host of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.1", "[::1]", "http://100.64.0.1"]) assert.match((await hostedProblem({ type: "postgres", host }, "", pub))!, /internal network/, host);
  assert.match((await hostedProblem({ type: "postgres", host: "sneaky.example.com" }, "", async () => [{ address: "8.8.8.8" }, { address: "10.0.0.1" }]))!, /internal network/, "any address counts");
  assert.match((await hostedProblem({ type: "azure", auth: "string" }, "BlobEndpoint=http://169.254.169.254;", pub))!, /internal network/);
});
test("what customers need stays allowed", async () => {
  assert.equal(await hostedProblem({ type: "postgres", host: "db.example.com" }, "", pub), null);
  assert.equal(await hostedProblem({ type: "s3", auth: "role" }, "", pub), null);
  assert.equal(await hostedProblem({ type: "azure", auth: "principal" }, "", pub), null);
  assert.equal(await hostedProblem({ type: "gcs", auth: "serviceAccount" }, "", pub), null);
  assert.equal(await hostedProblem({ type: "postgres", host: "no.such.name" }, "", async () => { throw new Error("nope"); }), null, "a name that doesn't resolve fails later, on its own");
});
test("the audit trail rotates without losing anything", () => {
  const { recent, archive } = rotateAudit([5, 4, 3, 2, 1], 2);
  assert.deepEqual(recent, [5, 4]);
  assert.deepEqual(archive, [1, 2, 3], "oldest first, so appending keeps time order");
  assert.deepEqual(rotateAudit([1], 2), { recent: [1], archive: [] });
});
