import {
  type ImplementerCompletionV2,
  ImplementerCompletionV2 as implementerCompletionV2Schema,
} from "@colony/schemas";
import type { Scope, Store, Task } from "@colony/core";
import type { ProviderProjectRef } from "@colony/provider";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import { mintRunToken, revokeRunToken, type MintedToken } from "./tokens.js";

const HEARTBEAT_INTERVAL_MS = 60_000;

export interface ImplementRunOptions {
  readonly leaseTtlMs?: number;
}

/**
 * Execute one implement run for a task already transitioned to `running`.
 *
 * Success/blocked envelope paths transition the task; every failure path
 * leaves the task untouched — the tick reconciles failed/expired runs into
 * requeue or block (single-writer discipline with optimistic versions).
 */
export async function runImplement(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  options: ImplementRunOptions = {},
): Promise<void> {
  const project: ProviderProjectRef = {
    id: scope.provider_project_id,
    path: scope.provider_project_path,
  };
  const developer = ctx.config.forAgent("developer");
  const leaseTtlMs =
    options.leaseTtlMs ?? developer.ceilings.timeoutMs + 5 * 60_000;

  const run = ctx.store.startRun({
    scope_id: scope.id,
    task_id: task.id,
    kind: "implement",
    lease_ttl_ms: leaseTtlMs,
  });
  ctx.store.audit(SERVICE_ACTOR, "run.start", {
    scope_id: scope.id,
    task_id: task.id,
    run_id: run.id,
  });

  const abortController = new AbortController();
  const heartbeat = setInterval(() => {
    if (abortController.signal.aborted) return;
    ctx.store.heartbeatRun(run.id, leaseTtlMs);
  }, HEARTBEAT_INTERVAL_MS);

  const execution = executeImplement(
    ctx,
    project,
    scope,
    task,
    run.id,
    leaseTtlMs,
    abortController,
  );
  trackRun(run.id, execution, () => {
    abortController.abort();
    return ctx.agents.developer.cancelRun(run.id).then(() => undefined);
  });
  try {
    await execution;
  } finally {
    clearInterval(heartbeat);
  }
}

