import type { AgentRole } from "@colony/config";
import {
  sanitizeTrace,
  type ProviderMergeRequest,
  type ProviderPipeline,
} from "@colony/provider";
import { createHash } from "node:crypto";
import {
  retryBackoffMs,
  TERMINAL_TASK_STATES,
  type PipelineObservationRow,
} from "@colony/core";
import type { Run, Scope, Task } from "@colony/core";
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import { startTickSpan } from "@colony/observability";
import type { ColonydContext } from "./context.js";
import { SERVICE_ACTOR } from "./context.js";
import { runArchitect } from "./runs/architect.js";
import { runImplement } from "./runs/implement.js";
import { runMergeGate } from "./runs/merge-gate.js";
import {
  getCurrentMrTask,
  hasActiveRepositoryMergeGate,
} from "./runs/mr-admission.js";
import {
  reconcileRejectedReview,
  reviewTimeoutModelExclusions,
  runReview,
} from "./runs/review.js";
import {
  latestPlanReview,
  MAX_PLAN_REVIEW_ROUNDS,
  planHash,
  planReviewRounds,
  runPlanReview,
  timedOutPlanReviewModelIds,
} from "./runs/plan-review.js";
import { revokeTokensForRuns } from "./runs/tokens.js";
import {
  buildValidationExtensionInput,
  runValidation,
} from "./runs/validate.js";
import { MAX_EXTENSION_ROUNDS } from "./runs/extend.js";
import {
  consecutiveModelFailures,
  isModelFailure,
  isPlatformFailure,
  retryOrFailTaskWithBudget,
  retryResetAt,
} from "./fault-budget.js";
import { abortRunsAndWait, activeTrackedRunIds } from "./runs/registry.js";

/** How long after a push the provider's MR head may still report the previous commit. */
const PROVIDER_HEAD_LAG_MS = 3 * 60_000;
/** Wait between a failed gate and re-gating the same head. */
const REGATE_BACKOFF_MS = 60_000;

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
  let err: unknown;
  try {
    await body();
  } catch (caught) {
    err = caught;
  }
  if (err === undefined) return;
  const message = err instanceof Error ? err.message : String(err);
  ctx.logger.error({ phase: name, error: message }, "tick.phase_error");
  try {
    ctx.store.audit(SERVICE_ACTOR, "tick.phase_error", {
      detail: { phase: name, error: message },
    });
  } catch {
    // audit failure must not break the tick
  }
  reapUnownedRuns(ctx, name, message);
}

/**
 * Fail the `running` rows no live handler owns. The registry is the source of
 * truth for work this process can still settle, so an untracked running row is
 * one whose handler already returned without recording a terminal result —
 * nobody will ever finish it, and it would otherwise sit `running`, holding its
 * task and carrying no fault, until the lease reaper got to it.
 *
 * They take the tick's own colonyd fault, which requeues free: the tick broke,
 * not the agent. Runs still executing are untouched — a live handler owns its
 * own outcome.
 */
