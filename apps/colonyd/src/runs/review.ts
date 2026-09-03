import { ReviewerVerdictV2 as reviewerVerdictV2Schema } from "@colony/schemas";
import { retryBackoffMs, type Scope, type Task } from "@colony/core";
import { isQuotaDeferred } from "@colony/sandbox";
import { isInfraError } from "../run-classification.js";
import { context } from "@opentelemetry/api";
import type { ProviderRepoRef } from "@colony/provider";
import { startColonyRunSpan, type ColonyRunSpan } from "@colony/observability";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import { buildReviewPacket } from "./packets.js";
import { mintRunToken, revokeRunToken, type MintedToken } from "./tokens.js";

const HEARTBEAT_INTERVAL_MS = 60_000;
// 2026-09-02: three rounds was too few - reviewer findings are the loop's
// main correction signal and rounds 4-6 were landing real fixes before the
// cap parked the task on a human. Backoff caps at 5 min, so ten rounds is
// bounded (~40 min of waits worst case).
const MAX_CONSECUTIVE_REVIEW_REJECTIONS = 10;
const MAX_CONSECUTIVE_REVIEW_FAILURES = 3;

/**
 * Run `fn` inside the run root's span context so SDK GenAI spans nest under
 * it. With no span (tracing disabled) this stays on the ambient context —
 * no tracing code path activates.
 */
function inRunSpanContext<T>(
  runSpan: ColonyRunSpan | undefined,
  fn: () => T,
): T {
  return runSpan ? context.with(runSpan.spanContext, fn) : fn();
}

export interface ReviewRunOptions {
  readonly leaseTtlMs?: number;
  readonly startModelId?: string;
}

/**
 * Execute one LLM review run for a task in `mr_open` at `headSha`.
 * Verdicts are recorded as run evidence; the tick reconciles approve → gate
 * and request_changes → requeue. No task transition on approve.
 */
export async function runReview(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  headSha: string,
  options: ReviewRunOptions = {},
): Promise<void> {
  const reviewer = ctx.agents.reviewer;
  if (!reviewer) {
    throw new Error(
      "review run dispatched but no reviewer agent is configured",
    );
  }
  const repo: ProviderRepoRef = {
    id: scope.provider_repo_id,
    path: scope.provider_repo_path,
  };
  const reviewerConfig = ctx.config.forAgent("reviewer");
  const modelId = options.startModelId ?? reviewerConfig.model.id;
  const leaseTtlMs =
    options.leaseTtlMs ?? reviewerConfig.ceilings.timeoutMs + 5 * 60_000;

  // The span must exist first so its trace id can ride on the run row:
  // mint the run id before either exists and hand it to both, so the span's
  // colony.run_id equals the store row id.
  const runId = crypto.randomUUID();
  const runSpan = startColonyRunSpan({
    scope_id: scope.id,
    task_id: task.id,
    run_id: runId,
    kind: "review",
    model_id: modelId,
  });
  const run = ctx.store.startRun({
    id: runId,
    scope_id: scope.id,
    task_id: task.id,
    kind: "review",
    lease_ttl_ms: leaseTtlMs,
    base_sha: headSha,
    model_id: modelId,
    trace_id: runSpan?.traceId ?? null,
  });
  ctx.store.audit(SERVICE_ACTOR, "run.start", {
    scope_id: scope.id,
    task_id: task.id,
    run_id: runId,
    detail: { kind: "review", head_sha: headSha },
  });

  const abortController = new AbortController();
  const heartbeat = setInterval(() => {
    if (abortController.signal.aborted) return;
    ctx.store.heartbeatRun(runId, leaseTtlMs);
  }, HEARTBEAT_INTERVAL_MS);

  const execution = executeReview(
    ctx,
    repo,
    scope,
    task,
    runId,
    headSha,
    abortController,
    runSpan,
    options.startModelId,
  );
  trackRun(runId, execution, () => {
    abortController.abort();
    return reviewer.cancelRun(runId).then(() => undefined);
  });
  try {
    await execution;
  } finally {
    clearInterval(heartbeat);
    // Safety net only: every terminal branch inside ends the span with its
    // own status; this catches paths that bypass finishRun entirely.
    runSpan?.end("canceled", "aborted");
  }
}

