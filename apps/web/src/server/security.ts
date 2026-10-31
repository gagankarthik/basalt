import "server-only";
import { DEFAULT_POLICY, type SessionPolicy } from "@/lib/sessionPolicy";
import { readJson, writeJson } from "./files";

export type Security = SessionPolicy & { requireMfa: boolean };
/** Kept apart from the config, which editors can save: only admins decide this. */
export const getSecurity = (): Security => ({ requireMfa: false, ...DEFAULT_POLICY, ...readJson<Partial<Security>>("security.json", {}) });
export const saveSecurity = (s: Security) => writeJson("security.json", s);
