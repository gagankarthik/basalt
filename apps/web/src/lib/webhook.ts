import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const REFUSED = "This address points to an internal network, which webhooks can't reach.";
const internal = new net.BlockList();
// Loopback, private, link-local, carrier-grade NAT (Alibaba metadata), reserved and multicast, plus Azure's public-looking metadata host
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["168.63.129.16", 32], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) internal.addSubnet(ip, bits, "ipv4");
// Loopback and IPv4-compatible, NAT64 and 6to4 (which wrap an IPv4 address), unique local (AWS metadata), link-local, multicast
for (const [ip, bits] of [["::", 96], ["64:ff9b::", 96], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) internal.addSubnet(ip, bits, "ipv6");

export const isInternal = (ip: string) => { const a = ip.split("%")[0]; return internal.check(a, net.isIP(a) === 6 ? "ipv6" : "ipv4"); };

// Checked at connect time rather than beforehand, so a name can't resolve to a public address for the check and an internal one for the request
const lookup: net.LookupFunction = (host, opts, cb) => dns.lookup(host, { ...opts, all: true }, (err, list) => {
  if (err) return cb(err, "", 0);
  if (list.some((a) => isInternal(a.address))) return cb(new Error(REFUSED), "", 0);
  if (opts.all) cb(null, list); else cb(null, list[0].address, list[0].family);
});

/** Posts JSON and gives back the status. Redirects aren't followed, so one can't lead to an internal address. */
export async function postJson(url: string, body: string, headers: Record<string, string> = {}) {
  const u = new URL(url), host = u.hostname.replace(/^\[|\]$/g, ""), open = process.env.BASALT_ALLOW_PRIVATE_WEBHOOKS === "1";
  // A literal IP never goes through lookup
  if (!open && net.isIP(host) && isInternal(host)) throw new Error(REFUSED);
  return new Promise<number>((done, fail) => {
    const req = (u.protocol === "https:" ? https : http).request(u, { method: "POST", headers: { "content-type": "application/json", ...headers }, signal: AbortSignal.timeout(8000), ...(open ? {} : { lookup }) }, (res) => { res.resume(); done(res.statusCode ?? 0); });
    req.on("error", fail);
    req.end(body);
  });
}