async function executeReview(
  ctx: ColonydContext,
  repo: ProviderRepoRef,
  scope: Scope,
  task: Task,
  runId: string,
  headSha: string,
  abortController: AbortController,
  runSpan: ColonyRunSpan | undefined,
  startModelId: string | undefined,
): Promise<void> {
  const reviewer = ctx.agents.reviewer;
  if (!reviewer) {
    failReview(ctx, scope, task, runId, headSha, "reviewer agent missing", {
      runSpan,
    });
    return;
  }
  let minted: MintedToken | null = null;
  try {
    minted = await mintRunToken(ctx.provider, repo, {
      name: `colony-review-${task.id}`,
      scopes: ["read_repository"],
      singleToken: ctx.env.singleToken,
      fallbackToken: ctx.env.gitlabToken,
    });
    if (minted?.token_id) ctx.store.setRunToken(runId, minted.token_id);
    ctx.store.audit(SERVICE_ACTOR, "agent_token.minted", {
      scope_id: scope.id,
      task_id: task.id,
      run_id: runId,
      detail: {
        mode: ctx.env.singleToken ? "single_token" : "repo_token",
        token_id: minted?.token_id ?? null,
      },
    });

    const project = scope.project_name
      ? (ctx.store.getProject(scope.project_name) ?? null)
      : null;
    const files = scope.project_name
      ? ctx.store.listProjectFiles(scope.project_name)
      : [];
    const { repo: repoWithCredentials, ...packet } = buildReviewPacket(
      task,
      scope,
      project,
      files,
      repo,
      headSha,
    );
    const full = {
      ...packet,
      repo: {
        ...repoWithCredentials,
        credentials: minted ? { token: minted.token } : undefined,
      },
    };

    const metadata = await inRunSpanContext(runSpan, () =>
      reviewer.startRun(full, {
        role: "reviewer",
        runId,
        startModelId,
        traceContext: runSpan?.spanContext,
      }),
    );
    if (abortController.signal.aborted) {
      ctx.store.finishRun(runId, "canceled", {
        error: "aborted",
        evidence_json: JSON.stringify({ head_sha: headSha }),
      });
      runSpan?.end("canceled", "aborted");
      return;
    }

    if (metadata.status !== "succeeded") {
      failReview(
        ctx,
        scope,
        task,
        runId,
        headSha,
        metadata.rejectionReason ?? metadata.status,
        { runSpan },
      );
      return;
    }

    const output = await reviewer.getRunOutput(runId);
    const parsed = output
      ? reviewerVerdictV2Schema.safeParse(output.envelope)
      : null;
    if (!parsed || !parsed.success) {
      failReview(ctx, scope, task, runId, headSha, "envelope invalid", {
        runSpan,
        envelopeJson: output ? JSON.stringify(output.envelope) : undefined,
      });
      return;
    }
    const envelope = parsed.data;

    if (envelope.head_sha !== headSha) {
      // The branch can move mid-review (an implement retry pushing to the
      // same MR). If the reviewer honestly reviewed the MR's CURRENT head,
      // the verdict is valid at that head - accept it there instead of
      // discarding a finished run.
      let currentHead: string | undefined;
      try {
        const mr = await ctx.provider.mergeRequests.get(
          repo,
          `${repo.id}:${task.mr_iid}`,
        );
        currentHead = mr.head_commit_sha;
      } catch {
        currentHead = undefined;
      }
      if (currentHead !== undefined && envelope.head_sha === currentHead) {
        ctx.store.audit(SERVICE_ACTOR, "review.head_advanced", {
          scope_id: scope.id,
          task_id: task.id,
          run_id: runId,
          detail: { dispatched_sha: headSha, reviewed_sha: envelope.head_sha },
        });
        headSha = envelope.head_sha;
      } else {
        failReview(
          ctx,
          scope,
          task,
          runId,
          headSha,
          "envelope facts unverified: reviewed head_sha mismatch",
          { runSpan, envelopeJson: JSON.stringify(envelope) },
        );
        return;
      }
    }

    if (envelope.verdict === "approve") {
      ctx.store.finishRun(runId, "succeeded", {
        head_sha: headSha,
        envelope_json: JSON.stringify(envelope),
        evidence_json: JSON.stringify({
          verdict: "approve",
          head_sha: headSha,
        }),
      });
      runSpan?.end("succeeded");
      ctx.store.audit(SERVICE_ACTOR, "review.approved", {
        scope_id: scope.id,
        task_id: task.id,
        run_id: runId,
        detail: { head_sha: headSha },
      });
      return;
    }

    ctx.store.finishRun(runId, "succeeded", {
      head_sha: headSha,
      envelope_json: JSON.stringify(envelope),
      evidence_json: JSON.stringify({
        verdict: "request_changes",
        head_sha: headSha,
        findings: envelope.findings,
      }),
    });
    runSpan?.end("succeeded");
    ctx.store.audit(SERVICE_ACTOR, "review.changes_requested", {
      scope_id: scope.id,
      task_id: task.id,
      run_id: runId,
      detail: { head_sha: headSha, findings_count: envelope.findings.length },
    });
    reconcileRejectedReview(ctx, task);
  } catch (err) {
    failReview(
      ctx,
      scope,
      task,
      runId,
      headSha,
      err instanceof Error ? err.message : String(err),
      { runSpan },
    );
  } finally {
    if (minted) {
      try {
        await revokeRunToken(ctx.provider, repo, minted);
      } catch {
        ctx.store.audit(SERVICE_ACTOR, "agent_token.revoke_failed", {
          scope_id: scope.id,
          task_id: task.id,
          run_id: runId,
        });
      }
    }
  }
}

