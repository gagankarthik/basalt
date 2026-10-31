import type { Metadata } from "next";
import localFont from "next/font/local";
import Landing from "@/components/Landing";

const display = localFont({ src: "../fonts/InterDisplay-Medium.woff2", weight: "500", variable: "--font-inter-display" });

export const metadata: Metadata = {
  title: "Basalt: your whole data stack, in one workspace",
  description: "Data sync, personal data masking, transformations and dashboards in one workspace, with the sign-in and audit controls companies ask for.",
};

export default function Page() {
  return <div className={display.variable}><Landing /></div>;
}

