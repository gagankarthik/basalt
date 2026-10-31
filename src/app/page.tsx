import type { Metadata } from "next";
import localFont from "next/font/local";
import Landing from "@/components/Landing";

const display = localFont({ src: "../fonts/InterDisplay-Medium.woff2", weight: "500", variable: "--font-inter-display" });

export const metadata: Metadata = {
  title: "Basalt: your whole data stack, on one server",
  description: "Self-hosted data sync, personal data masking, transformations and dashboards for small enterprises.",
};

export default function Page() {
  return <div className={display.variable}><Landing /></div>;
}

