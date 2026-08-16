import {
  type ArchitectDecompositionV2,
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
} from "@colony/schemas";
import type { Scope, Store } from "@colony/core";
import type { ProviderProjectRef } from "@colony/provider";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import { mintRunToken, revokeRunToken, type MintedToken } from "./tokens.js";

const HEARTBEAT_INTERVAL_MS = 60_000;

export interface ArchitectRunOptions {
  readonly leaseTtlMs?: number;
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
  const project: ProviderProjectRef = {
    id: scope.provider_project_id,
    path: scope.provider_project_path,
  };
  const architect = ctx.config.forAgent("architect");
  const leaseTtlMs =
    options.leaseTtlMs ?? architect.ceilings.timeoutMs + 5 * 60_000;

  const run = ctx.store.startRun({
    scope_id: scope.id,
    kind: "architect",
    lease_ttl_ms: leaseTtlMs,
  });
  ctx.store.audit(SERVICE_ACTOR, "run.start", {
    scope_id: scope.id,
    run_id: run.id,
  });

  const abortController = new AbortController();
  const heartbeat = setInterval(() => {
    if (abortController.signal.aborted) return;
    ctx.store.heartbeatRun(run.id, leaseTtlMs);
  }, HEARTBEAT_INTERVAL_MS);

  const execution = executeArchitect(
    ctx,
    project,
    scope,
    run.id,
    leaseTtlMs,
    abortController,
  );
  trackRun(run.id, execution, () => {
    abortController.abort();
    return ctx.agents.architect.cancelRun(run.id).then(() => undefined);
  });
  try {
    await execution;
  } finally {
    clearInterval(heartbeat);
  }
}

async function executeArchitect(
  ctx: ColonydContext,
  project: ProviderProjectRef,
  scope: Scope,
  runId: string,
  leaseTtlMs: number,
  abortController: AbortController,
): Promise<void> {
  let minted: MintedToken | null = null;
  try {
    minted = await mintRunToken(ctx.provider, project, {
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
        mode: ctx.env.singleToken ? "single_token" : "project_token",
        token_id: minted?.token_id ?? null,
      },
    });

    const baseSha = (
      await ctx.provider.commits.get(project, scope.default_branch)
    ).sha;
    const packet = {
      kind: "architect_scope",
      scope_id: scope.id,
      goal: scope.goal,
      body: buildArchitectBody(scope),
      repo: {
        url: scope.provider_project_path,
        credentials: minted ? { token: minted.token } : undefined,
        branch: scope.default_branch,
        base_commit: baseSha,
      },
    };

    const metadata = await ctx.agents.architect.startRun(packet, {
      role: "architect",
      runId,
    });
    if (abortController.signal.aborted) {
      ctx.store.finishRun(runId, "canceled", { error: "aborted" });
      return;
    }

    if (metadata.status !== "succeeded") {
      ctx.store.finishRun(runId, "failed", {
        error: metadata.rejectionReason ?? metadata.status,
      });
      ctx.store.audit(SERVICE_ACTOR, "run.failed", {
        scope_id: scope.id,
        run_id: runId,
        detail: { reason: metadata.rejectionReason ?? metadata.status },
      });
      return;
    }

    const output = await ctx.agents.architect.getRunOutput(runId);
    const parsed = output
      ? architectDecompositionV2Schema.safeParse(output.envelope)
      : null;
    if (!parsed || !parsed.success) {
      ctx.store.finishRun(runId, "failed", {
        error: "envelope invalid",
        envelope_json: output ? JSON.stringify(output.envelope) : undefined,
      });
      return;
    }
    const envelope = parsed.data;

    if (!isAcyclic(envelope.tasks.map((t) => t.depends_on))) {
      ctx.store.finishRun(runId, "failed", {
        error: "decomposition dependency graph is cyclic",
        envelope_json: JSON.stringify(envelope),
      });
      return;
    }

    ctx.store.finishRun(runId, "succeeded", {
      envelope_json: JSON.stringify(envelope),
    });
    ctx.store.setScopePlan(scope.id, JSON.stringify(envelope));
    ctx.store.audit(SERVICE_ACTOR, "scope.plan_proposed", {
      scope_id: scope.id,
      run_id: runId,
      detail: { task_count: envelope.tasks.length },
    });
  } catch (err) {
    ctx.store.finishRun(runId, "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    ctx.store.audit(SERVICE_ACTOR, "run.failed", {
      scope_id: scope.id,
      run_id: runId,
      detail: { reason: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    if (minted) {
      try {
        await revokeRunToken(ctx.provider, project, minted);
      } catch {
        ctx.store.audit(SERVICE_ACTOR, "agent_token.revoke_failed", {
          scope_id: scope.id,
          run_id: runId,
        });
      }
    }
  }
}

function buildArchitectBody(scope: Scope): string {
  const lines = [
    `Scope goal: ${scope.goal}`,
    "",
    "Inspect the repository (read-only) before decomposing.",
    "Emit architect_decomposition with at most 20 outcome-oriented tasks.",
    "Each task spec must contain: goal, user-observable behavior, invariants, required evidence.",
    "Prefer coarse vertical tasks over file-sliced tasks.",
    "Two tasks must not both introduce schema migrations unless one depends on the other.",
    "depends_on entries are indexes into the tasks array; the graph must be acyclic.",
  ];
  if (scope.plan_feedback) {
    lines.push(
      "",
      "## Operator feedback on your previous plan",
      scope.plan_feedback,
      "",
      "The previous decomposition was rejected. Revise it to address this feedback.",
    );
  }
  return lines.join("\n");
}

function isAcyclic(deps: ReadonlyArray<readonly number[]>): boolean {
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
