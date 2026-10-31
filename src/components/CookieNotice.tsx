"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

const KEY = "basalt-cookie-notice", PUBLIC = /^\/($|sales|docs|terms|privacy|login|form)/;
const listeners = new Set<() => void>();
const seen = () => { try { return !!localStorage.getItem(KEY); } catch { return true; } };

/** Basalt only sets a sign-in cookie, so this informs and needs no accept or reject choice. If analytics or ads are ever added, it has to become a real choice. */
export function CookieNotice() {
  const path = usePathname();
  const hidden = useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, seen, () => true);
  if (hidden || !PUBLIC.test(path)) return null;
  const close = () => { try { localStorage.setItem(KEY, "1"); } catch { /* it comes back next visit */ } listeners.forEach((f) => f()); };
  return <div className="cookie" role="region" aria-label="Cookie notice">
    <p>We only use essential cookies to keep you signed in, and your browser stores your preferences. We don&apos;t use advertising or analytics cookies. <Link href="/privacy">Privacy policy</Link></p>
    <button type="button" onClick={close}>Got it</button>
  </div>;
}
