import { parseFault, type Run } from "@colony/core";
import { isQuotaDeferred } from "@colony/sandbox";

/**
 * Failure classes that are the platform's fault, not the agent's: the
 * colonyd process restarting mid-run, or the LLM gateway erroring. These
 * retry with backoff but never consume any attempt budget — work must only
 * block on failures the agent could have prevented.
 */
export const INFRA_FAILURE =
  /^process_restart$|^lease_expired$|^provider_connection_failure(?::|$)|^liveness_watchdog_no_progress$|^liveness_watchdog_tool_wedge$|^zero_output_stall$|^workspace_lost$|\b(?:429|50[234])\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EACCES|EROFS|fetch failed|Unable to connect|workspace_provision_failed|workspace_transfer_failed|reaping \d+ startup-orphaned|RBAC: denied creating|timed out .* waiting for (?:backing pod of )?Sandbox CR|Sandbox CR .* failed:|sandboxes\.agents\.x-k8s\.io .{0,120}? not found|Agent "Main" was replaced during session initialization|GitLab (?:GET|POST|PUT) .* timed out/i;

/** Classify historical errors when no authoritative structured fault exists. */
export function isInfraError(error: string | null | undefined): boolean {
  return typeof error === "string" && INFRA_FAILURE.test(error);
}

// Structured faults are authoritative when they identify a concrete layer.
// Unknown faults retain the legacy text fallback so historical and partially
// migrated rows keep their existing retry semantics.
function structuredFaultIsDeferred(
  faultJson: string | null | undefined,
): boolean | undefined {
  const fault = parseFault(faultJson);
  if (!fault || fault.layer === "unknown") return undefined;
  return fault.layer !== "model";
}

/**
 * True when a failed run should be retried without consuming an attempt.
 *
 * Structured fault data takes precedence over the legacy error string. Quota
 * refusal remains a textual fallback because it is a scheduling condition and
 * not a run-layer fault.
 */
export function isDeferredRunFailure(
  run: Pick<Run, "status" | "error" | "fault_json"> | null | undefined,
): boolean {
  if (!run || run.status !== "failed") return false;
  return (
    structuredFaultIsDeferred(run.fault_json) ??
    (isInfraError(run.error) || isQuotaDeferred(run.error))
  );
}

/**
 * Count accountable implementation failures in a caller-selected
 * chronological history. Platform deferrals and canceled executions are
 * ignored; a successful implementation starts a fresh failure streak.
 */
export function consecutiveImplementationFailures(
  runs: readonly Run[],
): number {
  let failures = 0;
  for (const run of runs) {
    if (run.kind !== "implement") continue;
    if (run.status === "succeeded") {
      failures = 0;
      continue;
    }
    if (run.status !== "failed" || isDeferredRunFailure(run)) continue;
    failures += 1;
  }
  return failures;
}
