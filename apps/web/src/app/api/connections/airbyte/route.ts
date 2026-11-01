import { cancelAirbyte, connectorList, connectorSpec } from "@/server/airbyte";
import { api, HttpError } from "@/server/auth";
import { audit } from "@/server/files";

// Admin only: choosing a connector leads to running third-party code on this server
export const GET = api("admin", (req) => {
  const spec = new URL(req.url).searchParams.get("spec");
  return spec ? connectorSpec(spec) : connectorList();
});

export const POST = api("admin", async (req, user) => {
  const b = await req.json();
  if (b.action !== "cancel") throw new HttpError(400, "Unknown action.");
  const stopped = cancelAirbyte(String(b.connectionId));
  if (stopped) audit(user.name, "Stopped an Airbyte connector", String(b.connectionId), true);
  return { stopped };
});
