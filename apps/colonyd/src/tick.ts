import { randomUUID } from "node:crypto";
import type { Run, Scope, Store, Task } from "@colony/core";
import { retryBackoffMs, TERMINAL_TASK_STATES } from "@colony/core";
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import type { ColonydContext } from "./context.js";
import { SERVICE_ACTOR } from "./context.js";
import { runArchitect } from "./runs/architect.js";
import { runImplement } from "./runs/implement.js";
import { runMergeGate } from "./runs/merge-gate.js";
import { reconcileRejectedReview, runReview } from "./runs/review.js";
import { revokeTokensForRuns } from "./runs/tokens.js";
import { runValidation } from "./runs/validate.js";

/**
 * One reconciliation pass. Each phase is fail-isolated: a phase error is
 * logged + audited and the tick continues with the next phase.
 */
export async function tick(ctx: ColonydContext): Promise<void> {
  const now = new Date();

  await phase(ctx, "expire_leases", () => expireLeases(ctx, now));
  await phase(ctx, "poll_provider", () => pollProviderFacts(ctx, now));
  await phase(ctx, "advance_mr_open", () => advanceMrOpenTasks(ctx));
  await phase(ctx, "scope_planning", () => advanceScopePlanning(ctx));
  await phase(ctx, "dispatch_implementers", () => dispatchImplementers(ctx));
  await phase(ctx, "scope_closure", () => closeScopes(ctx));
  await phase(ctx, "validate_scopes", () => validateScopes(ctx));
}

async function phase(
  ctx: ColonydContext,
  name: string,
  body: () => Promise<void> | void,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error({ phase: name, error: message }, "tick.phase_error");
    try {
      ctx.store.audit(SERVICE_ACTOR, "tick.phase_error", {
        detail: { phase: name, error: message },
      });
    } catch {
      // audit failure must not break the tick
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — expire leases; requeue or block the work they owned.
// ---------------------------------------------------------------------------

async function expireLeases(ctx: ColonydContext, now: Date): Promise<void> {
  const expired = ctx.store.expireDeadLeases(now);
  await revokeTokensForRuns(ctx.store, ctx.provider, expired);
  for (const run of expired) {
    ctx.store.audit(SERVICE_ACTOR, "run.lease_expired", {
      scope_id: run.scope_id,
      task_id: run.task_id,
      run_id: run.id,
    });
    if (run.kind === "implement" && run.task_id) {
      retryOrFailTask(ctx, run.task_id, "lease_expired");
    } else if (run.kind === "architect") {
      retryOrFailScope(ctx, run.scope_id, "lease_expired");
    } else if (run.kind === "merge_gate" && run.task_id) {
      requeueGateTask(ctx, run.task_id);
    } else if (run.kind === "review") {
      // Task stays mr_open; the next tick re-dispatches a review at the
      // current head SHA. Review is evidence, not a task-state owner.
    } else if (run.kind === "validate") {
      // Credential-free: no token to revoke. The scope stays `validating`
      // and the operator revalidates via POST /scopes/:id/revalidate.
    }
  }

  // Runs that failed inside their lease leave their task `running` with no
  // active run (the handler only transitions success/blocked paths). The
  // tick is the reconciler for that case: requeue or block per attempt count.
  for (const scope of ctx.store.listScopes()) {
    for (const task of ctx.store.listTasks(scope.id)) {
      if (task.state !== "running") continue;
      const hasActiveRun = ctx.store
        .runsForTask(task.id)
        .some((r) => r.kind === "implement" && r.status === "running");
      if (hasActiveRun) continue;
      retryOrFailTask(ctx, task.id, "run_failed");
    }
  }
}

/**
 * Failure classes that are the platform's fault, not the agent's: the
 * colonyd process restarting mid-run, or the LLM gateway erroring. These
 * retry with backoff but never consume the task's attempt budget — a task
 * must only block on failures the agent could have prevented.
 */
const INFRA_FAILURE =
  /^process_restart$|^liveness_watchdog_no_progress$|^zero_output_stall$|\b(?:429|50[234])\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|workspace_provision_failed|RBAC: denied creating|timed out .* waiting for (?:backing pod of )?Sandbox CR|Sandbox CR .* failed:/i;

/** Exported for tests: classify a run error as infrastructure-caused. */
export function isInfraError(error: string | null | undefined): boolean {
  return typeof error === "string" && INFRA_FAILURE.test(error);
}

function lastImplementFailureWasInfra(
  ctx: ColonydContext,
  taskId: string,
): boolean {
  const last = ctx.store
    .runsForTask(taskId)
    .filter((r) => r.kind === "implement")
    .at(-1);
  return last?.status === "failed" && isInfraError(last.error);
}

function retryOrFailTask(
  ctx: ColonydContext,
  taskId: string,
  reason: string,
): void {
  const task = ctx.store.getTask(taskId);
  if (!task || task.state !== "running") return;
  const infra = lastImplementFailureWasInfra(ctx, taskId);
  const attempt = infra ? task.attempt : task.attempt + 1;
  if (infra) {
    ctx.store.audit(SERVICE_ACTOR, "task.infra_retry", {
      scope_id: task.scope_id,
      task_id: task.id,
      detail: { reason },
    });
  }
  if (attempt >= ctx.env.maxAttempts) {
    ctx.store.transitionTask(
      task.id,
      task.state_version,
      "blocked",
      SERVICE_ACTOR,
      {
        blocked_reason: `retries exhausted: ${reason}`,
      },
    );
    return;
  }
  ctx.store.transitionTask(
    task.id,
    task.state_version,
    "queued",
    SERVICE_ACTOR,
    {
      attempt,
      next_retry_at: new Date(
        Date.now() + retryBackoffMs(attempt),
      ).toISOString(),
    },
  );
}

function retryOrFailScope(
  ctx: ColonydContext,
  scopeId: string,
  reason: string,
): void {
  const scope = ctx.store.getScope(scopeId);
  if (!scope || scope.status !== "planning") return;
  const attempts = ctx.store
    .runsForScope(scope.id)
    .filter((r) => r.kind === "architect" && r.status !== "running").length;
  if (attempts >= ctx.env.maxAttempts) {
    ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
      blocked_reason: `architect retries exhausted: ${reason}`,
    });
  }
  // Otherwise the planning phase redispatches an architect run.
}

