/**
 * Wrong passwords lock one sender quickly, so a stranger can't lock someone else out of their account by guessing from elsewhere.
 * Senders can fake their address, so a much higher limit for the whole account still stops guessing at scale.
 */
export function createThrottle({ perSender = 5, perAccount = 100, lockMs = 300000, maxKeys = 10000 } = {}) {
  const seen = new Map<string, { n: number; until: number }>();
  const live = (key: string, now: number) => { const e = seen.get(key); if (e && e.until && e.until <= now) { seen.delete(key); return undefined; } return e; };
  const hit = (key: string, limit: number, now: number) => {
    const n = (live(key, now)?.n ?? 0) + 1;
    // Made-up emails would otherwise fill memory
    if (seen.size >= maxKeys) seen.clear();
    seen.set(key, { n, until: n >= limit ? now + lockMs : 0 });
  };
  const locked = (key: string, now: number) => !!live(key, now)?.until;
  return {
    blocked: (email: string, sender: string, now = Date.now()) => locked(`${email}|${sender}`, now) || locked(email, now),
    fail(email: string, sender: string, now = Date.now()) { hit(`${email}|${sender}`, perSender, now); hit(email, perAccount, now); },
    clear(email: string, sender: string) { seen.delete(`${email}|${sender}`); seen.delete(email); },
  };
}
