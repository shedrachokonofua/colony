import {
  type ArchitectDecompositionV2,
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
} from "@colony/schemas";
import type { Scope, Store } from "@colony/core";
import type { ProviderRepoRef } from "@colony/provider";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import { buildArchitectPacket } from "./packets.js";
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
  const repo: ProviderRepoRef = {
    id: scope.provider_repo_id,
    path: scope.provider_repo_path,
  };
  const architect = ctx.config.forAgent("architect");
  const leaseTtlMs =
    options.leaseTtlMs ?? architect.ceilings.timeoutMs + 5 * 60_000;

  const run = ctx.store.startRun({
    scope_id: scope.id,
    kind: "architect",
    lease_ttl_ms: leaseTtlMs,
    model_id: architect.model.id,
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
    repo,
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
  repo: ProviderRepoRef,
  scope: Scope,
  runId: string,
  leaseTtlMs: number,
  abortController: AbortController,
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
    const project = scope.project_name
      ? (ctx.store.getProject(scope.project_name) ?? null)
      : null;
    const { repo: repoWithCredentials, ...packet } = buildArchitectPacket(
      scope,
      project,
      repo,
      baseSha,
    );
    const full = {
      ...packet,
      repo: {
        ...repoWithCredentials,
        credentials: minted ? { token: minted.token } : undefined,
      },
    };

    const metadata = await ctx.agents.architect.startRun(full, {
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
