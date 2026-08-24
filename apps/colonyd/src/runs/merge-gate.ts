import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Scope, Store, Task } from "@colony/core";
import { retryBackoffMs } from "@colony/core";
import { context } from "@opentelemetry/api";
import type { ProviderMergeRequest, ProviderRepoRef } from "@colony/provider";
import { startColonyRunSpan, type ColonyRunSpan } from "@colony/observability";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
import { trackRun } from "./registry.js";

const GATE_LEASE_MS = 30 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;
const MAX_CONSECUTIVE_GATE_FAILURES = 3;
const MAX_CONSECUTIVE_MERGE_REFUSALS = 3;

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
  readonly files?: readonly string[];
  readonly commands?: readonly GateCommandResult[];
}

/**
 * Deterministic prospective-merge check. Test seam: colonyd accepts an
 * injected `gateExecutor`; the real implementation lives in
 * `defaultGateExecutor`.
 */
export type GateExecutor = (
  input: GateExecutionInput,
) => Promise<GateFailure | null>;

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
 * Concurrency: the tick only dispatches a gate when none is active for the
 * scope, so two tasks in one scope never interleave merges.
 */
export async function runMergeGate(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  headSha: string,
): Promise<void> {
  const repo: ProviderRepoRef = {
    id: scope.provider_repo_id,
    path: scope.provider_repo_path,
  };
  // The span must exist first so its trace id can ride on the run row.
  const runId = crypto.randomUUID();
  const runSpan = startColonyRunSpan({
    scope_id: scope.id,
    task_id: task.id,
    run_id: runId,
    kind: "merge_gate",
    model_id: null,
  });
  const run = ctx.store.startRun({
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

  const execution = executeMergeGate(
    ctx,
    repo,
    scope,
    task,
    runId,
    headSha,
    runSpan,
  );
  trackRun(runId, execution, () => Promise.resolve());
  try {
    await execution;
  } finally {
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
  runSpan: ColonyRunSpan | undefined,
): Promise<void> {
  const workspace = join(tmpdir(), "colonyd-gate", runId);
  const repoPath = scope.provider_repo_path;
  const clone = buildCloneUrl(ctx, repoPath);
  try {
    const executor = ctx.gateExecutor ?? defaultGateExecutor;
    const failure = await executor({
      workspace,
      cloneUrl: clone.cloneUrl,
      displayUrl: clone.displayUrl,
      targetBranch: scope.default_branch,
      taskBranch: task.branch ?? `colony/${task.id}`,
      headSha,
    });

    if (failure) {
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

    // Stale-head protection: re-fetch the MR; if the head moved since the
    // gate started, fail this gate and let the next tick re-gate the new SHA.
    let mr;
    try {
      mr = await ctx.provider.mergeRequests.get(
        repo,
        mrRef(repo.id, task.mr_iid!),
      );
    } catch (err) {
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
      mergeResult = await ctx.provider.mergeRequests.merge(repo, mr.id, {
        sha: headSha,
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
      requeueOrBlockAfterGateFailure(ctx, scope, task, headSha, evidence);
      return;
    }

    ctx.store.finishRun(runId, "succeeded", {
      head_sha: headSha,
      evidence_json: JSON.stringify({
        reason: "merge_accepted",
        head_sha: headSha,
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
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Three-strike handling after a gate failure: requeue with backoff and
 * attempt++, or block after MAX consecutive failures at the same head SHA
 * (gate failures) / merge refusals.
 */
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
  const gitArgs: string[][] = [
    [
      "clone",
      "--quiet",
      "--branch",
      input.targetBranch,
      input.cloneUrl,
      input.workspace,
    ],
  ];
  for (const args of gitArgs) {
    git(args, tmpdir(), input);
  }
  git(["fetch", "--quiet", "origin", input.taskBranch], input.workspace, input);

  // Scan the incoming diff BEFORE the prospective merge. After merging
  // headSha into target, `git diff target...headSha` is empty because
  // headSha is an ancestor of target — that previously let secrets merge.
  const scan = secretScan(input);
  if (scan) return scan;

  try {
    git(
      ["merge", "--no-ff", "--no-edit", input.headSha],
      input.workspace,
      input,
    );
  } catch (err) {
    const conflicts = conflictedFiles(input.workspace);
    if (conflicts.length === 0) throw err;
    return { reason: "merge_conflict", files: conflicts };
  }

  const gateConfig = readGateConfig(input.workspace);
  if (!gateConfig) return null; // missing colony.gate.yaml -> no commands, audit handled by caller
  if (gateConfig.commands.length === 0) return null;

  const results: GateCommandResult[] = [];
  for (const cmd of gateConfig.commands) {
    const { exitCode, tail } = runGateCommand(
      input.workspace,
      cmd,
      gateConfig.timeoutSeconds,
    );
    results.push({ cmd, exit_code: exitCode, tail });
    if (exitCode !== 0) {
      return { reason: "command_failed", commands: results };
    }
  }
  return null;
};

function conflictedFiles(workspace: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      {
        cwd: workspace,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
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

function secretScan(input: GateExecutionInput): GateFailure | null {
  const changed = git(
    ["diff", `${input.targetBranch}...${input.headSha}`, "--name-only"],
    input.workspace,
    input,
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const file of changed) {
    const name = file.split("/").pop() ?? file;
    if (name === "PACKET.json" || name === ".env") {
      return { reason: "secret_scan", files: [file] };
    }
  }

  const patch = git(
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

interface GateConfig {
  readonly commands: readonly string[];
  readonly timeoutSeconds: number;
}

function readGateConfig(workspace: string): GateConfig | null {
  const configPath = join(workspace, "colony.gate.yaml");
  if (!existsSync(configPath)) return null;
  const raw = parseYaml(readFileSync(configPath, "utf8")) as {
    commands?: unknown;
    timeout_seconds?: unknown;
  };
  const commands = Array.isArray(raw?.commands)
    ? raw.commands.filter((c): c is string => typeof c === "string")
    : [];
  const timeoutSeconds =
    typeof raw?.timeout_seconds === "number" && raw.timeout_seconds > 0
      ? raw.timeout_seconds
      : DEFAULT_COMMAND_TIMEOUT_SECONDS;
  return { commands, timeoutSeconds };
}

function runGateCommand(
  cwd: string,
  cmd: string,
  timeoutSeconds: number,
): { exitCode: number; tail: readonly string[] } {
  try {
    const output = execFileSync("bash", ["-lc", cmd], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutSeconds * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, tail: lastLines(output, 200) };
  } catch (err) {
    const output =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : err instanceof Error
          ? err.message
          : String(err);
    const code =
      err &&
      typeof err === "object" &&
      "status" in err &&
      typeof (err as { status: unknown }).status === "number"
        ? ((err as { status: number }).status as number)
        : 1;
    return { exitCode: code, tail: lastLines(output, 200) };
  }
}

function lastLines(text: string, max: number): string[] {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - max));
}

function git(
  args: readonly string[],
  cwd: string,
  input: GateExecutionInput,
): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
      // Prospective --no-ff merge creates a commit; CI images often have no
      // git identity, which git otherwise reports as a merge failure.
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: process.env["GIT_AUTHOR_NAME"] || "colony-gate",
        GIT_AUTHOR_EMAIL:
          process.env["GIT_AUTHOR_EMAIL"] || "colony-gate@local",
        GIT_COMMITTER_NAME: process.env["GIT_COMMITTER_NAME"] || "colony-gate",
        GIT_COMMITTER_EMAIL:
          process.env["GIT_COMMITTER_EMAIL"] || "colony-gate@local",
      },
    });
  } catch (err) {
    const message = sanitizeGitError(
      err instanceof Error ? err.message : String(err),
      input,
    );
    throw new Error(message);
  }
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
