import type { Run } from "@colony/core";
import type { SandboxHandle } from "@colony/sandbox";
import type { Logger } from "../logging.js";

/**
 * Destroy the sandbox of a run that reached a terminal state without its
 * in-process handler (lease expiry, crash reap, tick-error reap, a resume
 * that failed). The runner's own teardown only fires for segments it
 * completes, so these paths must reap by the run row's sandbox_id through
 * the configured engine — otherwise the sandbox outlives its run and holds a
 * namespace slot until some unrelated startup sweep notices it (production
 * 2026-09-26: until an operator deleted it by hand). A sandbox that is
 * already gone is not an error: `connect` rejects and there is nothing left
 * to reap.
 */
export async function destroyRunSandbox(
  connect: (sandboxId: string) => Promise<SandboxHandle>,
  run: Pick<Run, "id" | "sandbox_id">,
  logger: Logger,
): Promise<void> {
  if (run.sandbox_id === null) return;
  try {
    const handle = await connect(run.sandbox_id);
    await handle.destroy();
  } catch (err) {
    logger.warn(
      {
        run_id: run.id,
        sandbox_id: run.sandbox_id,
        error: err instanceof Error ? err.message : String(err),
      },
      "sandbox.teardown_failed",
    );
  }
}
