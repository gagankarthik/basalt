/** Runs in a row with the same job and outcome read as one line. A different outcome always stands alone, so a failure never hides inside a group. Newest first in, newest kept. */
export function groupRuns<T extends { name: string; kind: string; status: string }>(runs: T[]): (T & { count: number })[] {
  const out: (T & { count: number })[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.name === r.name && last.kind === r.kind && last.status === r.status) last.count++;
    else out.push({ ...r, count: 1 });
  }
  return out;
}
