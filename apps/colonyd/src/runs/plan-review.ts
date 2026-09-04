import {
  type ArchitectDecompositionV2,
  PlanReviewVerdictV1,
} from "@colony/schemas";
import { formatPlanReviewFeedback } from "@colony/agent-runtime";
import { createHash } from "node:crypto";
import { context } from "@opentelemetry/api";
import type { Scope } from "@colony/core";
import type { ProviderRepoRef } from "@colony/provider";
import { startColonyRunSpan, type ColonyRunSpan } from "@colony/observability";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import { buildPlanReviewPacket } from "./packets.js";
import { mintRunToken, revokeRunToken, type MintedToken } from "./tokens.js";

const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Review rounds a plan may go through before the scope blocks on a human.
 * Same cap as the code-review loop: findings are the correction signal, and
 * a plan that cannot converge in this many rounds has a problem the
 * architect cannot fix alone.
 */
export const MAX_PLAN_REVIEW_ROUNDS = 10;

export interface PlanReviewRunOptions {
  readonly leaseTtlMs?: number;
  readonly startModelId?: string;
}

/**
 * Review a proposed plan (scopes.plan_json) with the reviewer chain. An
 * approve leaves the plan in place for materialization/operator approval and
 * is recorded on the run; request_changes clears the plan and hands the
 * findings to the next architect run through the existing replan path.
 */
export async function runPlanReview(
  ctx: ColonydContext,
  scope: Scope,
  plan: ArchitectDecompositionV2,
  round: number,
  options: PlanReviewRunOptions = {},
): Promise<void> {
  const planReviewer = ctx.agents.planReviewer;
  if (!planReviewer) return;
  const repo: ProviderRepoRef = {
    id: scope.provider_repo_id,
    path: scope.provider_repo_path,
  };
  const reviewer = ctx.config.forAgent("plan_reviewer");
  const modelId = options.startModelId ?? reviewer.model.id;
  const leaseTtlMs =
    options.leaseTtlMs ?? reviewer.ceilings.timeoutMs + 5 * 60_000;

  const runId = crypto.randomUUID();
  const runSpan = startColonyRunSpan({
    scope_id: scope.id,
    task_id: null,
    run_id: runId,
    kind: "plan_review",
    model_id: modelId,
  });
  ctx.store.startRun({
    id: runId,
    scope_id: scope.id,
    kind: "plan_review",
    lease_ttl_ms: leaseTtlMs,
    model_id: modelId,
    trace_id: runSpan?.traceId ?? null,
  });
  ctx.store.audit(SERVICE_ACTOR, "run.start", {
    scope_id: scope.id,
    run_id: runId,
    detail: { kind: "plan_review", round },
  });

  const abortController = new AbortController();
  const heartbeat = setInterval(() => {
    if (abortController.signal.aborted) return;
    ctx.store.heartbeatRun(runId, leaseTtlMs);
  }, HEARTBEAT_INTERVAL_MS);

  const execution = executePlanReview(
    ctx,
    repo,
    scope,
    plan,
    round,
    runId,
    abortController,
    runSpan,
    options,
  );
  trackRun(runId, execution, () => {
    abortController.abort();
    return planReviewer.cancelRun(runId).then(() => undefined);
  });
  try {
    await execution;
  } finally {
    clearInterval(heartbeat);
    runSpan?.end("canceled", "aborted");
  }
}

