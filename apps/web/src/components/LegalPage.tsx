import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "./icons";
import "./legal.css";

/** Fill these in before going live. Until then the pages show the bracketed text, so a missing detail can't pass unnoticed. */
export const LEGAL = {
  company: "[Company legal name]",
  address: "[Company mailing address]",
  email: "[legal contact email]",
  state: "[State]",
  effective: "[Effective date]",
};

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="lg">
      <header className="lg-head"><Link href="/" className="lg-brand"><Mark size={28} />Basalt</Link><nav aria-label="Legal"><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link></nav></header>
      <main className="lg-body">
        <h1>{title}</h1>
        <p className="lg-date">Effective {LEGAL.effective}</p>
        {children}
      </main>
    </div>
  );
}
