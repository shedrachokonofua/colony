/**
 * Failure classes that are the platform's fault, not the agent's: the
 * colonyd process restarting mid-run, or the LLM gateway erroring. These
 * retry with backoff but never consume any attempt budget — work must only
 * block on failures the agent could have prevented.
 */
export const INFRA_FAILURE =
  /^process_restart$|^liveness_watchdog_no_progress$|^liveness_watchdog_tool_wedge$|^zero_output_stall$|^workspace_lost$|\b(?:429|50[234])\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EACCES|EROFS|fetch failed|Unable to connect|workspace_provision_failed|workspace_transfer_failed|RBAC: denied creating|timed out .* waiting for (?:backing pod of )?Sandbox CR|Sandbox CR .* failed:|sandboxes\.agents\.x-k8s\.io .{0,120}? not found|Agent "Main" was replaced during session initialization|GitLab (?:GET|POST|PUT) .* timed out/i;

// 'Agent "Main" was replaced during session initialization' is the SDK
// losing its own session handle at boot - one minute in, no agent work
// done; it burned col-0029a8c3.3's last attempt (2026-09-02).
// The Sandbox-CR alternative: a CR that vanished under a live run (the
// 20:42 restart boundary on 2026-09-01 - the daemon came back, the CR did
// not) surfaces as a k8s 404 body. Nothing the agent did; free requeue.
/** Exported for tests: classify a run error as infrastructure-caused. */
export function isInfraError(error: string | null | undefined): boolean {
  return typeof error === "string" && INFRA_FAILURE.test(error);
}
