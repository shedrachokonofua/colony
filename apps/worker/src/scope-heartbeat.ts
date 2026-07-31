import type { RecoveryFailureState, TaskGraphRepository } from "@colony/db";
import { isScopeId, type ActorId, type Scope, type Task } from "@colony/domain";
import {
  HEARTBEAT_RECOVERY_BACKOFF_CAP_TICKS,
  HEARTBEAT_RECOVERY_FAILURE_LIMIT,
} from "@colony/workflows";

const HEARTBEAT_TICK_MS = 60_000;

/**
 * COL-3.x — per-scope supervisor heartbeat.
 *
 * Called from `scopeSupervisorWorkflow`'s heartbeat timer (every minute
 * when no signals have arrived). Classifies forward-progress stalls,
 * persists durable recovery evidence, and dispatches bounded recovery.
 * Repeated failures apply exponential backoff and eventually stop the line
 * by transitioning the scope to blocked until an operator or success resets it.
 *
 * Stall classifiers:
 *
 *   awaiting_architect       — scope state = draft, no architect run started
 *   awaiting_decomposition_review — proposal status = proposed, no review
 *   awaiting_dag_commit      — proposal status = human_approved, no commit
 *   unclaimed_ready          — scope active with ready tasks, none claimed
 *   dev_run_died             — task in claimed/in_progress with stale agent_runs
 *   awaiting_review          — task in review_requested, no review_resolved
 *   awaiting_merge           — task in merge_ready, no provider.mr.merged
 *   awaiting_scope_review    — scope in scope_review_requested, no review run
 *   awaiting_scope_close     — scope in scope_review_approved, no closeScope
 *
 * Returns one of:
 *   - { status: "healthy" }              — recent progress, nothing to do
 *   - { status: "stalled", classifier }  — fresh stall, audit written
 *   - { status: "recovered", classifier } — stall classifier matches a prior
 *                                            stall, but progress has since
 *                                            been made; clears the stall
 *   - { status: "scope_terminal" }       — scope is closed/canceled; the
 *                                            workflow should exit its loop
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

export interface ScopeHeartbeatDeps {
  readonly repo: TaskGraphRepository;
}

export interface ScopeHeartbeatTickInput {
  readonly scope_id: string;
  readonly stall_threshold_ms: number;
  readonly idempotency_key: string;
}

export type ScopeHeartbeatTickResult = {
  readonly scope_id: string;
  readonly status: "healthy" | "stalled" | "recovered" | "scope_terminal";
  readonly classifier?: string;
  readonly recovery?: string;
  readonly recovery_allowed?: boolean;
  readonly recovery_failure_count?: number;
  readonly recovery_backoff_ticks?: number;
  readonly recovery_circuit_open?: boolean;
  readonly last_failure_reason?: string;
  readonly last_progress_age_ms?: number;
};

const TERMINAL_SCOPE_STATES = new Set(["closed", "canceled"]);

export function createScopeHeartbeatTick(deps: ScopeHeartbeatDeps) {
  return async function scopeHeartbeatTick(
    input: ScopeHeartbeatTickInput,
  ): Promise<ScopeHeartbeatTickResult> {
    if (!isScopeId(input.scope_id)) {
      return { scope_id: input.scope_id, status: "healthy" };
    }
    const scope = await deps.repo.getScope(input.scope_id);
    if (!scope) {
      return { scope_id: input.scope_id, status: "healthy" };
    }
    if (TERMINAL_SCOPE_STATES.has(scope.state)) {
      return { scope_id: input.scope_id, status: "scope_terminal" };
    }
    const tasks = await deps.repo.listTasks(input.scope_id);
    const now = Date.now();
    const lastProgressAt = computeLastProgressAt(scope, tasks);
    const ageMs = now - lastProgressAt;

    if (ageMs < input.stall_threshold_ms) {
      // Recent progress — write a healthy heartbeat audit row.
      await deps.repo.writeAudit({
        scope_id: input.scope_id,
        actor: SUPERVISOR_ACTOR,
        action: "scope.heartbeat.healthy",
        capability: "graph.write",
        target_kind: "scope",
        target_id: input.scope_id,
        reason: "heartbeat_healthy",
        evidence: {
          last_progress_age_ms: ageMs,
          scope_state: scope.state,
          idempotency_key: input.idempotency_key,
        },
      });
      return {
        scope_id: input.scope_id,
        status: "healthy",
        last_progress_age_ms: ageMs,
      };
    }

    const classifier = classifyStall(scope, tasks);
    const recovery = recoveryHintFor(classifier);
    const role = recoveryRoleFor(classifier);
    const failureState = role
      ? await deps.repo.getRecoveryFailureState({
          scope_id: input.scope_id,
          role,
        })
      : undefined;
    const recoveryBackoffTicks = failureState
      ? backoffTicksFor(failureState, now)
      : 0;
    let recoveryAllowed = true;
    let circuitOpen = false;
    let scopeBlocked = false;

    if (failureState?.latest_status === "running") {
      recoveryAllowed = false;
    } else if (
      failureState &&
      failureState.failure_count >= HEARTBEAT_RECOVERY_FAILURE_LIMIT
    ) {
      recoveryAllowed = false;
      circuitOpen = true;
      if (scope.state !== "blocked") {
        await deps.repo.updateScopeState(
          input.scope_id,
          scope.state_version,
          "blocked",
          {
            actor: SUPERVISOR_ACTOR,
            capability: "graph.write",
            reason: `heartbeat_recovery_circuit_open:${classifier}`,
          },
        );
        scopeBlocked = true;
      }
      await deps.repo.writeAudit({
        scope_id: input.scope_id,
        actor: SUPERVISOR_ACTOR,
        action: "scope.heartbeat.recovery_circuit_open",
        capability: "graph.write",
        target_kind: "scope",
        target_id: input.scope_id,
        previous_state: scope.state,
        new_state: "blocked",
        reason: `recovery_failure_limit:${classifier}`,
        evidence: {
          classifier,
          attempt_count: failureState.failure_count,
          last_failure_reason:
            failureState.last_failure_reason ?? "agent_run_failed",
          operator_action: "operator override or successful signal required",
        },
      });
    } else if (failureState && recoveryBackoffTicks > 0) {
      recoveryAllowed = false;
    }

    await deps.repo.writeAudit({
      scope_id: input.scope_id,
      actor: SUPERVISOR_ACTOR,
      action: "scope.heartbeat.stalled",
      capability: "graph.write",
      target_kind: "scope",
      target_id: input.scope_id,
      reason: classifier,
      evidence: {
        last_progress_age_ms: ageMs,
        scope_state: scopeBlocked ? "blocked" : scope.state,
        recovery_hint: recovery,
        recovery_allowed: recoveryAllowed,
        recovery_failure_count: failureState?.failure_count ?? 0,
        recovery_backoff_ticks: recoveryBackoffTicks,
        recovery_circuit_open: circuitOpen,
        last_failure_reason: failureState?.last_failure_reason,
        idempotency_key: input.idempotency_key,
      },
    });
    return {
      scope_id: input.scope_id,
      status: "stalled",
      classifier,
      recovery,
      recovery_allowed: recoveryAllowed,
      recovery_failure_count: failureState?.failure_count ?? 0,
      recovery_backoff_ticks: recoveryBackoffTicks,
      recovery_circuit_open: circuitOpen,
      last_failure_reason: failureState?.last_failure_reason,
      last_progress_age_ms: ageMs,
    };
  };
}

function recoveryRoleFor(
  classifier: string,
): "architect" | "reviewer" | undefined {
  switch (classifier) {
    case "awaiting_architect":
      return "architect";
    case "awaiting_decomposition_review_or_approval":
    case "awaiting_review":
      return "reviewer";
    default:
      return undefined;
  }
}

function backoffTicksFor(state: RecoveryFailureState, now: number): number {
  const failedTerminalRun =
    state.latest_status === "failed" ||
    state.latest_status === "canceled" ||
    state.latest_status === "envelope_rejected";
  if (
    state.failure_count <= 0 ||
    !failedTerminalRun ||
    !state.latest_finished_at
  ) {
    return 0;
  }
  const required = Math.min(
    2 ** Math.max(0, state.failure_count - 1),
    HEARTBEAT_RECOVERY_BACKOFF_CAP_TICKS,
  );
  const elapsedTicks = Math.floor(
    Math.max(0, now - new Date(state.latest_finished_at).getTime()) /
      HEARTBEAT_TICK_MS,
  );
  return elapsedTicks >= required ? 0 : required - elapsedTicks;
}

function computeLastProgressAt(scope: Scope, tasks: readonly Task[]): number {
  let latest = new Date(scope.updated_at).getTime();
  for (const task of tasks) {
    const t = new Date(task.updated_at).getTime();
    if (t > latest) latest = t;
  }
  return latest;
}

function classifyStall(scope: Scope, tasks: readonly Task[]): string {
  switch (scope.state) {
    case "draft":
      return "awaiting_architect";
    case "decomposition_proposed":
      return "awaiting_decomposition_review_or_approval";
    case "decomposition_approved":
      return "awaiting_dag_commit";
    case "active": {
      const ready = tasks.filter((t) => t.state === "ready");
      const claimed = tasks.filter((t) => t.state === "claimed");
      const inProgress = tasks.filter((t) => t.state === "in_progress");
      const reviewRequested = tasks.filter(
        (t) => t.state === "review_requested",
      );
      const mergeReady = tasks.filter((t) => t.state === "merge_ready");
      if (mergeReady.length > 0) return "awaiting_merge";
      if (reviewRequested.length > 0) return "awaiting_review";
      if (claimed.length > 0) return "claimed_no_progress";
      if (inProgress.length > 0) return "developer_run_stalled";
      if (ready.length > 0) return "unclaimed_ready";
      return "active_no_open_tasks";
    }
    case "scope_review_requested":
      return "awaiting_scope_review";
    case "scope_review_approved":
      return "awaiting_scope_close";
    case "blocked":
      return "scope_blocked";
    case "conflict":
      return "scope_conflict";
    default:
      return `unknown_state:${scope.state}`;
  }
}

function recoveryHintFor(classifier: string): string {
  switch (classifier) {
    case "awaiting_architect":
      return "trigger startArchitectRun";
    case "awaiting_decomposition_review_or_approval":
      return "trigger startDecompositionReviewRun or operator /approve";
    case "awaiting_dag_commit":
      return "operator must commit (commitDecompositionProposal)";
    case "unclaimed_ready":
      return "trigger claimReadyTask";
    case "claimed_no_progress":
    case "developer_run_stalled":
      return "trigger startDeveloperRun (or mark task failed)";
    case "awaiting_review":
      return "trigger startReviewerRun";
    case "awaiting_merge":
      return "trigger mergeTask";
    case "awaiting_scope_review":
      return "trigger scope review run";
    case "awaiting_scope_close":
      return "trigger closeScope";
    case "scope_blocked":
    case "scope_conflict":
      return "operator action required";
    default:
      return "unknown";
  }
}
