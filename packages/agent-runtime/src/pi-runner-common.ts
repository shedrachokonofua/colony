import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { COLONY_SKILLS, playbookPrompt } from "./colony-skills.js";
import type { Agent, AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { Static } from "@oh-my-pi/omptype/typebox";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import {
  type ArchitectDecompositionV2,
  type ImplementerCompletionV2,
  type TaskCostModelV1,
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
  ImplementerCompletionV2 as implementerCompletionV2Schema,
  ReviewerVerdictV2 as reviewerVerdictV2Schema,
} from "@colony/schemas";
import type { z } from "zod";
import { validateDecompositionEnvelope } from "./envelope-validation.js";
import type { AgentRunEnvironment, AgentRuntimePacket } from "./adapter.js";
import type { CredentialBroker } from "./credential-broker.js";
import { permissiveCredentialBroker } from "./credential-broker.js";
import type { RunAuditSink } from "./audit-sink.js";
import type { PiRunRequest } from "./pi-adapter.js";
import type { SandboxEngine } from "@colony/sandbox";
import type { WebToolsConfig } from "./web-tools.js";
import { RunEvidenceCollector, toolResultText } from "./run-evidence.js";
import { redactValue } from "./redact.js";

export interface PiRunnerLogger {
  info?(fields: Record<string, unknown>, message: string): void;
  warn?(fields: Record<string, unknown>, message: string): void;
  error?(fields: Record<string, unknown>, message: string): void;
}

/**
 * A model as Colony's config describes it. The SDK's `Model` carries a resolved
 * provider-compatibility policy that only its registry can produce, so runners
 * register specs and then resolve the real `Model` back out of the registry.
 */
export interface PiModelSpec {
  readonly id: string;
  readonly name: string;
  readonly api: Api;
  readonly provider: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: ReadonlyArray<"text" | "image">;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly headers?: Record<string, string>;
}

export interface PiRunnerBaseOptions {
  readonly broker?: CredentialBroker;
  readonly logger?: PiRunnerLogger;
  readonly model?: PiModelSpec | PiModelResolver;
  readonly webTools?: WebToolsConfig;
  readonly fallbackModels?: readonly PiModelSpec[];
  readonly thinkingLevel?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";
  readonly maxTurns?: number;
  readonly runTimeoutMs?: number;
  /** Zero-output recovery backoff base. Tests shrink it; production defaults to 15s. */
  readonly jiggleBackoffMs?: number;
  /** Pi SDK retries per failed request. Tests isolate runner failover with zero SDK retries. */
  readonly retryMaxRetries?: number;
  readonly scratchDir?: string;
  readonly engine?: SandboxEngine;
  /**
   * Does this model have a free dispatch slot right now? Injected by colonyd
   * from the same store/config the dispatcher's slot picker reads, so
   * runtime failover and dispatch agree on capacity. Absent: every
   * candidate is assumed free (fake/test wiring).
   */
  readonly modelHasCapacity?: (modelId: string) => boolean;
  /** Durable session root; when set, runs persist session JSONL under it. */
  readonly sessionsDir?: string;
  /** Reports the sandbox id as soon as the sandbox is created (runs-table write-back). */
  readonly onSandboxId?: (runId: string, sandboxId: string) => void;
  /** Audit sink for run events and the artifact ledger; noop when unset. */
  readonly auditSink?: RunAuditSink;
}

export type PiModelResolver = (
  request: PiRunRequest,
) => Promise<PiModelSpec> | PiModelSpec;
export interface PiRunGuardOptions extends PiRunnerBaseOptions {
  readonly onFailure?: (reason: string) => void;
  /**
   * How the guard stops the run. MUST be a deliberate abort - the session's
   * `abort()`, which sets the SDK's abort-in-progress latch. A bare
   * `agent.abort()` carries no reason, and the SDK's turn recovery classes
   * a reason-less abort as a dropped provider stream and RETRIES the turn:
   * a child session that hit its turn guard spun 1700+ turns in a test and,
   * live, pinned its parent reviewer 30 minutes past the wall (2026-09-01).
   */
  readonly abort: () => void;
  /** Exact secrets to remove from active-operation details before logging. */
  readonly redactSecrets?: readonly string[];
  /** Evidence collector fed by the guard subscription; noop when unset. */
  readonly evidence?: RunEvidenceCollector;
  /**
   * Submit tool whose failed calls emit `completion_rejected`. Undefined on
   * guard install sites without an evidence collector (subagents, critics).
   */
  readonly rejectionToolName?: string;
  /**
   * Fired when the model returns `zeroOutputStallTurns` consecutive
   * assistant messages with zero output tokens and no tool activity - a
   * provider that rate-limits by going silent instead of erroring (observed
   * live: ox-alpha's free upstream). Flag-only: the guard never aborts; an
   * empty turn resolves the prompt naturally and the caller owns the
   * wake/backoff/failover decision.
   */
  readonly onZeroOutputStall?: () => void;
  /**
   * Fired on EVERY assistant `message_end` with the turn's terminal state,
   * so the runner can distinguish "this model answered" from "this model's
   * transport died". Flag-only for the same reason as {@link onZeroOutputStall}:
   * the guard reports, the runner owns the retry/failover decision.
   */
  readonly onAssistantMessage?: (message: {
    readonly stopReason: string;
    readonly errorMessage: string | undefined;
    readonly outputTokens: number;
  }) => void;
  readonly zeroOutputStallTurns?: number;
  /**
   * Max silence between agent events before the run is declared dead.
   * Liveness is judged from observed progress (message deltas, turn/tool
   * boundaries), the way Temporal's heartbeat_timeout polices activities:
   * a run that emits nothing for this long is hung in some remote await
   * (LLM fetch, exec socket) that its own cancellation path failed to bound.
   * Tool executions are exempt while in flight until TOOL_WEDGE_TIMEOUT_MS;
   * each exec carries its own engine-enforced deadline, and a missing end
   * event is treated as a dead transport once that cap expires.
   */
  readonly livenessTimeoutMs?: number;
  /** In-flight tool wedge cap override; tests shrink it. Default {@link TOOL_WEDGE_TIMEOUT_MS}. */
  readonly toolWedgeTimeoutMs?: number;
}

export interface ActivePiRun {
  readonly abort: () => Promise<void> | void;
}

export const DEFAULT_PI_RUN_TIMEOUT_MS = 15 * 60_000;

export function runnerBroker(options: PiRunnerBaseOptions): CredentialBroker {
  if (options.broker) return options.broker;
  if (process.env.NODE_ENV === "test") return permissiveCredentialBroker;
  throw new Error(
    "Pi runner requires an explicit credential broker outside test mode",
  );
}

export async function resolvePiModel(
  request: PiRunRequest,
  model: PiRunnerBaseOptions["model"],
): Promise<PiModelSpec> {
  if (typeof model === "function") {
    return model(request);
  }
  if (model) return model;
  throw new Error(
    `No Pi model configured for the ${request.environment.role} agent; configure the ${request.environment.role} model in Colony config`,
  );
}

/**
 * Per-run scratch directory at `${tmpdir}/colony-pi-runs/<runId>/`.
 * Created fresh and seeded with a `PACKET.json` for the agent to read.
 * Returned path is the agent's cwd — the agent should stay inside it.
 *
 * Without this, Pi's coding tools default cwd to the surrounding Node
 * process cwd (the Colony repo), and the model can also pass absolute
 * paths to grep/find/bash — observed in practice as `rg /Users/shdrch`
 * which deadlocks the run for many minutes.
 */
export function provisionScratchDir(
  runId: string,
  packet: AgentRuntimePacket,
  override?: string,
): string {
  // An override is a caller-owned ROOT, not the run dir itself: the run dir
  // is its `<runId>` subdirectory. Teardown removes only the run dir, so a
  // caller that shares one override across runs (the daemon's validate
  // workspace, tracing harnesses) keeps its root.
  const dir = override
    ? join(override, runId)
    : join(tmpdir(), "colony-pi-runs", runId);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(
      join(dir, "PACKET.json"),
      JSON.stringify(packet, null, 2),
      "utf8",
    );
  } catch {
    // best-effort seed; the agent can still operate without the file
  }
  seedPlaybooks(dir);
  materializeProjectFiles(dir, packet);
  return dir;
}

