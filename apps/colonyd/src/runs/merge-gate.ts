import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildIsolatedCommandEnv,
  VALIDATE_ENV_ALLOWLIST,
} from "@colony/sandbox";
import type { Scope, Store, Task } from "@colony/core";
import { retryBackoffMs } from "@colony/core";
import { context } from "@opentelemetry/api";
import type { ProviderMergeRequest, ProviderRepoRef } from "@colony/provider";
import { startColonyRunSpan, type ColonyRunSpan } from "@colony/observability";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";
import {
  getCurrentMrTask,
  hasActiveRepositoryMergeGate,
} from "./mr-admission.js";
import {
  buildMergeProvenanceLine,
  collectRunModelIds,
} from "./model-provenance.js";

const GATE_LEASE_MS = 30 * 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;
const MAX_CONSECUTIVE_GATE_FAILURES = 3;
const MAX_CONSECUTIVE_MERGE_REFUSALS = 3;

const NEVER_ABORTED = new AbortController().signal;
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
export interface GateExecutionInput {
  readonly workspace: string;
  readonly cloneUrl: string;
  readonly displayUrl: string;
  readonly targetBranch: string;
  readonly taskBranch: string;
  readonly headSha: string;
  readonly signal?: AbortSignal;
}

export interface GateCommandResult {
  readonly cmd: string;
  readonly exit_code: number;
  readonly tail: readonly string[];
}

export interface GateFailure {
  readonly reason:
    | "merge_conflict"
    | "secret_scan"
    | "command_failed"
    | "workspace_failed"
    | "no_gate_config";
  /**
   * Static, operator-safe explanation for configuration failures. Never
   * include parser errors or the configuration contents here.
   */
  readonly detail?: string;
  readonly files?: readonly string[];
  readonly commands?: readonly GateCommandResult[];
}

/**
 * Deterministic prospective-merge check. Test seam: colonyd accepts an
 * injected `gateExecutor`; the real implementation lives in
 * `defaultGateExecutor`.
 *
 * On success the executor reports the incoming diff's file list (`null`
 * also remains a valid success for injected executors). It cannot be
 * recomputed later: after the prospective `--no-ff` merge,
 * `git diff target...headSha` is empty because headSha became an ancestor.
 */
export type GateExecutor = (
  input: GateExecutionInput,
) => Promise<GateFailure | GateSuccess | null>;

/** Files in the incoming diff (target...head), captured pre-merge. */
export interface GateSuccess {
  readonly files_changed: readonly string[];
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("operation was aborted");
    error.name = "AbortError";
    throw error;
  }
}

function isGateFailure(
  result: GateFailure | GateSuccess,
): result is GateFailure {
  return "reason" in result;
}

interface GateOutcome {
  readonly kind:
    | "gate_failed"
    | "head_moved"
    | "merge_refused"
    | "merge_accepted";
  readonly evidence: Record<string, unknown>;
}

/**
 * Run the prospective merge gate for a task in `mr_open` at head SHA `H`.
 * Gates are serialized by provider repository, across all scopes.
 */
