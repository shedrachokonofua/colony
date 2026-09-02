import type { AgentRole } from "@colony/config";
import type { Run, Scope, Store, Task } from "@colony/core";
import { retryBackoffMs, TERMINAL_TASK_STATES } from "@colony/core";
import { SANDBOX_QUOTA_EXHAUSTED } from "@colony/sandbox";
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import { startTickSpan } from "@colony/observability";
import type { ColonydContext } from "./context.js";
import { SERVICE_ACTOR } from "./context.js";
import { runArchitect } from "./runs/architect.js";
import { runImplement } from "./runs/implement.js";
import { runMergeGate } from "./runs/merge-gate.js";
import { reconcileRejectedReview, runReview } from "./runs/review.js";
import { revokeTokensForRuns } from "./runs/tokens.js";
import {
  buildValidationExtensionInput,
  runValidation,
} from "./runs/validate.js";
import { MAX_EXTENSION_ROUNDS } from "./runs/extend.js";
import { isInfraError } from "./run-classification.js";
import { abortRunsAndWait } from "./runs/registry.js";

/** How long after a push the provider's MR head may still report the previous commit. */
const PROVIDER_HEAD_LAG_MS = 3 * 60_000;

/** Agent-caused replan failures after one failed validation before the scope blocks. */
const MAX_VALIDATION_REPLAN_FAILURES = 3;
/** Fire-and-forget run dispatch; records that this tick dispatched work. */
type RunDispatcher = (run: Promise<void>) => void;

/**
 * One reconciliation pass. Each phase is fail-isolated: a phase error is
 * logged + audited and the tick continues with the next phase.
 */
export async function tick(ctx: ColonydContext): Promise<void> {
  const now = new Date();

  // The tick span exists only when the tick actually dispatched work: quiet
  // ticks are noise, not observability signal. It is ended when the pass
  // returns — the dispatched runs themselves outlive it (task 3 owns those).
  let tickSpan: { end(): void } | undefined;
  const dispatch: RunDispatcher = (run) => {
    tickSpan ??= startTickSpan();
    // A dispatched run that rejects must never become an unhandled
    // rejection: node terminates the process on those (the e2e server died
    // exactly this way when startRun hit a locked database, 2026-08-31).
    run.catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error({ error: message }, "tick.dispatch_error");
      try {
        ctx.store.audit(SERVICE_ACTOR, "tick.dispatch_error", {
          detail: { error: message },
        });
      } catch {
        // audit failure must not compound the dispatch failure
      }
    });
  };

  try {
    await phase(ctx, "expire_leases", () => expireLeases(ctx, now));
    await phase(ctx, "poll_provider", () => pollProviderFacts(ctx, now));
    await phase(ctx, "advance_mr_open", () =>
      advanceMrOpenTasks(ctx, dispatch),
    );
    await phase(ctx, "scope_planning", () =>
      advanceScopePlanning(ctx, dispatch),
    );
    await phase(ctx, "dispatch_implementers", () =>
      dispatchImplementers(ctx, dispatch),
    );
    await phase(ctx, "scope_closure", () => closeScopes(ctx));
    await phase(ctx, "validate_scopes", () => validateScopes(ctx, dispatch));
  } finally {
    tickSpan?.end();
  }
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
 * A quota rejection is a scheduling condition, not a failure: the work stays
 * eligible and the next tick retries it once capacity exists. Detection is
 * textual because run errors cross the database boundary as strings.
 */
function isQuotaDeferred(error: string | null | undefined): boolean {
  return typeof error === "string" && error.includes(SANDBOX_QUOTA_EXHAUSTED);
}

/**
 * Pick the first model in a role's configured chain with a free dispatch slot.
 *
 * Caps throttle individual models, never the pipeline: a saturated primary
 * overflows to the first fallback with capacity. An unresolvable role (lazy or
 * fake configs omitting it) counts as free rather than stalling the pipeline.
 */
