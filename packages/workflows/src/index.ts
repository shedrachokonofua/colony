import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";

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
  | "operator_override";

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
    };

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
}

export type TaskLifecycleState =
  | "created"
  | "ready"
  | "claimed"
  | "in_progress"
  | "review_requested"
  | "changes_requested"
  | "merge_ready"
  | "merged"
  | "closed"
  | "blocked"
  | "conflict"
  | "failed"
  | "canceled"
  | "pending_sync";

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
      readonly final_state: TaskLifecycleState;
      readonly developer_envelope?: unknown;
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
  readonly openMrGate: (input: {
    readonly task_id: TaskId;
  }) => Promise<GateResult>;
  readonly startReviewerRun: (input: {
    readonly task_id: TaskId;
    readonly reviewer: string;
    readonly developer_envelope: unknown;
  }) => Promise<ReviewerRunResult>;
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

export function supervisorWorkflowId(scope_id: ScopeId): string {
  return `supervisor-${scope_id}`;
}

export const RECONCILE_INTERVAL = "15 minutes" as const;

/**
 * Per-scope heartbeat cadence — the supervisor's "am I making forward
 * progress?" tick. Three heartbeats fit inside one reconcile window so
 * a stalled scope surfaces well before drift detection runs.
 */
export const HEARTBEAT_INTERVAL = "5 minutes" as const;

/**
 * After this much wall time without any audit/event/agent_run/task
 * update on the scope, the heartbeat activity classifies the scope as
 * stalled and tries to recover. Default keeps a tight enough window
 * for active scopes (architect run takes ~5 min) but doesn't trip on
 * normal-cadence developer runs.
 */
export const HEARTBEAT_STALL_THRESHOLD_MS = 10 * 60 * 1000; // 10 min

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
  startToCloseTimeout: "30 seconds",
  retry: {
    maximumAttempts: 1,
  },
});

const DEVELOPER_ASSIGNEE = "bot:engine" as const;
const REVIEWER_ASSIGNEE = "bot:reviewer" as const;

async function driveClaimedTask(input: {
  readonly scope_id: ScopeId;
  readonly task_id: TaskId;
  readonly assignee: string;
}): Promise<void> {
  const dev = await activities.startDeveloperRun({
    task_id: input.task_id,
    assignee: input.assignee,
  });
  if (
    !dev.started ||
    dev.envelope_status !== "succeeded" ||
    !dev.developer_envelope
  ) {
    return;
  }

  await activities.openMrGate({ task_id: input.task_id });
  await activities.startReviewerRun({
    task_id: input.task_id,
    reviewer: REVIEWER_ASSIGNEE,
    developer_envelope: dev.developer_envelope,
  });
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

async function evaluateAndAdvanceTask(task_id: TaskId): Promise<void> {
  const gate = await activities.checkMrGate({ task_id });
  if (!gate.checked || !gate.gate_open) return;
  const merge = await activities.mergeTask({ task_id });
  if (!merge.merged) return;
  await activities.closeTaskAfterMerge({
    task_id,
    merge_commit_sha: merge.merge_commit_sha,
    verified_by_webhook: false,
  });
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
  }
}

export async function scopeSupervisorWorkflow(
  scope_id: ScopeId,
): Promise<void> {
  const queue: Array<SupervisorSignal & { readonly seq: number }> = [];
  let nextSignalSeq = 1;
  let nextReconcileSeq = 1;
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

  await activities.readScopeState({ scope_id });
  await claimAndDriveReadyTask(scope_id);

  let nextHeartbeatSeq = 1;
  let heartbeatTickCount = 0;

  for (;;) {
    const signaled = await condition(
      () => queue.length > 0,
      HEARTBEAT_INTERVAL,
    );

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

      heartbeatTickCount += 1;
      // Reconcile every 3rd heartbeat tick (5 min × 3 = 15 min, matching
      // the documented RECONCILE_INTERVAL). Drift checks remain on their
      // own cadence; the heartbeat handles liveness.
      if (heartbeatTickCount % 3 === 0) {
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
        await activities.reconcileScope({
          scope_id,
          idempotency_key: reconcileActivityIdempotencyKey({
            scope_id,
            workflow_id: info.workflowId,
            run_id: info.runId,
            sequence: nextReconcileSeq++,
          }),
        });
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
    }

    for (const task_id of taskIdsToEvaluate) {
      await evaluateAndAdvanceTask(task_id);
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
  }
}