function failReview(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  runId: string,
  headSha: string,
  error: string,
  options: { runSpan?: ColonyRunSpan; envelopeJson?: string } = {},
): void {
  ctx.store.finishRun(runId, "failed", {
    error,
    envelope_json: options.envelopeJson,
    evidence_json: JSON.stringify({ head_sha: headSha }),
  });
  options.runSpan?.end("failed", error);
  ctx.store.audit(SERVICE_ACTOR, "run.failed", {
    scope_id: scope.id,
    task_id: task.id,
    run_id: runId,
    detail: { reason: error },
  });
  blockIfConsecutiveReviewFailures(ctx, task, headSha);
}

function blockIfConsecutiveReviewFailures(
  ctx: ColonydContext,
  task: Task,
  headSha: string,
): void {
  const current = ctx.store.getTask(task.id);
  if (!current || current.state !== "mr_open") return;
  const fails = countConsecutiveFailedReviews(ctx, current, headSha);
  if (fails < MAX_CONSECUTIVE_REVIEW_FAILURES) return;
  ctx.store.transitionTask(
    current.id,
    current.state_version,
    "blocked",
    SERVICE_ACTOR,
    {
      blocked_reason: `review failed ${fails} consecutive times at ${headSha}`,
    },
  );
}

/**
 * Failed review runs at this head SHA that the reviewer is accountable for.
 * A run a saturated cluster refused before the reviewer ever saw the diff is
 * a scheduling condition, so it counts as zero: charging it would hold the
 * MR hostage to infrastructure capacity.
 */
function countConsecutiveFailedReviews(
  ctx: ColonydContext,
  task: Task,
  headSha: string,
): number {
  const runs = ctx.store
    .runsForTask(task.id)
    .filter((r) => r.kind === "review");
  let count = 0;
  for (const run of [...runs].reverse()) {
    const evidence = parseReviewEvidence(run.evidence_json);
    if (evidence.head_sha !== headSha) break;
    if (run.status === "succeeded") break;
    if (run.status !== "failed") break;
    if (isQuotaDeferred(run.error)) continue;
    if (isInfraError(run.error)) continue;
    count += 1;
  }
  return count;
}

/**
 * Idempotent. Also called from the tick for crash self-healing when the
 * handler died between finishRun(request_changes) and requeue.
 */
export function reconcileRejectedReview(ctx: ColonydContext, task: Task): void {
  const current = ctx.store.getTask(task.id);
  if (!current || current.state !== "mr_open") return;

  const rejections = countConsecutiveReviewRejections(ctx, current);
  if (rejections >= MAX_CONSECUTIVE_REVIEW_REJECTIONS) {
    ctx.store.transitionTask(
      current.id,
      current.state_version,
      "blocked",
      SERVICE_ACTOR,
      {
        blocked_reason: `review rejected ${MAX_CONSECUTIVE_REVIEW_REJECTIONS} consecutive times`,
      },
    );
    return;
  }

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
}

function countConsecutiveReviewRejections(
  ctx: ColonydContext,
  task: Task,
): number {
  const runs = ctx.store
    .runsForTask(task.id)
    .filter((r) => r.kind === "review");
  let count = 0;
  for (const run of [...runs].reverse()) {
    if (
      run.status === "failed" &&
      (isQuotaDeferred(run.error) || isInfraError(run.error))
    )
      continue;
    if (run.status !== "succeeded") break;
    const evidence = parseReviewEvidence(run.evidence_json);
    if (evidence.verdict === "approve") break;
    if (evidence.verdict !== "request_changes") break;
    count += 1;
  }
  return count;
}

function parseReviewEvidence(evidenceJson: string | null): {
  head_sha?: string;
  verdict?: string;
} {
  if (!evidenceJson) return {};
  try {
    return JSON.parse(evidenceJson) as {
      head_sha?: string;
      verdict?: string;
    };
  } catch {
    return {};
  }
}
