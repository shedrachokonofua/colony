// The delivery stage a task is in, as the API derives it. The console never
// infers a stage from a task state or an audit string: it renders
// `delivery_status.stage` through this one map.
//
// Labels are short on purpose — they sit in a DAG node badge, a drawer line,
// a running row, and a scope banner, all of which are tight on width.

/** @typedef {"provider_head_pending" | "pipeline_pending" | "pipeline_running" | "ci_failed" | "repair_pending" | "repair_running" | "repair_failed" | "awaiting_review" | "reviewing" | "changes_requested" | "awaiting_human_approval" | "merge_gate_pending" | "merge_gate_running" | "merge_gate_failed" | "merge_conflict" | "ready_to_merge" | "merging" | "merged" | "blocked"} DeliveryStage */

/**
 * A task's delivery status, exactly as GET /scopes/:id and GET /tasks/:id
 * serve it.
 *
 * @typedef {{
 *   stage: DeliveryStage,
 *   since: string,
 *   evidence: Array<{ kind: string, text: string, url?: string }>,
 *   run_ids: string[],
 * }} DeliveryStatus
 */

/** @type {Record<DeliveryStage, string>} */
export const DELIVERY_STAGE_LABEL = {
  provider_head_pending: "Waiting for head",
  pipeline_pending: "CI queued",
  pipeline_running: "CI running",
  ci_failed: "CI failed",
  repair_pending: "Repair queued",
  repair_running: "Repairing",
  repair_failed: "Repair failed",
  awaiting_review: "Awaiting review",
  reviewing: "Reviewing",
  changes_requested: "Changes requested",
  awaiting_human_approval: "Awaiting approval",
  merge_gate_pending: "Gate pending",
  merge_gate_running: "Gate running",
  merge_gate_failed: "Gate failed",
  merge_conflict: "Merge conflict",
  ready_to_merge: "Ready to merge",
  merging: "Merging",
  merged: "Merged",
  blocked: "Blocked",
};

/** Every stage the API can send, in the order it defines them. */
export const DELIVERY_STAGES = /** @type {readonly DeliveryStage[]} */ ([
  "provider_head_pending",
  "pipeline_pending",
  "pipeline_running",
  "ci_failed",
  "repair_pending",
  "repair_running",
  "repair_failed",
  "awaiting_review",
  "reviewing",
  "changes_requested",
  "awaiting_human_approval",
  "merge_gate_pending",
  "merge_gate_running",
  "merge_gate_failed",
  "merge_conflict",
  "ready_to_merge",
  "merging",
  "merged",
  "blocked",
]);

/**
 * The stage of a delivery_status payload, or null when the task has none.
 * @param {Record<string, any> | null | undefined} deliveryStatus
 * @returns {DeliveryStage | null}
 */
export function deliveryStage(deliveryStatus) {
  const stage = deliveryStatus?.stage;
  return typeof stage === "string" && stage in DELIVERY_STAGE_LABEL
    ? /** @type {DeliveryStage} */ (stage)
    : null;
}

/**
 * The short label for one delivery status. Falls back to the raw state for a
 * stage this build predates, so a new backend stage still reads as something.
 * @param {Record<string, any> | null | undefined} deliveryStatus
 * @param {string} [fallback]
 */
export function deliveryStageLabel(deliveryStatus, fallback = "") {
  const stage = deliveryStage(deliveryStatus);
  if (stage) return DELIVERY_STAGE_LABEL[stage];
  return fallback;
}