export function pickDispatchSlot(
  ctx: ColonydContext,
  role: AgentRole,
): { readonly allowed: boolean; readonly startModelId: string | null } {
  let roleConfig;
  try {
    roleConfig = ctx.config.forAgent(role);
  } catch {
    return { allowed: true, startModelId: null };
  }
  const models = [roleConfig.model, ...roleConfig.fallbackModels];
  for (const [index, model] of models.entries()) {
    const limit = ctx.config.modelParallelLimit(model.id);
    if (limit === null || ctx.store.activeRunCountByModel(model.id) < limit) {
      return {
        allowed: true,
        startModelId: index === 0 ? null : model.id,
      };
    }
  }
  return { allowed: false, startModelId: null };
}

function lastImplementRun(
  ctx: ColonydContext,
  taskId: string,
): Run | undefined {
  return ctx.store
    .runsForTask(taskId)
    .filter((r) => r.kind === "implement")
    .at(-1);
}

function retryOrFailTask(
  ctx: ColonydContext,
  taskId: string,
  reason: string,
): void {
  const task = ctx.store.getTask(taskId);
  if (!task || task.state !== "running") return;
  // Deferred failures are the platform's fault, not the agent's: the
  // platform broke underneath the run, or the cluster refused to schedule
  // it. Neither may consume the task's attempt budget.
  const last = lastImplementRun(ctx, taskId);
  const deferred =
    last?.status === "failed" &&
    (isInfraError(last.error) || isQuotaDeferred(last.error));
  const attempt = deferred ? task.attempt : task.attempt + 1;
  if (deferred) {
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
  // A saturated cluster is immediately eligible again once capacity exists,
  // so a quota deferral carries no backoff penalty.
  const quotaDeferred = isQuotaDeferred(last?.error);
  ctx.store.transitionTask(
    task.id,
    task.state_version,
    "queued",
    SERVICE_ACTOR,
    quotaDeferred
      ? { attempt }
      : {
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
  const attempts = architectAttempts(ctx, scope.id);
  if (attempts >= ctx.env.maxAttempts) {
    ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
      blocked_reason: `architect retries exhausted: ${reason}`,
    });
  }
  // Otherwise the planning phase redispatches an architect run.
}

/**
 * Failed architect runs that count against the scope's attempt budget.
 * Infra-classified failures are the environment's fault, not the plan's -
 * the same exemption the task path applies (2026-08-31: a probe bug killed
 * three architects per scope with workspace_lost and blocked every scope).
 */
function architectAttempts(ctx: ColonydContext, scopeId: string): number {
  return ctx.store
    .runsForScope(scopeId)
    .filter(
      (r) =>
        r.kind === "architect" &&
        r.status !== "running" &&
        !isQuotaDeferred(r.error) &&
        !isInfraError(r.error),
    ).length;
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

async function advanceMrOpenTasks(
  ctx: ColonydContext,
  dispatch: RunDispatcher,
): Promise<void> {
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
    if (ctx.draining.isDraining()) return;
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
    // GitLab's MR head lags a fresh push by a tick or two. A review
    // dispatched in that window reviews the PREVIOUS head and its verdict
    // is worthless at the gate (col-66b8a6c8.6 reviewed a6c5971 after the
    // implementer had pushed 0984cfc, 2026-09-02). The implement run row
    // carries the pushed head: when the provider disagrees within the lag
    // window, wait. Beyond it a mismatch means the branch genuinely moved
    // (rebase, operator push) and the provider is the truth again.
    const pushed = lastImplementRun(ctx, task.id);
    const providerHeadLagging =
      pushed?.status === "succeeded" &&
      !!pushed.head_sha &&
      pushed.head_sha !== headSha &&
      !!pushed.finished_at &&
      Date.now() - Date.parse(pushed.finished_at) < PROVIDER_HEAD_LAG_MS;
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

    // A conflicted MR cannot merge; reviewing or gating it wastes a full
    // run. Requeue so an implement run rebases the branch - unless one is
    // already in flight and may be about to move the head anyway.
    if (mr.has_conflicts === true) {
      if (
        ctx.store.activeRuns("implement").some((r) => r.task_id === task.id)
      ) {
        continue;
      }
      // A review in flight is reviewing the head the rebase is about to
      // replace. Requeueing beside it ran an implementer and a reviewer on
      // col-c8f58a57.3 concurrently (2026-09-01); stop the review first.
      const liveReviews = ctx.store
        .activeRuns("review")
        .filter((r) => r.task_id === task.id)
        .map((r) => r.id);
      if (liveReviews.length > 0) {
        const stopped = await abortRunsAndWait(liveReviews);
        if (!stopped.every(Boolean)) continue;
      }
      const current = ctx.store.getTask(task.id);
      if (!current || current.state !== "mr_open") continue;
      const attempt = current.attempt + 1;
      ctx.store.transitionTask(
        current.id,
        current.state_version,
        "queued",
        SERVICE_ACTOR,
        {
          attempt,
          next_retry_at: new Date(
            Date.now() + retryBackoffMs(attempt),
          ).toISOString(),
        },
      );
      ctx.store.audit(SERVICE_ACTOR, "mr.conflicted", {
        scope_id: scope.id,
        task_id: task.id,
        detail: { mr_iid: task.mr_iid, head_sha: headSha },
      });
      continue;
    }

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
        // Only review dispatch waits on a lagging provider head; a verdict
        // that matches the provider's current head is authoritative above.
        if (providerHeadLagging) continue;
        const slot = pickDispatchSlot(ctx, "reviewer");
        if (!slot.allowed) continue;
        dispatch(
          runReview(ctx, scope, task, headSha, {
            startModelId: slot.startModelId ?? undefined,
          }),
        );
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
    dispatch(runMergeGate(ctx, scope, task, headSha));
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

async function advanceScopePlanning(
  ctx: ColonydContext,
  dispatch: RunDispatcher,
): Promise<void> {
  for (const scope of ctx.store.listScopes()) {
    if (ctx.draining.isDraining()) return;
    if (scope.status === "draft") {
      const activeArchitect = ctx.store
        .runsForScope(scope.id)
        .some((r) => r.kind === "architect" && r.status === "running");
      if (activeArchitect) continue;
      const slot = pickDispatchSlot(ctx, "architect");
      if (!slot.allowed) continue;
      ctx.store.setScopeStatus(scope.id, "planning", SERVICE_ACTOR);
      dispatch(
        runArchitect(ctx, ctx.store.getScope(scope.id)!, {
          startModelId: slot.startModelId ?? undefined,
        }),
      );
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

      if (!lastArchitect) {
        // Planning with no architect run at all: a crash between the status
        // transition and the dispatch, or an operator unblock. Self-heal by
        // dispatching rather than stalling until someone notices.
        const slot = pickDispatchSlot(ctx, "architect");
        if (!slot.allowed) continue;
        dispatch(
          runArchitect(ctx, scope, {
            startModelId: slot.startModelId ?? undefined,
          }),
        );
        continue;
      }

      if (lastArchitect?.status === "succeeded" && !scope.plan_json) {
        // Replan requested: the operator rejected the plan with feedback.
        const slot = pickDispatchSlot(ctx, "architect");
        if (!slot.allowed) continue;
        dispatch(
          runArchitect(ctx, scope, {
            startModelId: slot.startModelId ?? undefined,
          }),
        );
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
        // A saturated cluster refused the sandbox before the architect ran,
        // so that run is a scheduling condition, not an attempt: counting it
        // would park the scope on infrastructure capacity.
        const attempts = architectAttempts(ctx, scope.id);
        if (attempts >= ctx.env.maxAttempts) {
          ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
            blocked_reason: `architect retries exhausted: ${lastArchitect.error ?? "run failed"}`,
          });
          continue;
        }
        const slot = pickDispatchSlot(ctx, "architect");
        if (!slot.allowed) continue;
        dispatch(
          runArchitect(ctx, scope, {
            startModelId: slot.startModelId ?? undefined,
          }),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 5 — dispatch implementers for ready tasks.
// ---------------------------------------------------------------------------

async function dispatchImplementers(
  ctx: ColonydContext,
  dispatch: RunDispatcher,
): Promise<void> {
  const ready = ctx.store.readyTasks();
  for (const task of ready) {
    if (ctx.draining.isDraining()) return;
    if (ctx.store.activeRunCount("implement") >= ctx.env.maxConcurrent) break;
    const slot = pickDispatchSlot(ctx, "developer");
    if (!slot.allowed) continue;
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
    dispatch(
      runImplement(ctx, scope, ctx.store.getTask(current.id)!, {
        startModelId: slot.startModelId ?? undefined,
      }),
    );
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
// Phase 7 — validate acceptance or dispatch bounded architect repair.
async function validateScopes(
  ctx: ColonydContext,
  dispatch: RunDispatcher,
): Promise<void> {
  for (const scope of ctx.store.listScopes()) {
    if (ctx.draining.isDraining()) return;
    if (scope.status !== "validating") continue;
    const fresh = ctx.store.getScope(scope.id);
    if (!fresh || fresh.status !== "validating") continue;
    const runs = ctx.store.runsForScope(scope.id);
    const activeValidate = runs.some(
      (run) => run.kind === "validate" && run.status === "running",
    );
    const activeArchitect = runs.some(
      (run) => run.kind === "architect" && run.status === "running",
    );
    const lastValidate = runs.filter((run) => run.kind === "validate").at(-1);
    if (activeValidate || activeArchitect) continue;
    if (!lastValidate) {
      const slot = pickDispatchSlot(ctx, "developer");
      if (!slot.allowed) continue;
      dispatch(runValidation(ctx, fresh));
      continue;
    }
    if (lastValidate.status === "succeeded") continue;
    const architectsSince = runs.filter(
      (run) =>
        run.kind === "architect" && run.started_at > lastValidate.started_at,
    );
    const lastArchitect = architectsSince.at(-1);
    if (lastArchitect?.status === "succeeded") {
      const slot = pickDispatchSlot(ctx, "developer");
      if (!slot.allowed) continue;
      dispatch(runValidation(ctx, fresh));
      continue;
    }
    // A failed replan used to park the scope here forever: nothing retried
    // the architect and nothing blocked the scope (col-3a0319cc sat seven
    // hours behind a restart-killed replan, 2026-09-01). Infra deaths are
    // free; agent failures are budgeted like every other retry.
    const agentFailures = architectsSince.filter(
      (run) => run.status === "failed" && !isInfraError(run.error),
    ).length;
    if (agentFailures >= MAX_VALIDATION_REPLAN_FAILURES) {
      ctx.store.setScopeStatus(fresh.id, "blocked", SERVICE_ACTOR, {
        blocked_reason: `validation replan failed ${agentFailures} times: ${lastArchitect?.error ?? "unknown"}`,
      });
      continue;
    }
    if (fresh.extension_rounds >= MAX_EXTENSION_ROUNDS) {
      ctx.store.setScopeStatus(fresh.id, "blocked", SERVICE_ACTOR, {
        blocked_reason: `validation extension rounds exhausted (cap ${MAX_EXTENSION_ROUNDS})`,
      });
      continue;
    }
    const extension = buildValidationExtensionInput(ctx, fresh);
    const slot = pickDispatchSlot(ctx, "architect");
    if (!extension || !slot.allowed) continue;
    dispatch(
      runArchitect(ctx, fresh, {
        mode: "extension",
        extension,
        startModelId: slot.startModelId ?? undefined,
      }),
    );
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
