import { ReviewerVerdictV2 as reviewerVerdictV2Schema } from "@colony/schemas";
import { retryBackoffMs, type Scope, type Task } from "@colony/core";
import type { ProviderRepoRef } from "@colony/provider";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import { buildReviewPacket } from "./packets.js";
import { mintRunToken, revokeRunToken, type MintedToken } from "./tokens.js";

const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_REVIEW_REJECTIONS = 3;
const MAX_CONSECUTIVE_REVIEW_FAILURES = 3;

export interface ReviewRunOptions {
  readonly leaseTtlMs?: number;
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
  const leaseTtlMs =
    options.leaseTtlMs ?? reviewerConfig.ceilings.timeoutMs + 5 * 60_000;

  const run = ctx.store.startRun({
    scope_id: scope.id,
    task_id: task.id,
    kind: "review",
    lease_ttl_ms: leaseTtlMs,
    base_sha: headSha,
    model_id: reviewerConfig.model.id,
  });
  ctx.store.audit(SERVICE_ACTOR, "run.start", {
    scope_id: scope.id,
    task_id: task.id,
    run_id: run.id,
    detail: { kind: "review", head_sha: headSha },
  });

  const abortController = new AbortController();
  const heartbeat = setInterval(() => {
    if (abortController.signal.aborted) return;
    ctx.store.heartbeatRun(run.id, leaseTtlMs);
  }, HEARTBEAT_INTERVAL_MS);

  const execution = executeReview(
    ctx,
    repo,
    scope,
    task,
    run.id,
    headSha,
    abortController,
  );
  trackRun(run.id, execution, () => {
    abortController.abort();
    return reviewer.cancelRun(run.id).then(() => undefined);
  });
  try {
    await execution;
  } finally {
    clearInterval(heartbeat);
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
): Promise<void> {
  const reviewer = ctx.agents.reviewer;
  if (!reviewer) {
    failReview(ctx, scope, task, runId, headSha, "reviewer agent missing");
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
    const { repo: repoWithCredentials, ...packet } = buildReviewPacket(
      task,
      scope,
      project,
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

    const metadata = await reviewer.startRun(full, {
      role: "reviewer",
      runId,
    });
    if (abortController.signal.aborted) {
      ctx.store.finishRun(runId, "canceled", {
        error: "aborted",
        evidence_json: JSON.stringify({ head_sha: headSha }),
      });
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
      );
      return;
    }

    const output = await reviewer.getRunOutput(runId);
    const parsed = output
      ? reviewerVerdictV2Schema.safeParse(output.envelope)
      : null;
    if (!parsed || !parsed.success) {
      failReview(
        ctx,
        scope,
        task,
        runId,
        headSha,
        "envelope invalid",
        output ? JSON.stringify(output.envelope) : undefined,
      );
      return;
    }
    const envelope = parsed.data;

    if (envelope.head_sha !== headSha) {
      failReview(
        ctx,
        scope,
        task,
        runId,
        headSha,
        "envelope facts unverified: reviewed head_sha mismatch",
        JSON.stringify(envelope),
      );
      return;
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
  envelopeJson?: string,
): void {
  ctx.store.finishRun(runId, "failed", {
    error,
    envelope_json: envelopeJson,
    evidence_json: JSON.stringify({ head_sha: headSha }),
  });
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
        blocked_reason: "review rejected 3 consecutive times",
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