function requeueGateTask(ctx: ColonydContext, taskId: string): void {
  const task = ctx.store.getTask(taskId);
  if (!task || task.state !== "mr_open") return;
  const attempt = task.attempt + 1;
  ctx.store.transitionTask(
    task.id,
    task.state_version,
    "queued",
    SERVICE_ACTOR,
    {
      attempt,
      next_retry_at: new Date(
        Date.now() + retryBackoffMs(attempt),
      ).toISOString(),
    },
  );
}

// ---------------------------------------------------------------------------
// Phase 2 — poll provider facts for mr_open tasks.
// ---------------------------------------------------------------------------

async function pollProviderFacts(
  ctx: ColonydContext,
  now: Date,
): Promise<void> {
  const openTasks = ctx.store
    .listScopes()
    .filter((s) => s.status === "active")
    .flatMap((scope) =>
      ctx.store
        .listTasks(scope.id)
        .filter((t) => t.state === "mr_open" && t.mr_iid !== null)
        .map((task) => ({ scope, task })),
    );

  for (const { scope, task } of openTasks) {
    try {
      const mr = await ctx.provider.mergeRequests.get(
        { id: scope.provider_repo_id, path: scope.provider_repo_path },
        `${scope.provider_repo_id}:${task.mr_iid}`,
      );
      const dedupKey = `poll:mr:${task.id}:${task.mr_iid}:${mr.head_commit_sha ?? "none"}:${now.toISOString()}`;
      ctx.store.recordObservation(
        "poll",
        dedupKey,
        JSON.stringify(mr),
        task.id,
      );
    } catch (err) {
      ctx.store.audit(SERVICE_ACTOR, "provider.unreachable", {
        scope_id: scope.id,
        task_id: task.id,
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — advance mr_open tasks from provider facts; dispatch gates.
// ---------------------------------------------------------------------------

async function advanceMrOpenTasks(ctx: ColonydContext): Promise<void> {
  const candidates = ctx.store
    .listScopes()
    .filter((s) => s.status === "active")
    .flatMap((scope) =>
      ctx.store
        .listTasks(scope.id)
        .filter(
          (t) =>
            ["mr_open", "queued", "blocked"].includes(t.state) &&
            t.mr_iid !== null,
        )
        .map((task) => ({ scope, task })),
    );

  for (const { scope, task } of candidates) {
    let mr;
    try {
      mr = await ctx.provider.mergeRequests.get(
        { id: scope.provider_repo_id, path: scope.provider_repo_path },
        `${scope.provider_repo_id}:${task.mr_iid}`,
      );
    } catch (err) {
      // Fail closed: no transition on missing facts.
      ctx.store.audit(SERVICE_ACTOR, "provider.unreachable", {
        scope_id: scope.id,
        task_id: task.id,
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
      continue;
    }

    const headSha = mr.head_commit_sha;
    const lastGate = ctx.store
      .runsForTask(task.id)
      .filter((r) => r.kind === "merge_gate")
      .at(-1);

    if (mr.state === "merged") {
      const evidence = parseEvidence(lastGate?.evidence_json ?? null);
      const gatePassedAtHead =
        headSha !== undefined &&
        lastGate?.status === "succeeded" &&
        evidence?.head_sha === headSha;
      const timedOutMergeObserved =
        headSha !== undefined &&
        lastGate?.status === "failed" &&
        evidence?.head_sha === headSha &&
        evidence.reason === "workspace_failed" &&
        isMergeRequestTimeout(evidence.error);
      if (!gatePassedAtHead && !timedOutMergeObserved) {
        // MR merged at a SHA the gate never approved. Record and hold.
        ctx.store.audit(SERVICE_ACTOR, "gate.stale_merge_observed", {
          scope_id: scope.id,
          task_id: task.id,
          detail: { head_sha: headSha, gated_sha: evidence?.head_sha },
        });
        continue;
      }
      if (timedOutMergeObserved) {
        // Compatibility recovery for runs written before the merge gate
        // confirmed an ambiguous timeout by re-reading the MR.
        ctx.store.audit(SERVICE_ACTOR, "gate.merge_timeout_reconciled", {
          scope_id: scope.id,
          task_id: task.id,
          run_id: lastGate.id,
          detail: { head_sha: headSha, error: evidence.error },
        });
      }
      ctx.store.transitionTask(
        task.id,
        task.state_version,
        "merged",
        SERVICE_ACTOR,
      );
      ctx.store.audit(SERVICE_ACTOR, "mr.merged", {
        scope_id: scope.id,
        task_id: task.id,
        detail: { head_sha: headSha },
      });
      continue;
    }

    if (mr.state !== "opened") continue;
    if (task.state !== "mr_open") continue;

    // Pipeline requirement: if the MR head has a pipeline it must succeed
    // before the gate runs; unknown pipeline state fails closed this tick.
    const pipelineReady = await pipelineGate(
      ctx,
      scope,
      task,
      mr.head_commit_sha,
    );
    if (!pipelineReady) continue;

    // Dispatch a gate when none succeeded at the current head SHA and no
    // gate run is active for the scope (serialize merges per scope).
    if (!headSha) continue;

    if (ctx.config.reviewMode === "required") {
      const reviews = ctx.store
        .runsForTask(task.id)
        .filter((r) => r.kind === "review");
      const approvedAtHead = reviews.some(
        (r) =>
          r.status === "succeeded" &&
          parseEvidence(r.evidence_json)?.verdict === "approve" &&
          parseEvidence(r.evidence_json)?.head_sha === headSha,
      );
      if (!approvedAtHead) {
        const latest = reviews.at(-1);
        if (
          latest?.status === "succeeded" &&
          parseEvidence(latest.evidence_json)?.verdict === "request_changes" &&
          parseEvidence(latest.evidence_json)?.head_sha === headSha
        ) {
          // Crash self-heal: handler died between finishRun and requeue.
          reconcileRejectedReview(ctx, task);
          continue;
        }
        if (latest?.status === "running") continue;
        if (
          ctx.store.activeRuns("review").some((r) => r.scope_id === scope.id)
        ) {
          continue;
        }
        void runReview(ctx, scope, task, headSha);
        continue;
      }
    }

    // Manual approvals: the gate both validates and merges, so it only
    // dispatches once a human approved this exact head SHA.
    if (scope.approvals === "manual" && task.merge_approved_sha !== headSha) {
      continue;
    }

    if (lastGate?.status === "running") continue;
    if (
      lastGate?.status === "succeeded" &&
      parseEvidence(lastGate.evidence_json)?.head_sha === headSha
    ) {
      continue;
    }
    if (
      ctx.store.activeRuns("merge_gate").some((r) => r.scope_id === scope.id)
    ) {
      continue;
    }
    void runMergeGate(ctx, scope, task, headSha);
  }
}

interface RunEvidence {
  readonly head_sha?: string;
  readonly verdict?: string;
  readonly reason?: string;
  readonly error?: string;
}

function parseEvidence(evidenceJson: string | null): RunEvidence | undefined {
  if (!evidenceJson) return undefined;
  try {
    return JSON.parse(evidenceJson) as RunEvidence;
  } catch {
    return undefined;
  }
}

function isMergeRequestTimeout(error: string | undefined): boolean {
  return (
    typeof error === "string" &&
    /^GitLab (?:PUT|POST) .*\/merge_requests\/[^/]+\/merge timed out$/.test(
      error,
    )
  );
}

/**
 * True when the gate may proceed. Pipelines are optional: repos without CI
 * pass. When a pipeline exists for the head SHA it must be `success`;
 * errors or pending states fail closed (no gate this tick).
 */
async function pipelineGate(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  headSha: string | undefined,
): Promise<boolean> {
  if (!headSha) return true;
  try {
    const pipeline = await ctx.provider.pipelines.getStatus(
      { id: scope.provider_repo_id, path: scope.provider_repo_path },
      headSha,
    );
    if (pipeline.status === "success") return true;
    if (pipeline.status === "failed" || pipeline.status === "canceled") {
      ctx.store.audit(SERVICE_ACTOR, "gate.pipeline_blocked", {
        scope_id: scope.id,
        task_id: task.id,
        detail: { status: pipeline.status },
      });
    }
    return false;
  } catch {
    // No pipeline for this SHA / unknown status: proceed (seed + acceptance
    // repos have no .gitlab-ci.yml; the gate's local commands are the CI).
    return true;
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — scope planning: dispatch architect runs, materialize plans.
// ---------------------------------------------------------------------------

async function advanceScopePlanning(ctx: ColonydContext): Promise<void> {
  for (const scope of ctx.store.listScopes()) {
    if (scope.status === "draft") {
      const activeArchitect = ctx.store
        .runsForScope(scope.id)
        .some((r) => r.kind === "architect" && r.status === "running");
      if (activeArchitect) continue;
      ctx.store.setScopeStatus(scope.id, "planning", SERVICE_ACTOR);
      void runArchitect(ctx, ctx.store.getScope(scope.id)!);
      continue;
    }

    if (scope.status === "planning") {
      const activeArchitect = ctx.store
        .runsForScope(scope.id)
        .some((r) => r.kind === "architect" && r.status === "running");
      if (activeArchitect) continue;

      const lastArchitect = ctx.store
        .runsForScope(scope.id)
        .filter((r) => r.kind === "architect")
        .at(-1);

      if (lastArchitect?.status === "succeeded" && !scope.plan_json) {
        // Replan requested: the operator rejected the plan with feedback.
        void runArchitect(ctx, scope);
        continue;
      }

      if (lastArchitect?.status === "succeeded" && scope.plan_json) {
        let plan: ArchitectDecompositionV2;
        try {
          plan = JSON.parse(scope.plan_json) as ArchitectDecompositionV2;
        } catch {
          ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
            blocked_reason: "plan_json unparseable",
          });
          continue;
        }
        if (ctx.config.hitlMode === "yolo" && scope.approvals !== "manual") {
          ctx.store.materializePlan(scope.id, plan, SERVICE_ACTOR);
        }
        // gated or manual approvals: wait for POST /scopes/:id/approve-plan
        continue;
      }

      if (lastArchitect && lastArchitect.status === "failed") {
        const attempts = ctx.store
          .runsForScope(scope.id)
          .filter(
            (r) => r.kind === "architect" && r.status !== "running",
          ).length;
        if (attempts >= ctx.env.maxAttempts) {
          ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
            blocked_reason: `architect retries exhausted: ${lastArchitect.error ?? "run failed"}`,
          });
          continue;
        }
        void runArchitect(ctx, scope);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 5 — dispatch implementers for ready tasks.
// ---------------------------------------------------------------------------

async function dispatchImplementers(ctx: ColonydContext): Promise<void> {
  const ready = ctx.store.readyTasks();
  for (const task of ready) {
    if (ctx.store.activeRunCount("implement") >= ctx.env.maxConcurrent) break;
    const scope = ctx.store.getScope(task.scope_id);
    if (!scope || scope.status !== "active") continue;
    const current = ctx.store.getTask(task.id);
    if (!current || current.state !== "queued") continue;
    ctx.store.transitionTask(
      current.id,
      current.state_version,
      "running",
      SERVICE_ACTOR,
    );
    void runImplement(ctx, scope, ctx.store.getTask(current.id)!);
  }
}

// ---------------------------------------------------------------------------
// Phase 6 — scope closure.
// ---------------------------------------------------------------------------

async function closeScopes(ctx: ColonydContext): Promise<void> {
  for (const scope of ctx.store.listScopes()) {
    if (scope.status !== "active") continue;
    const tasks = ctx.store.listTasks(scope.id);
    if (tasks.length === 0) continue;

    const terminal = tasks.every((t) => TERMINAL_TASK_STATES.has(t.state));
    if (terminal) {
      const mergedCount = tasks.filter((t) => t.state === "merged").length;
      if (mergedCount >= 1) {
        ctx.store.setScopeStatus(scope.id, "validating", SERVICE_ACTOR, {
          acceptance_count: acceptanceCriteriaCount(scope),
        });
      } else {
        ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
          blocked_reason: "all tasks canceled without merges",
        });
      }
      continue;
    }

    const unfinished = tasks.filter((t) => !TERMINAL_TASK_STATES.has(t.state));
    // Only block when every unfinished task is blocked. Queued tasks still in
    // retry backoff will become runnable on their own; blocking the scope in
    // the meantime would stall self-healing (readyTasks requires scope active).
    const allBlocked = unfinished.every((t) => t.state === "blocked");
    const anyActiveRun = ctx.store
      .activeRuns()
      .some((r) => r.scope_id === scope.id);
    if (allBlocked && !anyActiveRun) {
      const blockedIds = unfinished.map((t) => t.id);
      ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
        blocked_reason: `no runnable tasks; blocked: ${blockedIds.join(", ")}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 7 — validation: run acceptance commands on validating scopes.
// ---------------------------------------------------------------------------

async function validateScopes(ctx: ColonydContext): Promise<void> {
  for (const scope of ctx.store.listScopes()) {
    if (scope.status !== "validating") continue;
    // Re-fetch fresh before dispatch (scope may have moved since list).
    const fresh = ctx.store.getScope(scope.id);
    if (!fresh || fresh.status !== "validating") continue;
    // The first validate run is dispatched once; after a failure the scope
    // parks and the operator re-triggers via the revalidate endpoint.
    const hasValidateRun = ctx.store
      .runsForScope(scope.id)
      .some((r) => r.kind === "validate");
    if (hasValidateRun) continue;
    const running = ctx.store
      .activeRuns("validate")
      .some((r) => r.scope_id === scope.id);
    if (running) continue;
    void runValidation(ctx, fresh);
  }
}

function acceptanceCriteriaCount(scope: Scope): number {
  if (!scope.acceptance_json) return 0;
  try {
    const parsed = JSON.parse(scope.acceptance_json);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export const TICK_PHASES = [
  "expire_leases",
  "poll_provider",
  "advance_mr_open",
  "scope_planning",
  "dispatch_implementers",
  "scope_closure",
  "validate_scopes",
] as const;
