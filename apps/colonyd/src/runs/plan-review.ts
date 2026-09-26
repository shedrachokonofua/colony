import {
  type ArchitectDecompositionV2,
  PlanReviewVerdictV1,
} from "@colony/schemas";
import { z } from "zod";
import { context } from "@opentelemetry/api";
import type { Fault, Scope } from "@colony/core";
import type { ProviderRepoRef } from "@colony/provider";
import { startColonyRunSpan, type ColonyRunSpan } from "@colony/observability";
import {
  faultForFailure,
  isTimeoutFault,
  modelFault,
} from "../fault-budget.js";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import { buildPlanReviewPacket } from "./packets.js";
import {
  BUDGET_EPOCH_ACTIONS,
  goalInputs,
  planHash,
  previousPlanReview,
} from "./plan-loop.js";
import { mintRunToken, revokeRunToken, type MintedToken } from "./tokens.js";

const HEARTBEAT_INTERVAL_MS = 60_000;
const planReviewSubject = z.object({ plan_hash: z.string() });

export interface PlanReviewRunOptions {
  readonly leaseTtlMs?: number;
  readonly startModelId?: string;
  readonly excludedModelIds?: readonly string[];
  /** The architect run that proposed the plan; names the review it revised. */
  readonly proposedByRunId?: string;
}

/**
 * Review a proposed plan (scopes.plan_json) with the reviewer chain and
 * record the verdict on the run. The plan stays in place either way: the
 * tick materializes or holds an approved plan, and sends a rejected one back
 * to the architect or stops for the operator (plan-loop.ts).
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
  const planHashValue = planHash(scope.plan_json ?? JSON.stringify(plan));
  let minted: MintedToken | null = null;
  let baseSha: string | undefined;
  try {
    minted = await mintRunToken(ctx.provider, repo, {
      name: `colony-plan-review-${scope.id}`,
      scopes: ["api", "read_repository"],
      singleToken: ctx.env.singleToken,
      fallbackToken: ctx.env.gitlabToken,
    });
    if (minted?.token_id) ctx.store.setRunToken(runId, minted.token_id);

    baseSha = (await ctx.provider.commits.get(repo, scope.default_branch)).sha;
    ctx.store.setRunBaseSha(runId, baseSha);
    const project = scope.project_name
      ? (ctx.store.getProject(scope.project_name) ?? null)
      : null;
    const files = scope.project_name
      ? ctx.store.listProjectFiles(scope.project_name)
      : [];
    const previous = options.proposedByRunId
      ? previousPlanReview(ctx, scope.id, options.proposedByRunId, plan)
      : null;
    const packet = buildPlanReviewPacket(
      scope,
      project,
      files,
      baseSha,
      plan,
      round,
      previous,
    );
    const full = {
      ...packet,
      repo: {
        ...packet.repo,
        credentials: minted ? { token: minted.token } : undefined,
      },
    };
    const startRunOptions = {
      role: "plan_reviewer" as const,
      runId,
      startModelId: options.startModelId,
      excludedModelIds: options.excludedModelIds,
      ...(runSpan ? { traceContext: runSpan.spanContext } : {}),
    };
    const metadata = await (runSpan
      ? context.with(runSpan.spanContext, () =>
          planReviewer.startRun(full, startRunOptions),
        )
      : planReviewer.startRun(full, startRunOptions));
    if (abortController.signal.aborted) {
      ctx.store.finishRun(runId, "canceled", { error: "aborted" });
      runSpan?.end("canceled", "aborted");
      return;
    }
    if (metadata.status !== "succeeded") {
      const reason = metadata.rejectionReason ?? metadata.status;
      finishPlanReviewFailure(
        ctx,
        scope,
        runId,
        planHashValue,
        baseSha,
        reason,
        faultForFailure(
          ctx.store,
          { scope_id: scope.id, run_id: runId },
          reason,
          metadata.fault,
        ),
      );
      runSpan?.end("failed", reason);
      return;
    }
    const output = await planReviewer.getRunOutput(runId);
    const parsed = output
      ? PlanReviewVerdictV1.safeParse(output.envelope)
      : null;
    if (!parsed || !parsed.success) {
      finishPlanReviewFailure(
        ctx,
        scope,
        runId,
        planHashValue,
        baseSha,
        "envelope invalid",
        modelFault("envelope_invalid", "envelope invalid"),
        output ? JSON.stringify(output.envelope) : undefined,
      );
      runSpan?.end("failed", "envelope invalid");
      return;
    }
    const verdict = parsed.data;
    ctx.store.finishRun(runId, "succeeded", {
      envelope_json: JSON.stringify(verdict),
      evidence_json: JSON.stringify({
        verdict: verdict.verdict,
        round,
        plan_hash: planHashValue,
        findings: verdict.findings,
        inspected: verdict.inspected,
        goal_inputs: goalInputs(scope, project, files),
        ...(previous
          ? {
              previous_review_run_id: previous.review.run.id,
              previous_findings: verdict.previous_findings ?? [],
            }
          : {}),
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
    // abandon); a rejection counts only against the plan still in place.
    const current = ctx.store.getScope(scope.id);
    if (
      !current ||
      current.status !== "planning" ||
      current.plan_json !== scope.plan_json
    ) {
      return;
    }
    if (verdict.verdict === "request_changes") {
      ctx.store.audit(SERVICE_ACTOR, "scope.plan_rejected", {
        scope_id: scope.id,
        run_id: runId,
        detail: { round, findings: verdict.findings.length },
      });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    finishPlanReviewFailure(
      ctx,
      scope,
      runId,
      planHashValue,
      baseSha,
      reason,
      faultForFailure(
        ctx.store,
        { scope_id: scope.id, run_id: runId },
        reason,
        undefined,
      ),
    );
    runSpan?.end("failed", reason);
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

function finishPlanReviewFailure(
  ctx: ColonydContext,
  scope: Scope,
  runId: string,
  planHashValue: string,
  baseSha: string | undefined,
  error: string,
  fault: Fault,
  envelopeJson?: string,
): void {
  ctx.store.finishRun(runId, "failed", {
    error,
    fault,
    envelope_json: envelopeJson,
    evidence_json: JSON.stringify({
      plan_hash: planHashValue,
      ...(baseSha ? { base_sha: baseSha } : {}),
    }),
  });
  ctx.store.audit(SERVICE_ACTOR, "run.failed", {
    scope_id: scope.id,
    run_id: runId,
    detail: { reason: error, kind: "plan_review" },
  });
}

/**
 * Return model ids whose timeout failures belong to the current proposal and
 * exact plan content. Runs before the proposal run (or before an operator
 * reset) cannot consume this proposal's timeout budget.
 */
