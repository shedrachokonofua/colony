// Placeholder workflow bundle for the supervisor task queue.
// Real workflows land in packages/workflows and are wired in via COL-0.10+.

export async function healthCheckWorkflow(): Promise<string> {
  return "ok";
}
