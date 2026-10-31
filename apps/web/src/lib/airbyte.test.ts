import assert from "node:assert/strict";
import test from "node:test";
import { configuredStream, discriminator, duckType, initialConfig, licenseName, LineSplitter, missingFields, optionFor, orderedProps, parseMessage, plainText, recordRow, scrubber, secretKeys, secretValues, stateFor, streamInfo, type JsonSchema } from "./airbyte.ts";

test("lines survive any chunking, including split multi-part output", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"a"'), []);
  assert.deepEqual(s.push(':1}\n{"b":2}\n{"c'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(s.end(), ['{"c']);
  assert.deepEqual(s.end(), []);
});
test("a runaway line is refused rather than held in memory", () => {
  assert.throws(() => new LineSplitter(10).push("x".repeat(11)), /longer than/);
});
test("records keep stream, namespace and data", () => {
  assert.deepEqual(parseMessage('{"type":"RECORD","record":{"stream":"users","data":{"id":1},"emitted_at":5}}'), { type: "RECORD", stream: "users", data: { id: 1 } });
  assert.equal((parseMessage('{"type":"RECORD","record":{"stream":"t","namespace":"s","data":{}}}') as { stream: string }).stream, "s.t");
});
test("a malformed RECORD or STATE fails instead of dropping data quietly", () => {
  assert.throws(() => parseMessage('{"type":"RECORD","record":{"stream":"users"}}'), /malformed RECORD/);
  assert.throws(() => parseMessage('{"type":"RECORD","record":{"stream":"u","data":[1]}}'), /malformed RECORD/);
  assert.throws(() => parseMessage('{"type":"STATE"}'), /malformed STATE/);
});
test("big integers keep their exact value", () => {
  const m = parseMessage('{"type":"RECORD","record":{"stream":"u","data":{"id":9007199254740993,"ok":12,"neg":-123456789012345678,"f":1.5}}}') as { data: Record<string, unknown> };
  assert.deepEqual(m.data, { id: "9007199254740993", ok: 12, neg: "-123456789012345678", f: 1.5 });
});
test("non-protocol output is text, never a crash", () => {
  assert.deepEqual(parseMessage("Traceback (most recent call last):"), { type: "TEXT", line: "Traceback (most recent call last):" });
  assert.equal(parseMessage('{"not json').type, "TEXT");
  assert.equal(parseMessage('{"no":"type"}').type, "TEXT");
  assert.equal(parseMessage("   ").type, "OTHER");
  assert.equal(parseMessage('{"type":"SOMETHING_NEW"}').type, "OTHER");
});
test("logs, errors, status, spec, catalog and config updates", () => {
  assert.deepEqual(parseMessage('{"type":"LOG","log":{"level":"WARN","message":"slow"}}'), { type: "LOG", level: "WARN", message: "slow" });
  assert.deepEqual(parseMessage('{"type":"TRACE","trace":{"type":"ERROR","error":{"message":"bad key","failure_type":"config_error"}}}'), { type: "TRACE_ERROR", message: "bad key", failure: "config_error" });
  assert.equal(parseMessage('{"type":"TRACE","trace":{"type":"ESTIMATE"}}').type, "OTHER");
  assert.deepEqual(parseMessage('{"type":"TRACE","trace":{"type":"STREAM_STATUS","stream_status":{"status":"INCOMPLETE","stream_descriptor":{"name":"u"}}}}'), { type: "STREAM_INCOMPLETE", stream: "u" });
  assert.equal(parseMessage('{"type":"TRACE","trace":{"type":"STREAM_STATUS","stream_status":{"status":"COMPLETE","stream_descriptor":{"name":"u"}}}}').type, "OTHER");
  assert.deepEqual(parseMessage('{"type":"CONNECTION_STATUS","connectionStatus":{"status":"FAILED","message":"no"}}'), { type: "STATUS", ok: false, message: "no" });
  assert.deepEqual(parseMessage('{"type":"SPEC","spec":{"connectionSpecification":{"type":"object"}}}'), { type: "SPEC", schema: { type: "object" } });
  assert.deepEqual(parseMessage('{"type":"CATALOG","catalog":{"streams":[{"name":"u"}]}}'), { type: "CATALOG", streams: [{ name: "u" }] });
  assert.deepEqual(parseMessage('{"type":"CONTROL","control":{"type":"CONNECTOR_CONFIG","connectorConfig":{"config":{"t":"new"}}}}'), { type: "CONFIG_UPDATE", config: { t: "new" } });
});
test("per-stream, global and old-style state", () => {
  const per = { type: "STREAM", stream: { stream_descriptor: { name: "u" }, stream_state: { c: 1 } } };
  assert.equal(stateFor("u", per), per);
  assert.equal(stateFor("other", per), null);
  assert.equal(stateFor("s.u", { type: "STREAM", stream: { stream_descriptor: { name: "u", namespace: "s" } } })?.type, "STREAM");
  const global = { type: "GLOBAL", global: { shared_state: { lsn: 5 }, stream_states: [] } };
  assert.equal(stateFor("anything", global), global);
  const legacy = { data: { u: { c: 1 } } };
  assert.equal(stateFor("u", legacy), legacy);
  assert.equal(stateFor("u", { type: "STREAM" }), null);
});
test("record rows follow the column list, so a held-back column can't slip through", () => {
  const cols = [{ name: "id", type: "BIGINT" }, { name: "meta", type: "JSON" }, { name: "tags", type: "JSON" }, { name: "note", type: "JSON" }, { name: "gone", type: "VARCHAR" }, { name: "ok", type: "BOOLEAN" }];
  assert.deepEqual(recordRow({ id: 1, email: "a@b.co", meta: { x: 1 }, tags: [1], note: "plain", ok: false }, cols), ["1", '{"x":1}', "[1]", '"plain"', null, "false"]);
});
test("schema types map to warehouse types", () => {
  assert.equal(duckType({ type: ["null", "integer"] }), "BIGINT");
  assert.equal(duckType({ type: "number" }), "DOUBLE");
  assert.equal(duckType({ type: ["null", "number"], airbyte_type: "integer" }), "BIGINT");
  assert.equal(duckType({ type: "boolean" }), "BOOLEAN");
  assert.equal(duckType({ type: "string", format: "date" }), "DATE");
  assert.equal(duckType({ type: ["null", "string"], format: "date-time" }), "TIMESTAMP");
  assert.equal(duckType({ type: "object" }), "JSON");
  assert.equal(duckType({ type: ["null", "array"] }), "JSON");
  assert.equal(duckType({ type: ["string", "integer"] }), "VARCHAR");
  assert.equal(duckType({ oneOf: [] }), "VARCHAR");
  assert.equal(duckType(undefined), "VARCHAR");
});
test("only a single top-level key and cursor are offered", () => {
  const base = { name: "u", json_schema: { properties: { id: { type: "integer" } } } };
  assert.deepEqual(streamInfo({ ...base, source_defined_primary_key: [["id"]], source_defined_cursor: true, default_cursor_field: ["at"] }), { name: "u", columns: [{ name: "id", type: "BIGINT" }], primaryKey: "id", cursor: "at" });
  assert.equal(streamInfo({ ...base, source_defined_primary_key: [["a"], ["b"]] }).primaryKey, undefined);
  assert.equal(streamInfo({ ...base, source_defined_primary_key: [["a", "b"]] }).primaryKey, undefined);
  assert.equal(streamInfo({ ...base, namespace: "s" }).name, "s.u");
});
test("the configured stream refuses a mode that can't work", () => {
  const s = { name: "u", supported_sync_modes: ["full_refresh"] };
  assert.throws(() => configuredStream(s, true, "at"), /doesn't support incremental/);
  assert.equal(configuredStream(s, false, undefined).destination_sync_mode, "overwrite");
  const inc = { name: "u", supported_sync_modes: ["full_refresh", "incremental"], default_cursor_field: ["d"] };
  assert.deepEqual(configuredStream(inc, true, "mine").cursor_field, ["mine"]);
  assert.deepEqual(configuredStream({ ...inc, source_defined_cursor: true }, true, "mine").cursor_field, ["d"]);
  assert.throws(() => configuredStream({ name: "u", supported_sync_modes: ["incremental"] }, true, undefined), /Choose a cursor/);
  assert.equal(configuredStream({ name: "u", supported_sync_modes: ["incremental"], default_cursor_field: ["d"] }, false, undefined).sync_mode, "incremental");
});
const SPEC: JsonSchema = {
  required: ["key", "auth"],
  properties: {
    key: { type: "string", title: "API key", airbyte_secret: true, order: 1 }, site: { type: "string", default: "x.com", order: 0 }, hide: { type: "string", airbyte_hidden: true },
    auth: { title: "Auth", type: "object", oneOf: [
      { title: "Token", required: ["t"], properties: { kind: { const: "token" }, t: { type: "string", airbyte_secret: true, title: "T" } } },
      { title: "Basic", required: ["pw"], properties: { kind: { const: "basic" }, pw: { type: "string", airbyte_secret: true, title: "PW" } } },
    ] },
  },
};
test("secrets are found through nested options and scrubbed in every form", () => {
  assert.deepEqual([...secretKeys(SPEC)].sort(), ["key", "pw", "t"]);
  const vals = secretValues({ key: "abc", site: "x.com", auth: { kind: "token", t: "tok/en+1" }, access_token: "looks-secret", list: [{ pw: "p\"w" }] }, secretKeys(SPEC));
  assert.deepEqual([...vals].sort(), ["abc", "looks-secret", "p\"w", "tok/en+1"]);
  const s = scrubber(vals);
  assert.equal(s("key=abc and tok/en+1 at x.com"), "key=[hidden] and [hidden] at x.com");
  assert.equal(s("url?t=tok%2Fen%2B1"), "url?t=[hidden]");
  assert.equal(s(JSON.stringify("say p\"w")), '"say [hidden]"');
});
test("the form follows the spec: order, hidden fields, defaults and required fields", () => {
  assert.deepEqual(orderedProps(SPEC).map(([k]) => k), ["site", "key", "auth"]);
  const c = initialConfig(SPEC);
  assert.deepEqual(c, { site: "x.com", auth: { kind: "token" } });
  assert.deepEqual(missingFields(SPEC, c), ["API key", "Auth: T"]);
  assert.deepEqual(missingFields(SPEC, { key: "k", auth: { kind: "basic", pw: "p" } }), []);
  assert.equal(discriminator(SPEC.properties!.auth.oneOf!), "kind");
  assert.equal(optionFor(SPEC.properties!.auth.oneOf!, { kind: "basic" }).title, "Basic");
  assert.equal(plainText('See <a href="x">the docs</a> <b>now</b>'), "See the docs now");
});
test("licence names are shown consistently and an unknown one isn't guessed", () => {
  assert.equal(licenseName("Elv2"), "ELv2");
  assert.equal(licenseName("MIT"), "MIT");
  assert.equal(licenseName(undefined), "Not stated");
});
