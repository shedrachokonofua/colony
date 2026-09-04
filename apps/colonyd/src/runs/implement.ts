import {
  type ImplementerCompletionV2,
  ImplementerCompletionV2 as implementerCompletionV2Schema,
} from "@colony/schemas";
import type { Scope, Task } from "@colony/core";
import { context } from "@opentelemetry/api";
import type { ProviderRepoRef } from "@colony/provider";
import { startColonyRunSpan, type ColonyRunSpan } from "@colony/observability";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import {
  buildImplementPacket,
  type ImplementHistoricalEvidence,
  type ImplementExecutionContext,
} from "./packets.js";
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
  readonly startModelId?: string;
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
  const modelId = options.startModelId ?? developer.model.id;
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
    model_id: modelId,
  });
  const run = ctx.store.startRun({
    id: runId,
    scope_id: scope.id,
    task_id: task.id,
    kind: "implement",
    lease_ttl_ms: leaseTtlMs,
    model_id: modelId,
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
    options.startModelId,
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
  startModelId: string | undefined,
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
    const branch = task.branch ?? `colony/${task.id}`;
    const interrupted = interruptedAttempt(ctx, task, runId);
    const executionContext = await buildImplementExecutionContext(
      ctx,
      repo,
      task,
      scope.default_branch,
      branch,
      baseSha,
      interrupted !== undefined,
    );
    const currentHead =
      executionContext.remote_head.status === "known"
        ? executionContext.remote_head.value
        : undefined;
    const reviewRepair = latestReviewRepair(
      ctx,
      task,
      currentHead,
      executionContext.mode === "repair",
    );
    const gate = latestGateFailure(ctx, task, currentHead);
    const historicalEvidence = [
      ...(interrupted ? [interrupted.evidence] : []),
      ...reviewRepair.historical,
      ...gate.historical,
    ];
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
        executionContext,
        historicalEvidence,
        operatorFeedback: task.human_feedback ?? undefined,
        currentGateFailure: gate.active,
        currentReviewFindings: reviewRepair.active?.findings,
        currentRejectedHeadSha: reviewRepair.rejectedHeadSha,
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
        startModelId,
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

    if (
      reviewRepair.rejectedHeadSha &&
      envelope.head_sha === reviewRepair.rejectedHeadSha
    ) {
      const reason = "repair_no_change";
      ctx.store.finishRun(runId, "failed", {
        error: reason,
        envelope_json: JSON.stringify(envelope),
      });
      runSpan?.end("failed", reason);
      ctx.store.audit(SERVICE_ACTOR, "run.failed", {
        scope_id: scope.id,
        task_id: task.id,
        run_id: runId,
        detail: {
          reason,
          rejected_head_sha: reviewRepair.rejectedHeadSha,
        },
      });
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
      } catch (err) {
        if (
          typeof err !== "object" ||
          err === null ||
          !("status" in err) ||
          (typeof err.status !== "number" && typeof err.status !== "string") ||
          Number(err.status) !== 404
        ) {
          throw new Error(
            `existing MR lookup failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        // A confirmed 404 means the stored MR reference is stale.
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

    if (mrIid === undefined && envelope.head_sha === baseSha) {
      // The branch carries no commits beyond the default branch: the task
      // was already satisfied on main (an operator or a sibling landed it
      // first). GitLab reports an empty MR as unmergeable and the conflict
      // path would requeue it forever (col-7064acc1.5, 2026-09-03: two
      // implement runs in 15 s over a zero-diff MR). Nothing to merge.
      ctx.store.finishRun(runId, "succeeded", {
        head_sha: envelope.head_sha,
        envelope_json: JSON.stringify(envelope),
        evidence_json: JSON.stringify({ commands: envelope.commands }),
      });
      runSpan?.end("succeeded");
      ctx.store.audit(SERVICE_ACTOR, "mr.skipped_noop", {
        scope_id: scope.id,
        task_id: task.id,
        run_id: runId,
        detail: { head_sha: envelope.head_sha, base_sha: baseSha },
      });
      const current = ctx.store.getTask(task.id)!;
      ctx.store.transitionTask(
        current.id,
        current.state_version,
        "merged",
        SERVICE_ACTOR,
        { branch: envelope.branch },
      );
      return;
    }

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
async function buildImplementExecutionContext(
  ctx: ColonydContext,
  repo: ProviderRepoRef,
  task: Task,
  targetBranch: string,
  branch: string,
  targetHeadSha: string,
  hasInterruptedAttempt: boolean,
): Promise<ImplementExecutionContext> {
  const repair =
    hasInterruptedAttempt || task.branch !== null || task.mr_iid !== null;
  if (!repair) {
    return {
      mode: "fresh",
      branch,
      target_branch: targetBranch,
      target_head_sha: targetHeadSha,
      remote_head: { status: "not_requested" },
      pipeline: { status: "not_requested" },
      current_objective:
        "Implement the durable task requirements on the new task branch.",
    };
  }

  let remoteHead: ImplementExecutionContext["remote_head"];
  try {
    remoteHead = {
      status: "known",
      value: (await ctx.provider.commits.get(repo, branch)).sha,
    };
  } catch (err) {
    remoteHead = {
      status: "unknown",
      reason: `remote task-branch lookup failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  let pipeline: ImplementExecutionContext["pipeline"];
  if (remoteHead.status !== "known") {
    pipeline = {
      status: "unknown",
      reason: "remote task-branch HEAD is unknown",
    };
  } else {
    try {
      const current = await ctx.provider.pipelines.getStatus(
        repo,
        remoteHead.value,
      );
      if (!current.status || current.status === "unknown") {
        pipeline = {
          status: "unknown",
          reason: "provider returned no current pipeline outcome",
        };
      } else {
        pipeline = {
          status: "known",
          value: {
            status: current.status,
            ...(current.commit_sha ? { commit_sha: current.commit_sha } : {}),
          },
        };
      }
    } catch (err) {
      pipeline = {
        status: "unknown",
        reason: `pipeline lookup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
  return {
    mode: "repair",
    branch,
    target_branch: targetBranch,
    target_head_sha: targetHeadSha,
    remote_head: remoteHead,
    pipeline,
    current_objective:
      task.mr_iid === null
        ? "Resume the existing task branch from its remote HEAD; preserve completed work and make only incremental changes required by the durable requirements."
        : `Repair or land the existing MR !${task.mr_iid} from the current remote task-branch HEAD; preserve completed work, do not start over or open a new MR, and make only incremental changes required by verified current evidence.`,
  };
}

interface ReviewRepair {
  active?: { findings: string; rejectedHeadSha: string };
  /** The latest rejection that has not been superseded by a later approval. */
  rejectedHeadSha?: string;
  historical: ImplementHistoricalEvidence[];
}

function interruptedAttempt(
  ctx: ColonydContext,
  task: Task,
  excludeRunId: string,
): { evidence: ImplementHistoricalEvidence } | undefined {
  const runs = ctx.store
    .runsForTask(task.id)
    .filter((run) => run.kind === "implement" && run.id !== excludeRunId);
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
  return {
    evidence: {
      kind: "interrupted",
      at: last.finished_at ?? last.started_at,
      ...((last.head_sha ?? last.base_sha)
        ? { head_sha: last.head_sha ?? last.base_sha! }
        : {}),
      text: [
        `The previous attempt was cut off${ran} (${last.error}) without submitting an envelope.`,
        "It may already have pushed part of this task. BEFORE writing anything:",
        "- Inspect the remote task branch and its diff against packet.repo.base_commit to see what already landed.",
        "- Continue from that state; never restart work that is already pushed.",
        "Then write the remaining change, push it early, and submit.",
      ].join("\n"),
    },
  };
}

function latestReviewRepair(
  ctx: ColonydContext,
  task: Task,
  currentHead: string | undefined,
  repairMode: boolean,
): ReviewRepair {
  const historical: ImplementHistoricalEvidence[] = [];
  let currentResolved = false;
  let historicalAdded = false;
  const uncertainRepairHead = repairMode && currentHead === undefined;
  const runs = ctx.store
    .runsForTask(task.id)
    .filter((r) => r.kind === "review" && r.status === "succeeded");
  for (const run of [...runs].reverse()) {
    if (!run.evidence_json) continue;
    let evidence: {
      verdict?: string;
      head_sha?: string;
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
    if (
      evidence.verdict !== "request_changes" &&
      evidence.verdict !== "approve"
    ) {
      continue;
    }
    const headSha =
      evidence.head_sha ?? run.head_sha ?? run.base_sha ?? undefined;
    if (!headSha) continue;
    const findings = evidence.findings ?? [];
    const text =
      evidence.verdict === "approve"
        ? "Reviewer approved this head."
        : findings.length === 0
          ? run.evidence_json
          : findings
              .map((f) => {
                const loc = f.file ? " `" + f.file + "`" : "";
                return `- **${f.severity ?? "note"}**${loc}: ${f.note ?? ""}`;
              })
              .join("\n");

    // If the current branch head is unavailable, the newest review still
    // determines whether a rejection remains unsuperseded. Keep that guard
    // separate from current-review classification: the packet must not claim
    // this SHA is the current head merely because the lookup was uncertain.
    if (uncertainRepairHead && !currentResolved) {
      currentResolved = true;
      if (evidence.verdict === "request_changes") {
        historical.push({
          kind: "review",
          at: run.finished_at ?? run.started_at,
          head_sha: headSha,
          text,
        });
        return { rejectedHeadSha: headSha, historical };
      }
      return { historical };
    }

    if (
      currentHead !== undefined &&
      headSha === currentHead &&
      !currentResolved
    ) {
      currentResolved = true;
      if (evidence.verdict === "request_changes") {
        return {
          active: { findings: text, rejectedHeadSha: headSha },
          rejectedHeadSha: headSha,
          historical,
        };
      }
      return { historical };
    }
    if (!historicalAdded && evidence.verdict === "request_changes") {
      historicalAdded = true;
      historical.push({
        kind: "review",
        at: run.finished_at ?? run.started_at,
        head_sha: headSha,
        text,
      });
    }
  }
  return { historical };
}

interface GateRepair {
  active?: string;
  historical: ImplementHistoricalEvidence[];
}

function latestGateFailure(
  ctx: ColonydContext,
  task: Task,
  currentHead: string | undefined,
): GateRepair {
  let currentResolved = false;
  let historicalAdded = false;
  const historical: ImplementHistoricalEvidence[] = [];
  const runs = ctx.store
    .runsForTask(task.id)
    .filter((r) => r.kind === "merge_gate");
  for (const run of [...runs].reverse()) {
    let evidence: Record<string, unknown> = {};
    if (run.evidence_json) {
      try {
        evidence = JSON.parse(run.evidence_json) as Record<string, unknown>;
      } catch {
        // The run/base identity still scopes the terminal outcome.
      }
    }
    const headSha =
      typeof evidence.head_sha === "string"
        ? evidence.head_sha
        : (run.head_sha ?? run.base_sha ?? undefined);
    if (!headSha) continue;
    if (run.status === "succeeded") {
      if (
        currentHead !== undefined &&
        headSha === currentHead &&
        !currentResolved
      ) {
        currentResolved = true;
        continue;
      }
      continue;
    }
    if (run.status !== "failed") continue;
    const text =
      run.evidence_json ?? run.error ?? "gate run failed without evidence";
    if (
      currentHead !== undefined &&
      headSha === currentHead &&
      !currentResolved
    ) {
      currentResolved = true;
      return { active: text, historical };
    }
    if (!historicalAdded) {
      historicalAdded = true;
      historical.push({
        kind: "gate",
        at: run.finished_at ?? run.started_at,
        head_sha: headSha,
        text,
      });
    }
  }
  return { historical };
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
