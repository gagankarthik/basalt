import fs from "node:fs";
import { dataPath, withConn } from "@/server/engine";

/** For a load balancer or monitor, so no sign-in. It says only whether Basalt can serve, and nothing about what's inside. */
export async function GET() {
  try {
    await withConn((c) => c.run("SELECT 1"));
    const p = dataPath(`.health-${process.pid}`);
    fs.writeFileSync(p, ""); fs.rmSync(p);
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("Health check failed", e);
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
