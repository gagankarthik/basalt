import { analyticsStats } from "@/server/analytics";
import { api } from "@/server/auth";

// Admins only: the slowest queries are shown as written, and can hold values someone searched for
export const GET = api("admin", async () => analyticsStats());
