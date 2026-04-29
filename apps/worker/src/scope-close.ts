import type { TaskGraphRepository } from "@colony/db";
import {
  isScopeId,
  type ActorId,
  type Task,
  type TaskState,
} from "@colony/domain";

/**
 * COL-3.5b — Scope close review and closure.
 *
 * Three activities:
 *
 *   evaluateScopeCloseReadiness({ scope_id }) — pure function over
 *     repository state. Returns a readiness report with reasons for
 *     each blocker (open child tasks, pending_sync residue, conflict
 *     residue, blocked tasks). Used by the supervisor before
 *     transitioning the scope to scope_review_requested.
 *
 *   requestScopeReview({ scope_id, actor }) — transitions an active
 *     scope to scope_review_requested when the readiness check passes.
 *     Idempotent; refuses if any task is still in a non-closed state
 *     other than canceled.
 *
 *   closeScope({ scope_id, actor, reason }) — transitions a
 *     scope_review_approved scope to closed, and writes the final
 *     scope.closed audit row. Refuses if any child task has slipped
 *     back into a non-terminal state since approval.
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "closed",
  "canceled",
]);

export interface ScopeCloseDeps {
  readonly repo: TaskGraphRepository;
}

export interface EvaluateScopeCloseReadinessInput {
  readonly scope_id: string;
}

export interface ScopeCloseReadiness {
  readonly scope_id: string;
  readonly ready: boolean;
  readonly reasons: readonly string[];
  readonly open_task_ids: readonly string[];
  readonly blocked_task_ids: readonly string[];
  readonly pending_sync_task_ids: readonly string[];
  readonly conflict_task_ids: readonly string[];
}

export function createEvaluateScopeCloseReadiness(deps: ScopeCloseDeps) {
  return async function evaluateScopeCloseReadiness(
    input: EvaluateScopeCloseReadinessInput,
  ): Promise<ScopeCloseReadiness> {
    if (!isScopeId(input.scope_id)) {
      return {
        scope_id: input.scope_id,
        ready: false,
        reasons: ["invalid_scope_id"],
        open_task_ids: [],
        blocked_task_ids: [],
        pending_sync_task_ids: [],
        conflict_task_ids: [],
      };
    }
    const tasks = await deps.repo.listTasks(input.scope_id);
    return summarizeReadiness(input.scope_id, tasks);
  };
}

function summarizeReadiness(
  scope_id: string,
  tasks: readonly Task[],
): ScopeCloseReadiness {
  const open: string[] = [];
  const blocked: string[] = [];
  const pendingSync: string[] = [];
  const conflict: string[] = [];
  for (const task of tasks) {
    if (TERMINAL_TASK_STATES.has(task.state)) continue;
    if (task.state === "blocked") blocked.push(task.id);
    else if (task.state === "pending_sync") pendingSync.push(task.id);
    else if (task.state === "conflict") conflict.push(task.id);
    else open.push(task.id);
  }
  const reasons: string[] = [];
  if (open.length > 0) reasons.push(`open_tasks:${open.length}`);
  if (blocked.length > 0) reasons.push(`blocked_tasks:${blocked.length}`);
  if (pendingSync.length > 0)
    reasons.push(`pending_sync:${pendingSync.length}`);
  if (conflict.length > 0) reasons.push(`conflict:${conflict.length}`);
  return {
    scope_id,
    ready: reasons.length === 0,
    reasons,
    open_task_ids: open,
    blocked_task_ids: blocked,
    pending_sync_task_ids: pendingSync,
    conflict_task_ids: conflict,
  };
}

export interface RequestScopeReviewInput {
  readonly scope_id: string;
  readonly actor?: string;
  readonly reason?: string;
}

export type RequestScopeReviewResult =
  | {
      readonly applied: false;
      readonly scope_id?: string;
      readonly reason: string;
    }
  | {
      readonly applied: true;
      readonly scope_id: string;
      readonly previous_state: string;
      readonly new_state: "scope_review_requested";
      readonly readiness: ScopeCloseReadiness;
    };

export function createRequestScopeReview(deps: ScopeCloseDeps) {
  const evaluate = createEvaluateScopeCloseReadiness(deps);
  return async function requestScopeReview(
    input: RequestScopeReviewInput,
  ): Promise<RequestScopeReviewResult> {
    if (!isScopeId(input.scope_id)) {
      return { applied: false, reason: "invalid_scope_id" };
    }
    const scope = await deps.repo.getScope(input.scope_id);
    if (!scope) {
      return {
        applied: false,
        scope_id: input.scope_id,
        reason: "scope_not_found",
      };
    }
    if (scope.state === "scope_review_requested") {
      return {
        applied: true,
        scope_id: scope.id,
        previous_state: scope.state,
        new_state: "scope_review_requested",
        readiness: await evaluate({ scope_id: scope.id }),
      };
    }
    if (scope.state !== "active") {
      return {
        applied: false,
        scope_id: scope.id,
        reason: `scope_not_active:${scope.state}`,
      };
    }
    const readiness = await evaluate({ scope_id: scope.id });
    if (!readiness.ready) {
      return {
        applied: false,
        scope_id: scope.id,
        reason: `not_ready:${readiness.reasons.join(",")}`,
      };
    }
    const final = await deps.repo.updateScopeState(
      scope.id,
      scope.state_version,
      "scope_review_requested",
      {
        actor: (input.actor ?? SUPERVISOR_ACTOR) as ActorId,
        capability: "graph.write",
        reason: input.reason ?? "all_child_tasks_closed",
      },
    );
    await deps.repo.writeAudit({
      scope_id: scope.id,
      actor: (input.actor ?? SUPERVISOR_ACTOR) as ActorId,
      action: "scope.review_requested",
      capability: "graph.write",
      target_kind: "scope",
      target_id: scope.id,
      previous_state: scope.state,
      new_state: final.state,
      reason: input.reason ?? "all_child_tasks_closed",
      evidence: {
        readiness_reasons: readiness.reasons,
      },
    });
    return {
      applied: true,
      scope_id: scope.id,
      previous_state: scope.state,
      new_state: "scope_review_requested",
      readiness,
    };
  };
}

export interface CloseScopeInput {
  readonly scope_id: string;
  readonly actor: string;
  readonly reason?: string;
}

export type CloseScopeResult =
  | {
      readonly applied: false;
      readonly scope_id?: string;
      readonly reason: string;
    }
  | {
      readonly applied: true;
      readonly scope_id: string;
      readonly previous_state: "scope_review_approved";
      readonly new_state: "closed";
    };

export function createCloseScope(deps: ScopeCloseDeps) {
  const evaluate = createEvaluateScopeCloseReadiness(deps);
  return async function closeScope(
    input: CloseScopeInput,
  ): Promise<CloseScopeResult> {
    if (!isScopeId(input.scope_id)) {
      return { applied: false, reason: "invalid_scope_id" };
    }
    const scope = await deps.repo.getScope(input.scope_id);
    if (!scope) {
      return {
        applied: false,
        scope_id: input.scope_id,
        reason: "scope_not_found",
      };
    }
    if (scope.state !== "scope_review_approved") {
      return {
        applied: false,
        scope_id: scope.id,
        reason: `scope_not_review_approved:${scope.state}`,
      };
    }
    const readiness = await evaluate({ scope_id: scope.id });
    if (!readiness.ready) {
      return {
        applied: false,
        scope_id: scope.id,
        reason: `tasks_drifted_after_review:${readiness.reasons.join(",")}`,
      };
    }
    const final = await deps.repo.updateScopeState(
      scope.id,
      scope.state_version,
      "closed",
      {
        actor: input.actor as ActorId,
        capability: "graph.write",
        reason: input.reason ?? "scope_review_approved_close",
      },
    );
    await deps.repo.writeAudit({
      scope_id: scope.id,
      actor: input.actor as ActorId,
      action: "scope.closed",
      capability: "graph.write",
      target_kind: "scope",
      target_id: scope.id,
      previous_state: scope.state,
      new_state: final.state,
      reason: input.reason ?? "scope_review_approved_close",
      evidence: {
        closed_task_count:
          readiness.open_task_ids.length === 0 ? "all" : "drift",
      },
    });
    return {
      applied: true,
      scope_id: scope.id,
      previous_state: "scope_review_approved",
      new_state: "closed",
    };
  };
}