/**
 * Write the Colony playbooks into the workspace at `.colony/skills/` and
 * git-exclude both the playbooks and PACKET.json. The daemon builds the
 * workspace and the engine ships it to the sandbox pod verbatim, so the
 * files are readable in-pod at the same relative path. Best-effort: a run
 * without playbooks still has the prompt-level senses.
 */
function seedPlaybooks(dir: string): void {
  try {
    const skillsDir = join(dir, ".colony", "skills");
    mkdirSync(skillsDir, { recursive: true });
    for (const skill of COLONY_SKILLS) {
      writeFileSync(join(skillsDir, skill.file), skill.content, "utf8");
    }
    const excludePath = join(dir, ".git", "info", "exclude");
    if (existsSync(join(dir, ".git"))) {
      mkdirSync(dirname(excludePath), { recursive: true });
      const existing = existsSync(excludePath)
        ? readFileSync(excludePath, "utf8")
        : "";
      // PACKET.json carries the provider token and the transcript captures
      // tool results that can contain it (PACKET.json reads, `git remote -v`),
      // so both are excluded: they live in the worktree for the whole run,
      // which is exactly when the agent commits. Anchored patterns only —
      // unanchored ones would shadow same-named directories the repo tracks.
      const wanted = [
        "PACKET.json",
        ".colony/",
        ".colony/project/",
        "/sessions/",
      ].filter((line) => !existing.split("\n").includes(line));
      if (wanted.length > 0) {
        writeFileSync(
          excludePath,
          `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${wanted.join("\n")}\n`,
          "utf8",
        );
      }
    }
  } catch {
    // best-effort; never fail provisioning over playbooks
  }
}

const RESERVED_PREFIXES = ["packet.json", ".colony", ".git", ".env"];

/**
 * Materialize project reference files into `.colony/project/` from the
 * packet manifest. Best-effort — a materialization failure never fails
 * provisioning. Files are written read-only (0o444); stale files from a
 * reused run dir are removed first. Invalid or dangerous filenames are
 * silently skipped: they never clobber PACKET.json, .git/** , or
 * .colony/skills/** .
 */
export function materializeProjectFiles(
  dir: string,
  packet: AgentRuntimePacket,
): void {
  try {
    const projectDir = join(dir, ".colony", "project");
    // Drop stale files from a reused run dir FIRST — a reused dir
    // must never carry stale content even when this packet carries
    // no manifest.
    rmSync(projectDir, { recursive: true, force: true });

    const rawProject = (packet as Record<string, unknown>)["project"];
    if (
      !rawProject ||
      typeof rawProject !== "object" ||
      !("files" in (rawProject as Record<string, unknown>))
    ) {
      return;
    }
    const files = (rawProject as Record<string, unknown>)["files"];
    if (!Array.isArray(files) || files.length === 0) return;

    mkdirSync(projectDir, { recursive: true });

    const projectDirResolved = resolve(projectDir);
    // Sort by filename defensively.
    const sorted = [...files].sort((a: unknown, b: unknown) => {
      const fa =
        typeof a === "object" && a !== null
          ? String((a as Record<string, unknown>)["filename"] ?? "")
          : "";
      const fb =
        typeof b === "object" && b !== null
          ? String((b as Record<string, unknown>)["filename"] ?? "")
          : "";
      return fa.localeCompare(fb);
    });

    for (const entry of sorted) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const filename = String(record["filename"] ?? "");
      // Path safety checks — skip dangerous filenames.
      if (
        !filename ||
        filename === "." ||
        filename === ".." ||
        filename.includes("/") ||
        filename.includes("\\") ||
        filename.includes("\u0000")
      ) {
        continue;
      }
      const lower = filename.toLowerCase();
      if (RESERVED_PREFIXES.includes(lower)) continue;
      // Check traversal — resolved path must stay inside projectDir.
      const target = join(projectDir, filename);
      const targetResolved = resolve(target);
      if (!targetResolved.startsWith(projectDirResolved + sep)) {
        continue;
      }
      const content =
        typeof record["content"] === "string" ? record["content"] : "";
      writeFileSync(target, content, { mode: 0o444, encoding: "utf8" });
    }
  } catch {
    // best-effort; never fail provisioning over file materialization
  }
}

export interface PacketRepoRef {
  readonly url: string;
  readonly branch: string;
  readonly base_commit: string;
  readonly credentials?: { readonly token: string };
}

export interface RepoWorkspaceOptions extends PiRunnerBaseOptions {
  readonly requireCredentials?: boolean;
}

export function provisionRepoWorkspace(
  runId: string,
  packet: AgentRuntimePacket,
  options: RepoWorkspaceOptions,
): string {
  if (options.scratchDir) {
    return provisionScratchDir(runId, packet, options.scratchDir);
  }

  const repo = packetRepo(packet);
  if (!repo || (options.requireCredentials && !repo.credentials?.token)) {
    if (options.requireCredentials) {
      throw new Error("workspace_provision_failed:missing_credentials");
    }
    return provisionScratchDir(runId, packet);
  }

  const clone = resolvePacketCloneUrl(repo.url, repo.credentials?.token);
  const dir = join(tmpdir(), "colony-pi-runs", runId);
  let lastFailure:
    | {
        readonly stage: "clone" | "checkout" | "packet_seed";
        readonly error: unknown;
      }
    | undefined;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    try {
      git(
        ["clone", "--quiet", "--no-single-branch", clone.cloneUrl, dir],
        dirname(dir),
      );
    } catch (err) {
      lastFailure = { stage: "clone", error: err };
      if (attempt < 4) sleepSync(1500);
      continue;
    }

    try {
      try {
        git(["checkout", "--quiet", repo.branch], dir);
      } catch (err) {
        if (!isBranchNotFoundError(err)) throw err;
        git(["checkout", "--quiet", "-B", repo.branch, repo.base_commit], dir);
      }
    } catch (err) {
      lastFailure = { stage: "checkout", error: err };
      if (attempt < 4) sleepSync(1500);
      continue;
    }

    try {
      writeFileSync(join(dir, "PACKET.json"), JSON.stringify(packet, null, 2), {
        encoding: "utf8",
      });
      seedPlaybooks(dir);
      materializeProjectFiles(dir, packet);
      return dir;
    } catch (err) {
      lastFailure = { stage: "packet_seed", error: err };
      if (attempt < 4) sleepSync(1500);
    }
  }

  const failure = lastFailure ?? {
    stage: "clone" as const,
    error: new Error("git did not report a failure"),
  };
  const reason = formatWorkspaceProvisionFailure(
    failure.stage,
    failure.error,
    clone.secret,
  );
  options.logger?.warn?.(
    {
      runId,
      repoUrl: clone.displayUrl,
      branch: repo.branch,
      baseCommit: repo.base_commit,
      attempts: 4,
      error: gitFailureDetail(failure.error, clone.secret),
    },
    "agent_workspace_clone_failed",
  );
  rmSync(dir, { recursive: true, force: true });
  throw new Error(reason);
}

