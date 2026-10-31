import { DocsTheme } from "@/components/docs/DocsClient";
import "@/components/docs/docs.css";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <><DocsTheme />{children}</>;
}
