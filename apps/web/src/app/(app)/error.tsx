"use client";
import { ErrorState } from "@/components/ui";

export default function PageError({ error, retry }: { error: Error; retry: () => void }) {
  return <ErrorState title="This page couldn't load" retry={retry}>{error.message}</ErrorState>;
}