function formatWorkspaceProvisionFailure(
  stage: "clone" | "checkout" | "packet_seed",
  error: unknown,
  secret: string | undefined,
): string {
  const label =
    stage === "clone"
      ? "clone_failed"
      : stage === "checkout"
        ? "checkout_failed"
        : "packet_seed_failed";
  return `workspace_provision_failed:${label}:${gitFailureDetail(error, secret)}`;
}

function gitFailureDetail(error: unknown, secret: string | undefined): string {
  const candidate =
    error && typeof error === "object"
      ? (error as {
          readonly status?: unknown;
          readonly stderr?: unknown;
        })
      : {};
  const status =
    typeof candidate.status === "number" || typeof candidate.status === "string"
      ? String(candidate.status)
      : undefined;
  const stderr =
    typeof candidate.stderr === "string"
      ? candidate.stderr
      : candidate.stderr instanceof Buffer
        ? candidate.stderr.toString("utf8")
        : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const rawDetail = (stderr?.trim() || message.trim()).replace(/\s+/g, " ");
  const safeDetail = sanitizeSecret(rawDetail, secret).trim();
  const shortDetail =
    safeDetail.length > 240 ? `${safeDetail.slice(0, 240)}…` : safeDetail;
  return status && !shortDetail.includes(status)
    ? `exit_status=${status}:${shortDetail}`
    : shortDetail || (status ? `exit_status=${status}` : "unknown");
}

function isBranchNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const stderr = "stderr" in error ? error.stderr : undefined;
  const message =
    (typeof stderr === "string"
      ? stderr
      : stderr instanceof Buffer
        ? stderr.toString("utf8")
        : "") +
    " " +
    (error instanceof Error ? error.message : "");
  return /pathspec .* did not match/i.test(message);
}

export function packetRepo(packet: AgentRuntimePacket): PacketRepoRef | null {
  const candidate = packet as {
    repo?: {
      url?: unknown;
      branch?: unknown;
      base_commit?: unknown;
      credentials?: { token?: unknown };
    };
  };
  if (
    typeof candidate.repo?.url === "string" &&
    typeof candidate.repo.branch === "string" &&
    typeof candidate.repo.base_commit === "string"
  ) {
    return {
      url: candidate.repo.url,
      branch: candidate.repo.branch,
      base_commit: candidate.repo.base_commit,
      credentials:
        typeof candidate.repo.credentials?.token === "string"
          ? { token: candidate.repo.credentials.token }
          : undefined,
    };
  }
  return null;
}

