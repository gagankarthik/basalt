/** Which models a re-run needs: those that failed and those skipped because of them. A check that failed isn't here, because building its model again won't change the data it found. */
export function retryNames(results: { unique_id?: unknown; status?: unknown }[], current: string[]) {
  const known = new Set(current);
  return results.filter((r) => /^(model|seed|snapshot)\./.test(String(r.unique_id)) && ["error", "skipped"].includes(String(r.status))).map((r) => String(r.unique_id).split(".").pop()!).filter((n) => known.has(n));
}

/** The oldest cursor value worth reading again. Rows that arrive late carry an older cursor than what's already loaded, so reading only past the newest would miss them for good. */
export function incrementalCutoff(cursor: string, table: string, lookbackDays?: number) {
  const newest = `(SELECT max(${cursor}) FROM ${table})`;
  return lookbackDays ? `${newest} - INTERVAL ${Math.floor(lookbackDays)} DAY` : newest;
}
