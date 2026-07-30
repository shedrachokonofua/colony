import {
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import { ActivityFailure, ApplicationFailure } from "@temporalio/common";

/**
 * Temporal workflow-safe package.
 *
 * Keep this package deterministic: no database clients, provider clients,
 * wall-clock reads, process/env access, random values, network calls, or Pi
 * runtime integration. Side effects belong in activities outside this package.
 */
export const COLONY_WORKFLOWS_PACKAGE = "@colony/workflows" as const;

export type ScopeId = string;
export type TaskId = string;

export type SupervisorSignalName =
  | "provider_event"
  | "approval"
  | "changes_requested"
  | "pipeline_update"
  | "operator_override"
  | "architect_requested";

export type JsonPrimitive = string | number | boolean | null;
export type NormalizedAttributes = Readonly<Record<string, JsonPrimitive>>;

export interface SignalReference {
  readonly provider?: string;
  readonly object_kind?: string;
  readonly object_id?: string;
  readonly event_id?: string;
  readonly artifact_id?: string;
  readonly uri?: string;
  /**
   * Provider project context (COL-1.2b). Webhook events arriving from a
   * multi-repo scope must carry the project ID/path so downstream lookups
   * resolve `provider_mirrors` to the correct row even when issue IIDs
   * collide across projects.
   */
  readonly provider_project_id?: string;
  readonly provider_project_path?: string;
}

interface SupervisorSignalBase {
  readonly task_id?: TaskId;
  readonly actor?: string;
  readonly occurred_at?: string;
  readonly reference?: SignalReference;
  readonly attributes?: NormalizedAttributes;
}

export interface ProviderEventSignal extends SupervisorSignalBase {
  readonly provider: string;
  readonly event_type: string;
  readonly event_id: string;
  readonly object_kind: string;
  readonly object_id: string;
  readonly provider_project_id?: string;
  readonly provider_project_path?: string;
}

export interface ApprovalSignal extends SupervisorSignalBase {
  readonly actor: string;
  readonly artifact_id: string;
  readonly approval_id?: string;
  readonly commit_sha?: string;
  readonly pipeline_id?: string;
}

export interface ChangesRequestedSignal extends SupervisorSignalBase {
  readonly actor: string;
  readonly reason: string;
  readonly review_id?: string;
  readonly artifact_id?: string;
}

export interface PipelineUpdateSignal extends SupervisorSignalBase {
  readonly provider: string;
  readonly pipeline_id: string;
  readonly status: string;
  readonly commit_sha?: string;
}

export interface OperatorOverrideSignal extends SupervisorSignalBase {
  readonly actor: string;
  readonly action: string;
  readonly reason: string;
}

/**
 * Operator (or recovery) intent: run the architect against this scope.
 * Both the UI/API and the supervisor's heartbeat-driven recovery send the
 * same signal — one handler, two senders.
 */
export interface ArchitectRequestedSignal extends SupervisorSignalBase {
  readonly actor: string;
  readonly reason?: string;
  readonly audit_id?: string;
  readonly event_id?: string;
}

export type SupervisorSignal =
  | { readonly name: "provider_event"; readonly payload: ProviderEventSignal }
  | { readonly name: "approval"; readonly payload: ApprovalSignal }
  | {
      readonly name: "changes_requested";
      readonly payload: ChangesRequestedSignal;
    }
  | {
      readonly name: "pipeline_update";
      readonly payload: PipelineUpdateSignal;
    }
  | {
      readonly name: "operator_override";
      readonly payload: OperatorOverrideSignal;
    }
  | {
      readonly name: "architect_requested";
      readonly payload: ArchitectRequestedSignal;
    };

interface SupervisorContinuationState {
  readonly pending_signals?: ReadonlyArray<
    SupervisorSignal & { readonly seq: number }
  >;
  readonly next_signal_seq?: number;
  readonly next_reconcile_seq?: number;
  readonly next_heartbeat_seq?: number;
  readonly heartbeat_tick_count?: number;
  readonly processed_work_count?: number;
}

export interface ScopeStateSnapshot {
  readonly scope: {
    readonly id: ScopeId;
    readonly state: string;
    readonly state_version: number;
  } | null;
  readonly tasks: ReadonlyArray<{
    readonly id: TaskId;
    readonly state: string;
    readonly state_version: number;
    readonly claim_version: number;
    readonly assignee?: string;
  }>;
}

export interface RecordWorkflowEventInput {
  readonly scope_id: ScopeId;
  readonly task_id?: TaskId;
  readonly signal_seq: number;
  readonly signal: SupervisorSignalName;
  readonly kind: string;
  readonly actor?: string;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly payload: Readonly<object>;
}

export interface RecordWorkflowEventResult {
  readonly recorded: boolean;
  readonly event_id?: string;
  readonly audit_id?: string;
  readonly reason?: string;
}

export interface ClaimReadyTaskInput {
  readonly scope_id: ScopeId;
  readonly assignee: string;
}

export interface ClaimReadyTaskResult {
  readonly claimed: boolean;
  readonly task_id?: TaskId;
  readonly assignee?: string;
  readonly provider_projection?: {
    readonly status: "synced" | "skipped" | "failed";
    readonly provider?: string;
    readonly provider_id?: string;
    readonly provider_project_id?: string;
    readonly reason?: string;
  };
  readonly reason?: string;
}

export interface ReconcileScopeInput {
  readonly scope_id: ScopeId;
  readonly idempotency_key: string;
}

export interface ReconcileScopeResult {
  readonly scope_id: ScopeId;
  readonly checked_at: string;
  readonly ok: boolean;
  readonly auto_corrected: number;
  readonly conflicts: number;
  readonly warnings: number;
  readonly findings?: ReadonlyArray<{
    readonly task_id?: TaskId;
    readonly kind?: string;
    readonly severity?: string;
    readonly action?: string;
    readonly actual?: Readonly<Record<string, unknown>>;
  }>;
  readonly tasks?: ReadonlyArray<{
    readonly task_id: TaskId;
    readonly state?: string;
    readonly findings?: ReadonlyArray<{
      readonly kind?: string;
      readonly severity?: string;
      readonly action?: string;
    }>;
  }>;
}

export type TaskLifecycleState =
  | "created"
  | "ready"
  | "claimed"
  | "plan_proposed"
  | "plan_review"
  | "in_progress"
  | "review_requested"
  | "changes_requested"
  | "merge_ready"
  | "merged"
  | "closed"
  | "blocked"
  | "conflict"
  | "failed"
  | "canceled";
export type AgentOutcome =
  | "done"
  | "approved"
  | "changes_requested"
  | "blocked"
  | "escalate";

export type DeveloperRunResult =
  | {
      readonly started: false;
      readonly task_id?: TaskId;
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly task_id: TaskId;
      readonly run_id: string;
      readonly envelope_status: "succeeded" | "envelope_rejected" | "failed";
      readonly outcome?: AgentOutcome;
      readonly final_state: TaskLifecycleState;
      readonly developer_envelope?: unknown;
      readonly reason?: string;
    };

export type DeveloperPlanResult =
  | {
      readonly started: false;
      readonly task_id?: TaskId;
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly task_id: TaskId;
      readonly envelope_status: "succeeded" | "envelope_rejected" | "failed";
      readonly outcome?: AgentOutcome;
      readonly final_state: TaskLifecycleState;
      readonly developer_plan?: unknown;
      readonly reason?: string;
    };

export type PlanReviewResult =
  | {
      readonly started: false;
      readonly task_id?: TaskId;
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly task_id: TaskId;
      readonly envelope_status: "succeeded" | "envelope_rejected" | "failed";
      readonly outcome?: AgentOutcome;
      readonly review_result?:
        | "approved"
        | "changes_requested"
        | "blocked"
        | "escalate";
      readonly final_state: TaskLifecycleState;
      readonly plan_review?: unknown;
      readonly reason?: string;
    };

export type ReviewerRunResult =
  | {
      readonly started: false;
      readonly task_id?: TaskId;
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly task_id: TaskId;
      readonly run_id: string;
      readonly review_id: string;
      readonly envelope_status: "succeeded" | "envelope_rejected" | "failed";
      readonly outcome?: AgentOutcome;
      readonly review_result?:
        | "approved"
        | "changes_requested"
        | "blocked"
        | "escalate";
      readonly final_state: TaskLifecycleState;
      readonly reason?: string;
    };

export type GateResult =
  | { readonly opened: false; readonly reason?: string }
  | {
      readonly opened: true;
      readonly gate_id?: string;
      readonly reason?: string;
    };

export type HumanApprovalResult =
  | { readonly recorded: false; readonly reason: string }
  | { readonly recorded: true; readonly approval_id: string };

export type PipelineStatusResult =
  | { readonly recorded: false; readonly reason: string }
  | { readonly recorded: true; readonly invalidated_approvals: number };

export type CheckGateResult =
  | { readonly checked: false; readonly reason: string }
  | {
      readonly checked: true;
      readonly task_id: TaskId;
      readonly final_state: TaskLifecycleState;
      readonly gate_open: boolean;
      readonly reasons: readonly string[];
    };

export type MergeResult =
  | {
      readonly merged: false;
      readonly task_id?: TaskId;
      readonly reason: string;
    }
  | {
      readonly merged: true;
      readonly task_id: TaskId;
      readonly final_state: TaskLifecycleState;
      readonly merge_commit_sha?: string;
    };

export type CloseResult =
  | {
      readonly closed: false;
      readonly task_id?: TaskId;
      readonly reason: string;
    }
  | {
      readonly closed: true;
      readonly task_id: TaskId;
      readonly final_state: TaskLifecycleState;
    };

export type DecompositionCommandResult =
  | { readonly applied: false; readonly reason: string }
  | {
      readonly applied: true;
      readonly proposal_id: string;
      readonly action:
        | "review_recorded"
        | "human_approved"
        | "changes_requested";
    };

export type TaskReworkResult =
  | {
      readonly applied: false;
      readonly task_id?: TaskId;
      readonly reason: string;
    }
  | {
      readonly applied: true;
      readonly task_id: TaskId;
      readonly previous_state: TaskLifecycleState;
      readonly new_state: TaskLifecycleState;
      readonly invalidated_approvals: number;
      readonly rework_count: number;
    };

export type OperatorTaskAction =
  | "cancel"
  | "block"
  | "unblock"
  | "force_pending_sync"
  | "requeue_ready";

export type OperatorScopeAction = "cancel";

export type ApplyOperatorOverrideInput =
  | {
      readonly target: "task";
      readonly task_id: TaskId;
      readonly action: OperatorTaskAction;
      readonly actor: string;
      readonly reason: string;
      readonly evidence?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly target: "scope";
      readonly scope_id: ScopeId;
      readonly action: OperatorScopeAction;
      readonly actor: string;
      readonly reason: string;
      readonly evidence?: Readonly<Record<string, unknown>>;
    };

export type ApplyOperatorOverrideResult =
  | { readonly applied: false; readonly reason: string }
  | {
      readonly applied: true;
      readonly target: "task" | "scope";
      readonly previous_state: string;
      readonly new_state: string;
    };

export type ArchitectRunActivityResult =
  | {
      readonly started: false;
      readonly scope_id?: string;
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly scope_id: string;
      readonly run_id: string;
      readonly envelope_status: "succeeded" | "envelope_rejected" | "failed";
      readonly proposal_id?: string;
      readonly reason?: string;
    };

export type DecompositionReviewActivityResult =
  | {
      readonly started: false;
      readonly scope_id?: string;
      readonly proposal_id?: string;
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly scope_id: string;
      readonly proposal_id: string;
      readonly run_id: string;
      readonly envelope_status: "succeeded" | "envelope_rejected" | "failed";
      readonly outcome?: AgentOutcome;
      readonly review_result?:
        | "approved"
        | "changes_requested"
        | "blocked"
        | "escalate";
      readonly reason?: string;
    };

export interface LongRunningSupervisorActivities {
  readonly startArchitectRun: (input: {
    readonly scope_id: ScopeId;
    readonly actor?: string;
  }) => Promise<ArchitectRunActivityResult>;
  readonly startDecompositionReviewRun: (input: {
    readonly scope_id: ScopeId;
    readonly proposal_id?: string;
    readonly reviewer?: string;
  }) => Promise<DecompositionReviewActivityResult>;
}

export interface SupervisorActivities {
  readonly readScopeState: (input: {
    readonly scope_id: ScopeId;
  }) => Promise<ScopeStateSnapshot>;
  readonly recordWorkflowEvent: (
    input: RecordWorkflowEventInput,
  ) => Promise<RecordWorkflowEventResult>;
  readonly claimReadyTask: (
    input: ClaimReadyTaskInput,
  ) => Promise<ClaimReadyTaskResult>;
  readonly reconcileScope: (
    input: ReconcileScopeInput,
  ) => Promise<ReconcileScopeResult>;
  readonly startDeveloperRun: (input: {
    readonly task_id: TaskId;
    readonly assignee: string;
  }) => Promise<DeveloperRunResult>;
  readonly startDeveloperPlanRun: (input: {
    readonly task_id: TaskId;
    readonly assignee: string;
  }) => Promise<DeveloperPlanResult>;
  readonly startPlanReviewRun: (input: {
    readonly task_id: TaskId;
    readonly reviewer: string;
    readonly developer_plan: unknown;
  }) => Promise<PlanReviewResult>;
  readonly openMrGate: (input: {
    readonly task_id: TaskId;
  }) => Promise<GateResult>;
  readonly startReviewerRun: (input: {
    readonly task_id: TaskId;
    readonly reviewer: string;
    readonly developer_envelope: unknown;
  }) => Promise<ReviewerRunResult>;
  readonly markTaskFailed: (input: {
    readonly task_id: TaskId;
    readonly reason: string;
  }) => Promise<
    | {
        readonly marked: false;
        readonly task_id?: TaskId;
        readonly reason: string;
      }
    | {
        readonly marked: true;
        readonly task_id: TaskId;
        readonly previous_state: TaskLifecycleState;
        readonly new_state: "failed";
      }
  >;
  readonly recordHumanApproval: (input: {
    readonly task_id: TaskId;
    readonly actor: string;
    readonly commit_sha?: string;
    readonly pipeline_id?: string;
    readonly evidence?: Readonly<Record<string, unknown>>;
  }) => Promise<HumanApprovalResult>;
  readonly recordPipelineStatus: (input: {
    readonly task_id: TaskId;
    readonly pipeline_id: string;
    readonly commit_sha: string;
    readonly status: string;
  }) => Promise<PipelineStatusResult>;
  readonly checkMrGate: (input: {
    readonly task_id: TaskId;
  }) => Promise<CheckGateResult>;
  readonly mergeTask: (input: {
    readonly task_id: TaskId;
    readonly actor?: string;
  }) => Promise<MergeResult>;
  readonly closeTaskAfterMerge: (input: {
    readonly task_id: TaskId;
    readonly merge_commit_sha?: string;
    readonly verified_by_webhook?: boolean;
  }) => Promise<CloseResult>;
  readonly applyDecompositionCommand: (input: {
    readonly scope_id: ScopeId;
    readonly action: "approve" | "changes";
    readonly actor: string;
    readonly reason?: string;
  }) => Promise<DecompositionCommandResult>;
  readonly requestTaskRework: (input: {
    readonly task_id: TaskId;
    readonly actor: string;
    readonly reason?: string;
  }) => Promise<TaskReworkResult>;
  readonly applyOperatorOverride: (
    input: ApplyOperatorOverrideInput,
  ) => Promise<ApplyOperatorOverrideResult>;
  readonly checkProviderHealth: (input: {
    readonly provider?: string;
  }) => Promise<{
    readonly provider: string;
    readonly ok: boolean;
    readonly checked_at: string;
    readonly latency_ms?: number;
    readonly error?: string;
    readonly version?: string;
  }>;
  readonly markScopePendingSync: (input: {
    readonly scope_id: ScopeId;
    readonly reason?: string;
    readonly health?: {
      readonly ok: boolean;
      readonly checked_at: string;
      readonly error?: string;
    };
  }) => Promise<{
    readonly scope_id: ScopeId;
    readonly transitioned: number;
    readonly skipped: number;
    readonly already_pending: number;
    readonly task_ids: readonly string[];
  }>;
  readonly scopeHeartbeatTick: (input: {
    readonly scope_id: ScopeId;
    readonly stall_threshold_ms: number;
    readonly idempotency_key: string;
  }) => Promise<{
    readonly scope_id: ScopeId;
    readonly status: "healthy" | "stalled" | "recovered" | "scope_terminal";
    readonly classifier?: string;
    readonly recovery?: string;
    readonly last_progress_age_ms?: number;
  }>;
}

export const providerEventSignal =
  defineSignal<[ProviderEventSignal]>("providerEvent");
export const approvalSignal = defineSignal<[ApprovalSignal]>("approval");
export const changesRequestedSignal =
  defineSignal<[ChangesRequestedSignal]>("changesRequested");
export const pipelineUpdateSignal =
  defineSignal<[PipelineUpdateSignal]>("pipelineUpdate");
export const operatorOverrideSignal =
  defineSignal<[OperatorOverrideSignal]>("operatorOverride");
export const architectRequestedSignal =
  defineSignal<[ArchitectRequestedSignal]>("architectRequested");

export function supervisorWorkflowId(scope_id: ScopeId): string {
  return `supervisor-${scope_id}`;
}

export const RECONCILE_INTERVAL = "5 minutes" as const;

/**
 * Per-scope heartbeat cadence — the supervisor's "am I making forward
 * progress?" tick. Drives both stall detection and self-healing
 * recovery dispatch (architect / reviewer kickoffs when the scope is
 * stuck mid-flow).
 */
export const HEARTBEAT_INTERVAL = "1 minute" as const;

/**
 * After this much wall time without any scope/task update, the
 * heartbeat classifies the scope as stalled and dispatches recovery.
 * In-flight agent runs bump scope.updated_at on submission so a
 * tight threshold doesn't trip mid-run. Tuned to match the 1-min
 * heartbeat cadence — recovery fires within ~3 min of a real stall.
 */
export const HEARTBEAT_STALL_THRESHOLD_MS = 3 * 60 * 1000; // 3 min

export function reconcileActivityIdempotencyKey(input: {
  readonly scope_id: ScopeId;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly sequence: number;
}): string {
  return `${input.workflow_id}:${input.run_id}:reconcile:${input.scope_id}:${input.sequence}`;
}

export function heartbeatActivityIdempotencyKey(input: {
  readonly scope_id: ScopeId;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly sequence: number;
}): string {
  return `${input.workflow_id}:${input.run_id}:heartbeat:${input.scope_id}:${input.sequence}`;
}

const activities = proxyActivities<SupervisorActivities>({
  startToCloseTimeout: "30 minutes",
  retry: {
    initialInterval: "3 seconds",
    maximumInterval: "1 minute",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

const agentActivities = proxyActivities<
  Pick<
    SupervisorActivities,
    | "startDeveloperPlanRun"
    | "startPlanReviewRun"
    | "startDeveloperRun"
    | "startReviewerRun"
  >
>({
  startToCloseTimeout: "30 minutes",
  scheduleToCloseTimeout: "2 hours",
  retry: {
    initialInterval: "10 seconds",
    maximumInterval: "2 minutes",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["NonRetryableAgentRunError"],
  },
});

/**
 * Architect runs invoke an LLM and can run for many minutes. Give them a
 * dedicated proxy with a long timeout; the standard 30s window above
 * fits the lightweight orchestration activities.
 */
const longRunningActivities = proxyActivities<LongRunningSupervisorActivities>({
  startToCloseTimeout: "30 minutes",
  retry: {
    maximumAttempts: 1,
  },
});
const DEVELOPER_ASSIGNEE = "bot:engine" as const;
const REVIEWER_ASSIGNEE = "bot:reviewer" as const;
const TASK_REFINEMENT_LOOP_CAP = 50;

async function blockTaskAndAudit(input: {
  readonly scope_id: ScopeId;
  readonly task_id: TaskId;
  readonly reason: string;
  readonly signal_seq: number;
  readonly evidence?: Readonly<Record<string, unknown>>;
}): Promise<void> {
  const info = workflowInfo();
  await activities.applyOperatorOverride({
    target: "task",
    task_id: input.task_id,
    action: "block",
    actor: "svc:supervisor",
    reason: input.reason,
    evidence: input.evidence,
  });
  await activities.recordWorkflowEvent({
    scope_id: input.scope_id,
    task_id: input.task_id,
    signal_seq: input.signal_seq,
    signal: "operator_override",
    kind: "task_blocked",
    actor: "svc:supervisor",
    workflow_id: info.workflowId,
    run_id: info.runId,
    payload: {
      action: "block",
      reason: input.reason,
      ...(input.evidence ?? {}),
    },
  });
}

async function driveClaimedTask(input: {
  readonly scope_id: ScopeId;
  readonly task_id: TaskId;
  readonly assignee: string;
}): Promise<void> {
  try {
    for (let cycle = 1; cycle <= TASK_REFINEMENT_LOOP_CAP; cycle += 1) {
      let planApproved = false;
      for (
        let attempt = 1;
        attempt <= TASK_REFINEMENT_LOOP_CAP && !planApproved;
        attempt += 1
      ) {
        const plan = await agentActivities.startDeveloperPlanRun({
          task_id: input.task_id,
          assignee: input.assignee,
        });
        const planOutcome = "outcome" in plan ? plan.outcome : undefined;
        if (
          !plan.started ||
          planOutcome === "blocked" ||
          planOutcome === "escalate"
        ) {
          await blockTaskAndAudit({
            ...input,
            signal_seq: cycle * TASK_REFINEMENT_LOOP_CAP + attempt,
            reason:
              plan.reason ??
              (planOutcome === "blocked" || planOutcome === "escalate"
                ? `developer_plan_${planOutcome}`
                : "developer_plan_not_started"),
            evidence: {
              envelope_status: plan.started
                ? plan.envelope_status
                : "not_started",
              outcome: planOutcome,
            },
          });
          return;
        }
        if (plan.envelope_status !== "succeeded" || !plan.developer_plan) {
          if (attempt < TASK_REFINEMENT_LOOP_CAP) continue;
          await blockTaskAndAudit({
            ...input,
            signal_seq: cycle * TASK_REFINEMENT_LOOP_CAP + attempt,
            reason: "developer_plan_refinement_loop_cap_exhausted",
            evidence: {
              envelope_status: plan.envelope_status,
              outcome: planOutcome,
            },
          });
          return;
        }

        const planReview = await agentActivities.startPlanReviewRun({
          task_id: input.task_id,
          reviewer: REVIEWER_ASSIGNEE,
          developer_plan: plan.developer_plan,
        });
        const planReviewOutcome =
          "outcome" in planReview ? planReview.outcome : undefined;
        if (
          !planReview.started ||
          planReviewOutcome === "blocked" ||
          planReviewOutcome === "escalate"
        ) {
          await blockTaskAndAudit({
            ...input,
            signal_seq: cycle * TASK_REFINEMENT_LOOP_CAP + attempt,
            reason:
              planReview.reason ??
              (planReviewOutcome === "blocked" ||
              planReviewOutcome === "escalate"
                ? `plan_review_${planReviewOutcome}`
                : "plan_review_not_started"),
            evidence: {
              envelope_status: planReview.started
                ? planReview.envelope_status
                : "not_started",
              outcome: planReviewOutcome,
            },
          });
          return;
        }
        if (planReview.envelope_status !== "succeeded") {
          if (attempt < TASK_REFINEMENT_LOOP_CAP) continue;
          await blockTaskAndAudit({
            ...input,
            signal_seq: cycle * TASK_REFINEMENT_LOOP_CAP + attempt,
            reason: "plan_review_refinement_loop_cap_exhausted",
            evidence: {
              envelope_status: planReview.envelope_status,
              outcome: planReviewOutcome,
            },
          });
          return;
        }
        if (planReview.review_result === "approved") {
          planApproved = true;
        } else if (planReview.review_result === "changes_requested") {
          continue;
        } else {
          await blockTaskAndAudit({
            ...input,
            signal_seq: cycle * TASK_REFINEMENT_LOOP_CAP + attempt,
            reason: "plan_review_no_approval",
            evidence: { review_result: planReview.review_result },
          });
          return;
        }
      }
      if (!planApproved) {
        await blockTaskAndAudit({
          ...input,
          signal_seq: cycle * TASK_REFINEMENT_LOOP_CAP,
          reason: "plan_refinement_loop_cap_exhausted",
        });
        return;
      }

      const dev = await agentActivities.startDeveloperRun({
        task_id: input.task_id,
        assignee: input.assignee,
      });
      const devOutcome = "outcome" in dev ? dev.outcome : undefined;
      if (
        !dev.started ||
        dev.envelope_status !== "succeeded" ||
        devOutcome === "blocked" ||
        devOutcome === "escalate" ||
        !dev.developer_envelope
      ) {
        await blockTaskAndAudit({
          ...input,
          signal_seq: cycle * TASK_REFINEMENT_LOOP_CAP + 10_000,
          reason:
            dev.reason ??
            (devOutcome === "blocked" || devOutcome === "escalate"
              ? `developer_${devOutcome}`
              : "developer_envelope_failed"),
          evidence: {
            envelope_status: dev.started ? dev.envelope_status : "not_started",
            outcome: devOutcome,
          },
        });
        return;
      }

      const gate = await activities.openMrGate({ task_id: input.task_id });
      if (!gate.opened) {
        await blockTaskAndAudit({
          ...input,
          signal_seq: cycle * TASK_REFINEMENT_LOOP_CAP + 20_000,
          reason: `open_mr_gate_failed:${gate.reason ?? "unknown"}`,
        });
        return;
      }
      const review = await agentActivities.startReviewerRun({
        task_id: input.task_id,
        reviewer: REVIEWER_ASSIGNEE,
        developer_envelope: dev.developer_envelope,
      });
      const reviewOutcome = "outcome" in review ? review.outcome : undefined;
      if (
        !review.started ||
        review.envelope_status !== "succeeded" ||
        reviewOutcome === "blocked" ||
        reviewOutcome === "escalate"
      ) {
        await blockTaskAndAudit({
          ...input,
          signal_seq: cycle * TASK_REFINEMENT_LOOP_CAP + 30_000,
          reason:
            review.reason ??
            (reviewOutcome === "blocked" || reviewOutcome === "escalate"
              ? `review_${reviewOutcome}`
              : "review_envelope_failed"),
          evidence: {
            envelope_status: review.started
              ? review.envelope_status
              : "not_started",
            outcome: reviewOutcome,
          },
        });
        return;
      }
      if (review.review_result === "approved") return;
      if (review.review_result !== "changes_requested") {
        await blockTaskAndAudit({
          ...input,
          signal_seq: cycle * TASK_REFINEMENT_LOOP_CAP + 30_001,
          reason: "review_no_approval",
          evidence: { review_result: review.review_result },
        });
        return;
      }
    }
    await blockTaskAndAudit({
      ...input,
      signal_seq: TASK_REFINEMENT_LOOP_CAP * TASK_REFINEMENT_LOOP_CAP,
      reason: "task_refinement_loop_cap_exhausted",
    });
  } catch (err) {
    await blockTaskAndAudit({
      ...input,
      signal_seq: 2_000_000,
      reason: `agent_activity_failed:${activityFailureReason(err)}`,
    });
  }
}

function activityFailureReason(err: unknown): string {
  if (err instanceof ActivityFailure) {
    const cause = err.cause;
    if (cause instanceof ApplicationFailure) {
      return cause.message;
    }
    return cause instanceof Error ? cause.message : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

async function claimAndDriveReadyTask(scope_id: ScopeId): Promise<void> {
  const claimed = await activities.claimReadyTask({
    scope_id,
    assignee: DEVELOPER_ASSIGNEE,
  });
  if (!claimed.claimed || !claimed.task_id) return;
  await driveClaimedTask({
    scope_id,
    task_id: claimed.task_id,
    assignee: claimed.assignee ?? DEVELOPER_ASSIGNEE,
  });
}

function isMergedProviderSignal(
  signal: SupervisorSignal & { readonly seq: number },
  task_id: TaskId,
): boolean {
  if (signal.name !== "provider_event" || signal.payload.task_id !== task_id) {
    return false;
  }
  const eventType = signal.payload.event_type.toLowerCase();
  return (
    eventType === "merged" ||
    eventType === "merge" ||
    eventType.includes("merge_request_merged") ||
    signal.payload.attributes?.["state"] === "merged"
  );
}

async function markTaskPendingSyncAndAudit(input: {
  readonly scope_id: ScopeId;
  readonly task_id: TaskId;
  readonly reason: string;
  readonly signal_seq: number;
}): Promise<void> {
  const info = workflowInfo();
  await activities.applyOperatorOverride({
    target: "task",
    task_id: input.task_id,
    action: "force_pending_sync",
    actor: "svc:supervisor",
    reason: input.reason,
  });
  await activities.recordWorkflowEvent({
    scope_id: input.scope_id,
    task_id: input.task_id,
    signal_seq: input.signal_seq,
    signal: "provider_event",
    kind: "task_pending_sync",
    actor: "svc:supervisor",
    workflow_id: info.workflowId,
    run_id: info.runId,
    payload: { reason: input.reason },
  });
}

async function consumeReconciliationResult(
  scope_id: ScopeId,
  result: ReconcileScopeResult,
  signal_seq: number,
): Promise<void> {
  if (result.conflicts <= 0) return;
  const taskIds = new Set<TaskId>();
  for (const finding of result.findings ?? []) {
    if (finding.task_id && finding.severity === "conflict") {
      taskIds.add(finding.task_id);
    }
  }
  for (const task of result.tasks ?? []) {
    if (task.findings?.some((finding) => finding.severity === "conflict")) {
      taskIds.add(task.task_id);
    }
  }
  if (taskIds.size === 0) {
    await activities.markScopePendingSync({
      scope_id,
      reason: `reconcile_conflicts:${result.conflicts}`,
    });
  } else {
    for (const task_id of taskIds) {
      await markTaskPendingSyncAndAudit({
        scope_id,
        task_id,
        signal_seq: signal_seq++,
        reason: "reconcile_conflict",
      });
    }
  }
  const info = workflowInfo();
  await activities.recordWorkflowEvent({
    scope_id,
    signal_seq,
    signal: "provider_event",
    kind: "reconcile_conflict",
    actor: "svc:supervisor",
    workflow_id: info.workflowId,
    run_id: info.runId,
    payload: { conflicts: result.conflicts, warnings: result.warnings },
  });
}

async function evaluateAndAdvanceTask(
  scope_id: ScopeId,
  task_id: TaskId,
  queue: ReadonlyArray<SupervisorSignal & { readonly seq: number }>,
  reconcileSeq: number,
): Promise<void> {
  const gate = await activities.checkMrGate({ task_id });
  if (!gate.checked || !gate.gate_open) return;
  const merge = await activities.mergeTask({ task_id });
  if (!merge.merged) return;

  const webhookConfirmed = await condition(
    () => queue.some((signal) => isMergedProviderSignal(signal, task_id)),
    "2 minutes",
  );
  if (webhookConfirmed) {
    await activities.closeTaskAfterMerge({
      task_id,
      merge_commit_sha: merge.merge_commit_sha,
      verified_by_webhook: true,
    });
    return;
  }

  const reconciliation = await activities.reconcileScope({
    scope_id,
    idempotency_key: reconcileActivityIdempotencyKey({
      scope_id,
      workflow_id: workflowInfo().workflowId,
      run_id: workflowInfo().runId,
      sequence: reconcileSeq,
    }),
  });
  await consumeReconciliationResult(scope_id, reconciliation, reconcileSeq);
  const mergedByReconcile =
    reconciliation.tasks?.some(
      (task) => task.task_id === task_id && task.state === "merged",
    ) ?? false;
  if (mergedByReconcile) {
    await activities.closeTaskAfterMerge({
      task_id,
      merge_commit_sha: merge.merge_commit_sha,
      verified_by_webhook: false,
    });
  } else {
    await markTaskPendingSyncAndAudit({
      scope_id,
      task_id,
      signal_seq: reconcileSeq + 100_000,
      reason: "merge_webhook_timeout_unconfirmed",
    });
  }
}

function eventKind(signal: SupervisorSignalName): string {
  switch (signal) {
    case "approval":
      return "approval_recorded";
    case "changes_requested":
      return "review_resolved";
    case "operator_override":
      return "operator_override";
    case "pipeline_update":
    case "provider_event":
      return "provider_event";
    case "architect_requested":
      return "architect_decomposition_requested";
  }
}

function isOperatorTaskAction(action: string): action is OperatorTaskAction {
  return (
    action === "cancel" ||
    action === "block" ||
    action === "unblock" ||
    action === "force_pending_sync" ||
    action === "requeue_ready"
  );
}

function isOperatorScopeAction(action: string): action is OperatorScopeAction {
  return action === "cancel";
}

/**
 * Run the architect, and on success tail-call the decomposition
 * reviewer. Used by both the operator-intent signal handler and the
 * heartbeat-driven recovery path so the chain is identical regardless
 * of trigger. Recovery semantics: if the scope is already past draft
 * with an un-reviewed proposal, skip architect and go straight to
 * reviewer (the activity self-locates the latest `proposed` proposal).
 */
async function driveArchitectThenReview(
  scope_id: ScopeId,
  actor: string,
): Promise<void> {
  const arch = await longRunningActivities.startArchitectRun({
    scope_id,
    actor,
  });
  const proposedFresh =
    arch.started && arch.envelope_status === "succeeded" && arch.proposal_id;
  const isStalledAtReview =
    !arch.started && arch.reason?.startsWith("scope_not_draft:");
  if (proposedFresh) {
    await longRunningActivities.startDecompositionReviewRun({
      scope_id,
      proposal_id: arch.proposal_id,
    });
  } else if (isStalledAtReview) {
    await longRunningActivities.startDecompositionReviewRun({
      scope_id,
    });
  }
}

export async function scopeSupervisorWorkflow(
  scope_id: ScopeId,
  continuation?: SupervisorContinuationState,
): Promise<void> {
  const queue: Array<SupervisorSignal & { readonly seq: number }> = [
    ...(continuation?.pending_signals ?? []),
  ];
  let nextSignalSeq = continuation?.next_signal_seq ?? 1;
  let nextReconcileSeq = continuation?.next_reconcile_seq ?? 1;
  const info = workflowInfo();

  setHandler(providerEventSignal, (payload) => {
    queue.push({ seq: nextSignalSeq++, name: "provider_event", payload });
  });
  setHandler(approvalSignal, (payload) => {
    queue.push({ seq: nextSignalSeq++, name: "approval", payload });
  });
  setHandler(changesRequestedSignal, (payload) => {
    queue.push({ seq: nextSignalSeq++, name: "changes_requested", payload });
  });
  setHandler(pipelineUpdateSignal, (payload) => {
    queue.push({ seq: nextSignalSeq++, name: "pipeline_update", payload });
  });
  setHandler(operatorOverrideSignal, (payload) => {
    queue.push({ seq: nextSignalSeq++, name: "operator_override", payload });
  });
  setHandler(architectRequestedSignal, (payload) => {
    queue.push({ seq: nextSignalSeq++, name: "architect_requested", payload });
  });

  await activities.readScopeState({ scope_id });
  await claimAndDriveReadyTask(scope_id);

  let nextHeartbeatSeq = continuation?.next_heartbeat_seq ?? 1;
  let heartbeatTickCount = continuation?.heartbeat_tick_count ?? 0;
  let processedWorkCount = continuation?.processed_work_count ?? 0;

  let heartbeatTimer = sleep(HEARTBEAT_INTERVAL).then(() => true);
  for (;;) {
    const heartbeatDue = await Promise.race([
      condition(() => queue.length > 0).then(() => false),
      heartbeatTimer,
    ]);
    const signaled = !heartbeatDue;
    if (heartbeatDue) {
      heartbeatTimer = sleep(HEARTBEAT_INTERVAL).then(() => true);
    }

    if (!signaled) {
      // Per-scope liveness tick — fires every HEARTBEAT_INTERVAL when
      // no signals have arrived. Detects stalled scopes (architect run
      // never started, claimed task without a developer envelope, MR
      // gate open but unmerged, etc.) and triggers targeted recovery
      // via the scopeHeartbeatTick activity.
      const heartbeat = await activities.scopeHeartbeatTick({
        scope_id,
        stall_threshold_ms: HEARTBEAT_STALL_THRESHOLD_MS,
        idempotency_key: heartbeatActivityIdempotencyKey({
          scope_id,
          workflow_id: info.workflowId,
          run_id: info.runId,
          sequence: nextHeartbeatSeq++,
        }),
      });
      if (heartbeat.status === "scope_terminal") {
        // Scope reached closed/canceled — exit the workflow loop.
        return;
      }

      if (heartbeat.status === "stalled" && heartbeat.classifier) {
        switch (heartbeat.classifier) {
          case "awaiting_architect":
            await driveArchitectThenReview(scope_id, "svc:supervisor");
            break;
          case "awaiting_decomposition_review_or_approval":
            await longRunningActivities.startDecompositionReviewRun({
              scope_id,
            });
            break;
        }
      }

      heartbeatTickCount += 1;
      // Reconcile every 5th heartbeat tick (1 min × 5 = 5 min,
      // matching RECONCILE_INTERVAL). Drift checks query the provider
      // for every mirror, so they're heavier than the per-tick stall
      // classifier — but 5 min is fine for a homelab provider and
      // catches divergence fast.
      if (heartbeatTickCount % 5 === 0) {
        const health = await activities.checkProviderHealth({});
        if (!health.ok) {
          // Provider down: freeze the DAG so partially completed work
          // can finish internally but cannot advance into provider-
          // visible actions until the next reconcile finds the provider
          // healthy.
          await activities.markScopePendingSync({
            scope_id,
            reason: `provider_unhealthy:${health.error ?? "unknown"}`,
            health: {
              ok: health.ok,
              checked_at: health.checked_at,
              error: health.error,
            },
          });
          continue;
        }
        const reconciliation = await activities.reconcileScope({
          scope_id,
          idempotency_key: reconcileActivityIdempotencyKey({
            scope_id,
            workflow_id: info.workflowId,
            run_id: info.runId,
            sequence: nextReconcileSeq,
          }),
        });
        await consumeReconciliationResult(
          scope_id,
          reconciliation,
          nextReconcileSeq++,
        );
      }
      processedWorkCount += 1;
      if (processedWorkCount >= 100 || workflowInfo().continueAsNewSuggested) {
        await continueAsNew<typeof scopeSupervisorWorkflow>(scope_id, {
          pending_signals: queue,
          next_signal_seq: nextSignalSeq,
          next_reconcile_seq: nextReconcileSeq,
          next_heartbeat_seq: nextHeartbeatSeq,
          heartbeat_tick_count: heartbeatTickCount,
          processed_work_count: 0,
        });
        return;
      }
      await claimAndDriveReadyTask(scope_id);
      continue;
    }

    let signal = queue.shift();
    const taskIdsToEvaluate: TaskId[] = [];
    const taskIdsToRework: TaskId[] = [];
    while (signal) {
      await activities.recordWorkflowEvent({
        scope_id,
        task_id: signal.payload.task_id,
        signal_seq: signal.seq,
        signal: signal.name,
        kind: eventKind(signal.name),
        actor: signal.payload.actor,
        workflow_id: info.workflowId,
        run_id: info.runId,
        payload: signal.payload,
      });
      if (signal.name === "approval" && signal.payload.task_id) {
        await activities.recordHumanApproval({
          task_id: signal.payload.task_id,
          actor: signal.payload.actor,
          commit_sha: signal.payload.commit_sha,
          pipeline_id: signal.payload.pipeline_id,
          evidence: {
            artifact_id: signal.payload.artifact_id,
            approval_id: signal.payload.approval_id,
          },
        });
        taskIdsToEvaluate.push(signal.payload.task_id);
      }
      if (
        signal.name === "pipeline_update" &&
        signal.payload.task_id &&
        signal.payload.commit_sha
      ) {
        await activities.recordPipelineStatus({
          task_id: signal.payload.task_id,
          pipeline_id: signal.payload.pipeline_id,
          commit_sha: signal.payload.commit_sha,
          status: signal.payload.status,
        });
        taskIdsToEvaluate.push(signal.payload.task_id);
      }
      if (signal.name === "architect_requested") {
        await driveArchitectThenReview(scope_id, signal.payload.actor);
      }
      if (signal.name === "operator_override") {
        if (signal.payload.task_id) {
          if (isOperatorTaskAction(signal.payload.action)) {
            await activities.applyOperatorOverride({
              target: "task",
              task_id: signal.payload.task_id,
              action: signal.payload.action,
              actor: signal.payload.actor,
              reason: signal.payload.reason,
              evidence: {
                signal_seq: signal.seq,
                reference: signal.payload.reference,
              },
            });
          }
        } else if (isOperatorScopeAction(signal.payload.action)) {
          await activities.applyOperatorOverride({
            target: "scope",
            scope_id,
            action: signal.payload.action,
            actor: signal.payload.actor,
            reason: signal.payload.reason,
            evidence: {
              signal_seq: signal.seq,
              reference: signal.payload.reference,
            },
          });
        }
      }
      if (signal.name === "provider_event") {
        const attrs = signal.payload.attributes;
        const target = attrs?.command_target;
        const kind = attrs?.command_kind;
        if (
          target === "scope_decomposition" &&
          (kind === "approve" || kind === "changes")
        ) {
          const reason =
            kind === "changes" && typeof attrs?.command_prose === "string"
              ? attrs.command_prose
              : undefined;
          await activities.applyDecompositionCommand({
            scope_id,
            action: kind === "approve" ? "approve" : "changes",
            actor: signal.payload.actor ?? "unknown",
            reason,
          });
        }
        // Task-level /changes: kick the task back into developer rework
        // and queue it to re-drive after the signal batch drains.
        if (target === "task" && kind === "changes" && signal.payload.task_id) {
          const reason =
            typeof attrs?.command_prose === "string"
              ? attrs.command_prose
              : undefined;
          const result = await activities.requestTaskRework({
            task_id: signal.payload.task_id,
            actor: signal.payload.actor ?? "unknown",
            reason,
          });
          if (result.applied) {
            taskIdsToRework.push(signal.payload.task_id);
          }
        }
      }
      signal = queue.shift();
      processedWorkCount += 1;
    }
    for (const task_id of taskIdsToEvaluate) {
      await evaluateAndAdvanceTask(
        scope_id,
        task_id,
        queue,
        nextReconcileSeq++,
      );
    }
    // Re-drive developer + reviewer for any task that was just kicked
    // back into rework. This forces a fresh review on the new head;
    // requestTaskRework already invalidated stale approvals.
    for (const task_id of taskIdsToRework) {
      await driveClaimedTask({
        scope_id,
        task_id,
        assignee: DEVELOPER_ASSIGNEE,
      });
    }
    await claimAndDriveReadyTask(scope_id);

    if (processedWorkCount >= 100 || workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof scopeSupervisorWorkflow>(scope_id, {
        pending_signals: queue,
        next_signal_seq: nextSignalSeq,
        next_reconcile_seq: nextReconcileSeq,
        next_heartbeat_seq: nextHeartbeatSeq,
        heartbeat_tick_count: heartbeatTickCount,
        processed_work_count: 0,
      });
      return;
    }
  }
}