async function executeImplement(
  ctx: ColonydContext,
  project: ProviderProjectRef,
  scope: Scope,
  task: Task,
  runId: string,
  leaseTtlMs: number,
  abortController: AbortController,
): Promise<void> {
  let minted: MintedToken | null = null;
  try {
    minted = await mintRunToken(ctx.provider, project, {
      name: `colony-task-${task.id}`,
      scopes: ["api", "write_repository"],
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

    const baseSha = (
      await ctx.provider.commits.get(project, scope.default_branch)
    ).sha;
    const branch = `colony/${task.id}`;
    const packet = {
      kind: "implement_task",
      task_id: task.id,
      scope_id: scope.id,
      goal: task.title,
      body: buildPacketBody(ctx, task),
      repo: {
        url: scope.provider_project_path,
        credentials: minted ? { token: minted.token } : undefined,
        branch,
        base_commit: baseSha,
      },
    };

    const metadata = await ctx.agents.developer.startRun(packet, {
      role: "developer",
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
        task_id: task.id,
        run_id: runId,
        detail: { reason: metadata.rejectionReason ?? metadata.status },
      });
      return;
    }

    const output = await ctx.agents.developer.getRunOutput(runId);
    const parsed = output
      ? implementerCompletionV2Schema.safeParse(output.envelope)
      : null;
    if (!parsed || !parsed.success) {
      ctx.store.finishRun(runId, "failed", {
        error: "envelope invalid",
        envelope_json: output ? JSON.stringify(output.envelope) : undefined,
      });
      return;
    }
    const envelope = parsed.data;

    if (envelope.status === "blocked") {
      ctx.store.finishRun(runId, "succeeded", {
        envelope_json: JSON.stringify(envelope),
      });
      const current = ctx.store.getTask(task.id)!;
      ctx.store.transitionTask(
        current.id,
        current.state_version,
        "blocked",
        SERVICE_ACTOR,
        {
          blocked_reason: envelope.blocked_reason ?? "agent reported blocked",
        },
      );
      return;
    }

    // Verify envelope facts against the provider before any transition.
    const verified = await verifyEnvelopeFacts(ctx, project, envelope, branch);
    if (!verified.ok) {
      ctx.store.finishRun(runId, "failed", {
        error: `envelope facts unverified: ${verified.reason}`,
        envelope_json: JSON.stringify(envelope),
      });
      return;
    }

    // Requeue paths must never open duplicate MRs: reuse the task's open MR
    // when one still exists for this branch.
    let mrIid: number | undefined;
    let mrReused = false;
    if (task.mr_iid !== null) {
      try {
        const existing = await ctx.provider.mergeRequests.get(
          project,
          `${scope.provider_project_id}:${task.mr_iid}`,
        );
        if (existing.state === "opened") {
          mrIid = task.mr_iid;
          mrReused = true;
        }
      } catch {
        // Stale MR reference — open a fresh one below.
      }
    }
    if (mrIid === undefined) {
      const mr = await ctx.provider.mergeRequests.open(project, {
        source_branch: envelope.branch,
        target_branch: scope.default_branch,
        title: task.title,
        description: buildMrDescription(task, envelope),
      });
      if (mr.iid === undefined) {
        ctx.store.finishRun(runId, "failed", {
          error: "merge request opened without iid",
          envelope_json: JSON.stringify(envelope),
        });
        return;
      }
      mrIid = mr.iid;
    }

    ctx.store.finishRun(runId, "succeeded", {
      head_sha: envelope.head_sha,
      envelope_json: JSON.stringify(envelope),
      evidence_json: JSON.stringify({ commands: envelope.commands }),
    });
    ctx.store.audit(SERVICE_ACTOR, mrReused ? "mr.reused" : "mr.opened", {
      scope_id: scope.id,
      task_id: task.id,
      run_id: runId,
      detail: { mr_iid: mrIid, head_sha: envelope.head_sha },
    });
    const current = ctx.store.getTask(task.id)!;
    ctx.store.transitionTask(
      current.id,
      current.state_version,
      "mr_open",
      SERVICE_ACTOR,
      {
        branch: envelope.branch,
        mr_iid: mrIid,
      },
    );
  } catch (err) {
    ctx.store.finishRun(runId, "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    ctx.store.audit(SERVICE_ACTOR, "run.failed", {
      scope_id: scope.id,
      task_id: task.id,
      run_id: runId,
      detail: { reason: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    if (minted) {
      try {
        await revokeRunToken(ctx.provider, project, minted);
        ctx.store.audit(SERVICE_ACTOR, "agent_token.revoked", {
          scope_id: scope.id,
          task_id: task.id,
          run_id: runId,
        });
      } catch (err) {
        ctx.store.audit(SERVICE_ACTOR, "agent_token.revoke_failed", {
          scope_id: scope.id,
          task_id: task.id,
          run_id: runId,
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }
}

function buildPacketBody(ctx: ColonydContext, task: Task): string {
  const sections = [
    task.spec,
    "",
    "## Invariants",
    "- Work on the branch provided in packet.repo; commit there and push.",
    "- colonyd opens the merge request after your run — do NOT open an MR yourself.",
    "- Never commit PACKET.json or credentials; keep the diff limited to this task.",
    "- Submit implementer_completion with the exact branch and head SHA you pushed.",
  ];
  const gateFailure = latestGateFailure(ctx, task);
  if (gateFailure) {
    sections.push("", "## Previous gate failure", gateFailure);
  }
  return sections.join("\n");
}

function latestGateFailure(
  ctx: ColonydContext,
  task: Task,
): string | undefined {
  const runs = ctx.store
    .runsForTask(task.id)
    .filter((r) => r.kind === "merge_gate" && r.status === "failed");
  const latest = runs.at(-1);
  if (!latest) return undefined;
  return (
    latest.evidence_json ?? latest.error ?? "gate run failed without evidence"
  );
}

function buildMrDescription(
  task: Task,
  envelope: ImplementerCompletionV2,
): string {
  const commands = envelope.commands
    .map((c) => `- \`${c.cmd}\` -> exit ${c.exit_code}`)
    .join("\n");
  return [
    envelope.summary,
    "",
    `Colony task: ${task.id}`,
    commands ? `Evidence:\n${commands}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function verifyEnvelopeFacts(
  ctx: ColonydContext,
  project: ProviderProjectRef,
  envelope: ImplementerCompletionV2,
  expectedBranch: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await ctx.provider.commits.get(project, envelope.head_sha);
  } catch {
    return { ok: false, reason: `commit ${envelope.head_sha} not found` };
  }
  if (envelope.branch !== expectedBranch) {
    return {
      ok: false,
      reason: `envelope branch ${envelope.branch} != expected ${expectedBranch}`,
    };
  }
  let branchHead: string;
  try {
    branchHead = (await ctx.provider.commits.get(project, envelope.branch)).sha;
  } catch {
    return { ok: false, reason: `branch ${envelope.branch} not found` };
  }
  if (branchHead !== envelope.head_sha) {
    return {
      ok: false,
      reason: `branch head ${branchHead} != envelope head_sha ${envelope.head_sha}`,
    };
  }
  return { ok: true };
}
