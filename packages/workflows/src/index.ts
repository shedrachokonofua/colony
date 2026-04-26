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

export function reconcileActivityIdempotencyKey(input: {
  readonly scope_id: ScopeId;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly sequence: number;
}): string {
  return `${input.workflow_id}:${input.run_id}:reconcile:${input.scope_id}:${input.sequence}`;
}

const activities = proxyActivities<SupervisorActivities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    maximumAttempts: 1,
  },
});

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
  await activities.claimReadyTask({ scope_id, assignee: "bot:engine" });

  for (;;) {
    const signaled = await condition(
      () => queue.length > 0,
      RECONCILE_INTERVAL,
    );

    if (!signaled) {
      await activities.reconcileScope({
        scope_id,
        idempotency_key: reconcileActivityIdempotencyKey({
          scope_id,
          workflow_id: info.workflowId,
          run_id: info.runId,
          sequence: nextReconcileSeq++,
        }),
      });
      await activities.claimReadyTask({ scope_id, assignee: "bot:engine" });
      continue;
    }

    let signal = queue.shift();
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
      signal = queue.shift();
    }

    await activities.claimReadyTask({ scope_id, assignee: "bot:engine" });
  }
}