export function resolvePacketCloneUrl(
  repoUrl: string,
  token: string | undefined,
): {
  readonly cloneUrl: string;
  readonly displayUrl: string;
  readonly secret?: string;
} {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repoUrl)) {
    const url = new URL(repoUrl);
    if (token && (url.protocol === "https:" || url.protocol === "http:")) {
      url.username = "oauth2";
      url.password = token;
    }
    const display = new URL(url.href);
    display.username = "";
    display.password = "";
    return {
      cloneUrl: url.href,
      displayUrl: display.href,
      secret: (token ?? url.password) || undefined,
    };
  }

  if (repoUrl.startsWith("git@")) {
    return { cloneUrl: repoUrl, displayUrl: repoUrl };
  }

  // Absolute filesystem paths are valid local clone sources. Do not reinterpret
  // them as GitLab repo paths merely because the daemon has a base URL.
  if (isAbsolute(repoUrl)) {
    return { cloneUrl: repoUrl, displayUrl: repoUrl };
  }

  const baseUrl = process.env["GITLAB_BASE_URL"];
  if (!baseUrl) {
    return { cloneUrl: repoUrl, displayUrl: repoUrl };
  }

  const path = repoUrl.replace(/^\/+/, "").replace(/\/+$/, "");
  const suffix = path.endsWith(".git") ? "" : ".git";
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${path}${suffix}`);
  if (token && (url.protocol === "https:" || url.protocol === "http:")) {
    url.username = "oauth2";
    url.password = token;
  }

  const display = new URL(url.href);
  display.username = "";
  display.password = "";
  return {
    cloneUrl: url.href,
    displayUrl: url.href,
    secret: (token ?? url.password) || undefined,
  };
}

export function sanitizeSecret(
  value: string,
  secret: string | undefined,
): string {
  if (!secret) return value;
  return value
    .replaceAll(secret, "[redacted]")
    .replaceAll(encodeURIComponent(secret), "[redacted]");
}

export function createSandboxId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Silence budget before a run with no tool in flight is declared hung. */
export const DEFAULT_LIVENESS_TIMEOUT_MS = 12 * 60_000;

/**
 * Maximum wall clock for a tool execution that has not produced its end event.
 * The engine-side exec deadline is 900s; no legitimate exec outlives that, so
 * a 20-minute in-flight "tool" is a dead transport rather than a long command.
 */
export const TOOL_WEDGE_TIMEOUT_MS = 20 * 60_000;

export const LIVENESS_FAILURE_REASON = "liveness_watchdog_no_progress";
export const TOOL_WEDGE_FAILURE_REASON = "liveness_watchdog_tool_wedge";

export const WORKSPACE_LOST_REASON = "workspace_lost";

export interface WorkspaceProbeHandle {
  exec(
    request: { command: string; timeoutMs?: number },
    onEvent: (event: unknown) => void,
  ): Promise<{ exitCode: number | null }>;
}

export interface WorkspaceProbeOptions {
  readonly intervalMs?: number;
  readonly logger?: PiRunnerLogger;
  readonly runId: string;
  readonly sandboxId: string;
  /** Fired once, after two consecutive completed probes report the markers gone. */
  readonly onLost: () => void;
}

/** Mutable probe state; one instance per installed probe. */
export interface WorkspaceProbeState {
  misses: number;
  fired: boolean;
}

/**
 * One probe step: exec the marker check and update state. Only a COMPLETED
 * exec is evidence - a nonzero exit means the markers are gone; a thrown or
 * timed-out exec means the check could not run and proves nothing
 * (2026-08-31: a probe transport bug miscounted as loss killed every run at
 * minute four). cwd is intentionally omitted: ExecRequest cwd is
 * workspace-relative and defaults to the workspace root, where both markers
 * live. Returns true when this step declared the workspace lost.
 */
export async function workspaceProbeStep(
  handle: WorkspaceProbeHandle,
  state: WorkspaceProbeState,
  options: WorkspaceProbeOptions,
): Promise<boolean> {
  if (state.fired) return false;
  try {
    const res = await handle.exec(
      { command: "test -e .git || test -e PACKET.json", timeoutMs: 10_000 },
      () => {},
    );
    if (res.exitCode === 0) {
      state.misses = 0;
      return false;
    }
    if (res.exitCode === null) return false; // timed out: not evidence
    state.misses += 1;
  } catch (err) {
    options.logger?.warn?.(
      {
        runId: options.runId,
        sandboxId: options.sandboxId,
        error: err instanceof Error ? err.message : String(err),
      },
      "workspace_probe_error",
    );
    // A gone pod makes exec THROW (the exec WebSocket fails), and thrown
    // probes used to count as nothing: three runs generated against
    // reaped sandboxes for 26+ minutes with 13 consecutive probe errors
    // each (2026-09-01). One throw is a blip; a streak is a dead pod.
    state.misses += 1;
    if (state.misses < 3) return false;
    state.fired = true;
    options.logger?.warn?.(
      { runId: options.runId, sandboxId: options.sandboxId },
      WORKSPACE_LOST_REASON,
    );
    options.onLost();
    return true;
  }
  if (state.misses < 2) return false;
  state.fired = true;
  options.logger?.warn?.(
    { runId: options.runId, sandboxId: options.sandboxId },
    WORKSPACE_LOST_REASON,
  );
  options.onLost();
  return true;
}

/**
 * Detects sandbox storage vanishing mid-run (node reboot, container recycle):
 * repo workspaces carry .git, scratch workspaces carry PACKET.json. Thin
 * scheduling shell over {@link workspaceProbeStep}, which owns every
 * decision and is tested without timers.
 */
export function installWorkspaceProbe(
  handle: WorkspaceProbeHandle,
  options: WorkspaceProbeOptions,
): () => void {
  const state: WorkspaceProbeState = { misses: 0, fired: false };
  const timer = setInterval(() => {
    void workspaceProbeStep(handle, state, options).then((lost) => {
      if (lost) clearInterval(timer);
    });
  }, options.intervalMs ?? 120_000);
  return () => clearInterval(timer);
}
export function installRunGuards(
  agent: Agent,
  runId: string,
  options: PiRunGuardOptions,
): () => void {
  let turns = 0;
  let usdSpent = 0;
  let previousMessageAt = performance.now();
  const maxTurns = options.maxTurns ?? 60;
  // Terminal-state latch: after the limit fires once, every later event in
  // the same agent loop would otherwise re-warn, re-fail, and re-abort —
  // colonyd's role logger mirrors each warn into `run_events`, which is how
  // one run produced dozens of identical `pi_run_limit_exceeded` rows.
  let runLimitEmitted = false;

  // Progress-based liveness (Temporal heartbeat_timeout analog): every agent
  // event is a heartbeat. Forensics on hung runs showed two client-side hang
  // seams under Bun - an LLM fetch whose abort never surfaced and an exec
  // WebSocket that died silently - each burning the whole wall clock while
  // stream-level guards saw nothing. The watchdog bounds every such seam at
  // once because it trusts only observed events, not any transport's own
  // timeout. Tool time is exempt while in flight until the wedge cap: the
  // engine deadline normally bounds it, but a lost completion event must not
  // renew this exemption forever.
  const livenessTimeoutMs =
    options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
  const toolWedgeTimeoutMs =
    options.toolWedgeTimeoutMs ?? TOOL_WEDGE_TIMEOUT_MS;
  let inFlightTools = 0;
  let toolFlightStartedAt: number | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let unsubscribed = false;
  const armWatchdog = (): void => {
    clearTimeout(watchdog);
    if (unsubscribed || livenessTimeoutMs <= 0) return;
    const now = performance.now();
    const toolInFlightMs =
      toolFlightStartedAt === undefined
        ? 0
        : Math.max(0, now - toolFlightStartedAt);
    const delay =
      inFlightTools > 0 && toolFlightStartedAt !== undefined
        ? Math.min(
            livenessTimeoutMs,
            Math.max(1, toolWedgeTimeoutMs - toolInFlightMs),
          )
        : livenessTimeoutMs;
    watchdog = setTimeout(() => {
      watchdog = undefined;
      if (inFlightTools > 0 && toolFlightStartedAt !== undefined) {
        const toolInFlightMs = Math.max(
          0,
          performance.now() - toolFlightStartedAt,
        );
        if (toolInFlightMs >= toolWedgeTimeoutMs) {
          options.logger?.warn?.(
            {
              runId,
              silenceMs: toolInFlightMs,
              reason: TOOL_WEDGE_FAILURE_REASON,
            },
            "pi_liveness_watchdog",
          );
          options.onFailure?.(TOOL_WEDGE_FAILURE_REASON);
          options.abort();
          return;
        }
        armWatchdog();
        return;
      }
      options.logger?.warn?.(
        {
          runId,
          silenceMs: livenessTimeoutMs,
          reason: LIVENESS_FAILURE_REASON,
        },
        "pi_liveness_watchdog",
      );
      options.onFailure?.(LIVENESS_FAILURE_REASON);
      options.abort();
    }, delay);
  };
  armWatchdog();

  // Zero-output stall: some providers rate-limit by returning empty
  // completions instead of errors. Nothing throws, so model fallback never
  // triggers and continuation steers retry the mute model until the wall.
  // N consecutive empty assistant messages with no tool activity = stall.
  const zeroOutputStallTurns = options.zeroOutputStallTurns ?? 3;
  function activeToolDetail(
    args: unknown,
    secrets: readonly string[] = [],
  ): string | null {
    const redacted = redactValue(args, secrets);
    if (!redacted || typeof redacted !== "object" || Array.isArray(redacted))
      return null;
    const record = redacted as Record<string, unknown>;
    const detail = record.command ?? record.path ?? record.pattern;
    if (typeof detail !== "string" || !detail.trim()) return null;
    return detail.length <= 200 ? detail : `${detail.slice(0, 199)}…`;
  }

  let zeroOutputTurns = 0;

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      if (inFlightTools === 0) toolFlightStartedAt = performance.now();
      inFlightTools += 1;
      zeroOutputTurns = 0;
      options.evidence?.toolStart(event.toolCallId, event.args, event.intent);
      options.logger?.info?.(
        {
          runId,
          tool: event.toolName,
          detail: activeToolDetail(event.args, options.redactSecrets),
          startedAt: new Date().toISOString(),
        },
        "pi_tool_start",
      );
    }
    if (event.type === "tool_execution_end") {
      inFlightTools = Math.max(0, inFlightTools - 1);
      if (inFlightTools === 0) toolFlightStartedAt = undefined;
      if (inFlightTools === 0) {
        options.logger?.info?.(
          { runId, endedAt: new Date().toISOString() },
          "pi_tool_end",
        );
      }
      // The end event is the sole carrier of the result; the collector is
      // keyed by toolCallId, so firing here (and only here) yields exactly
      // one tool_call row per call.
      const { text, isErrorText } = toolResultText(event.result);
      void options.evidence?.toolEnd({
        toolCallId: event.toolCallId,
        tool: event.toolName,
        isError: isErrorText || event.isError === true,
        endedAtMs: Date.now(),
        resultText: text,
      });
      // Rejected submission evidence: submit-tool executes that threw (the
      // schema/mechanical validators throw deliberately) and upstream argument
      // validation failures (the loop emits the TypeBox message as the end
      // event's result, never reaching afterToolCall) both surface here. The
      // end event is the one seam that carries every rejection verbatim.
      if (
        options.rejectionToolName !== undefined &&
        event.toolName === options.rejectionToolName &&
        (isErrorText || event.isError === true)
      ) {
        options.evidence?.completionRejected(text, event.toolName);
      }
    }
    armWatchdog();
    if (event.type === "turn_end") {
      turns += 1;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      const messageUsd = usage?.cost.total ?? 0;
      const messageCompletedAt = performance.now();
      usdSpent += messageUsd;
      // Extended evidence row: keeps the legacy logger row's fields plus the
      // new evidence keys, emitted through the audit sink. The logger line is
      // renamed so `pi_usage` reaches `run_events` through this path only —
      // colonyd's roleLogger mirrors every logger message into `run_events`
      // under its message string, so keeping the old name would double-emit.
      options.evidence?.usage({
        usage,
        provider: event.message.provider,
        model: event.message.model,
        stopReason: event.message.stopReason,
        errorMessage: event.message.errorMessage,
        duration: event.message.duration,
        ttft: event.message.ttft,
        turnDurationSeconds: (messageCompletedAt - previousMessageAt) / 1_000,
      });
      options.logger?.info?.(
        {
          runId,
          messageUsd,
          usdSpent,
          inputTokens: usage?.input,
          outputTokens: usage?.output,
          cacheReadTokens: usage?.cacheRead,
          turnDurationSeconds: (messageCompletedAt - previousMessageAt) / 1_000,
          cacheWriteTokens: usage?.cacheWrite,
        },
        // Was "pi_usage": that name is now owned by the sink row above.
        "pi_turn_usage",
      );
      previousMessageAt = messageCompletedAt;
      // Reported last so the guard's own accounting above is unaffected.
      options.onAssistantMessage?.({
        stopReason: event.message.stopReason,
        errorMessage: event.message.errorMessage,
        outputTokens: usage?.output ?? 0,
      });
      if ((usage?.output ?? 0) === 0) {
        zeroOutputTurns += 1;
        if (zeroOutputTurns >= zeroOutputStallTurns) {
          zeroOutputTurns = 0;
          options.logger?.warn?.(
            { runId, stallTurns: zeroOutputStallTurns },
            "pi_zero_output_stall",
          );
          // Flag only - never abort. An empty assistant turn ends naturally
          // (the prompt resolves as idle), and aborting a live session has
          // been observed to poison the replayed conversation for the next
          // model. The runner decides between wake, backoff, and failover.
          options.onZeroOutputStall?.();
        }
      } else {
        zeroOutputTurns = 0;
      }
    }
    const reason =
      turns >= maxTurns ? "max_turns_exhausted_without_envelope" : undefined;
    if (reason && !runLimitEmitted) {
      runLimitEmitted = true;
      options.logger?.warn?.(
        {
          runId,
          turns,
          usdSpent,
          reason,
        },
        "pi_run_limit_exceeded",
      );
      options.onFailure?.(reason);
      options.abort();
    }
  });
  return () => {
    unsubscribed = true;
    clearTimeout(watchdog);
    unsubscribe();
    // The collector serializes its emits; settle() appends the one
    // run_summary after pending tool_call rows and drains the chain before
    // finalization reads it.
    void options.evidence?.settle();
  };
}

export function withRunTimeout(
  runId: string,
  timeoutMs: number | undefined,
  abort: () => Promise<void> | void,
  onTimeout?: () => void,
): () => void {
  const timer = setTimeout(() => {
    onTimeout?.();
    void abort();
  }, timeoutMs ?? DEFAULT_PI_RUN_TIMEOUT_MS);
  return () => clearTimeout(timer);
}

export async function waitForIdleOrCapturedEnvelope(
  agent: Agent,
  capturedEnvelope: Promise<void>,
): Promise<void> {
  await Promise.race([agent.waitForIdle(), capturedEnvelope]);
}

export function buildImplementerSystemPrompt(): string {
  return [
    "# Role",
    "You are the Colony Implementer: an autonomous software engineer who lands exactly one task as a pushed branch. You keep going until the task is completely resolved — never end your run with the work half-done or unverified.",
    "",
    "# Environment",
    "- Your working directory is a clone of the target repository with the prepared work branch checked out (see packet.repo). The remote is preconfigured with credentials: `git push` works as-is.",
    "- Your sandbox is this directory only. Never read, write, grep, or list paths outside it; never use absolute paths like /Users, /home, /etc, or globs that escape it. Stay inside `.`.",
    "- If you are unsure about file contents or structure, read the files — never guess or invent code you have not seen.",
    "- Project reference files listed in the packet are available read-only at `.colony/project/<filename>` — read the ones relevant to the task before acting; never modify, move, or delete anything under `.colony/project/`.",
    "",
    "# Workflow",
    "1. Understand: read the task spec in packet.body, including any 'Spec amendment (operator...)' sections — those are authoritative and supersede earlier text they contradict.",
    "2. Explore: inspect the relevant files, tests, imports, and neighboring patterns. Check whether equivalent behavior already exists before creating anything new; reuse existing schemas, helpers, dependencies, and conventions.",
    "3. Plan: decide the smallest idiomatic change that satisfies the spec. For bug fixes, reproduce the failure FIRST and keep the reproduction as your finish line.",
    "4. Implement incrementally: make a focused change, then immediately verify it (typecheck, the narrowest relevant test) before moving on. Re-read files after editing them.",
    "5. Checkpoint: as soon as your change compiles, commit on the work branch and `git push origin <branch>` — BEFORE any full-suite run or other long verification. A run that is killed keeps only what you pushed; unpushed work is lost. Keep committing and pushing as you go.",
    "6. Verify like the gate will: run the full relevant checks (install if needed, typecheck, lint, tests) and record every command with its exit code.",
    "7. Self-review: read your final `git diff origin/<base>...HEAD` as if you were the reviewer — every hunk must serve the spec, and every spec requirement must appear in the diff. Cut anything that does not; add anything missing.",
    "8. Land: push the final commit on the work branch, then confirm the push (`git log origin/<branch>..HEAD` must be empty).",
    "",
    "# Discipline",
    "- The diff must contain ONLY changes the spec requires. Do what it asks, but no more: no drive-by refactors, new dependencies, generated files, public contract changes, or type suppressions unless the spec makes them necessary.",
    "- When you change a signature, pattern, or check, grep for every other call site and duplicate copy that needs the identical change. A fix applied to only some matching sites is a broken change, and reviewers reject it.",
    "- Completely implement what you start. Never leave comments describing code instead of code, TODO stubs, or placeholder implementations.",
    "- Never delete or weaken a failing test to make the suite pass: debug the implementation first; change a test only when the spec requires it or the test is demonstrably wrong — and say so in your summary.",
    "- Edit files in place. Never create parallel copies (file_v2, file_new); delete any temporary scripts you created before finishing.",
    "- Comments carry only what code cannot: why, invariants, gotchas. Never narrate what the code plainly does, never write change-log comments ('// added X') - git owns history - and never leave commented-out code. A comment that can be deleted without losing information is noise.",
    "",
    "# Design senses",
    "- When the spec requires a new function, type, or module, design DEEP: a small interface hiding a lot of behavior. The interface is everything a caller must know — signature, invariants, error modes — and fewer entry points with more leverage beat many shallow pass-throughs. The deletion test: if removing the thing would just move its complexity into N callers, it earns its place; if complexity would vanish, it was a pass-through.",
    "- Accept dependencies as parameters instead of constructing them inside; prefer returning results over mutating state. Both make the code testable through its real interface. Do not introduce an abstraction seam only one implementation will ever fill — one adapter is a hypothetical seam, two is a real one.",
    "- Design it twice: for any non-trivial new interface, sketch a second, materially different shape before writing the implementation, and keep the better one. The first idea is rarely the best, and this costs minutes.",
    "",
    "# Debugging",
    "Read the WHOLE error message and stack trace first; it often names the fix. Then, before building any theory, build a FEEDBACK LOOP: one command (a test, a script, a curl) that goes red on this exact symptom and will go green when it is fixed. 'Runs without erroring' is not a loop; it must catch THIS bug. Reading code to form theories before that command exists is the classic failure — the loop is 90% of the debugging.",
    "Tighten the loop, then shrink the reproduction until every remaining element is load-bearing — a minimal repro shrinks the suspect space and becomes the regression test. For flaky bugs, raise the reproduction rate (loop the trigger 100x, add stress, narrow timing) until it is debuggable. For performance problems, measure a baseline and bisect; logs are the wrong tool.",
    "Hypothesize like a scientist: list 3-5 ranked hypotheses BEFORE testing any (a single hypothesis anchors you), each falsifiable — 'if X is the cause, changing Y makes the loop go green'. Test the top one with the smallest possible change; never stack a second speculative fix on an unverified first. Instrument only at boundaries that distinguish hypotheses, tag every debug line with one unique prefix (e.g. [DBG-4f2a]) so a single grep removes them all, and grep for that prefix before finishing.",
    "After three failed fixes the diagnosis is wrong, not unlucky — and if each fix moves the failure somewhere new, the approach itself is wrong: reconsider the design or submit blocked with your ranked analysis. Never paper over a failure: no sleeps for race conditions, no retries around deterministic bugs, no catch-and-ignore, no weakened assertions. State the confirmed root cause in the commit message.",
    "",
    "# Test senses",
    "- Fixing a bug: write the failing test FIRST and watch it fail for the right reason (missing behavior, not a typo or import error). A test you never saw fail proves nothing. Then make it pass with the smallest change.",
    "- A test must assert behavior a caller can observe, and it must be able to fail if the implementation breaks. A test that only checks a mock was called, restates the implementation line by line, or passes with the feature deleted is worse than no test — do not write it. Before writing any test, name the production change that would make it fail.",
    "- Match the repository's existing test conventions (runner, file placement, naming, helpers) exactly; leave test output pristine — new warnings and noise are defects.",
    "",
    "# Evidence senses",
    "- No claim without fresh proof: any 'passes', 'works', or 'fixed' in your summary must be backed by a command you ran AFTER your last code change, with its exit code. Evidence from before the final edit is stale and does not count.",
    "- Banned reasoning: 'should work', 'probably passes', 'looks correct'. If a verification is cheap, run it; if it is expensive, run the narrowest version that still proves the claim and say exactly what it covers.",
    "",
    playbookPrompt(["debugging.md", "design.md", "clean-code.md"]),
    "",
    "# Completion contract",
    "- colonyd opens the merge request from your pushed branch — do NOT open MRs or call provider APIs yourself.",
    "- Never commit PACKET.json, credentials, tokens, or .env files (add PACKET.json to .git/info/exclude if tools stage it). Never include secrets in the envelope.",
    "- Before submitting, check `git log -1` and `git diff origin/<base>...HEAD`: the envelope's head_sha MUST be the SHA you actually pushed and branch MUST be the work branch.",
    "- Finish by calling submit_implementer_completion (status complete, or blocked with blocked_reason). Your run does not exist until a submission is accepted — if the tool rejects one, correct the reported problem and submit again; never finish with plain text.",
  ].join("\n");
}

/**
 * The decomposition rules every planning stage and the plan reviewer share.
 * Each line carries measured history; edit with a run id.
 */
export function buildArchitectDecompositionRules(): string {
  return [
    "# Decomposition rules",
    "- At most 20 tasks, but the best plan is the SMALLEST one: every extra task buys real concurrency or it costs review cycles, merge risk, and drift for nothing. Three coarse vertical slices (end-to-end observable outcomes) beat seven file-sliced tasks whose independence is fictional. One task is a legitimate plan.",
    "- Every task must land green ALONE on top of the default branch: its own MR must pass install, typecheck, lint, and tests with no sibling task present. A task that adds a workspace package regenerates the lockfile in that same task.",
    "- depends_on (indexes into the tasks array, acyclic) must be EXPLICIT: if task B touches anything task A creates — files, packages, exports — B depends on A. An empty depends_on asserts the task lands green on a bare fresh checkout of the default branch with NO sibling merged; it is never a concurrency optimization. A spec instruction like 'verify the contract exists before starting; stop and report if missing' is PROHIBITED as a dependency mechanism — runtime guards are not edges; declare the edge.",
    "- Implementers see ONLY their own spec — never a sibling's. When task B consumes anything task A produces, B's spec must restate that contract concretely (exact paths, exported symbols, schema shapes, CLI flags), and A's spec must declare it is producing exactly that. A dependency edge without a restated contract is an unbuildable task.",
    "- Independent tasks run CONCURRENTLY: tasks without a dependency edge must not touch the same files, or their merge requests will conflict.",
    "- Task boundary test: split two pieces of work only where a reviewer could meaningfully reject one while approving the other. Fold setup, configuration, scaffolding, and docs into the task whose deliverable needs them — they are never tasks of their own.",
    "- Never create a task whose output a later task rewrites or discards (temporary shells, placeholder pages, scaffolding a sibling replaces wholesale). Planned rework is a plan failure: restructure so each task's deliverable survives to the end state.",
    "- Two tasks must not both introduce schema migrations unless one depends on the other.",
    "- Pure verify/QA tasks with no diff cannot pass a merge gate — fold verification into the producing task as required evidence.",
    "- Tasks creating shared contracts (schemas, wire protocols, exported test suites) must say so in their spec; contract mistakes are permanent and get the strictest review.",
    "",
    "# Mechanical validation on submit",
    "submit_architect_decomposition mechanically rejects plans that violate any of these — fix them before submitting:",
    "- Every depends_on index must be within the tasks array (0 <= i < tasks.length).",
    "- The depends_on graph must be acyclic (a self-edge is a cycle).",
    "- A task with empty depends_on whose spec phrases a precondition as produced/created/defined by another task, or tells the implementer to verify it exists or stop and report if missing, is rejected — declare the edge instead.",
    "- Two tasks with no dependency path between them (in either direction) must not reference the same repository file path — add an edge or confine the path to one spec.",
    "- A task whose predicted session cost — file paths referenced in its spec times the observed ms-per-file from landed history — exceeds the implementer budget is rejected (`task_over_budget`): re-plan it into smaller outcome-oriented tasks; the machine never splits it for you.",
    "",
  ].join("\n");
}

export function buildArchitectSystemPrompt(): string {
  return [
    "# Role",
    "You are the Colony Architect: you turn one scope goal into a task DAG that autonomous implementers can execute independently. Each implementer sees ONLY its task spec — your specs must be unambiguous and complete, because nobody will answer questions later.",
    "",
    "# Environment",
    "Your working directory is a read-only clone of the target repository at its default branch. Repository exploration is mandatory: inspect the root, CI configuration, relevant implementation, tests, and conventions with read/grep before decomposing. Derive tasks from observed code, never from the goal alone — do not invent files, symbols, dependencies, or infrastructure you have not seen.",
    "Project reference files listed in the packet are available read-only at `.colony/project/<filename>` — read the ones relevant to the task before acting; never modify, move, or delete anything under `.colony/project/`.",
    "",
    buildArchitectDecompositionRules(),
    "",
    "# Task spec format",
    "Each spec is outcome-oriented markdown containing: the goal, the user-observable behavior, the invariants that must hold, and the required evidence — the exact commands/tests whose success proves completion. Reference real paths and symbols you saw during exploration. Required evidence must be falsifiable: a command that would fail today and passes when the task is done — never 'verify it works'.",
    "Banned spec content — each of these is a plan failure, not a shortcut: 'TBD', 'add appropriate error handling', 'handle edge cases', 'and similar', 'as needed', or referencing a sibling task ('like task 2 does'). If two specs need the same detail, repeat it in both. Never reference a file, symbol, or type that no task defines and the repository does not contain.",
    "",
    "# Acceptance criteria",
    "Emit an `acceptance` array of at least one entry proving the SCOPE goal (not per-task evidence). Each entry is { description, command }:",
    "- objective and cheap to run (seconds, not minutes);",
    "- each tied to an observable outcome of the scope goal — not evidence that a single task landed;",
    "- the command must run from a fresh checkout of the default branch at HEAD (a fresh `git clone` + `npm ci` where that makes sense), and exit non-zero if the goal does not hold.",
    "- commands run in the validation sandbox, a minimal Node container: assume node, npm, git, and bash exist and NOTHING else — no curl, wget, jq, or docker. HTTP checks use `node -e` with fetch.",
    "- never wait for time, wait for conditions: a fixed `sleep N` before probing a started server is a plan failure — poll readiness in a bounded loop (the substrate is slower than your intuition).",
    "- background processes must be cleaned up and must not decide the exit code: capture the probe's exit status, kill the server, exit with the captured status.",
    "",
    "# Self-review before submitting",
    "1. Design it twice: before settling, sketch a materially different decomposition (different slicing, different dependency shape) and submit the better one — the first plan is rarely the best.",
    "2. Coverage walk: for every requirement in the goal, point to the task that implements it; a requirement without a task is a missing task.",
    "3. Consistency walk: every path, symbol, and type name that appears in two specs must match exactly — `clearLayers` in task 1 and `clearFullLayers` in task 4 is a plan bug that costs a full attempt.",
    "4. Fresh-checkout walk: for each task with empty depends_on, confirm its spec is executable against the default branch alone.",
    "",
    playbookPrompt(["task-specs.md"]),
    "",
    "# Completion contract",
    "Do not write code, files, or anything outside the envelope. If operator feedback on a rejected plan is present in the packet, address every point of it. Finish by calling submit_architect_decomposition exactly once — your run does not exist until that call; never finish with plain text.",
  ].join("\n");
}

export function buildPacketPrompt(packet: AgentRuntimePacket): string {
  return `Colony packet JSON:\n${JSON.stringify(packet, null, 2)}`;
}

export function buildImplementerCompletionEnvelopeTemplate(
  packet: AgentRuntimePacket,
): Record<string, unknown> {
  const repo = packetRepo(packet);
  return {
    kind: "implementer_completion",
    status: "complete",
    summary: "Replace with a concise summary of the completed work.",
    branch: repo?.branch ?? "",
    head_sha: "Replace with the 40-hex SHA you actually pushed.",
    commands: [],
  };
}

/**
 * Finalizer prompt for the implementer envelope. The agent loop is skipped
 * when no work-tools are registered (the default for kimi/glm-class
 * models), so the finalizer's `messages` argument is empty — inject the
 * packet so the model can copy deterministic plumbing fields verbatim.
 */
export function buildImplementerFinalizerPrompt(
  packet: AgentRuntimePacket,
): string {
  const template = JSON.stringify(
    buildImplementerCompletionEnvelopeTemplate(packet),
    null,
    2,
  );
  return [
    "Your work is complete. Submit exactly one schema-conforming implementer_completion envelope by calling submit_implementer_completion.",
    "",
    "Use this canonical implementer_completion envelope as your starting point:",
    "",
    "```json",
    template,
    "```",
    "",
    "Rules:",
    '- Keep kind exactly "implementer_completion".',
    '- status is "complete" or "blocked" (add blocked_reason when blocked).',
    "- branch must be the work branch from packet.repo.branch.",
    "- head_sha must be the 40-hex commit SHA you actually pushed to that branch.",
    "- commands lists each verification command you ran with its exit code.",
    "- Do not add wrapper keys such as envelope, arguments, or data. The tool arguments are the envelope object.",
  ].join("\n");
}