function reapUnownedRuns(
  ctx: ColonydContext,
  phaseName: string,
  message: string,
): void {
  const owned = new Set(activeTrackedRunIds());
  for (const run of ctx.store.activeRuns()) {
    if (owned.has(run.id)) continue;
    ctx.store.finishRun(run.id, "failed", {
      error: `tick_error: ${phaseName}`,
      fault: {
        layer: "colonyd",
        code: "tick_error",
        detail: message.slice(0, 240),
      },
    });
    ctx.store.audit(SERVICE_ACTOR, "run.failed", {
      scope_id: run.scope_id,
      task_id: run.task_id,
      run_id: run.id,
      detail: { reason: `tick_error: ${phaseName}` },
    });
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
      ctx.store.audit(SERVICE_ACTOR, "gate.deferred", {
        scope_id: run.scope_id,
        task_id: run.task_id,
        run_id: run.id,
        detail: { reason: "lease_expired" },
      });
    } else if (run.kind === "review" || run.kind === "plan_review") {
      // Task stays mr_open (or the scope stays planning); the next tick
      // re-dispatches a review. Review is evidence, not a state owner.
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

interface DispatchSlotOptions {
  readonly excludedModelIds?: readonly string[];
}

interface DispatchSlot {
  readonly allowed: boolean;
  readonly startModelId: string | null;
  /** True only when every configured candidate was explicitly excluded. */
  readonly exhausted: boolean;
}

/**
 * Pick the first model in a role's configured chain with a free dispatch slot.
 *
 * Caps throttle individual models, never the pipeline: a saturated primary
 * overflows to the first fallback with capacity. An unresolvable role (lazy or
 * fake configs omitting it) counts as free rather than stalling the pipeline.
 */
export function pickDispatchSlot(
  ctx: Pick<ColonydContext, "config" | "store">,
  role: AgentRole,
  options: DispatchSlotOptions = {},
): DispatchSlot {
  let roleConfig;
  try {
    roleConfig = ctx.config.forAgent(role);
  } catch {
    return { allowed: true, startModelId: null, exhausted: false };
  }
  const models = [roleConfig.model, ...roleConfig.fallbackModels];
  let eligible = false;
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    if (options.excludedModelIds?.includes(model.id)) continue;
    eligible = true;
    const limit = ctx.config.modelParallelLimit(model.id);
    if (limit === null || ctx.store.activeRunCountByModel(model.id) < limit) {
      return {
        allowed: true,
        startModelId: index === 0 ? null : model.id,
        exhausted: false,
      };
    }
  }
  return { allowed: false, startModelId: null, exhausted: !eligible };
}
function blockExhaustedReview(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  headSha: string,
  excludedModelIds: readonly string[],
): void {
  const current = getCurrentMrTask(ctx, scope, task);
  if (!current) return;
  const boundedIds = excludedModelIds.slice(0, 16);
  const reason = `review models exhausted after timeout_without_envelope at ${headSha}: ${boundedIds.join(", ")}`;
  ctx.store.transitionTask(
    current.id,
    current.state_version,
    "blocked",
    SERVICE_ACTOR,
    { blocked_reason: reason },
  );
  ctx.store.audit(SERVICE_ACTOR, "review.admission_blocked", {
    scope_id: scope.id,
    task_id: task.id,
    detail: {
      reason,
      head_sha: headSha,
      excluded_model_ids: boundedIds,
    },
  });
}

function blockExhaustedPlanReview(
  ctx: ColonydContext,
  scope: Scope,
  planHashValue: string,
  excludedModelIds: readonly string[],
): void {
  const boundedIds = excludedModelIds.slice(0, 16);
  const reason = `plan review models exhausted after timeout_without_envelope for ${planHashValue}: ${boundedIds.join(", ")}`;
  ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
    blocked_reason: reason,
  });
  ctx.store.audit(SERVICE_ACTOR, "plan_review.admission_blocked", {
    scope_id: scope.id,
    detail: {
      reason,
      plan_hash: planHashValue,
      excluded_model_ids: boundedIds,
    },
  });
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
  retryOrFailTaskWithBudget(ctx, taskId, reason);
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
 * Only model faults count: the platform (or an unclassified legacy row)
 * never parks a scope — the same exemption the task path applies.
 */
