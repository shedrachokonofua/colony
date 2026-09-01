/**
 * Failure classes that are the platform's fault, not the agent's: the
 * colonyd process restarting mid-run, or the LLM gateway erroring. These
 * retry with backoff but never consume any attempt budget — work must only
 * block on failures the agent could have prevented.
 */
export const INFRA_FAILURE =
  /^process_restart$|^liveness_watchdog_no_progress$|^liveness_watchdog_tool_wedge$|^zero_output_stall$|^workspace_lost$|\b(?:429|50[234])\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|Unable to connect|workspace_provision_failed|workspace_transfer_failed|RBAC: denied creating|timed out .* waiting for (?:backing pod of )?Sandbox CR|Sandbox CR .* failed:/i;

/** Exported for tests: classify a run error as infrastructure-caused. */
export function isInfraError(error: string | null | undefined): boolean {
  return typeof error === "string" && INFRA_FAILURE.test(error);
}
