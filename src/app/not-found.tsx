import Link from "next/link";
import { Empty } from "@/components/ui";

export default function NotFound() {
  return <div className="auth"><Empty icon="search" title="This page doesn't exist" action={<Link className="btn primary" href="/home">Go to Home</Link>}>Check the address and try again.</Empty></div>;
}