function architectAttempts(ctx: ColonydContext, scopeId: string): number {
  const since = retryResetAt(ctx.store, "scope", scopeId);
  return ctx.store
    .runsForScope(scopeId)
    .filter(
      (r) =>
        r.kind === "architect" &&
        (!since || r.started_at > since) &&
        isModelFailure(r),
    ).length;
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

  for (const { scope, task: capturedTask } of candidates) {
    if (ctx.draining.isDraining()) return;
    let task = capturedTask;
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

    if (task.state === "mr_open") {
      const current = getCurrentMrTask(ctx, scope, task);
      if (!current) continue;
      task = current;
    } else {
      // Merged observation can reconcile a queued/blocked task, but only
      // when the captured task and scope are still authoritative.
      const currentScope = ctx.store.getScope(scope.id);
      const current = ctx.store.getTask(task.id);
      if (
        ctx.draining.isDraining() ||
        !currentScope ||
        currentScope.status !== "active" ||
        !current ||
        current.id !== task.id ||
        current.scope_id !== scope.id ||
        current.state_version !== task.state_version
      ) {
        continue;
      }
      task = current;
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
      const ambiguousMergeObserved =
        headSha !== undefined &&
        lastGate?.status === "failed" &&
        evidence?.head_sha === headSha &&
        (evidence.reason === "merge_unconfirmed" ||
          (evidence.reason === "workspace_failed" &&
            isMergeRequestTimeout(evidence.error)));
      if (!gatePassedAtHead && !ambiguousMergeObserved) {
        // MR merged at a SHA the gate never approved. Record and hold.
        ctx.store.audit(SERVICE_ACTOR, "gate.stale_merge_observed", {
          scope_id: scope.id,
          task_id: task.id,
          detail: { head_sha: headSha, gated_sha: evidence?.head_sha },
        });
        continue;
      }
      if (ambiguousMergeObserved) {
        // The gate passed this exact head before its merge response was lost.
        ctx.store.audit(SERVICE_ACTOR, "gate.merge_reconciled", {
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
    // run. Dispatch one bounded rebase repair per (task, source, target).
    if (mr.has_conflicts === true) {
      await repairAfterMergeConflict(ctx, scope, task, mr, providerHeadLagging);
      continue;
    }

    // Pipeline requirement: if the MR head has a pipeline it must succeed
    // before the gate runs; unknown pipeline state fails closed this tick.
    // Pipeline status is an awaited provider fact. Revalidate the task after
    // it settles, then perform any failed-CI mutation only on that authority.
    const pipelineResult = await pipelineGate(
      ctx,
      scope,
      task,
      mr.head_commit_sha,
    );
    const currentAfterPipeline = getCurrentMrTask(ctx, scope, task);
    if (!currentAfterPipeline) continue;
    task = currentAfterPipeline;
    if (!headSha) continue;

    const pipeline = pipelineResult.pipeline;
    if (pipeline?.commit_sha && pipeline.commit_sha !== headSha) {
      ctx.store.audit(SERVICE_ACTOR, "gate.pipeline_stale", {
        scope_id: scope.id,
        task_id: task.id,
        detail: {
          pipeline_id: pipeline.id,
          pipeline_status: pipeline.status,
          pipeline_commit_sha: pipeline.commit_sha,
          head_sha: headSha,
          pipeline_url: pipeline.metadata.web_url,
        },
      });
      continue;
    }
    if (pipeline?.status === "failed" || pipeline?.status === "canceled") {
      const activeTaskRun = ctx.store
        .activeRuns()
        .some(
          (run) =>
            run.task_id === task.id &&
            (run.kind === "implement" || run.kind === "merge_gate"),
        );
      if (activeTaskRun) continue;
      await repairAfterFailedPipeline(
        ctx,
        scope,
        task,
        headSha,
        pipeline,
        providerHeadLagging,
      );
      continue;
    }
    if (!pipelineResult.ready) continue;
    // Dispatch a gate when none succeeded at the current head SHA and no
    // gate run is active for the provider repository (serialize merges).
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
        if (reviews.some((run) => run.status === "running")) continue;
        // Only review dispatch waits on a lagging provider head; a verdict
        // that matches the provider's current head is authoritative above.
        if (providerHeadLagging) continue;
        const excludedModelIds = reviewTimeoutModelExclusions(
          ctx.store,
          task.id,
          headSha,
        );
        const slot = pickDispatchSlot(ctx, "reviewer", {
          excludedModelIds,
        });
        if (!slot.allowed) {
          if (slot.exhausted) {
            blockExhaustedReview(ctx, scope, task, headSha, excludedModelIds);
          }
          continue;
        }
        const admitted = getCurrentMrTask(ctx, scope, task);
        if (!admitted) continue;
        dispatch(
          runReview(ctx, scope, admitted, headSha, {
            startModelId: slot.startModelId ?? undefined,
            excludedModelIds,
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
    // Provider refusals and platform failures need fresh facts or a new gate,
    // not a code repair. Bound re-gating without charging the task's history.
    if (
      lastGate?.status === "failed" &&
      lastGate.finished_at &&
      (isPlatformFailure(lastGate) ||
        (parseEvidence(lastGate.evidence_json)?.head_sha === headSha &&
          isTransientMergeRefusal(
            parseEvidence(lastGate.evidence_json)?.reason,
          ))) &&
      Date.now() - Date.parse(lastGate.finished_at) < REGATE_BACKOFF_MS
    ) {
      continue;
    }
    if (hasActiveRepositoryMergeGate(ctx, scope)) {
      continue;
    }
    const admitted = getCurrentMrTask(ctx, scope, task);
    if (!admitted) continue;
    dispatch(runMergeGate(ctx, scope, admitted, headSha));
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

/** GitLab's "not mergeable right now" answers; mirrors merge-gate.ts. */
function isTransientMergeRefusal(reason: string | undefined): boolean {
  return (
    reason === "merge_refused:merge_http_405" ||
    reason === "merge_refused:merge_http_409"
  );
}

function isMergeRequestTimeout(error: string | undefined): boolean {
  return (
    typeof error === "string" &&
    /^GitLab (?:PUT|POST) .*\/merge_requests\/[^/]+\/merge timed out$/.test(
      error,
    )
  );
}

interface PipelineGateResult {
  readonly ready: boolean;
  readonly pipeline?: ProviderPipeline;
}

/** Conflict evidence: the provider's merge status plus the conflicted paths
 *  when the provider exposes them. `mergeRequests.diff` is advisory only —
 *  its failure must never block a repair claim. */
async function conflictedFiles(
  ctx: ColonydContext,
  scope: Scope,
  mr: ProviderMergeRequest,
): Promise<readonly string[]> {
  const repo = { id: scope.provider_repo_id, path: scope.provider_repo_path };
  try {
    const diffs = await ctx.provider.mergeRequests.diff(repo, mr.id);
    const files = diffs
      .map((entry) => entry.new_path ?? entry.old_path)
      .filter((path): path is string => typeof path === "string")
      .filter((path) => path.length > 0);
    return files
      .filter((path, index) => files.indexOf(path) === index)
      .slice(0, 25);
  } catch {
    // A diff we cannot read is not a conflict we cannot repair.
    return [];
  }
}

/** Exactly-once merge-conflict repair dispatch, keyed on
 *  sha256(task|merge_conflict|source|target). The claim is persisted BEFORE
 *  any transition, so a crash between claim and dispatch cannot duplicate the
 *  repair; the null-claim path reconciles that window. */
async function repairAfterMergeConflict(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  mr: ProviderMergeRequest,
  providerHeadLagging: boolean,
): Promise<void> {
  const sourceSha = mr.head_commit_sha;
  if (!sourceSha) return;
  ctx.store.audit(SERVICE_ACTOR, "mr.conflicted", {
    scope_id: scope.id,
    task_id: task.id,
    detail: { mr_iid: task.mr_iid, head_sha: sourceSha },
  });

  // The MR still reports the head the implementer replaced. Rebasing that
  // stale SHA races the push that has not appeared on the MR yet, and the
  // intent is keyed on it, so the real head would never be repaired.
  if (providerHeadLagging) return;

  let targetSha: string;
  try {
    targetSha = (
      await ctx.provider.commits.get(
        { id: scope.provider_repo_id, path: scope.provider_repo_path },
        scope.default_branch,
      )
    ).sha;
  } catch (err) {
    ctx.store.audit(SERVICE_ACTOR, "provider.unreachable", {
      scope_id: scope.id,
      task_id: task.id,
      detail: {
        stage: "conflict_target_head",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  const files = await conflictedFiles(ctx, scope, mr);
  const fingerprint = createHash("sha256")
    .update(`${task.id}|merge_conflict|${sourceSha}|${targetSha}`)
    .digest("hex");
  const intent = {
    kind: "merge_conflict",
    source_head_sha: sourceSha,
    target_head_sha: targetSha,
    evidence: [
      `merge status: ${mr.detailed_merge_status ?? "conflicts"}`,
      ...(files.length > 0 ? [`conflicted files: ${files.join(", ")}`] : []),
    ],
  } as const;

  const fresh = ctx.store.claimRepairIntent({
    fingerprint,
    task_id: task.id,
    trigger_kind: "merge_conflict",
    trigger_json: JSON.stringify(intent),
  });
  if (fresh === null) {
    // Crash/capacity reconciliation: the claim exists. A bound run means
    // dispatch happened or is imminent; so does a resolved intent. Otherwise
    // the window between the claim and the transition was interrupted, and
    // only a task still in mr_open may redo it.
    const existing = ctx.store.getRepairIntent(fingerprint);
    if (!existing || existing.run_id !== null) return;
    if (existing.resolved_head_sha !== null) return;
    const stillOpen = ctx.store.getTask(task.id);
    if (!stillOpen || stillOpen.state !== "mr_open") return;
    ctx.store.audit(SERVICE_ACTOR, "gate.repair_reconciled", {
      scope_id: scope.id,
      task_id: task.id,
      detail: { fingerprint },
    });
  }

  // An implement run already in flight may be about to move the head anyway.
  if (ctx.store.activeRuns("implement").some((r) => r.task_id === task.id))
    return;
  // A review in flight is reviewing the head the rebase is about to
  // replace. Requeueing beside it ran an implementer and a reviewer on
  // col-c8f58a57.3 concurrently (2026-09-01); stop the review first.
  const liveReviews = ctx.store
    .activeRuns("review")
    .filter((r) => r.task_id === task.id)
    .map((r) => r.id);
  if (liveReviews.length > 0) {
    const stopped = await abortRunsAndWait(liveReviews);
    if (!stopped.every(Boolean)) return;
  }
  const current = getCurrentMrTask(ctx, scope, task);
  if (!current) return;
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
  ctx.store.audit(SERVICE_ACTOR, "gate.repair_dispatched", {
    scope_id: scope.id,
    task_id: task.id,
    detail: { fingerprint, trigger: intent, attempt },
  });
}

/** The persisted pipeline statuses; anything else the provider reports is
 *  not a fact this schema can store, so it is not recorded. */
const PIPELINE_STATUSES: readonly string[] = [
  "pending",
  "running",
  "success",
  "failed",
  "canceled",
];

/**
 * Record the pipeline observed for `headSha` so read APIs can derive a
 * delivery stage without provider I/O. Called only after a successful
 * getStatus: a failed read leaves the previous observation untouched, so a
 * status is never guessed from a silence.
 */
function recordPipelineObservation(
  ctx: ColonydContext,
  task: Task,
  headSha: string,
  pipeline: ProviderPipeline,
): void {
  if (!PIPELINE_STATUSES.includes(pipeline.status)) return;
  ctx.store.upsertPipelineObservation({
    task_id: task.id,
    head_sha: headSha,
    status: pipeline.status as PipelineObservationRow["status"],
    pipeline_id: pipeline.id,
    web_url: pipeline.metadata.web_url ?? null,
    observed_at: new Date().toISOString(),
  });
}

/**
 * Read the provider pipeline for the MR head. This helper records the
 * observation it fetched; the caller must revalidate the MR task after this
 * awaited provider operation before recording a repair or blocking it.
 */
async function pipelineGate(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  headSha: string | undefined,
): Promise<PipelineGateResult> {
  if (!headSha) return { ready: true };
  try {
    const pipeline = await ctx.provider.pipelines.getStatus(
      { id: scope.provider_repo_id, path: scope.provider_repo_path },
      headSha,
    );
    recordPipelineObservation(ctx, task, headSha, pipeline);
    return {
      ready: pipeline.status === "success",
      pipeline,
    };
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 404 &&
      "body" in error &&
      error.body === "pipeline_not_found"
    ) {
      const pushed = lastImplementRun(ctx, task.id);
      const youngHead =
        pushed?.head_sha === headSha &&
        !!pushed.finished_at &&
        Date.now() - Date.parse(pushed.finished_at) < PROVIDER_HEAD_LAG_MS;
      return { ready: !youngHead };
    }
    // Transport/authorization errors do not establish that CI is absent.
    ctx.store.audit(SERVICE_ACTOR, "provider.unreachable", {
      scope_id: scope.id,
      task_id: task.id,
      detail: {
        stage: "pipeline_gate",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return { ready: false };
  }
}

function isMissingLog(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  if ("status" in error && (error as { status: unknown }).status === 404) {
    return true;
  }
  if (error instanceof Error && /\b404\b|not found/i.test(error.message)) {
    return true;
  }
  return false;
}

/** Exactly-once CI-failure repair dispatch, keyed on
 *  sha256(task|ci_failure|head). The claim is persisted BEFORE any
 *  transition or dispatch, so a crash between claim and dispatch cannot
 *  duplicate the repair; the null-claim path reconciles that window. */
async function repairAfterFailedPipeline(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  headSha: string,
  pipeline: ProviderPipeline,
  providerHeadLagging: boolean,
): Promise<void> {
  const pipelineAudit = {
    pipeline_id: pipeline.id,
    pipeline_status: pipeline.status,
    pipeline_commit_sha: pipeline.commit_sha,
    pipeline_url: pipeline.metadata.web_url,
    head_sha: headSha,
  };
  // Operator trail first; the repair dispatch rides on top of it.
  ctx.store.audit(SERVICE_ACTOR, "gate.pipeline_blocked", {
    scope_id: scope.id,
    task_id: task.id,
    detail: { ...pipelineAudit, status: pipeline.status },
  });

  // Obsolete head: a newer implement run already moved past this head, or
  // the provider still reports the previous push. Wait instead of repairing
  // a head nobody ships.
  const pushed = lastImplementRun(ctx, task.id);
  if (
    providerHeadLagging ||
    (pushed?.status === "succeeded" &&
      !!pushed.head_sha &&
      pushed.head_sha !== headSha)
  ) {
    return;
  }

  let evidence: string[];
  let jobIds: string[] = [];
  let jobNames: string[] = [];
  let jobUrls: string[] = [];
  try {
    const repo = { id: scope.provider_repo_id, path: scope.provider_repo_path };
    const jobs = await ctx.provider.pipelines.listJobs(repo, pipeline.id);
    const failed = jobs.filter(
      (job) => job.status === "failed" || job.status === "canceled",
    );
    const traces: string[] = [];
    for (const job of failed) {
      jobIds.push(job.id);
      jobNames.push(job.name);
      if (job.web_url) jobUrls.push(job.web_url);
      try {
        const trace = await ctx.provider.pipelines.getTrace(repo, job.id);
        if (trace.text.trim()) traces.push(`${job.name}: ${trace.text.trim()}`);
      } catch (err) {
        if (isMissingLog(err)) {
          traces.push(
            sanitizeTrace(`${job.name}: trace unavailable (not found)`),
          );
        } else {
          // Transport, 429, 5xx, or network errors: do not claim a permanent
          // intent for a transient provider blip.
          throw err;
        }
      }
    }
    evidence = traces.length > 0 ? traces : [`pipeline ${pipeline.id} failed`];
  } catch (err) {
    // Detection is provider-backed; an unreachable provider never claims.
    ctx.store.audit(SERVICE_ACTOR, "provider.unreachable", {
      scope_id: scope.id,
      task_id: task.id,
      detail: {
        stage: "repair_evidence",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  const fingerprint = createHash("sha256")
    .update(`${task.id}|ci_failure|${headSha}`)
    .digest("hex");
  const intent = {
    kind: "ci_failure",
    source_head_sha: headSha,
    provider: {
      pipeline_id: pipeline.id,
      ...(pipeline.metadata.web_url
        ? { pipeline_url: pipeline.metadata.web_url }
        : {}),
      ...(jobIds.length ? { job_ids: jobIds } : {}),
      ...(jobNames.length ? { job_names: jobNames } : {}),
      ...(jobUrls.length ? { job_urls: jobUrls } : {}),
    },
    evidence,
  } as const;

  const fresh = ctx.store.claimRepairIntent({
    fingerprint,
    task_id: task.id,
    trigger_kind: "ci_failure",
    trigger_json: JSON.stringify(intent),
  });
  if (fresh === null) {
    // Crash/capacity reconciliation: the claim exists. If a run is already
    // bound, dispatch happened or is imminent — do nothing. Otherwise the
    // window between claimRepairIntent and transitionTask was interrupted:
    // redo it exactly as the fresh-claim path would have.
    const existing = ctx.store.getRepairIntent(fingerprint);
    if (!existing || existing.run_id !== null) return;
    if (existing.resolved_head_sha !== null) return;
    ctx.store.audit(SERVICE_ACTOR, "gate.repair_reconciled", {
      scope_id: scope.id,
      task_id: task.id,
      detail: { fingerprint },
    });
    await dispatchCiRepair(ctx, scope, task, fingerprint, intent);
    return;
  }

  await dispatchCiRepair(ctx, scope, task, fingerprint, intent);
}

/** Shared dispatch body for a fresh claim and the null-claim reconciliation:
 *  abort in-flight reviews first (never queue beside a live reviewer),
 *  re-check authority, then transition through the single-writer path. */
async function dispatchCiRepair(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  fingerprint: string,
  intent: {
    readonly kind: "ci_failure";
    readonly source_head_sha: string;
  },
): Promise<void> {
  // A review in flight is reviewing the head the repair is about to
  // replace; requeueing beside it ran an implementer and a reviewer on
  // col-c8f58a57.3 concurrently (2026-09-01). Stop the review first.
  const liveReviews = ctx.store
    .activeRuns("review")
    .filter((r) => r.task_id === task.id)
    .map((r) => r.id);
  if (liveReviews.length > 0) {
    const stopped = await abortRunsAndWait(liveReviews);
    if (!stopped.every(Boolean)) return;
  }
  const current = getCurrentMrTask(ctx, scope, task);
  if (!current) return;
  const slot = pickDispatchSlot(ctx, "developer");
  if (!slot.allowed) {
    // Capacity, not eligibility: the claim stays, the next tick reconciles
    // through the null-claim path and dispatches when a slot opens.
    ctx.store.audit(SERVICE_ACTOR, "gate.repair_deferred_capacity", {
      scope_id: scope.id,
      task_id: task.id,
      detail: { fingerprint },
    });
    return;
  }
  const attempt = current.attempt + 1;
  if (attempt >= ctx.env.maxAttempts) {
    ctx.store.transitionTask(
      current.id,
      current.state_version,
      "blocked",
      SERVICE_ACTOR,
      {
        blocked_reason: `ci_failure repair attempts exhausted (${attempt}/${ctx.env.maxAttempts}) at head ${intent.source_head_sha}`,
      },
    );
    ctx.store.audit(SERVICE_ACTOR, "gate.pipeline_blocked", {
      scope_id: scope.id,
      task_id: task.id,
      detail: {
        outcome: "blocked",
        reason: "ci_failure repair attempts exhausted",
        attempt,
        head_sha: intent.source_head_sha,
        fingerprint,
      },
    });
    return;
  }
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
  ctx.store.audit(SERVICE_ACTOR, "gate.repair_dispatched", {
    scope_id: scope.id,
    task_id: task.id,
    detail: { fingerprint, trigger: intent, attempt },
  });
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
      const scopeRuns = ctx.store.runsForScope(scope.id);
      const activeArchitect = scopeRuns.some(
        (r) => r.kind === "architect" && r.status === "running",
      );
      if (activeArchitect) continue;
      if (
        scopeRuns.some(
          (r) => r.kind === "plan_review" && r.status === "running",
        )
      )
        continue;

      const lastArchitect = ctx.store
        .runsForScope(scope.id)
        .filter((r) => r.kind === "architect")
        .at(-1);

      if (
        !lastArchitect ||
        (lastArchitect.status === "canceled" && !scope.plan_json)
      ) {
        if (lastArchitect?.status === "canceled") {
          const attempts = architectAttempts(ctx, scope.id);
          if (attempts >= ctx.env.maxAttempts) {
            ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
              blocked_reason: `architect retries exhausted: ${attempts} failed attempts`,
            });
            continue;
          }
        }
        // Planning with no architect run, or with an architect canceled by a
        // pause/operator interruption, is recoverable. Canceled runs are not
        // agent failures and must not consume the architect attempt budget.
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
        // The plan goes through the reviewer chain before anyone builds on
        // it - the same loop an implementer's MR gets. request_changes
        // clears the plan with the findings and the architect runs again
        // (the branch above); approve lets it through to the operator or
        // to materialization. Without a reviewer configured the plan is
        // trusted as before.
        if (ctx.agents.planReviewer) {
          const review = latestPlanReview(
            ctx,
            scope.id,
            scope.plan_json,
            lastArchitect.id,
          );
          if (!review) {
            const rounds = planReviewRounds(ctx, scope.id);
            if (rounds >= MAX_PLAN_REVIEW_ROUNDS) {
              ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
                blocked_reason: `plan review rejected ${rounds} consecutive times`,
              });
              continue;
            }
            const excludedModelIds = timedOutPlanReviewModelIds(
              ctx,
              scope.id,
              scope.plan_json,
              lastArchitect.id,
            );
            const slot = pickDispatchSlot(ctx, "plan_reviewer", {
              excludedModelIds,
            });
            if (!slot.allowed) {
              if (slot.exhausted) {
                blockExhaustedPlanReview(
                  ctx,
                  scope,
                  planHash(scope.plan_json),
                  excludedModelIds,
                );
              }
              continue;
            }
            dispatch(
              runPlanReview(ctx, scope, plan, rounds + 1, {
                startModelId: slot.startModelId ?? undefined,
                excludedModelIds,
              }),
            );
            continue;
          }
          if (review.verdict !== "approve") continue;
        }
        if (ctx.config.hitlMode === "yolo" && scope.approvals !== "manual") {
          ctx.store.materializePlan(scope.id, plan, SERVICE_ACTOR);
        }
        // gated or manual approvals: wait for POST /scopes/:id/approve-plan
        continue;
      }

      if (lastArchitect && lastArchitect.status === "failed") {
        // A platform fault (or an unclassified legacy row) is a scheduling
        // condition, not an attempt: counting it would park the scope on
        // infrastructure capacity.
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
    // The newest unresolved CI-failure intent for this task, if any:
    // select unresolved intents whose bound run is not currently active so
    // that infra retries (or cleared run_ids) can re-bind to the retried run.
    const activeRunIds = new Set(
      ctx.store
        .runsForTask(current.id)
        .filter((r) => r.status === "running")
        .map((r) => r.id),
    );
    const intent = ctx.store
      .listRepairIntents(current.id)
      .filter(
        (r) =>
          r.resolved_head_sha === null &&
          (r.run_id === null || !activeRunIds.has(r.run_id)),
      )
      .at(-1);
    dispatch(
      runImplement(ctx, scope, ctx.store.getTask(current.id)!, {
        startModelId: slot.startModelId ?? undefined,
        repairIntentFingerprint: intent?.fingerprint,
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
    // Block when nothing can run: every unfinished task is blocked, or is
    // queued behind a task that is (transitively). A queued task in retry
    // backoff with a live dependency chain still counts as runnable-later
    // (readyTasks requires the scope active, so blocking would stall its
    // self-heal). Before this, a scope with one blocked task and one queued
    // descendant read `active` forever with nothing to do (col-c8f58a57).
    const blocked = unfinished.filter((t) => t.state === "blocked");
    if (blocked.length === 0) continue;
    const stuck = new Set(blocked.map((t) => t.id));
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of unfinished) {
        if (stuck.has(t.id) || t.state !== "queued") continue;
        if (ctx.store.taskDeps(t.id).some((dep) => stuck.has(dep))) {
          stuck.add(t.id);
          grew = true;
        }
      }
    }
    const nothingRunnable = unfinished.every((t) => stuck.has(t.id));
    const anyActiveRun = ctx.store
      .activeRuns()
      .some((r) => r.scope_id === scope.id);
    if (nothingRunnable && !anyActiveRun) {
      const blockedIds = blocked.map((t) => t.id);
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
    // A validation that never ran (sandbox provision failed, provider
    // unreachable) has no verdict for an architect to diagnose; re-run it.
    // col-7064acc1 (2026-09-03): an etcd stall failed the sandbox create and
    // the scope spent an extension round asking an architect to explain it.
    if (isPlatformFailure(lastValidate)) {
      const slot = pickDispatchSlot(ctx, "developer");
      if (!slot.allowed) continue;
      dispatch(runValidation(ctx, fresh));
      continue;
    }
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
    const agentFailures = architectsSince.filter((run) =>
      isModelFailure(run),
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
