import type { TaskGraphRepository } from "@colony/db";
import { isTaskId, type ActorId, type TaskState } from "@colony/domain";

/**
 * COL-3.4 task conflict state and resolution.
 *
 * Two activities:
 *
 *   recordTaskConflict({ task_id, kind, evidence }) — transitions a task
 *     to `conflict` and writes a typed audit row. Idempotent: a task
 *     already in `conflict` is a no-op.
 *
 *   resolveTaskConflict({ task_id, action, actor, reason }) — moves a
 *     task out of `conflict` into a recovery state chosen by the
 *     resolver. Allowed actions:
 *       - "requeue_ready"   → conflict -> ready (re-enter dependency
 *         loop; supervisor will reclaim)
 *       - "requeue_in_progress" → conflict -> in_progress (resume the
 *         current developer run)
 *       - "block" → conflict -> blocked (handoff to a human/operator)
 *       - "cancel" → conflict -> canceled (drop the task entirely)
 *
 * Conflict classes (recorded in `kind`):
 *   - "manual_merge"               (human merged the MR outside Colony)
 *   - "stale_commit_approval"      (approval pinned to a SHA that no
 *                                    longer matches the head)
 *   - "provider_issue_closed_mr_open" (issue closed but MR is still
 *                                      open)
 *   - "missing_audit"              (lifecycle gap detected at close)
 *   - "policy_violation"           (operator override or policy denial
 *                                    surfaces a conflict)
 *   - "unauthorized_action"        (provider write without matching
 *                                    capability evidence)
 *   - "label_drift"                (auto-resolvable; usually handled by
 *                                    reconcileScope label correction —
 *                                    surfaces here only if the
 *                                    auto-correction itself fails)
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

const ALLOWED_FROM_STATES: ReadonlyArray<TaskState> = [
  "claimed",
  "in_progress",
  "review_requested",
  "changes_requested",
  "merge_ready",
  "merged",
  "pending_sync",
  "blocked",
];

export type ConflictKind =
  | "manual_merge"
  | "stale_commit_approval"
  | "provider_issue_closed_mr_open"
  | "missing_audit"
  | "policy_violation"
  | "unauthorized_action"
  | "label_drift";

export interface RecordTaskConflictInput {
  readonly task_id: string;
  readonly kind: ConflictKind;
  readonly actor?: string;
  readonly reason?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export type RecordTaskConflictResult =
  | {
      readonly applied: false;
      readonly task_id?: string;
      readonly reason: string;
    }
  | {
      readonly applied: true;
      readonly task_id: string;
      readonly previous_state: TaskState;
      readonly new_state: "conflict";
      readonly conflict_kind: ConflictKind;
    };

export interface TaskConflictDeps {
  readonly repo: TaskGraphRepository;
}

export function createRecordTaskConflict(deps: TaskConflictDeps) {
  return async function recordTaskConflict(
    input: RecordTaskConflictInput,
  ): Promise<RecordTaskConflictResult> {
    if (!isTaskId(input.task_id)) {
      return { applied: false, reason: "invalid_task_id" };
    }
    const task = await deps.repo.getTask(input.task_id);
    if (!task) {
      return {
        applied: false,
        task_id: input.task_id,
        reason: "task_not_found",
      };
    }
    if (task.state === "conflict") {
      // Idempotent: still write an evidence audit row so we know we saw
      // the same conflict signal again, but don't transition.
      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor: (input.actor ?? SUPERVISOR_ACTOR) as ActorId,
        action: "task.conflict.observed",
        capability: "task.assign",
        target_kind: "task",
        target_id: task.id,
        reason: input.reason ?? `conflict:${input.kind}`,
        evidence: { conflict_kind: input.kind, ...(input.evidence ?? {}) },
      });
      return {
        applied: true,
        task_id: task.id,
        previous_state: task.state,
        new_state: "conflict",
        conflict_kind: input.kind,
      };
    }
    if (!ALLOWED_FROM_STATES.includes(task.state)) {
      return {
        applied: false,
        task_id: task.id,
        reason: `task_not_open_to_conflict:${task.state}`,
      };
    }
    await deps.repo.updateTaskState(task.id, task.state_version, "conflict", {
      actor: (input.actor ?? SUPERVISOR_ACTOR) as ActorId,
      capability: "task.assign",
      reason: input.reason ?? `conflict:${input.kind}`,
    });
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: (input.actor ?? SUPERVISOR_ACTOR) as ActorId,
      action: "task.conflict.recorded",
      capability: "task.assign",
      target_kind: "task",
      target_id: task.id,
      previous_state: task.state,
      new_state: "conflict",
      reason: input.reason ?? `conflict:${input.kind}`,
      evidence: { conflict_kind: input.kind, ...(input.evidence ?? {}) },
    });
    return {
      applied: true,
      task_id: task.id,
      previous_state: task.state,
      new_state: "conflict",
      conflict_kind: input.kind,
    };
  };
}

export type ResolveConflictAction =
  | "requeue_ready"
  | "requeue_in_progress"
  | "block"
  | "cancel";

export interface ResolveTaskConflictInput {
  readonly task_id: string;
  readonly action: ResolveConflictAction;
  readonly actor: string;
  readonly reason?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export type ResolveTaskConflictResult =
  | {
      readonly applied: false;
      readonly task_id?: string;
      readonly reason: string;
    }
  | {
      readonly applied: true;
      readonly task_id: string;
      readonly previous_state: "conflict";
      readonly new_state: TaskState;
    };

const ACTION_TARGET: Record<ResolveConflictAction, TaskState> = {
  requeue_ready: "ready",
  requeue_in_progress: "in_progress",
  block: "blocked",
  cancel: "canceled",
};

export function createResolveTaskConflict(deps: TaskConflictDeps) {
  return async function resolveTaskConflict(
    input: ResolveTaskConflictInput,
  ): Promise<ResolveTaskConflictResult> {
    if (!isTaskId(input.task_id)) {
      return { applied: false, reason: "invalid_task_id" };
    }
    const task = await deps.repo.getTask(input.task_id);
    if (!task) {
      return {
        applied: false,
        task_id: input.task_id,
        reason: "task_not_found",
      };
    }
    if (task.state !== "conflict") {
      return {
        applied: false,
        task_id: task.id,
        reason: `task_not_in_conflict:${task.state}`,
      };
    }
    const target = ACTION_TARGET[input.action];
    if (!target) {
      return {
        applied: false,
        task_id: task.id,
        reason: `invalid_action:${input.action}`,
      };
    }
    const final = await deps.repo.updateTaskState(
      task.id,
      task.state_version,
      target,
      {
        actor: input.actor as ActorId,
        capability: "task.assign",
        reason: input.reason ?? `resolve_conflict:${input.action}`,
      },
    );
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: input.actor as ActorId,
      action: "task.conflict.resolved",
      capability: "task.assign",
      target_kind: "task",
      target_id: task.id,
      previous_state: "conflict",
      new_state: final.state,
      reason: input.reason ?? `resolve_conflict:${input.action}`,
      evidence: { action: input.action, ...(input.evidence ?? {}) },
    });
    return {
      applied: true,
      task_id: task.id,
      previous_state: "conflict",
      new_state: final.state,
    };
  };
}
