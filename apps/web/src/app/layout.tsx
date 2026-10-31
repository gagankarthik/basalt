import type { Metadata } from "next";
import Script from "next/script";
import { CookieNotice } from "@/components/CookieNotice";
import { Geist, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const sans = Geist({ variable: "--font-geist", subsets: ["latin"] });
const mono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });

// Runs before the first paint, so a saved docs theme doesn't flash the other one
const DOCS_THEME = `try{var t=localStorage.getItem("basalt-docs-theme");if(location.pathname.indexOf("/docs")===0&&(t==="light"||t==="dark"))document.documentElement.dataset.theme=t}catch(e){}`;

export const metadata: Metadata = { title: "Basalt", description: "Data sync, modeling and analytics" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="system" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>{children}<CookieNotice /><Script id="docs-theme" strategy="beforeInteractive">{DOCS_THEME}</Script></body>
    </html>
  );
}