async function executePlanReview(
  ctx: ColonydContext,
  repo: ProviderRepoRef,
  scope: Scope,
  plan: ArchitectDecompositionV2,
  round: number,
  runId: string,
  abortController: AbortController,
  runSpan: ColonyRunSpan | undefined,
  options: PlanReviewRunOptions,
): Promise<void> {
  const planReviewer = ctx.agents.planReviewer!;
  let minted: MintedToken | null = null;
  try {
    minted = await mintRunToken(ctx.provider, repo, {
      name: `colony-plan-review-${scope.id}`,
      scopes: ["api", "read_repository"],
      singleToken: ctx.env.singleToken,
      fallbackToken: ctx.env.gitlabToken,
    });
    if (minted?.token_id) ctx.store.setRunToken(runId, minted.token_id);

    const baseSha = (await ctx.provider.commits.get(repo, scope.default_branch))
      .sha;
    const project = scope.project_name
      ? (ctx.store.getProject(scope.project_name) ?? null)
      : null;
    const files = scope.project_name
      ? ctx.store.listProjectFiles(scope.project_name)
      : [];
    const packet = buildPlanReviewPacket(
      scope,
      project,
      files,
      baseSha,
      plan,
      round,
    );
    const full = {
      ...packet,
      repo: {
        ...packet.repo,
        credentials: minted ? { token: minted.token } : undefined,
      },
    };

    const metadata = await (runSpan
      ? context.with(runSpan.spanContext, () =>
          planReviewer.startRun(full, {
            role: "plan_reviewer",
            runId,
            startModelId: options.startModelId,
            traceContext: runSpan.spanContext,
          }),
        )
      : planReviewer.startRun(full, { role: "plan_reviewer", runId }));
    if (abortController.signal.aborted) {
      ctx.store.finishRun(runId, "canceled", { error: "aborted" });
      runSpan?.end("canceled", "aborted");
      return;
    }
    if (metadata.status !== "succeeded") {
      const reason = metadata.rejectionReason ?? metadata.status;
      ctx.store.finishRun(runId, "failed", { error: reason });
      runSpan?.end("failed", reason);
      return;
    }
    const output = await planReviewer.getRunOutput(runId);
    const parsed = output
      ? PlanReviewVerdictV1.safeParse(output.envelope)
      : null;
    if (!parsed || !parsed.success) {
      ctx.store.finishRun(runId, "failed", {
        error: "envelope invalid",
        envelope_json: output ? JSON.stringify(output.envelope) : undefined,
      });
      runSpan?.end("failed", "envelope invalid");
      return;
    }
    const verdict = parsed.data;
    ctx.store.finishRun(runId, "succeeded", {
      envelope_json: JSON.stringify(verdict),
      evidence_json: JSON.stringify({
        verdict: verdict.verdict,
        round,
        plan_hash: planHash(scope.plan_json ?? JSON.stringify(plan)),
        findings: verdict.findings,
        inspected: verdict.inspected,
      }),
    });
    runSpan?.end("succeeded");
    ctx.store.audit(SERVICE_ACTOR, "scope.plan_reviewed", {
      scope_id: scope.id,
      run_id: runId,
      detail: {
        round,
        verdict: verdict.verdict,
        findings: verdict.findings.length,
        inspected: verdict.inspected.length,
      },
    });
    // The scope may have moved while the review ran (operator replan or
    // abandon); only act on a plan that is still the one reviewed.
    const current = ctx.store.getScope(scope.id);
    if (
      !current ||
      current.status !== "planning" ||
      current.plan_json !== scope.plan_json
    ) {
      return;
    }
    if (verdict.verdict === "request_changes") {
      ctx.store.requestReviewReplan(
        scope.id,
        formatPlanReviewFeedback(verdict, round),
      );
      ctx.store.audit(SERVICE_ACTOR, "scope.plan_rejected", {
        scope_id: scope.id,
        run_id: runId,
        detail: { round, findings: verdict.findings.length },
      });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.store.finishRun(runId, "failed", { error: reason });
    runSpan?.end("failed", reason);
    ctx.store.audit(SERVICE_ACTOR, "run.failed", {
      scope_id: scope.id,
      run_id: runId,
      detail: { reason, kind: "plan_review" },
    });
  } finally {
    if (minted) {
      try {
        await revokeRunToken(ctx.provider, repo, minted);
      } catch {
        ctx.store.audit(SERVICE_ACTOR, "agent_token.revoke_failed", {
          scope_id: scope.id,
          run_id: runId,
        });
      }
    }
  }
}

export function planHash(planJson: string): string {
  return createHash("sha256").update(planJson).digest("hex");
}

/**
 * The verdict recorded for exactly this plan: same content (hash) and
 * reviewed after the architect run that proposed it. "After" is the store's
 * run order, not a timestamp: millisecond ties between a review and the next
 * architect run made time-keyed lookups both miss a fresh verdict and
 * inherit a stale one. Keying on content alone would let an architect that
 * resubmits an identical rejected plan inherit the old verdict and never be
 * reviewed - or re-dispatched - again.
 */
export function latestPlanReview(
  ctx: ColonydContext,
  scopeId: string,
  planJson: string,
  proposedByRunId: string,
): { verdict: "approve" | "request_changes"; round: number } | null {
  const hash = planHash(planJson);
  const runs = ctx.store.runsForScope(scopeId);
  const proposedAt = runs.findIndex((r) => r.id === proposedByRunId);
  for (const run of runs.slice(proposedAt + 1).reverse()) {
    if (
      run.kind !== "plan_review" ||
      run.status !== "succeeded" ||
      !run.evidence_json
    )
      continue;
    try {
      const evidence = JSON.parse(run.evidence_json) as {
        verdict?: unknown;
        round?: unknown;
        plan_hash?: unknown;
      };
      if (evidence.plan_hash !== hash) continue;
      if (
        (evidence.verdict === "approve" ||
          evidence.verdict === "request_changes") &&
        typeof evidence.round === "number"
      ) {
        return { verdict: evidence.verdict, round: evidence.round };
      }
    } catch {
      // an unreadable verdict is no verdict
    }
  }
  return null;
}

/**
 * Plan reviews on this scope that sent the plan back (rejections), counted
 * since the latest epoch marker. An operator continue/replan or unblock
 * starts a fresh rejection budget, mirroring the architectAttempts pattern:
 * listAudit returns its window oldest-first, so the LATEST marker is the
 * last match, not the first. No marker means a legacy scope (col-1e4f99fd):
 * count all of history.
 */
export function planReviewRounds(ctx: ColonydContext, scopeId: string): number {
  const events = ctx.store.listAudit({ scope_id: scopeId, limit: 500 }).events;
  const marker = events
    .filter(
      (row) =>
        row.action === "scope.plan_review_continued" ||
        row.action === "scope.plan_review_replanned" ||
        row.action === "scope.unblocked",
    )
    .at(-1);
  return events.filter(
    (row) =>
      row.action === "scope.plan_rejected" && (!marker || row.id > marker.id),
  ).length;
}
