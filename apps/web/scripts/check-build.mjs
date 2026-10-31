// Fails if a build's file lists include anything from the data folder. Run after `npm run build`.
import fs from "node:fs";
import path from "node:path";
const dist = process.env.BASALT_DIST_DIR ?? ".next", found = new Set();
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith(".nft.json")) for (const x of JSON.parse(fs.readFileSync(f, "utf8")).files ?? []) { const r = path.relative(path.resolve("../.."), path.resolve(path.dirname(f), x)), top = r.split(path.sep); if (top[0] === "data" || (top[0] === "apps" && top[2] === "data")) found.add(r); } } };
walk(dist);
if (found.size) { console.error("Data files are listed in the build:", [...found]); process.exit(1); }
console.log("OK: no data files in the build's file lists");
