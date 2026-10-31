import assert from "node:assert/strict";
import test from "node:test";
import { isInternal, postJson } from "./webhook.ts";

test("internal addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "168.63.129.16", "0.0.0.0", "::1", "::", "fd00:ec2::254", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:1::"]) assert.equal(isInternal(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isInternal(ip), false, ip);
});

test("webhooks refuse internal targets unless allowed", async () => {
  delete process.env.BASALT_ALLOW_PRIVATE_WEBHOOKS;
  // Spellings URL normalizes to loopback, then a name that only resolves to it
  for (const url of ["http://127.0.0.1:1/", "http://2130706433:1/", "http://0x7f.1:1/", "http://[::1]:1/", "http://[::ffff:127.0.0.1]:1/", "http://169.254.169.254/", "http://localhost:1/"]) await assert.rejects(postJson(url, "{}"), /internal network/, url);
  process.env.BASALT_ALLOW_PRIVATE_WEBHOOKS = "1";
  // Nothing listens on port 1, so getting as far as a refused connection shows the guard stepped aside
  await assert.rejects(postJson("http://127.0.0.1:1/", "{}"), /ECONNREFUSED/);
  delete process.env.BASALT_ALLOW_PRIVATE_WEBHOOKS;
});
