import { createHash } from "node:crypto";
import {
  type ArchitectDecompositionV2,
  PlanReviewVerdictV1,
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
} from "@colony/schemas";
import type { Run, Scope } from "@colony/core";
import { context } from "@opentelemetry/api";
import type { ProviderRepoRef } from "@colony/provider";
import { startColonyRunSpan, type ColonyRunSpan } from "@colony/observability";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import {
  buildArchitectExtensionPacket,
  buildArchitectPacket,
  type ArchitectExtensionInput,
  type ArchitectRevisionContext,
} from "./packets.js";
import {
  ArchitectExtensionEnvelope,
  formatPlanReviewFeedback,
} from "@colony/agent-runtime";
import type { ArchitectExtensionEnvelope as ArchitectExtensionEnvelopeType } from "@colony/agent-runtime";
import { handleArchitectExtension } from "./extend.js";
import { mintRunToken, revokeRunToken, type MintedToken } from "./tokens.js";

const HEARTBEAT_INTERVAL_MS = 60_000;

export interface ArchitectRunOptions {
  readonly leaseTtlMs?: number;
  readonly mode?: "initial" | "extension";
  readonly extension?: ArchitectExtensionInput;
  readonly startModelId?: string;
}
const REVISION_EPOCH_ACTIONS: Record<string, true> = {
  "plan.replan_requested": true,
  "scope.plan_review_continued": true,
  "scope.plan_review_replanned": true,
};

interface ReviewEvidence {
  readonly plan_hash?: unknown;
  readonly round?: unknown;
  readonly verdict?: unknown;
}
function parseReviewEvidence(
  run: Run,
): { planHash: string; round: number; verdict: PlanReviewVerdictV1 } | null {
  if (
    run.kind !== "plan_review" ||
    run.status !== "succeeded" ||
    !run.evidence_json ||
    !run.envelope_json
  ) {
    return null;
  }
  try {
    const evidence = JSON.parse(run.evidence_json) as ReviewEvidence;
    if (
      typeof evidence.plan_hash !== "string" ||
      typeof evidence.round !== "number" ||
      evidence.verdict !== "request_changes"
    ) {
      return null;
    }
    const verdict = PlanReviewVerdictV1.safeParse(
      JSON.parse(run.envelope_json),
    );
    if (!verdict.success || verdict.data.verdict !== "request_changes") {
      return null;
    }
    return {
      planHash: evidence.plan_hash,
      round: evidence.round,
      verdict: verdict.data,
    };
  } catch {
    return null;
  }
}

