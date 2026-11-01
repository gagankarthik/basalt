"use client";
import { useParams } from "next/navigation";
import BaseApp from "@/components/BaseApp";

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <BaseApp key={id} id={id} />;
}
