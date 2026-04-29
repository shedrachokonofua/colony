import type { TaskGraphRepository } from "@colony/db";
import { isScopeId, type ActorId, type Scope, type Task } from "@colony/domain";

/**
 * COL-3.x — per-scope supervisor heartbeat.
 *
 * Called from `scopeSupervisorWorkflow`'s heartbeat timer (every 5 min
 * when no signals have arrived). Classifies forward-progress stalls
 * and writes a typed audit row per tick. Recovery is intentionally
 * conservative: the activity flags the stall and writes evidence; it
 * doesn't mutate state beyond the audit row. The supervisor workflow
 * receives the classifier and can choose whether to fire follow-up
 * activities (`claimAndDriveReadyTask` etc.) — but the audit row is
 * the authoritative liveness signal regardless.
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
        scope_state: scope.state,
        recovery_hint: recovery,
        idempotency_key: input.idempotency_key,
      },
    });
    return {
      scope_id: input.scope_id,
      status: "stalled",
      classifier,
      recovery,
      last_progress_age_ms: ageMs,
    };
  };
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