function parseArchitectPlan(run: Run): ArchitectDecompositionV2 | null {
  if (
    run.kind !== "architect" ||
    run.status !== "succeeded" ||
    !run.envelope_json
  ) {
    return null;
  }
  try {
    const parsed = architectDecompositionV2Schema.safeParse(
      JSON.parse(run.envelope_json),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Locate the exact plan rejected in the current planning epoch. The rejection
 * audit identifies the review run; the review evidence identifies the plan by
 * content hash; and the preceding architect run supplies the durable envelope.
 * If an old database has feedback but no rejection audit, the same checks are
 * applied to the newest matching review, but only within the current epoch.
 */
export function findArchitectRevisionContext(
  ctx: ColonydContext,
  scope: Scope,
): ArchitectRevisionContext | null {
  const feedback = scope.plan_feedback?.trim();
  if (!feedback) return null;

  const audit = ctx.store.listAudit({ scope_id: scope.id, limit: 500 }).events;
  const epochMarker = audit
    .filter((row) => REVISION_EPOCH_ACTIONS[row.action] === true)
    .at(-1);
  const epoch = epochMarker
    ? `${epochMarker.action}:${epochMarker.id}`
    : "legacy";
  const rejection = audit
    .filter(
      (row) =>
        row.action === "scope.plan_rejected" &&
        (!epochMarker || row.id > epochMarker.id),
    )
    .at(-1);
  const rejectionRunId = rejection?.run_id ?? null;
  const runs = ctx.store.runsForScope(scope.id);
  const runEntries = runs.map((run, index) => ({ run, index }));
  const latestReview = runEntries
    .filter(({ run }) => run.kind === "plan_review")
    .at(-1);
  const candidates = rejectionRunId
    ? runEntries.filter(({ run }) => run.id === rejectionRunId)
    : latestReview
      ? [latestReview]
      : [];
  for (const { run: reviewRun, index: reviewIndex } of candidates) {
    const review = parseReviewEvidence(reviewRun);
    if (!review) continue;
    const normalizedFeedback = formatPlanReviewFeedback(
      review.verdict,
      review.round,
    ).trim();
    if (normalizedFeedback !== feedback) {
      continue;
    }
    if (epochMarker && reviewRun.started_at < epochMarker.at) continue;
    for (let i = reviewIndex - 1; i >= 0; i -= 1) {
      const architectRun = runs[i]!;
      if (
        architectRun.kind !== "architect" ||
        architectRun.status !== "succeeded" ||
        !architectRun.envelope_json ||
        (epochMarker && architectRun.started_at < epochMarker.at)
      ) {
        continue;
      }
      const plan = parseArchitectPlan(architectRun);
      if (!plan) continue;
      const planHash = createHash("sha256")
        .update(architectRun.envelope_json)
        .digest("hex");
      if (planHash !== review.planHash) continue;
      return {
        rejected_plan: plan,
        review_run_id: reviewRun.id,
        review_base_sha: reviewRun.base_sha,
        plan_hash: review.planHash,
        planning_epoch: epoch,
        feedback,
      };
    }
  }
  return null;
}
/**
 * Execute one architect run for a scope already transitioned to `planning`.
 * Success stores the validated plan in `scopes.plan_json`; the tick's
 * planning phase then materializes it (yolo) or waits for approval (gated).
 */
export async function runArchitect(
  ctx: ColonydContext,
  scope: Scope,
  options: ArchitectRunOptions = {},
): Promise<void> {
  const repo: ProviderRepoRef = {
    id: scope.provider_repo_id,
    path: scope.provider_repo_path,
  };
  const architect = ctx.config.forAgent("architect");
  const modelId = options.startModelId ?? architect.model.id;
  const leaseTtlMs =
    options.leaseTtlMs ?? architect.ceilings.timeoutMs + 5 * 60_000;

  // The span must exist first so its trace id can ride on the run row:
  // mint the run id before either exists and hand it to both, so the span's
  // colony.run_id equals the store row id.
  const runId = crypto.randomUUID();
  const runSpan = startColonyRunSpan({
    scope_id: scope.id,
    task_id: null,
    run_id: runId,
    kind: "architect",
    model_id: modelId,
  });
  const run = ctx.store.startRun({
    id: runId,
    scope_id: scope.id,
    kind: "architect",
    lease_ttl_ms: leaseTtlMs,
    model_id: modelId,
    trace_id: runSpan?.traceId ?? null,
  });
  ctx.store.audit(SERVICE_ACTOR, "run.start", {
    scope_id: scope.id,
    run_id: runId,
  });

  const abortController = new AbortController();
  const heartbeat = setInterval(() => {
    if (abortController.signal.aborted) return;
    ctx.store.heartbeatRun(runId, leaseTtlMs);
  }, HEARTBEAT_INTERVAL_MS);

  const execution = executeArchitect(
    ctx,
    repo,
    scope,
    runId,
    abortController,
    runSpan,
    options,
  );
  trackRun(runId, execution, () => {
    abortController.abort();
    return ctx.agents.architect.cancelRun(runId).then(() => undefined);
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

async function executeArchitect(
  ctx: ColonydContext,
  repo: ProviderRepoRef,
  scope: Scope,
  runId: string,
  abortController: AbortController,
  runSpan: ColonyRunSpan | undefined,
  options: ArchitectRunOptions,
): Promise<void> {
  let minted: MintedToken | null = null;
  try {
    minted = await mintRunToken(ctx.provider, repo, {
      name: `colony-architect-${scope.id}`,
      scopes: ["api", "read_repository"],
      singleToken: ctx.env.singleToken,
      fallbackToken: ctx.env.gitlabToken,
    });
    if (minted?.token_id) ctx.store.setRunToken(runId, minted.token_id);
    ctx.store.audit(SERVICE_ACTOR, "agent_token.minted", {
      scope_id: scope.id,
      run_id: runId,
      detail: {
        mode: ctx.env.singleToken ? "single_token" : "repo_token",
        token_id: minted?.token_id ?? null,
      },
    });

    const baseSha = (await ctx.provider.commits.get(repo, scope.default_branch))
      .sha;
    ctx.store.setRunBaseSha(runId, baseSha);
    const planningScope = ctx.store.getScope(scope.id) ?? scope;
    const revisionContext =
      options.mode === "extension"
        ? undefined
        : (findArchitectRevisionContext(ctx, planningScope) ?? undefined);
    const project = planningScope.project_name
      ? (ctx.store.getProject(planningScope.project_name) ?? null)
      : null;
    const files = planningScope.project_name
      ? ctx.store.listProjectFiles(planningScope.project_name)
      : [];
    const { repo: repoWithCredentials, ...packet } =
      options.mode === "extension" && options.extension
        ? buildArchitectExtensionPacket(
            planningScope,
            project,
            files,
            repo,
            baseSha,
            options.extension,
          )
        : buildArchitectPacket(
            planningScope,
            project,
            files,
            repo,
            baseSha,
            revisionContext,
          );
    const full = {
      ...packet,
      repo: {
        ...repoWithCredentials,
        credentials: minted ? { token: minted.token } : undefined,
      },
    };

    // Binding the dispatch to the span context is what makes the SDK's
    // invoke_agent/chat/execute_tool spans children of this run's trace.
    const metadata = await inRunSpanContext(runSpan, () =>
      ctx.agents.architect.startRun(full, {
        role: "architect",
        runId,
        startModelId: options.startModelId,
        traceContext: runSpan?.spanContext,
      }),
    );
    if (abortController.signal.aborted) {
      ctx.store.finishRun(runId, "canceled", { error: "aborted" });
      runSpan?.end("canceled", "aborted");
      return;
    }

    if (metadata.status !== "succeeded") {
      ctx.store.finishRun(runId, "failed", {
        error: metadata.rejectionReason ?? metadata.status,
      });
      runSpan?.end("failed", metadata.rejectionReason ?? metadata.status);
      ctx.store.audit(SERVICE_ACTOR, "run.failed", {
        scope_id: scope.id,
        run_id: runId,
        detail: { reason: metadata.rejectionReason ?? metadata.status },
      });
      return;
    }

    const output = await ctx.agents.architect.getRunOutput(runId);
    const parsed = output
      ? options.mode === "extension"
        ? ArchitectExtensionEnvelope.safeParse(output.envelope)
        : architectDecompositionV2Schema.safeParse(output.envelope)
      : null;
    if (!parsed || !parsed.success) {
      ctx.store.finishRun(runId, "failed", {
        error: "envelope invalid",
        envelope_json: output ? JSON.stringify(output.envelope) : undefined,
      });
      runSpan?.end("failed", "envelope invalid");
      return;
    }
    const envelope = parsed.data;
    if (options.mode === "extension") {
      const extension = envelope as ArchitectExtensionEnvelopeType;
      ctx.store.finishRun(runId, "succeeded", {
        envelope_json: JSON.stringify(extension),
      });
      runSpan?.end("succeeded");
      await handleArchitectExtension(ctx, scope, runId, extension);
      return;
    }
    const decomposition = envelope as ArchitectDecompositionV2;
    if (!isAcyclic(decomposition.tasks.map((task) => task.depends_on))) {
      ctx.store.finishRun(runId, "failed", {
        error: "decomposition dependency graph is cyclic",
        envelope_json: JSON.stringify(decomposition),
      });
      runSpan?.end("failed", "decomposition dependency graph is cyclic");
      return;
    }

    ctx.store.finishRun(runId, "succeeded", {
      envelope_json: JSON.stringify(decomposition),
    });
    runSpan?.end("succeeded");
    ctx.store.setScopePlan(scope.id, JSON.stringify(decomposition));
    ctx.store.audit(SERVICE_ACTOR, "scope.plan_proposed", {
      scope_id: scope.id,
      run_id: runId,
      detail: { task_count: decomposition.tasks.length },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.store.finishRun(runId, "failed", {
      error: reason,
    });
    runSpan?.end("failed", reason);
    ctx.store.audit(SERVICE_ACTOR, "run.failed", {
      scope_id: scope.id,
      run_id: runId,
      detail: { reason },
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

export function isAcyclic(deps: ReadonlyArray<readonly number[]>): boolean {
  const indegree = deps.map((edges) => edges.length);
  const queue: number[] = [];
  indegree.forEach((degree, node) => {
    if (degree === 0) queue.push(node);
  });
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited += 1;
    deps.forEach((edges, target) => {
      if (edges.includes(node)) {
        indegree[target] -= 1;
        if (indegree[target] === 0) queue.push(target);
      }
    });
  }
  return visited === deps.length;
}
