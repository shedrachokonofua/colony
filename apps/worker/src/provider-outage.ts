import type {
  ProviderProjectRepository,
  TaskGraphRepository,
} from "@colony/db";
import {
  isScopeId,
  type ActorId,
  type Task,
  type TaskState,
} from "@colony/domain";
import type { ProviderAdapter } from "@colony/provider";

/**
 * COL-3.3 Provider outage and pending-sync handling.
 *
 * Two activities:
 *
 *   checkProviderHealth({ provider }) — calls `adapter.health()` and
 *     returns the snapshot. Used by the supervisor workflow as a guard
 *     before issuing provider-visible writes (open MR, post review,
 *     merge, close issue).
 *
 *   markScopePendingSync({ scope_id, reason }) — transitions every task
 *     in `claimed`, `in_progress`, `review_requested`, `merge_ready`, or
 *     `changes_requested` to `pending_sync`. Already-claimed work can
 *     finish internally but cannot advance the DAG until reconciliation
 *     verifies the provider state. Idempotent: tasks already in
 *     `pending_sync` are a no-op.
 *
 * On recovery (provider health flips back to ok), the next `reconcileScope`
 * tick observes `pending_sync` tasks and either republishes the agent
 * output (if the provider state matches) or marks the task `conflict`
 * (if the provider has diverged in the meantime).
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

const PENDING_SYNC_ELIGIBLE_STATES: ReadonlyArray<TaskState> = [
  "claimed",
  "in_progress",
  "review_requested",
  "changes_requested",
  "merge_ready",
];

export interface CheckProviderHealthInput {
  readonly provider?: string;
}

export type CheckProviderHealthResult = {
  readonly provider: string;
  readonly ok: boolean;
  readonly checked_at: string;
  readonly latency_ms?: number;
  readonly error?: string;
  readonly version?: string;
};

export interface CheckProviderHealthDeps {
  readonly providerAdapter: ProviderAdapter;
}

export function createCheckProviderHealth(deps: CheckProviderHealthDeps) {
  return async function checkProviderHealth(
    _input: CheckProviderHealthInput = {},
  ): Promise<CheckProviderHealthResult> {
    void _input;
    const snap = await deps.providerAdapter.health();
    return { provider: deps.providerAdapter.provider, ...snap };
  };
}

export interface MarkScopePendingSyncInput {
  readonly scope_id: string;
  readonly reason?: string;
  /**
   * Optional health snapshot to evidence in the audit trail. The
   * workflow normally passes the most recent `checkProviderHealth`
   * result so the audit row links the outage to the affected tasks.
   */
  readonly health?: {
    readonly ok: boolean;
    readonly checked_at: string;
    readonly error?: string;
  };
}

export interface MarkScopePendingSyncResult {
  readonly scope_id: string;
  readonly transitioned: number;
  readonly skipped: number;
  readonly already_pending: number;
  readonly task_ids: readonly string[];
}

export interface MarkScopePendingSyncDeps {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
}

export function createMarkScopePendingSync(deps: MarkScopePendingSyncDeps) {
  return async function markScopePendingSync(
    input: MarkScopePendingSyncInput,
  ): Promise<MarkScopePendingSyncResult> {
    if (!isScopeId(input.scope_id)) {
      return {
        scope_id: input.scope_id,
        transitioned: 0,
        skipped: 0,
        already_pending: 0,
        task_ids: [],
      };
    }
    const tasks = await deps.repo.listTasks(input.scope_id);
    const transitionedIds: string[] = [];
    let skipped = 0;
    let alreadyPending = 0;
    const eligible = new Set<TaskState>(PENDING_SYNC_ELIGIBLE_STATES);
    for (const task of tasks) {
      if (task.state === "pending_sync") {
        alreadyPending += 1;
        continue;
      }
      if (!eligible.has(task.state)) {
        skipped += 1;
        continue;
      }
      await transitionToPendingSync(deps.repo, task, input);
      transitionedIds.push(task.id);
    }
    if (transitionedIds.length > 0) {
      await deps.repo.writeAudit({
        scope_id: input.scope_id,
        actor: SUPERVISOR_ACTOR,
        action: "scope.pending_sync.bulk",
        capability: "task.assign",
        target_kind: "scope",
        target_id: input.scope_id,
        reason: input.reason ?? "provider_unhealthy",
        evidence: {
          transitioned: transitionedIds.length,
          skipped,
          already_pending: alreadyPending,
          health: input.health,
        },
      });
    }
    return {
      scope_id: input.scope_id,
      transitioned: transitionedIds.length,
      skipped,
      already_pending: alreadyPending,
      task_ids: transitionedIds,
    };
  };
}

async function transitionToPendingSync(
  repo: TaskGraphRepository,
  task: Task,
  input: MarkScopePendingSyncInput,
): Promise<void> {
  await repo.updateTaskState(task.id, task.state_version, "pending_sync", {
    actor: SUPERVISOR_ACTOR,
    capability: "task.assign",
    reason: input.reason ?? "provider_unhealthy",
  });
  await repo.writeAudit({
    scope_id: task.scope_id,
    task_id: task.id,
    actor: SUPERVISOR_ACTOR,
    action: "task.pending_sync.entered",
    capability: "task.assign",
    target_kind: "task",
    target_id: task.id,
    previous_state: task.state,
    new_state: "pending_sync",
    reason: input.reason ?? "provider_unhealthy",
    evidence: {
      health: input.health,
    },
  });
}
