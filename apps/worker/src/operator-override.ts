import type { TaskGraphRepository, PolicyRepository } from "@colony/db";
import {
  isScopeId,
  isTaskId,
  type ActorId,
  type ScopeId,
  type ScopeState,
  type TaskState,
} from "@colony/domain";

/**
 * COL-3.5 operator override.
 *
 * Lets a privileged operator force a task or scope into a chosen state
 * outside the normal lifecycle. The override is gated by the
 * `policy.override` capability on the calling actor, requires a
 * non-empty `reason`, and writes a single audit row that captures
 * actor, reason, target, previous state, new state, and the requested
 * action.
 *
 * Two callable shapes:
 *
 *   applyOperatorOverride({ task_id, action, actor, reason }) — task-level.
 *     Allowed actions: cancel, block, unblock, force_close,
 *     force_pending_sync, requeue_ready.
 *
 *   applyOperatorOverride({ scope_id, action, actor, reason }) — scope-level.
 *     Allowed actions: cancel, force_close.
 *
 * The activity is the only place state-machine guards are loosened —
 * normal lifecycle transitions are validated by `updateTaskState` /
 * `updateScopeState`. The override path bypasses the precondition check
 * (`overrideStateMachine: true`) but still goes through the audited
 * repository helper so the previous-state evidence is captured.
 */

export interface OperatorOverrideDeps {
  readonly repo: TaskGraphRepository;
  readonly policy: PolicyRepository;
}

export type OperatorTaskAction =
  | "cancel"
  | "block"
  | "unblock"
  | "force_pending_sync"
  | "requeue_ready";

export type OperatorScopeAction = "cancel";

const TASK_ACTION_TARGET: Record<OperatorTaskAction, TaskState> = {
  cancel: "canceled",
  block: "blocked",
  unblock: "ready",
  force_pending_sync: "pending_sync",
  requeue_ready: "ready",
};

const SCOPE_ACTION_TARGET: Record<OperatorScopeAction, ScopeState> = {
  cancel: "canceled",
};

export type ApplyOperatorOverrideInput =
  | {
      readonly target: "task";
      readonly task_id: string;
      readonly action: OperatorTaskAction;
      readonly actor: string;
      readonly reason: string;
      readonly evidence?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly target: "scope";
      readonly scope_id: string;
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

export function createApplyOperatorOverride(deps: OperatorOverrideDeps) {
  return async function applyOperatorOverride(
    input: ApplyOperatorOverrideInput,
  ): Promise<ApplyOperatorOverrideResult> {
    const reason = input.reason.trim();
    if (!reason) return { applied: false, reason: "reason_required" };
    const actor = input.actor as ActorId;
    if (!(await actorHasOverride(deps.policy, actor))) {
      return { applied: false, reason: "policy.override_not_granted" };
    }
    if (input.target === "task") {
      return runTaskOverride(deps, input, actor, reason);
    }
    return runScopeOverride(deps, input, actor, reason);
  };
}

async function actorHasOverride(
  policy: PolicyRepository,
  actor: ActorId,
  scopeId: ScopeId | null = null,
): Promise<boolean> {
  const grants = await policy.getCapabilityGrantsForActor(actor, scopeId);
  return grants.has("policy.override");
}

async function runTaskOverride(
  deps: OperatorOverrideDeps,
  input: Extract<ApplyOperatorOverrideInput, { target: "task" }>,
  actor: ActorId,
  reason: string,
): Promise<ApplyOperatorOverrideResult> {
  if (!isTaskId(input.task_id)) {
    return { applied: false, reason: "invalid_task_id" };
  }
  const task = await deps.repo.getTask(input.task_id);
  if (!task) {
    return { applied: false, reason: "task_not_found" };
  }
  const target = TASK_ACTION_TARGET[input.action];
  if (task.state === target) {
    return {
      applied: true,
      target: "task",
      previous_state: task.state,
      new_state: target,
    };
  }
  const final = await deps.repo.updateTaskState(
    task.id,
    task.state_version,
    target,
    {
      actor,
      capability: "policy.override",
      reason,
    },
  );
  await deps.repo.writeAudit({
    scope_id: task.scope_id,
    task_id: task.id,
    actor,
    action: "task.operator_override",
    capability: "policy.override",
    target_kind: "task",
    target_id: task.id,
    previous_state: task.state,
    new_state: final.state,
    reason,
    evidence: { override_action: input.action, ...(input.evidence ?? {}) },
  });
  return {
    applied: true,
    target: "task",
    previous_state: task.state,
    new_state: final.state,
  };
}

async function runScopeOverride(
  deps: OperatorOverrideDeps,
  input: Extract<ApplyOperatorOverrideInput, { target: "scope" }>,
  actor: ActorId,
  reason: string,
): Promise<ApplyOperatorOverrideResult> {
  if (!isScopeId(input.scope_id)) {
    return { applied: false, reason: "invalid_scope_id" };
  }
  const scope = await deps.repo.getScope(input.scope_id);
  if (!scope) {
    return { applied: false, reason: "scope_not_found" };
  }
  const target = SCOPE_ACTION_TARGET[input.action];
  if (scope.state === target) {
    return {
      applied: true,
      target: "scope",
      previous_state: scope.state,
      new_state: target,
    };
  }
  const final = await deps.repo.updateScopeState(
    scope.id,
    scope.state_version,
    target,
    {
      actor,
      capability: "policy.override",
      reason,
    },
  );
  await deps.repo.writeAudit({
    scope_id: scope.id,
    actor,
    action: "scope.operator_override",
    capability: "policy.override",
    target_kind: "scope",
    target_id: scope.id,
    previous_state: scope.state,
    new_state: final.state,
    reason,
    evidence: { override_action: input.action, ...(input.evidence ?? {}) },
  });
  return {
    applied: true,
    target: "scope",
    previous_state: scope.state,
    new_state: final.state,
  };
}
