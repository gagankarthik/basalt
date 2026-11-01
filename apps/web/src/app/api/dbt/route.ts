import { api, HttpError } from "@/server/auth";
import { dbtVersion } from "@/server/dbt";
import { lastFreshness, projectDocs, runFreshness } from "@/server/jobs";

// Model SQL appears in the docs, so all of this is for editors
export const GET = api("editor", async () => ({ dbt: await dbtVersion(), configured: !!process.env.BASALT_DBT, freshness: lastFreshness() }));

export const POST = api("editor", async (req) => {
  const b = await req.json();
  if (b.kind === "freshness") return runFreshness(true);
  if (b.kind === "docs") return projectDocs();
  throw new HttpError(400, "Unknown request.");
});
