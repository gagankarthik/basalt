import type { Config } from "./types.ts";

/** The sample company replaces these lists, so it's only offered while there's nothing of the workspace's own to lose. */
export const canLoadSample = (c: Pick<Config, "connections" | "pipelines" | "models" | "dashboards" | "views" | "metrics">) => [c.connections, c.pipelines, c.models, c.dashboards, c.views, c.metrics].every((list) => !list.length);
