import { api } from "@/server/auth";
import { isDcl, runDcl } from "@/server/dcl";
import { runSql } from "@/server/engine";
import { audit } from "@/server/files";
import { guardFor } from "@/server/rls";

export const POST = api("viewer", async (req, user) => {
  const { sql, limit } = await req.json();
  if (typeof sql !== "string") throw new Error("Enter a SQL statement to run.");
  if (isDcl(sql)) return runDcl(sql, user);
  const r = await runSql(sql, { readOnly: user.role === "viewer", limit, rewrite: guardFor(user) });
  // Reads aren't recorded; anything that changes data or structure is
  const changed = r.kinds.filter((k) => k !== "DQL");
  if (changed.length) audit(user.name, `Ran ${changed.join(", ")}`, sql.trim().slice(0, 200));
  return r;
});
