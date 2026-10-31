export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { failInterruptedRuns, runDuePipelines } = await import("./server/jobs");
  failInterruptedRuns();
  setInterval(() => void runDuePipelines().catch(console.error), 60000);
}
