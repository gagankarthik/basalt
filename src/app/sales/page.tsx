import type { Metadata } from "next";
import localFont from "next/font/local";
import SalesPage from "@/components/SalesPage";

const display = localFont({ src: "../../fonts/InterDisplay-Medium.woff2", weight: "500", variable: "--font-inter-display" });

export const metadata: Metadata = { title: "Talk to sales | Basalt", description: "Tell us about your data and your team." };

export default function Page() {
  return <div className={display.variable}><SalesPage /></div>;
}
