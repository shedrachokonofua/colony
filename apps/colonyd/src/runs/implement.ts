import {
  type ImplementerCompletionV2,
  ImplementerCompletionV2 as implementerCompletionV2Schema,
} from "@colony/schemas";
import type { Scope, Store, Task } from "@colony/core";
import { context } from "@opentelemetry/api";
import type { ProviderRepoRef } from "@colony/provider";
import { startColonyRunSpan, type ColonyRunSpan } from "@colony/observability";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import { buildImplementPacket, type ImplementContinuity } from "./packets.js";
import { mintRunToken, revokeRunToken, type MintedToken } from "./tokens.js";
import {
  amendBranchWithTrailer,
  buildMergeProvenanceLine,
  collectRunModelIds,
  formatColonyModelsTrailer,
} from "./model-provenance.js";
import { buildCloneUrl } from "./merge-gate.js";

const HEARTBEAT_INTERVAL_MS = 60_000;
/** Run errors that mean "killed before it could submit", not "did the wrong thing". */
const INTERRUPTED_RUN_ERROR =
  /timeout_without_envelope|process_restart|operation was aborted/i;

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
  const repo: ProviderRepoRef = {
    id: scope.provider_repo_id,
    path: scope.provider_repo_path,
  };
  const developer = ctx.config.forAgent("developer");
  const leaseTtlMs =
    options.leaseTtlMs ?? developer.ceilings.timeoutMs + 5 * 60_000;

  // The span must exist first so its trace id can ride on the run row:
  // mint the run id before either exists and hand it to both, so the span's
  // colony.run_id equals the store row id.
  const runId = crypto.randomUUID();
  const runSpan = startColonyRunSpan({
    scope_id: scope.id,
    task_id: task.id,
    run_id: runId,
    kind: "implement",
    model_id: developer.model.id,
  });
  const run = ctx.store.startRun({
    id: runId,
    scope_id: scope.id,
    task_id: task.id,
    kind: "implement",
    lease_ttl_ms: leaseTtlMs,
    model_id: developer.model.id,
    trace_id: runSpan?.traceId ?? null,
  });
  ctx.store.audit(SERVICE_ACTOR, "run.start", {
    scope_id: scope.id,
    task_id: task.id,
    run_id: runId,
  });

  const abortController = new AbortController();
  const heartbeat = setInterval(() => {
    if (abortController.signal.aborted) return;
    ctx.store.heartbeatRun(runId, leaseTtlMs);
  }, HEARTBEAT_INTERVAL_MS);

  const execution = executeImplement(
    ctx,
    repo,
    scope,
    task,
    runId,
    leaseTtlMs,
    abortController,
    runSpan,
  );
  trackRun(runId, execution, () => {
    abortController.abort();
    return ctx.agents.developer.cancelRun(runId).then(() => undefined);
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

async function executeImplement(
  ctx: ColonydContext,
  repo: ProviderRepoRef,
  scope: Scope,
  task: Task,
  runId: string,
  leaseTtlMs: number,
  abortController: AbortController,
  runSpan: ColonyRunSpan | undefined,
): Promise<void> {
  let minted: MintedToken | null = null;
  try {
    minted = await mintRunToken(ctx.provider, repo, {
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
        mode: ctx.env.singleToken ? "single_token" : "repo_token",
        token_id: minted?.token_id ?? null,
      },
    });

    const baseSha = (await ctx.provider.commits.get(repo, scope.default_branch))
      .sha;
    const branch = `colony/${task.id}`;
    const project = scope.project_name
      ? (ctx.store.getProject(scope.project_name) ?? null)
      : null;
    const files = scope.project_name
      ? ctx.store.listProjectFiles(scope.project_name)
      : [];
    const { repo: repoWithCredentials, ...packet } = buildImplementPacket(
      task,
      scope,
      project,
      files,
      repo,
      branch,
      baseSha,
      {
        interrupted: interruptedAttempt(ctx, task),
        gateFailure: latestGateFailure(ctx, task),
        reviewFindings: latestReviewFindings(ctx, task),
      },
    );
    const full = {
      ...packet,
      repo: {
        ...repoWithCredentials,
        credentials: minted ? { token: minted.token } : undefined,
      },
    };

    const metadata = await inRunSpanContext(runSpan, () =>
      ctx.agents.developer.startRun(full, {
        role: "developer",
        runId,
        traceContext: runSpan?.spanContext,
      }),
    );
    if (abortController.signal.aborted) {
      ctx.store.finishRun(runId, "canceled", { error: "aborted" });
      runSpan?.end("canceled", "aborted");
      return;
    }

    if (metadata.status !== "succeeded") {
      const reason = metadata.rejectionReason ?? metadata.status;
      ctx.store.finishRun(runId, "failed", {
        error: reason,
      });
      runSpan?.end("failed", reason);
      ctx.store.audit(SERVICE_ACTOR, "run.failed", {
        scope_id: scope.id,
        task_id: task.id,
        run_id: runId,
        detail: { reason },
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
      runSpan?.end("failed", "envelope invalid");
      return;
    }
    const envelope = parsed.data;

    if (envelope.status === "blocked") {
      ctx.store.finishRun(runId, "succeeded", {
        envelope_json: JSON.stringify(envelope),
      });
      runSpan?.end("succeeded");
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

    // A completion without a single executed command is not evidence of
    // work — reject it before it can reach an MR or the gate.
    if (envelope.commands.length === 0) {
      ctx.store.finishRun(runId, "failed", {
        error: "envelope has no command evidence",
        envelope_json: JSON.stringify(envelope),
      });
      runSpan?.end("failed", "envelope has no command evidence");
      return;
    }

    // Verify envelope facts against the provider before any transition.
    const verified = await verifyEnvelopeFacts(ctx, repo, envelope, branch);
    if (!verified.ok) {
      const reason = `envelope facts unverified: ${verified.reason}`;
      ctx.store.finishRun(runId, "failed", {
        error: reason,
        envelope_json: JSON.stringify(envelope),
      });
      runSpan?.end("failed", reason);
      return;
    }

    // Requeue paths must never open duplicate MRs: reuse the task's open MR
    // when one still exists for this branch.
    let mrIid: number | undefined;
    let mrReused = false;
    if (task.mr_iid !== null) {
      try {
        const existing = await ctx.provider.mergeRequests.get(
          repo,
          `${scope.provider_repo_id}:${task.mr_iid}`,
        );
        if (existing.state === "opened") {
          mrIid = task.mr_iid;
          mrReused = true;
        }
      } catch {
        // Stale MR reference — open a fresh one below.
      }
    }
    // Model provenance: the implement runs that contributed to this branch
    // (incl. fallback destinations) ride as a Colony-Models trailer on every
    // branch commit and in the MR description.
    const modelIds = collectRunModelIds(
      ctx.store.runsForTask(task.id).filter((r) => r.kind === "implement"),
      (runId: string) =>
        ctx.store.listRunEventsByName(runId, "pi_model_fallback"),
    );
    const archIds = collectRunModelIds(
      ctx.store.runsForScope(scope.id).filter((r) => r.kind === "architect"),
      (runId: string) =>
        ctx.store.listRunEventsByName(runId, "pi_model_fallback"),
    );

    if (mrIid === undefined) {
      const mr = await ctx.provider.mergeRequests.open(repo, {
        source_branch: envelope.branch,
        target_branch: scope.default_branch,
        title: task.title,
        description: buildMrDescription(
          task,
          envelope,
          buildMergeProvenanceLine(archIds, modelIds, []),
        ),
      });
      if (mr.iid === undefined) {
        ctx.store.finishRun(runId, "failed", {
          error: "merge request opened without iid",
          envelope_json: JSON.stringify(envelope),
        });
        runSpan?.end("failed", "merge request opened without iid");
        return;
      }
      mrIid = mr.iid;
    }

    // Provenance: normalize the branch commits with a Colony-Models
    // trailer before the MR is reviewed, so reviewer evidence binds to
    // the canonical head. Best-effort — failure never fails the run.
    let finalHeadSha = envelope.head_sha;
    try {
      const trailer = formatColonyModelsTrailer(modelIds);
      if (trailer) {
        const clone = buildCloneUrl(ctx, scope.provider_repo_path);
        const amended = amendBranchWithTrailer({
          cloneUrl: clone.cloneUrl,
          branch: envelope.branch,
          defaultBranch: scope.default_branch,
          expectedHeadSha: envelope.head_sha,
          trailer,
        });
        finalHeadSha = amended;
        ctx.store.audit(SERVICE_ACTOR, "provenance.amended", {
          scope_id: scope.id,
          task_id: task.id,
          run_id: runId,
          detail: { old_head: envelope.head_sha, new_head: amended },
        });
      }
    } catch (amendErr) {
      ctx.store.audit(SERVICE_ACTOR, "provenance.amend_failed", {
        scope_id: scope.id,
        task_id: task.id,
        run_id: runId,
        detail: { head: envelope.head_sha, error: String(amendErr) },
      });
    }

    ctx.store.finishRun(runId, "succeeded", {
      head_sha: finalHeadSha,
      envelope_json: JSON.stringify(envelope),
      evidence_json: JSON.stringify({ commands: envelope.commands }),
    });
    runSpan?.end("succeeded");
    ctx.store.audit(SERVICE_ACTOR, mrReused ? "mr.reused" : "mr.opened", {
      scope_id: scope.id,
      task_id: task.id,
      run_id: runId,
      detail: { mr_iid: mrIid, head_sha: finalHeadSha },
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
    const reason = err instanceof Error ? err.message : String(err);
    ctx.store.finishRun(runId, "failed", {
      error: reason,
    });
    runSpan?.end("failed", reason);
    ctx.store.audit(SERVICE_ACTOR, "run.failed", {
      scope_id: scope.id,
      task_id: task.id,
      run_id: runId,
      detail: { reason },
    });
  } finally {
    if (minted) {
      try {
        await revokeRunToken(ctx.provider, repo, minted);
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

/**
 * Continuity for a retry after an interrupted attempt. A run killed by the
 * wall clock or a colonyd restart leaves no envelope, so the next attempt used
 * to start blank and re-explore from scratch — sometimes re-deriving work its
 * predecessor had already pushed. Tell it what happened and where to look.
 */
function interruptedAttempt(
  ctx: ColonydContext,
  task: Task,
): string | undefined {
  const runs = ctx.store
    .runsForTask(task.id)
    .filter((run) => run.kind === "implement");
  const last = runs.at(-1);
  if (!last || last.status !== "failed" || !last.error) return undefined;
  if (!INTERRUPTED_RUN_ERROR.test(last.error)) return undefined;
  const minutes =
    last.finished_at && last.started_at
      ? Math.round(
          (Date.parse(last.finished_at) - Date.parse(last.started_at)) / 60_000,
        )
      : undefined;
  const ran = minutes === undefined ? "" : ` after ${minutes} minutes`;
  return [
    `The previous attempt was cut off${ran} (${last.error}) without submitting an envelope.`,
    "It may already have pushed part of this task. BEFORE writing anything:",
    "- `git log --oneline origin/<branch> -5` and `git diff origin/<base_commit>...origin/<branch>` (branch and base_commit are in packet.repo) to see what already landed.",
    "- Continue from that state; never restart work that is already pushed.",
    "Then write the remaining change, push it early, and submit.",
  ].join("\n");
}

function latestReviewFindings(
  ctx: ColonydContext,
  task: Task,
): string | undefined {
  const runs = ctx.store
    .runsForTask(task.id)
    .filter((r) => r.kind === "review" && r.status === "succeeded");
  for (const run of [...runs].reverse()) {
    if (!run.evidence_json) continue;
    let evidence: {
      verdict?: string;
      findings?: ReadonlyArray<{
        severity?: string;
        file?: string;
        note?: string;
      }>;
    };
    try {
      evidence = JSON.parse(run.evidence_json) as typeof evidence;
    } catch {
      continue;
    }
    if (evidence.verdict !== "request_changes") continue;
    const findings = evidence.findings ?? [];
    if (findings.length === 0) {
      return run.evidence_json;
    }
    return findings
      .map((f) => {
        const loc = f.file ? " `" + f.file + "`" : "";
        return (
          "- **" + (f.severity ?? "note") + "**" + loc + ": " + (f.note ?? "")
        );
      })
      .join("\n");
  }
  return undefined;
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
  provenanceLine?: string,
): string {
  const commands = envelope.commands
    .map((c) => `- \`${c.cmd}\` -> exit ${c.exit_code}`)
    .join("\n");
  return [
    envelope.summary,
    "",
    `Colony task: ${task.id}`,
    commands ? `Evidence:\n${commands}` : "",
    provenanceLine ? `\n${provenanceLine}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function verifyEnvelopeFacts(
  ctx: ColonydContext,
  repo: ProviderRepoRef,
  envelope: ImplementerCompletionV2,
  expectedBranch: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await ctx.provider.commits.get(repo, envelope.head_sha);
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
    branchHead = (await ctx.provider.commits.get(repo, envelope.branch)).sha;
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