export function timedOutPlanReviewModelIds(
  ctx: ColonydContext,
  scopeId: string,
  planJson: string,
  proposedByRunId: string,
  since?: string,
): readonly string[] {
  const runs = ctx.store.runsForScope(scopeId);
  const proposedAt = runs.findIndex((run) => run.id === proposedByRunId);
  if (proposedAt < 0) return [];
  const hash = planHash(planJson);
  const marker = since ?? planReviewResetAt(ctx, scopeId);
  const ids = new Set<string>();
  for (const run of runs.slice(proposedAt + 1)) {
    if (
      run.kind !== "plan_review" ||
      !isTimeoutFault(run) ||
      !run.model_id ||
      (marker !== undefined && run.started_at <= marker) ||
      !run.evidence_json
    )
      continue;
    try {
      const evidence = planReviewSubject.safeParse(
        JSON.parse(run.evidence_json),
      );
      if (evidence.success && evidence.data.plan_hash === hash) {
        ids.add(run.model_id);
      }
    } catch {
      // An unreadable failure row cannot establish the current subject.
    }
  }
  return [...ids];
}

function planReviewResetAt(
  ctx: ColonydContext,
  scopeId: string,
): string | undefined {
  let beforeId: number | undefined;
  for (;;) {
    const page = ctx.store.listAudit({
      scope_id: scopeId,
      ...(beforeId === undefined ? {} : { before_id: beforeId }),
      limit: 200,
    });
    for (let index = page.events.length - 1; index >= 0; index -= 1) {
      if (BUDGET_EPOCH_ACTIONS[page.events[index]!.action] === true)
        return page.events[index]!.at;
    }
    if (!page.has_more || page.oldest_id === null) return undefined;
    beforeId = page.oldest_id;
  }
}