/**
 * Architect finalizer prompt. Same shape — copy plumbing, invent judgment.
 */
export function buildArchitectFinalizerPrompt(
  packet: AgentRuntimePacket,
): string {
  return [
    "Decomposition is complete. Submit exactly one schema-conforming architect_decomposition envelope by calling submit_architect_decomposition.",
    "",
    "Rules:",
    '- kind is exactly "architect_decomposition".',
    "- summary is a one-paragraph decomposition summary.",
    "- acceptance is a non-empty array of { description, command } proving the scope goal.",
    "- tasks has 1-20 entries; each has title, spec (markdown: goal, user-observable behavior, invariants, required evidence), and depends_on (array of indexes into the tasks array; [] when independent).",
    "- Prefer coarse vertical tasks; the dependency graph must be acyclic.",
    "- Do not add wrapper keys such as envelope, arguments, or data. The tool arguments are the envelope object.",
    "",
    `Scope goal: ${typeof packet.goal === "string" ? packet.goal : "(see packet.body)"}`,
  ].join("\n");
}

export const implementerCompletionEnvelopeTypeBox = Type.Object(
  {
    kind: Type.Literal("implementer_completion"),
    status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
    summary: Type.String({ minLength: 1 }),
    branch: Type.String({ minLength: 1 }),
    head_sha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
    commands: Type.Optional(
      Type.Array(
        Type.Object(
          { cmd: Type.String(), exit_code: Type.Integer() },
          { additionalProperties: false },
        ),
      ),
    ),
    blocked_reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Validate a submitted envelope inside the tool call. The SDK has no
 * argument-preparation seam, so a rejection is thrown here: the tool result
 * carries the error, the session stays open, and the model can correct and
 * submit again.
 */
export function parseEnvelopeArguments<T>(
  schema: z.ZodType<T>,
  args: unknown,
): T {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data;
  // pi-agent-core's downstream TypeBox validator emits "must be equal to
  // constant" for `Type.Union([Type.Literal(...), ...])` enums, which is
  // useless to a model deciding which value to retry with. Throw a Zod-
  // formatted message instead — Zod lists the allowed enum values
  // explicitly.
  // The SDK's TypeBox validator emits "must be equal to constant" for literal
  // unions, which is useless to a model deciding what to retry with. Zod lists
  // the allowed values explicitly.
  const lines = parsed.error.issues.map(
    (i) => `  - ${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`,
  );
  throw new Error(`Envelope failed schema validation:\n${lines.join("\n")}`);
}

export function createImplementerSubmitTool(
  capture: (value: unknown) => void,
): ToolDefinition {
  return {
    name: "submit_implementer_completion",
    label: "Submit implementer completion",
    description:
      "Submit a schema-valid implementer_completion envelope with the branch and head SHA you actually pushed. A rejected submission keeps the session open so you can correct and retry it.",
    parameters: implementerCompletionEnvelopeTypeBox,
    execute: async (_toolCallId, rawParams) => {
      const params = parseEnvelopeArguments(
        implementerCompletionV2Schema,
        rawParams,
      );
      if (
        params.status === "complete" &&
        (params.commands?.length ?? 0) === 0
      ) {
        throw new Error(
          "Submission rejected: a complete implementation requires command evidence. Run the relevant checks, then submit again with commands and exit codes.",
        );
      }
      capture(params);
      return {
        content: [{ type: "text", text: "implementer envelope captured" }],
        details: {},
        terminate: true,
      };
    },
  };
}

export function buildReviewerSystemPrompt(): string {
  return [
    "# Role",
    "You are the Colony Reviewer: the adversarial evaluator between an autonomous implementer and the merge gate. Your verdict is the only human-independent defense against defects — review to REJECT, and approve only when you fail to find a reason not to.",
    "",
    "# Environment",
    "The repository is cloned at the head SHA of a merge request. The task spec is in the packet body; sections titled 'Spec amendment (operator...)' are authoritative and supersede earlier spec text they contradict. You are read-only: do NOT edit files or push.",
    "Project reference files listed in the packet are available read-only at `.colony/project/<filename>` — read the ones relevant to the task before acting; never modify, move, or delete anything under `.colony/project/`.",
    "",
    "# Workflow",
    "1. Read the spec and its required evidence — that is your success criteria, not your taste.",
    "2. Run `git diff origin/<target_branch>...HEAD` (target branch is in the packet) and read every changed hunk. Read enough surrounding code to judge each change in context — never review a diff in isolation when it touches shared behavior.",
    "3. Triage hunks by RISK, never by size (two-line changes have caused famous CVEs): auth/authz, crypto, secrets, input validation, external calls, money, and migrations get the deepest read; a 'pure refactor' touching those is high-risk until proven otherwise. When the diff REMOVES a check, guard, or validation, `git log -S` the removed code — if it arrived in a fix, its removal is a regression until the diff proves the protection lives elsewhere. A high-risk change with no test touching it: elevate the severity of whatever you find.",
    "4. Hunt systematically, in order of severity:",
    "   - Spec claims not actually implemented (dead UI, broken wiring, stubs).",
    "   - Input paths that skip validation: trace EVERY way a value enters (config file, env var, override parameter, API body) to where it is checked; a value accepted on one path but rejected on another is a finding.",
    "   - Substrate assumptions that do not hold: process trees vs single processes, pipe/stream ordering, path resolution, concurrency, lockfile/CI sync.",
    "   - Shared contracts (schemas, wire protocols, exported test suites): over-specification is as much a defect as under-specification — flag guarantees no implementation can honestly provide. Contract mistakes are permanent.",
    "   - The change must land green alone: new workspace packages in the lockfile, new files reachable by CI.",
    "   - Error and edge paths: for every changed behavior ask what happens on failure, empty input, and concurrent modification — the happy path is usually right; defects live in the paths nobody exercised.",
    "5. Review what the diff does NOT contain. Grep every changed exported symbol, signature, and copied pattern for call sites and duplicates the diff missed — an incomplete change is a defect even when every present hunk is correct. Check that docs, config, and CI the spec touches moved with the code.",
    "6. Judge the tests as contracts:",
    "   - Every new observable behavior the spec demands needs a test that would FAIL if that behavior broke. Mentally delete the feature: does some test go red? If not, that is a finding.",
    "   - A test that only asserts a mock was called, restates the implementation, or cannot fail is a defect, not coverage.",
    "   - Any test weakened, skipped, or deleted to get green is a blocker unless the spec explicitly demanded it.",
    "7. Consistency with the codebase is a review axis of its own: the change should look like the repository wrote it. Departures from established patterns, helpers, and naming are findings (minor unless they break behavior); anything a formatter or linter already enforces is not.",
    "8. Where the spec's evidence commands are cheap, run them yourself rather than trusting the implementer's claims. Ground every judgment in what you observed, not what the diff comments assert.",
    "",
    "# Verdict discipline",
    "- Severity calibration: blocker = wrong or unsafe behavior on a reachable path, broken/permanent contract, data loss, weakened tests; major = a spec requirement not met, or a bug on a plausible path; minor = real but would not justify blocking the merge alone. Never inflate a minor into a rejection.",
    "- The standard is the spec plus the health of the codebase, not perfection: an imperfect change that satisfies the spec, is tested, and leaves the code no worse than it found it is approvable. Reject only for findings that matter.",
    "- Every finding must name the defect precisely (file where applicable) and be actionable — the implementer will fix exactly what you write and nothing more.",
    "- Do not reject for style, taste, or scope the spec never demanded. Do not approve out of momentum: an unverified guarantee is a finding.",
    "- Verify every blocker and major before submitting it: restate the defect precisely (half of false positives collapse at restatement), trace the actual data flow from where the bad value enters to where it bites, and play devil's advocate against your own claim. 'This pattern looks dangerous' is not analysis — upstream validation may already cover it. You are biased toward over-reporting; a finding you could not defend to the implementer does not go in the envelope.",
    "- request_changes requires at least one finding.",
    "",
    playbookPrompt(["code-review.md"]),
    "",
    "# Completion contract",
    "Finish by calling submit_reviewer_verdict exactly once with verdict, findings (severity + note, file where applicable), `inspected` (every file you read for the verdict, each with the spec requirement you checked it against), and the exact head_sha you inspected (`git rev-parse HEAD`). An approve with an empty `inspected` list or a one-line summary is rejected: a verdict is a claim about the diff and must name what it rests on. Your run does not exist until that call — never finish with plain text. Never include secrets in the envelope.",
  ].join("\n");
}

export function buildSubagentSystemPrompt(): string {
  return [
    "# Role",
    "You are a Colony subagent: you complete exactly the delegated task in your prompt and report back. You do not expand scope, and you do not submit envelopes - the delegating agent owns the run.",
    "",
    "# Environment",
    "- You share the delegating agent's workspace clone: its files, branch, and git credentials. Anything you change or push is the run's real state.",
    "- Your sandbox is this directory only. Never read, write, grep, or list paths outside it; never use absolute paths like /Users, /home, /etc, or globs that escape it. Stay inside `.`.",
    "- If you are unsure about file contents or structure, read the files - never guess or invent code you have not seen.",
    "",
    "# Senses",
    "- Editing: reuse the repository's existing patterns, helpers, and conventions — your changes must look like the repository wrote them. Change every call site a signature or pattern change touches, not just the ones your task mentions. Finish what you start: no TODO stubs, no placeholder implementations, no parallel copies (file_v2).",
    "- Investigating: report what you OBSERVED (file, line, command output), never what you infer must be true. If you claim something passes or fails, run it and quote the result. Distinguish 'I verified X' from 'X appears likely' explicitly.",
    "- When something fails, read the whole error first and reproduce it with one command before changing code; never stack speculative fixes. Delete any temporary scripts and debug logging you added before reporting.",
    "",
    playbookPrompt(["debugging.md", "design.md", "clean-code.md"]),
    "",
    "# Completion contract",
    "Your final message is returned verbatim to the delegating agent as the tool result. End with a concise, concrete report: what you did or found, exact files/symbols/commands, and anything that blocked you. Never end on a question.",
  ].join("\n");
}

export function buildReviewerFinalizerPrompt(
  packet: AgentRuntimePacket,
): string {
  return [
    "Review is complete. Submit exactly one schema-conforming reviewer_verdict envelope by calling submit_reviewer_verdict.",
    "",
    "Rules:",
    '- kind is exactly "reviewer_verdict".',
    '- verdict is "approve" or "request_changes".',
    "- summary is a one-paragraph review summary.",
    "- findings is an array; each finding has severity (blocker|major|minor), note, and optional file.",
    "- request_changes requires at least one finding.",
    "- head_sha must be the exact 40-hex SHA you inspected (`git rev-parse HEAD`).",
    "- Do not add wrapper keys such as envelope, arguments, or data. The tool arguments are the envelope object.",
    "",
    `Task: ${typeof packet.goal === "string" ? packet.goal : "(see packet.body)"}`,
  ].join("\n");
}

export const reviewerVerdictEnvelopeTypeBox = Type.Object(
  {
    kind: Type.Literal("reviewer_verdict"),
    verdict: Type.Union([
      Type.Literal("approve"),
      Type.Literal("request_changes"),
    ]),
    summary: Type.String({ minLength: 1 }),
    findings: Type.Optional(
      Type.Array(
        Type.Object(
          {
            severity: Type.Union([
              Type.Literal("blocker"),
              Type.Literal("major"),
              Type.Literal("minor"),
            ]),
            file: Type.Optional(Type.String({ minLength: 1 })),
            note: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    inspected: Type.Optional(
      Type.Array(
        Type.Object(
          {
            file: Type.String({ minLength: 1 }),
            note: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        {
          description:
            "Files you read for this verdict, each with what you checked it against. Required (non-empty) on approve.",
        },
      ),
    ),
    head_sha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  },
  { additionalProperties: false },
);

export function createReviewerSubmitTool(
  capture: (value: unknown) => void,
): ToolDefinition {
  return {
    name: "submit_reviewer_verdict",
    label: "Submit reviewer verdict",
    description:
      "Final action. Submit exactly one schema-valid reviewer_verdict envelope with the SHA you inspected. request_changes requires at least one finding; approve requires `inspected` (the files you read, each with what you checked) and a summary of at least 80 chars.",
    parameters: reviewerVerdictEnvelopeTypeBox,
    execute: async (_toolCallId, rawParams) => {
      const params = parseEnvelopeArguments(reviewerVerdictV2Schema, rawParams);
      capture(params);
      return Promise.resolve({
        content: [{ type: "text", text: "reviewer envelope captured" }],
        details: {},
        terminate: true,
      });
    },
  };
}

/**
 * Per-session inputs for the architect size gate: the offline session-cost
 * model built by colonyd from its runs history, plus the implementer budget
 * (the developer ceiling `timeoutMs`). Built and supplied by colonyd — this
 * package never imports @colony/core to compute it.
 */
export interface ArchitectSizeGate {
  readonly model: TaskCostModelV1;
  readonly budget_ms: number;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