export async function runMergeGate(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  headSha: string,
): Promise<void> {
  const admitted = getCurrentMrTask(ctx, scope, task);
  if (
    !admitted ||
    hasActiveRepositoryMergeGate(ctx, scope) ||
    (scope.approvals === "manual" && admitted.merge_approved_sha !== headSha)
  ) {
    return;
  }
  const repo: ProviderRepoRef = {
    id: scope.provider_repo_id,
    path: scope.provider_repo_path,
  };
  // The span must exist first so its trace id can ride on the run row:
  // mint the run id before either exists and hand it to both, so the span's
  // colony.run_id equals the store row id.
  const runId = crypto.randomUUID();
  const runSpan = startColonyRunSpan({
    scope_id: scope.id,
    task_id: task.id,
    run_id: runId,
    kind: "merge_gate",
    model_id: null,
  });
  ctx.store.startRun({
    id: runId,
    scope_id: scope.id,
    task_id: task.id,
    kind: "merge_gate",
    lease_ttl_ms: GATE_LEASE_MS,
    base_sha: headSha,
    trace_id: runSpan?.traceId ?? null,
  });
  ctx.store.audit(SERVICE_ACTOR, "run.start", {
    scope_id: scope.id,
    task_id: task.id,
    run_id: runId,
    detail: { kind: "merge_gate", head_sha: headSha },
  });

  const abortController = new AbortController();
  const heartbeat = setInterval(() => {
    if (abortController.signal.aborted) return;
    ctx.store.heartbeatRun(runId, GATE_LEASE_MS);
  }, HEARTBEAT_INTERVAL_MS);
  const execution = executeMergeGate(
    ctx,
    repo,
    scope,
    task,
    runId,
    headSha,
    abortController.signal,
    runSpan,
  );
  trackRun(runId, execution, () => {
    abortController.abort();
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

async function executeMergeGate(
  ctx: ColonydContext,
  repo: ProviderRepoRef,
  scope: Scope,
  task: Task,
  runId: string,
  headSha: string,
  signal: AbortSignal,
  runSpan: ColonyRunSpan | undefined,
): Promise<void> {
  const workspace = join(tmpdir(), "colonyd-gate", runId);
  const repoPath = scope.provider_repo_path;
  const clone = buildCloneUrl(ctx, repoPath);
  const requireMergeAuthority = (): void => {
    // Draining stops new dispatch, not completion within the drain budget.
    const current = getCurrentMrTask(ctx, scope, task, "in_flight");
    if (
      !current ||
      (scope.approvals === "manual" && current.merge_approved_sha !== headSha)
    ) {
      const error = new Error("merge authority revoked");
      error.name = "AbortError";
      throw error;
    }
  };
  try {
    throwIfAborted(signal);
    const executor = ctx.gateExecutor ?? defaultGateExecutor;
    const result = await executor({
      workspace,
      cloneUrl: clone.cloneUrl,
      displayUrl: clone.displayUrl,
      targetBranch: scope.default_branch,
      taskBranch: task.branch ?? `colony/${task.id}`,
      headSha,
      signal,
    });
    throwIfAborted(signal);
    requireMergeAuthority();
    if (result && isGateFailure(result)) {
      const failure: GateFailure = result;
      const evidence = { ...failure, head_sha: headSha };
      ctx.store.finishRun(runId, "failed", {
        evidence_json: JSON.stringify(evidence),
      });
      runSpan?.end("failed", String(evidence.reason));
      ctx.store.audit(SERVICE_ACTOR, "gate.fail", {
        scope_id: scope.id,
        task_id: task.id,
        run_id: runId,
        detail: evidence,
      });
      requeueOrBlockAfterGateFailure(ctx, scope, task, headSha, evidence);
      return;
    }

    throwIfAborted(signal);
    // Stale-head protection: re-fetch the MR; if the head moved since the
    // gate started, fail this gate and let the next tick re-gate the new SHA.
    let mr;
    try {
      mr = await ctx.provider.mergeRequests.get(
        repo,
        mrRef(repo.id, task.mr_iid!),
      );
    } catch (err) {
      throwIfAborted(signal);
      requireMergeAuthority();
      const reason = `mr refetch failed: ${err instanceof Error ? err.message : String(err)}`;
      ctx.store.finishRun(runId, "failed", {
        error: reason,
        evidence_json: JSON.stringify({ head_sha: headSha }),
      });
      runSpan?.end("failed", reason);
      requeueOrBlockAfterGateFailure(ctx, scope, task, headSha, {
        reason: "head_moved",
        head_sha: headSha,
      });
      return;
    }
    throwIfAborted(signal);
    requireMergeAuthority();
    const currentHead = mr.head_commit_sha;
    if (currentHead && currentHead !== headSha) {
      const evidence = {
        reason: "head_moved",
        head_sha: headSha,
        observed: currentHead,
      };
      ctx.store.finishRun(runId, "failed", {
        evidence_json: JSON.stringify(evidence),
      });
      runSpan?.end("failed", "head_moved");
      ctx.store.audit(SERVICE_ACTOR, "gate.fail", {
        scope_id: scope.id,
        task_id: task.id,
        run_id: runId,
        detail: evidence,
      });
      requeueOrBlockAfterGateFailure(ctx, scope, task, headSha, evidence);
      return;
    }

    let mergeResult: ProviderMergeRequest;
    try {
      // Merge subject names the merged work; the Colony-Models provenance
      // line rides below as a proper git trailer, not as the subject.
      const provenance = buildScopeProvenance(ctx, scope, task);
      const subject = `merge: ${task.title} (${task.id}, MR !${mr.iid})`;
      mergeResult = await ctx.provider.mergeRequests.merge(repo, mr.id, {
        sha: headSha,
        merge_commit_message: provenance
          ? `${subject}\n\n${provenance}\n`
          : subject,
      });
    } catch (mergeError) {
      let observed: ProviderMergeRequest | undefined;
      try {
        observed = await ctx.provider.mergeRequests.get(repo, mr.id);
      } catch {
        // Preserve the merge error when the confirming read also fails.
      }
      if (
        observed?.state === "merged" &&
        observed.head_commit_sha === headSha
      ) {
        const evidence = {
          reason: "merge_observed_after_error",
          error:
            mergeError instanceof Error
              ? mergeError.message
              : String(mergeError),
          head_sha: headSha,
        };
        ctx.store.finishRun(runId, "succeeded", {
          head_sha: headSha,
          evidence_json: JSON.stringify(evidence),
        });
        runSpan?.end("succeeded");
        ctx.store.audit(SERVICE_ACTOR, "gate.pass", {
          scope_id: scope.id,
          task_id: task.id,
          run_id: runId,
          detail: evidence,
        });
        return;
      }
      throw mergeError;
    }
    if (mergeResult.merged === false) {
      throwIfAborted(signal);
      const reason = `merge_refused:${mergeResult.reason ?? "unknown"}`;
      const evidence = {
        reason,
        head_sha: headSha,
      };
      ctx.store.finishRun(runId, "failed", {
        evidence_json: JSON.stringify(evidence),
      });
      runSpan?.end("failed", reason);
      ctx.store.audit(SERVICE_ACTOR, "gate.fail", {
        scope_id: scope.id,
        task_id: task.id,
        run_id: runId,
        detail: evidence,
      });
      if (isTransientMergeRefusal(mergeResult.reason)) {
        // GitLab answers 405/409 while the head's pipeline is still
        // registering or running, or while its mergeability is being
        // rechecked: the code is approved and unchanged, so there is nothing
        // for an implementer to redo. Hold mr_open and let the next tick
        // re-gate the same head; the consecutive-refusal cap still blocks a
        // head that never becomes mergeable. Requeueing here spent two extra
        // implement runs on an approved MR (col-e3021988.11, 2026-09-03).
        holdForRegate(ctx, task, headSha, evidence);
        return;
      }
      requeueOrBlockAfterGateFailure(ctx, scope, task, headSha, evidence);
      return;
    }

    // The executor captured the incoming diff's file list pre-merge; after
    // the prospective merge the same three-dot diff is empty because
    // headSha became an ancestor of target, so this cannot be recomputed.
    // The list feeds the offline task-cost heuristic (no new telemetry).
    ctx.store.finishRun(runId, "succeeded", {
      head_sha: headSha,
      evidence_json: JSON.stringify({
        reason: "merge_accepted",
        head_sha: headSha,
        files_changed: result ? [...result.files_changed] : [],
      }),
    });
    runSpan?.end("succeeded");
    ctx.store.audit(SERVICE_ACTOR, "gate.pass", {
      scope_id: scope.id,
      task_id: task.id,
      run_id: runId,
      detail: { head_sha: headSha },
    });
    // The mr_open -> merged transition happens when the tick's provider poll
    // observes state='merged' — facts, not the merge API response.
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      ctx.store.finishRun(runId, "canceled", {
        error: "aborted",
        evidence_json: JSON.stringify({ head_sha: headSha }),
      });
      runSpan?.end("canceled", "aborted");
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    const evidence = {
      reason: "workspace_failed",
      error,
      head_sha: headSha,
    };
    ctx.store.finishRun(runId, "failed", {
      evidence_json: JSON.stringify(evidence),
    });
    runSpan?.end("failed", error);
    ctx.store.audit(SERVICE_ACTOR, "gate.fail", {
      scope_id: scope.id,
      task_id: task.id,
      run_id: runId,
      detail: evidence,
    });
    requeueOrBlockAfterGateFailure(ctx, scope, task, headSha, evidence);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * Three-strike handling after a gate failure: requeue with backoff and
 * attempt++, or block after MAX consecutive failures at the same head SHA
 * (gate failures) / merge refusals.
 */
/** GitLab's "not mergeable right now" answers: pipeline pending, mergeability being rechecked. */
function isTransientMergeRefusal(reason: string | undefined): boolean {
  return reason === "merge_http_405" || reason === "merge_http_409";
}

/**
 * Keep the task mr_open after a transient refusal. Only the refusal cap
 * applies: a head refused MAX_CONSECUTIVE_MERGE_REFUSALS times in a row is
 * stuck for a reason the operator must see.
 */
function holdForRegate(
  ctx: ColonydContext,
  task: Task,
  headSha: string,
  evidence: Record<string, unknown>,
): void {
  const current = ctx.store.getTask(task.id);
  if (!current || current.state !== "mr_open") return;
  const mergeRefusals = countConsecutive(ctx, task, headSha, "merge_refusal");
  if (mergeRefusals >= MAX_CONSECUTIVE_MERGE_REFUSALS) {
    ctx.store.transitionTask(
      current.id,
      current.state_version,
      "blocked",
      SERVICE_ACTOR,
      {
        blocked_reason: `merge refused ${mergeRefusals} consecutive times at ${headSha}`,
      },
    );
    return;
  }
  ctx.store.audit(SERVICE_ACTOR, "gate.regate_pending", {
    scope_id: task.scope_id,
    task_id: task.id,
    detail: { ...evidence, refusals: mergeRefusals },
  });
}

function requeueOrBlockAfterGateFailure(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  headSha: string,
  evidence: Record<string, unknown>,
): void {
  const current = ctx.store.getTask(task.id);
  if (!current || current.state !== "mr_open") return;

  const reason = typeof evidence.reason === "string" ? evidence.reason : "";
  // A missing or invalid gate is an operator/configuration defect, not an
  // implementation failure. Block immediately so the automatic implement
  // retry loop cannot churn on a repository-wide admission problem.
  if (reason === "no_gate_config") {
    const detail =
      typeof evidence.detail === "string"
        ? evidence.detail
        : "colony.gate.yaml is missing or invalid";
    ctx.store.transitionTask(
      current.id,
      current.state_version,
      "blocked",
      SERVICE_ACTOR,
      { blocked_reason: `merge gate configuration required: ${detail}` },
    );
    return;
  }

  const gateFails = countConsecutive(ctx, task, headSha, "gate");
  const mergeRefusals = reason.startsWith("merge_refused")
    ? countConsecutive(ctx, task, headSha, "merge_refusal")
    : 0;

  if (gateFails >= MAX_CONSECUTIVE_GATE_FAILURES) {
    ctx.store.transitionTask(
      current.id,
      current.state_version,
      "blocked",
      SERVICE_ACTOR,
      {
        blocked_reason: `gate failed ${gateFails} consecutive times at ${headSha}`,
      },
    );
    return;
  }
  if (mergeRefusals >= MAX_CONSECUTIVE_MERGE_REFUSALS) {
    ctx.store.transitionTask(
      current.id,
      current.state_version,
      "blocked",
      SERVICE_ACTOR,
      {
        blocked_reason: `merge refused ${mergeRefusals} consecutive times at ${headSha}`,
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

/**
 * Count consecutive failed merge_gate runs for this task at `headSha`.
 * Kind `gate` counts every failure; `merge_refusal` counts only refusals.
 * A succeeded gate at the same SHA resets the streak.
 */
function countConsecutive(
  ctx: ColonydContext,
  task: Task,
  headSha: string,
  kind: "gate" | "merge_refusal",
): number {
  const runs = ctx.store
    .runsForTask(task.id)
    .filter((r) => r.kind === "merge_gate");
  let count = 0;
  for (const run of [...runs].reverse()) {
    const evidence = run.evidence_json
      ? (JSON.parse(run.evidence_json) as Record<string, unknown>)
      : {};
    if (evidence.head_sha !== headSha) break;
    if (run.status === "succeeded") break;
    if (run.status !== "failed") break;
    const reason = typeof evidence.reason === "string" ? evidence.reason : "";
    if (kind === "merge_refusal" && !reason.startsWith("merge_refused")) break;
    count += 1;
  }
  return count;
}

function mrRef(repoId: string, mrIid: number): string {
  return `${repoId}:${mrIid}`;
}

/**
 * Aggregate role-qualified model provenance for a scope/task merge commit
 * message. Deterministic non-model gates (merge_gate, validate) are
 * excluded; architect runs are scope-level, implement/review are task-level.
 */
function buildScopeProvenance(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
): string {
  const listEvents = (runId: string) =>
    ctx.store.listRunEventsByName(runId, "pi_model_fallback");
  const architect = collectRunModelIds(
    ctx.store.runsForScope(scope.id).filter((r) => r.kind === "architect"),
    listEvents,
  );
  const implement = collectRunModelIds(
    ctx.store.runsForTask(task.id).filter((r) => r.kind === "implement"),
    listEvents,
  );
  const review = collectRunModelIds(
    ctx.store.runsForTask(task.id).filter((r) => r.kind === "review"),
    listEvents,
  );
  return buildMergeProvenanceLine(architect, implement, review);
}

export function buildCloneUrl(
  ctx: ColonydContext,
  repoPath: string,
): { cloneUrl: string; displayUrl: string } {
  const base = ctx.env.gitlabBaseUrl.replace(/\/+$/, "");
  const path = repoPath.replace(/^\/+/, "").replace(/\/+$/, "");
  const suffix = path.endsWith(".git") ? "" : ".git";
  const url = new URL(`${base}/${path}${suffix}`);
  const display = new URL(url.href);
  if (
    ctx.env.gitlabToken &&
    (url.protocol === "https:" || url.protocol === "http:")
  ) {
    url.username = "oauth2";
    url.password = ctx.env.gitlabToken;
  }
  display.username = "";
  display.password = "";
  return { cloneUrl: url.href, displayUrl: display.href };
}

// ---------------------------------------------------------------------------
// Real gate executor: clone, prospective merge, secret scan, gate commands.
// ---------------------------------------------------------------------------

export const defaultGateExecutor: GateExecutor = async (input) => {
  await git(
    [
      "clone",
      "--quiet",
      "--branch",
      input.targetBranch,
      input.cloneUrl,
      input.workspace,
    ],
    tmpdir(),
    input,
  );
  await git(
    ["fetch", "--quiet", "origin", input.taskBranch],
    input.workspace,
    input,
  );

  // Scan the incoming diff BEFORE the prospective merge. After merging
  // headSha into target, `git diff target...headSha` is empty because
  // headSha is an ancestor of target — that previously let secrets merge.
  // The same list is the gate's success payload: post-merge it is empty.
  const changedFiles = await changedDiffFiles(input);
  const scan = await secretScan(input, changedFiles);
  if (scan) return scan;

  try {
    await git(
      ["merge", "--no-ff", "--no-edit", input.headSha],
      input.workspace,
      input,
    );
  } catch (err) {
    throwIfAborted(input.signal ?? NEVER_ABORTED);
    const conflicts = await conflictedFiles(input.workspace, input);
    if (conflicts.length === 0) throw err;
    return { reason: "merge_conflict", files: conflicts };
  }

  const gateConfig = readGateConfig(input.workspace);
  if ("reason" in gateConfig) return gateConfig;

  const scratchDir = await mkdtemp(join(tmpdir(), "colonyd-gate-env-"));
  try {
    const commandEnv = buildIsolatedCommandEnv(
      VALIDATE_ENV_ALLOWLIST,
      scratchDir,
      process.env,
      { CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" },
    );
    const results: GateCommandResult[] = [];
    for (const cmd of gateConfig.commands) {
      const { exitCode, tail } = await runGateCommand(
        input.workspace,
        cmd,
        gateConfig.timeoutSeconds,
        commandEnv,
        input.signal,
      );
      results.push({ cmd, exit_code: exitCode, tail });
      if (exitCode !== 0) {
        return { reason: "command_failed", commands: results };
      }
    }
    return { files_changed: changedFiles };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
};

interface GateConfig {
  readonly commands: readonly string[];
  readonly timeoutSeconds: number;
}

type GateConfigResult = GateConfig | GateFailure;

function readGateConfig(workspace: string): GateConfigResult {
  const configPath = join(workspace, "colony.gate.yaml");
  if (!existsSync(configPath)) {
    return {
      reason: "no_gate_config",
      detail: "colony.gate.yaml is missing",
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, "utf8"));
  } catch {
    // Do not expose parser diagnostics: YAML errors can echo a secret value
    // from the repository configuration.
    return {
      reason: "no_gate_config",
      detail: "colony.gate.yaml is malformed YAML",
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      reason: "no_gate_config",
      detail: "colony.gate.yaml must contain a mapping",
    };
  }

  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) {
    return {
      reason: "no_gate_config",
      detail: "commands must be a non-empty array",
    };
  }
  if (
    !raw.commands.every(
      (command): command is string =>
        typeof command === "string" && command.trim().length > 0,
    )
  ) {
    return {
      reason: "no_gate_config",
      detail: "commands must contain only non-blank strings",
    };
  }

  let timeoutSeconds = DEFAULT_COMMAND_TIMEOUT_SECONDS;
  if ("timeout_seconds" in raw) {
    const timeout = raw.timeout_seconds;
    if (
      typeof timeout !== "number" ||
      !Number.isFinite(timeout) ||
      timeout <= 0
    ) {
      return {
        reason: "no_gate_config",
        detail: "timeout_seconds must be a positive finite number",
      };
    }
    timeoutSeconds = timeout;
  }
  return {
    commands: raw.commands,
    timeoutSeconds,
  };
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const PROCESS_KILL_GRACE_MS = 1_000;

function runProcess(
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<ProcessResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ProcessResult>();
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let outputLimit = false;
  let settled = false;
  let timedOut = false;
  let terminationRequested = false;
  let timer: ReturnType<typeof setTimeout>;
  let killTimer: ReturnType<typeof setTimeout>;
  const finish = (result: ProcessResult): void => {
    if (settled) return;
    if (terminationRequested) sendSignal("SIGKILL");
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abort);
    resolve(result);
  };
  const sendSignal = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  };
  const kill = (): void => {
    terminationRequested = true;
    if (!child.killed) sendSignal("SIGTERM");
    if (!killTimer) {
      killTimer = setTimeout(() => {
        if (!settled) sendSignal("SIGKILL");
      }, PROCESS_KILL_GRACE_MS);
    }
  };
  const abort = (): void => {
    kill();
  };
  const collect =
    (target: Buffer[]): ((chunk: Buffer) => void) =>
    (chunk: Buffer): void => {
      if (outputLimit) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputLimit = true;
        kill();
        return;
      }
      target.push(chunk);
    };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abort);
    reject(error);
  });
  child.once("close", (code) => {
    finish({
      exitCode: outputLimit || timedOut ? 1 : (code ?? 1),
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
  });
  timer = setTimeout(
    () => {
      timedOut = true;
      kill();
    },
    Math.min(options.timeoutMs, 2_147_483_647),
  );
  if (options.signal?.aborted) {
    abort();
  } else {
    options.signal?.addEventListener("abort", abort, { once: true });
  }
  return promise;
}

async function conflictedFiles(
  workspace: string,
  input: GateExecutionInput,
): Promise<string[]> {
  try {
    const out = await git(
      ["diff", "--name-only", "--diff-filter=U"],
      workspace,
      input,
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const SECRET_PATTERNS = [
  /glpat-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /PRIVATE-TOKEN/,
];

/** Incoming-diff file list (target...head), split/trimmed like secretScan. */
async function changedDiffFiles(input: GateExecutionInput): Promise<string[]> {
  return (
    await git(
      ["diff", `${input.targetBranch}...${input.headSha}`, "--name-only"],
      input.workspace,
      input,
    )
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function secretScan(
  input: GateExecutionInput,
  changed: readonly string[],
): Promise<GateFailure | null> {
  for (const file of changed) {
    const name = file.split("/").pop() ?? file;
    if (name === "PACKET.json" || name === ".env") {
      return { reason: "secret_scan", files: [file] };
    }
  }

  const patch = await git(
    ["diff", `${input.targetBranch}...${input.headSha}`],
    input.workspace,
    input,
  );
  const addedLines = patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  for (const line of addedLines) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        return { reason: "secret_scan", files: changed };
      }
    }
  }
  return null;
}

async function runGateCommand(
  cwd: string,
  cmd: string,
  timeoutSeconds: number,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ exitCode: number; tail: readonly string[] }> {
  const result = await runProcess("bash", ["-c", cmd], {
    cwd,
    timeoutMs: timeoutSeconds * 1000,
    signal,
    env,
  });
  throwIfAborted(signal ?? NEVER_ABORTED);
  const output =
    result.exitCode === 0
      ? result.stdout
      : [result.stderr, result.stdout].filter(Boolean).join("\n");
  return { exitCode: result.exitCode, tail: lastLines(output, 200) };
}

function lastLines(text: string, max: number): string[] {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - max));
}

async function git(
  args: readonly string[],
  cwd: string,
  input: GateExecutionInput,
): Promise<string> {
  throwIfAborted(input.signal ?? NEVER_ABORTED);
  const result = await runProcess("git", args, {
    cwd,
    timeoutMs: 300_000,
    signal: input.signal,
    // Prospective --no-ff merge creates a commit; CI images often have no
    // git identity, which git otherwise reports as a merge failure.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env["GIT_AUTHOR_NAME"] || "colony-gate",
      GIT_AUTHOR_EMAIL: process.env["GIT_AUTHOR_EMAIL"] || "colony-gate@local",
      GIT_COMMITTER_NAME: process.env["GIT_COMMITTER_NAME"] || "colony-gate",
      GIT_COMMITTER_EMAIL:
        process.env["GIT_COMMITTER_EMAIL"] || "colony-gate@local",
    },
  });
  throwIfAborted(input.signal ?? NEVER_ABORTED);
  if (result.exitCode !== 0) {
    const output =
      result.stderr || result.stdout || `git exited ${result.exitCode}`;
    throw new Error(sanitizeGitError(output, input));
  }
  return result.stdout;
}

function sanitizeGitError(message: string, input: GateExecutionInput): string {
  const token = extractPassword(input.cloneUrl);
  if (!token) return message;
  return message
    .replaceAll(token, "[redacted]")
    .replaceAll(encodeURIComponent(token), "[redacted]");
}

function extractPassword(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.password || undefined;
  } catch {
    return undefined;
  }
}
