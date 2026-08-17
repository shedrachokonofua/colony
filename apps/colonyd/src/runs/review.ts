import { ReviewerVerdictV2 as reviewerVerdictV2Schema } from "@colony/schemas";
import { retryBackoffMs, type Scope, type Task } from "@colony/core";
import type { ProviderProjectRef } from "@colony/provider";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
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
  const project: ProviderProjectRef = {
    id: scope.provider_project_id,
    path: scope.provider_project_path,
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
    project,
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
  project: ProviderProjectRef,
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
    minted = await mintRunToken(ctx.provider, project, {
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
        mode: ctx.env.singleToken ? "single_token" : "project_token",
        token_id: minted?.token_id ?? null,
      },
    });

    const packet = {
      kind: "review_task",
      task_id: task.id,
      scope_id: scope.id,
      goal: task.title,
      head_sha: headSha,
      mr_iid: task.mr_iid,
      target_branch: scope.default_branch,
      body: buildReviewBody(task, scope.default_branch),
      repo: {
        url: scope.provider_project_path,
        credentials: minted ? { token: minted.token } : undefined,
        branch: task.branch ?? `colony/${task.id}`,
        base_commit: headSha,
      },
    };

    const metadata = await reviewer.startRun(packet, {
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
        await revokeRunToken(ctx.provider, project, minted);
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

function buildReviewBody(task: Task, defaultBranch: string): string {
  return [
    task.spec,
    "",
    "## Review instructions",
    `Diff against origin/${defaultBranch} (\`git diff origin/${defaultBranch}...HEAD\`) and inspect changed files.`,
    "Judge spec compliance and defects. Do not edit files or push.",
    "Sections titled 'Spec amendment (operator...)' are authoritative and supersede earlier spec text they contradict.",
    "Review adversarially — actively look for a reason to reject:",
    "- Trace EVERY input path (config file, env var, override parameter, API body) to its validation; an input accepted on one path but rejected on another is a finding.",
    "- Verify claimed guarantees hold under the substrate: process trees vs single processes, pipe ordering, path resolution, lockfile/CI sync.",
    "- For shared contracts (schemas, wire protocols, exported test suites): over-specification is as much a defect as under-specification — flag assertions no implementation can honestly guarantee.",
    "- Check the change lands green alone: new workspace packages must be in the lockfile, new files in CI's reach.",
    "Submit reviewer_verdict with the exact head SHA you inspected (`git rev-parse HEAD`).",
    "request_changes requires at least one finding.",
  ].join("\n");
}
