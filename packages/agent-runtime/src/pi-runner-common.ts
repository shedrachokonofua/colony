import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Agent, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import type {
  ResourceLoader,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  type ArchitectDecompositionV2,
  type ImplementerCompletionV2,
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
  ImplementerCompletionV2 as implementerCompletionV2Schema,
  ReviewerVerdictV2 as reviewerVerdictV2Schema,
} from "@colony/schemas";
import type { z } from "zod";
import type { AgentRunEnvironment, AgentRuntimePacket } from "./adapter.js";
import type { CredentialBroker } from "./credential-broker.js";
import { permissiveCredentialBroker } from "./credential-broker.js";
import type { PiRunRequest } from "./pi-adapter.js";
import type { SandboxEngine } from "@colony/sandbox";
import type { WebToolsConfig } from "./web-tools.js";

export interface PiRunnerLogger {
  info?(fields: Record<string, unknown>, message: string): void;
  warn?(fields: Record<string, unknown>, message: string): void;
  error?(fields: Record<string, unknown>, message: string): void;
}

export interface PiRunnerBaseOptions {
  readonly broker?: CredentialBroker;
  readonly logger?: PiRunnerLogger;
  readonly model?: Model<Api> | PiModelResolver;
  readonly webTools?: WebToolsConfig;
  readonly fallbackModels?: readonly Model<Api>[];
  readonly thinkingLevel?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";
  readonly maxTurns?: number;
  readonly runTimeoutMs?: number;
  readonly scratchDir?: string;
  readonly engine?: SandboxEngine;
}

export type PiModelResolver = (
  request: PiRunRequest,
) => Promise<Model<Api>> | Model<Api>;
export interface PiRunGuardOptions extends PiRunnerBaseOptions {
  readonly onFailure?: (reason: string) => void;
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
): Promise<Model<Api>> {
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
  const dir = override ?? join(tmpdir(), "colony-pi-runs", runId);
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
  return dir;
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
  // them as GitLab project paths merely because the daemon has a base URL.
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

export function noOpResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export function createSandboxId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
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

  return agent.subscribe((event) => {
    if (event.type === "turn_end") {
      turns += 1;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      const messageUsd = usage?.cost.total ?? 0;
      const messageCompletedAt = performance.now();
      usdSpent += messageUsd;
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
        "pi_usage",
      );
      previousMessageAt = messageCompletedAt;
    }
    const reason =
      turns >= maxTurns ? "max_turns_exhausted_without_envelope" : undefined;
    if (reason) {
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
      agent.abort();
    }
  });
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

export interface FinalizeEnvelopeOptions {
  readonly model: Model<Api>;
  readonly stream: StreamFn;
  readonly systemPrompt: string;
  readonly messages: ReadonlyArray<unknown>;
  readonly finalUserMessage: string;
  readonly schemaName: string;
  readonly typeboxSchema: unknown;
  /**
   * Optional validator. When provided, enables a retry loop: if the
   * model's first envelope fails validation, the finalizer reruns the
   * tool turn with the validation errors injected as user feedback.
   * Returns `null` when valid; an array of human-readable error
   * descriptions when invalid.
   */
  readonly validate?: (value: unknown) => string[] | null;
  /** Max attempts including the first. Default 3. */
  readonly maxAttempts?: number;
  /** Max time to wait for a finalizer stream event before giving up. */
  readonly streamTimeoutMs?: number;
  readonly logger?: PiRunnerLogger;
  readonly runId: string;
}

class FinalizerStreamTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`finalizer stream timed out after ${timeoutMs}ms`);
    this.name = "FinalizerStreamTimeoutError";
  }
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        timer = setTimeout(
          () => reject(new FinalizerStreamTimeoutError(timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Last-mile envelope capture for runs where the in-loop submit tool was
 * never called (e.g., Ollama-served models that ignore mid-loop
 * tool_choice forcing because of multiple available tools).
 *
 * Strategy: a single pi-ai `streamSimple` call with **only** the submit
 * tool registered + `toolChoice` forcing it. With one tool the
 * constraint is unambiguous and Ollama-class providers honor it (probed
 * directly: ~1.9s, schema-conforming args).
 *
 * We deliberately do not use `response_format: json_schema strict` here:
 * Ollama Cloud accepts the parameter but doesn't reliably enforce the
 * schema across all models.
 */
export async function finalizeEnvelopeWithStructuredOutput(
  options: FinalizeEnvelopeOptions,
): Promise<unknown> {
  const llmHistory = convertToLlm(
    options.messages as unknown as Parameters<typeof convertToLlm>[0],
  );
  const toolName = `submit_${options.schemaName}`;
  const tools = [
    {
      name: toolName,
      label: toolName,
      description: `Submit the final ${options.schemaName} envelope. Required.`,
      parameters:
        options.typeboxSchema as Parameters<StreamFn>[1]["tools"] extends ReadonlyArray<
          infer T
        >
          ? T extends { parameters: infer P }
            ? P
            : never
          : never,
    },
  ];
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const streamTimeoutMs = options.streamTimeoutMs ?? 180_000;

  let userMessage = options.finalUserMessage;
  let lastErrors: string[] | null = null;
  let lastCaptured: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const messages = [
      ...llmHistory,
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: userMessage }],
        timestamp: Date.now(),
      },
    ];
    const streamOptions = (
      options.model.api === "openai-completions"
        ? { toolChoice: { type: "function", function: { name: toolName } } }
        : {}
    ) as Parameters<StreamFn>[2];
    const events = await options.stream(
      options.model,
      {
        systemPrompt: options.systemPrompt,
        messages,
        tools,
      },
      streamOptions,
    );

    let captured: unknown;
    const iterator = events[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await nextWithTimeout(iterator, streamTimeoutMs);
        if (next.done) break;
        const event = next.value;
        if (event.type === "toolcall_end" && event.toolCall.name === toolName) {
          captured = event.toolCall.arguments;
          break;
        }
        if (event.type === "error") {
          options.logger?.error?.(
            { runId: options.runId, attempt, reason: event.reason },
            "finalize_envelope_stream_error",
          );
          return undefined;
        }
      }
    } catch (err) {
      if (err instanceof FinalizerStreamTimeoutError) {
        options.logger?.warn?.(
          {
            runId: options.runId,
            attempt,
            timeoutMs: err.timeoutMs,
          },
          "finalize_envelope_stream_timeout",
        );
        await iterator.return?.();
        return undefined;
      }
      options.logger?.error?.(
        {
          runId: options.runId,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        },
        "finalize_envelope_stream_threw",
      );
      return undefined;
    } finally {
      await iterator.return?.();
    }

    lastCaptured = captured;
    if (captured === undefined) {
      options.logger?.warn?.(
        { runId: options.runId, attempt },
        "finalize_envelope_no_tool_call",
      );
      return undefined;
    }

    if (!options.validate) {
      return captured;
    }

    const errors = options.validate(captured);
    if (errors === null) {
      if (attempt > 1) {
        options.logger?.info?.(
          { runId: options.runId, attempt },
          "finalize_envelope_repaired",
        );
      }
      return captured;
    }

    lastErrors = errors;
    options.logger?.warn?.(
      {
        runId: options.runId,
        attempt,
        errorCount: errors.length,
        errors: errors.slice(0, 8),
      },
      "finalize_envelope_validation_failed",
    );
    if (attempt < maxAttempts) {
      userMessage = [
        "Your previous envelope failed validation:",
        ...errors.slice(0, 12).map((e) => `  - ${e}`),
        "",
        "Submit a corrected envelope by calling the submit tool again. Start from the canonical envelope template you were given, keep deterministic packet fields unchanged, do not omit required fields, and use only the listed enum values exactly.",
      ].join("\n");
    }
  }

  options.logger?.error?.(
    { runId: options.runId, errors: lastErrors?.slice(0, 6) },
    "finalize_envelope_validation_unrecoverable",
  );
  return lastCaptured;
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
    "",
    "# Workflow",
    "1. Understand: read the task spec in packet.body, including any 'Spec amendment (operator...)' sections — those are authoritative and supersede earlier text they contradict.",
    "2. Explore: inspect the relevant files, tests, imports, and neighboring patterns. Check whether equivalent behavior already exists before creating anything new; reuse existing schemas, helpers, dependencies, and conventions.",
    "3. Plan: decide the smallest idiomatic change that satisfies the spec. For bug fixes, reproduce the failure FIRST and keep the reproduction as your finish line.",
    "4. Implement incrementally: make a focused change, then immediately verify it (typecheck, the narrowest relevant test) before moving on. Re-read files after editing them.",
    "5. Verify like the gate will: before finishing, run the full relevant checks (install if needed, typecheck, lint, tests) and record every command with its exit code.",
    "6. Self-review: read your final `git diff origin/<base>...HEAD` as if you were the reviewer — every hunk must serve the spec, and every spec requirement must appear in the diff. Cut anything that does not; add anything missing.",
    "7. Land: commit on the work branch, `git push origin <branch>`, then confirm the push (`git log origin/<branch>..HEAD` must be empty).",
    "",
    "# Discipline",
    "- The diff must contain ONLY changes the spec requires. Do what it asks, but no more: no drive-by refactors, new dependencies, generated files, public contract changes, or type suppressions unless the spec makes them necessary.",
    "- Completely implement what you start. Never leave comments describing code instead of code, TODO stubs, or placeholder implementations.",
    "- Never delete or weaken a failing test to make the suite pass: debug the implementation first; change a test only when the spec requires it or the test is demonstrably wrong — and say so in your summary.",
    "- Edit files in place. Never create parallel copies (file_v2, file_new); delete any temporary scripts you created before finishing.",
    "",
    "# When stuck",
    "After repeated failures on the same problem: stop, list the 3-5 most plausible root causes, rank them, and attack the most likely one. Never paper over a major issue with a workaround. If the task is genuinely impossible as specified, submit status blocked with a precise blocked_reason.",
    "",
    "# Completion contract",
    "- colonyd opens the merge request from your pushed branch — do NOT open MRs or call provider APIs yourself.",
    "- Never commit PACKET.json, credentials, tokens, or .env files (add PACKET.json to .git/info/exclude if tools stage it). Never include secrets in the envelope.",
    "- Before submitting, check `git log -1` and `git diff origin/<base>...HEAD`: the envelope's head_sha MUST be the SHA you actually pushed and branch MUST be the work branch.",
    "- Finish by calling submit_implementer_completion (status complete, or blocked with blocked_reason). Your run does not exist until a submission is accepted — if the tool rejects one, correct the reported problem and submit again; never finish with plain text.",
  ].join("\n");
}

export function buildArchitectSystemPrompt(): string {
  return [
    "# Role",
    "You are the Colony Architect: you turn one scope goal into a task DAG that autonomous implementers can execute independently. Each implementer sees ONLY its task spec — your specs must be unambiguous and complete, because nobody will answer questions later.",
    "",
    "# Environment",
    "Your working directory is a read-only clone of the target repository at its default branch. Repository exploration is mandatory: inspect the root, CI configuration, relevant implementation, tests, and conventions with read/grep before decomposing. Derive tasks from observed code, never from the goal alone — do not invent files, symbols, dependencies, or infrastructure you have not seen.",
    "",
    "# Decomposition rules",
    "- At most 20 tasks. Prefer coarse vertical slices (end-to-end observable outcomes) over file-sliced tasks; prefer the simplest decomposition that meets the goal.",
    "- Every task must land green ALONE on top of the default branch: its own MR must pass install, typecheck, lint, and tests with no sibling task present. A task that adds a workspace package regenerates the lockfile in that same task.",
    "- depends_on (indexes into the tasks array, acyclic) must be EXPLICIT: if task B touches anything task A creates — files, packages, exports — B depends on A. An empty depends_on claims the task can run first on a fresh checkout.",
    "- Independent tasks run CONCURRENTLY: tasks without a dependency edge must not touch the same files, or their merge requests will conflict.",
    "- Two tasks must not both introduce schema migrations unless one depends on the other.",
    "- Pure verify/QA tasks with no diff cannot pass a merge gate — fold verification into the producing task as required evidence.",
    "- Tasks creating shared contracts (schemas, wire protocols, exported test suites) must say so in their spec; contract mistakes are permanent and get the strictest review.",
    "",
    "# Task spec format",
    "Each spec is outcome-oriented markdown containing: the goal, the user-observable behavior, the invariants that must hold, and the required evidence — the exact commands/tests whose success proves completion. Reference real paths and symbols you saw during exploration.",
    "",
    "# Acceptance criteria",
    "Emit an `acceptance` array of at least one entry proving the SCOPE goal (not per-task evidence). Each entry is { description, command }:",
    "- objective and cheap to run (seconds, not minutes);",
    "- each tied to an observable outcome of the scope goal — not evidence that a single task landed;",
    "- the command must run from a fresh checkout of the default branch at HEAD (a fresh `git clone` + `npm ci` where that makes sense), and exit non-zero if the goal does not hold.",
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

export const architectDecompositionEnvelopeTypeBox = Type.Object(
  {
    kind: Type.Literal("architect_decomposition"),
    summary: Type.String({ minLength: 1 }),
    acceptance: Type.Array(
      Type.Object(
        {
          description: Type.String({ minLength: 1 }),
          command: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    tasks: Type.Array(
      Type.Object(
        {
          title: Type.String({ minLength: 1 }),
          spec: Type.String({ minLength: 1 }),
          depends_on: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);

function makeZodPrepare(
  schema: z.ZodType<unknown>,
): (args: unknown) => unknown {
  return (args: unknown) => {
    const parsed = schema.safeParse(args);
    if (parsed.success) return parsed.data;
    // pi-agent-core's downstream TypeBox validator emits "must be equal to
    // constant" for `Type.Union([Type.Literal(...), ...])` enums, which is
    // useless to a model deciding which value to retry with. Throw a Zod-
    // formatted message instead — Zod lists the allowed enum values
    // explicitly.
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`,
    );
    throw new Error(`Envelope failed schema validation:\n${lines.join("\n")}`);
  };
}

export function createImplementerSubmitTool(
  capture: (value: unknown) => void,
): ToolDefinition<typeof implementerCompletionEnvelopeTypeBox> {
  return {
    name: "submit_implementer_completion",
    label: "Submit implementer completion",
    description:
      "Submit a schema-valid implementer_completion envelope with the branch and head SHA you actually pushed. A rejected submission keeps the session open so you can correct and retry it.",
    parameters: implementerCompletionEnvelopeTypeBox,
    executionMode: "sequential",
    prepareArguments: makeZodPrepare(implementerCompletionV2Schema) as (
      args: unknown,
    ) => Static<typeof implementerCompletionEnvelopeTypeBox>,
    execute: async (_toolCallId, params) => {
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
    "",
    "# Workflow",
    "1. Read the spec and its required evidence — that is your success criteria, not your taste.",
    "2. Run `git diff origin/<target_branch>...HEAD` (target branch is in the packet) and read every changed hunk. Read enough surrounding code to judge each change in context — never review a diff in isolation when it touches shared behavior.",
    "3. Hunt systematically, in order of severity:",
    "   - Spec claims not actually implemented (dead UI, broken wiring, stubs).",
    "   - Input paths that skip validation: trace EVERY way a value enters (config file, env var, override parameter, API body) to where it is checked; a value accepted on one path but rejected on another is a finding.",
    "   - Substrate assumptions that do not hold: process trees vs single processes, pipe/stream ordering, path resolution, concurrency, lockfile/CI sync.",
    "   - Shared contracts (schemas, wire protocols, exported test suites): over-specification is as much a defect as under-specification — flag guarantees no implementation can honestly provide. Contract mistakes are permanent.",
    "   - The change must land green alone: new workspace packages in the lockfile, new files reachable by CI.",
    "4. Where the spec's evidence commands are cheap, run them yourself rather than trusting the implementer's claims. Ground every judgment in what you observed, not what the diff comments assert.",
    "",
    "# Verdict discipline",
    "- Every finding must name the defect precisely (file where applicable) and be actionable — the implementer will fix exactly what you write and nothing more.",
    "- Do not reject for style, taste, or scope the spec never demanded. Do not approve out of momentum: an unverified guarantee is a finding.",
    "- request_changes requires at least one finding.",
    "",
    "# Completion contract",
    "Finish by calling submit_reviewer_verdict exactly once with verdict, findings (severity + note, file where applicable), and the exact head_sha you inspected (`git rev-parse HEAD`). Your run does not exist until that call — never finish with plain text. Never include secrets in the envelope.",
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
    head_sha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  },
  { additionalProperties: false },
);

export function createReviewerSubmitTool(
  capture: (value: unknown) => void,
): AgentTool<typeof reviewerVerdictEnvelopeTypeBox> {
  return {
    name: "submit_reviewer_verdict",
    label: "Submit reviewer verdict",
    description:
      "Final action. Submit exactly one schema-valid reviewer_verdict envelope with the SHA you inspected. request_changes requires at least one finding.",
    parameters: reviewerVerdictEnvelopeTypeBox,
    executionMode: "sequential",
    prepareArguments: makeZodPrepare(reviewerVerdictV2Schema) as (
      args: unknown,
    ) => Static<typeof reviewerVerdictEnvelopeTypeBox>,
    execute: (_toolCallId, params) => {
      capture(params);
      return Promise.resolve({
        content: [{ type: "text", text: "reviewer envelope captured" }],
        details: {},
        terminate: true,
      });
    },
  };
}

export function createArchitectSubmitTool(
  capture: (value: unknown) => void,
): AgentTool<typeof architectDecompositionEnvelopeTypeBox> {
  return {
    name: "submit_architect_decomposition",
    label: "Submit architect decomposition",
    description:
      "Final action. Submit exactly one schema-valid architect_decomposition envelope with outcome-oriented tasks and an acyclic depends_on graph.",
    parameters: architectDecompositionEnvelopeTypeBox,
    executionMode: "sequential",
    prepareArguments: makeZodPrepare(architectDecompositionV2Schema) as (
      args: unknown,
    ) => Static<typeof architectDecompositionEnvelopeTypeBox>,
    execute: (_toolCallId, params) => {
      capture(params);
      return Promise.resolve({
        content: [{ type: "text", text: "architect envelope captured" }],
        details: {},
        terminate: true,
      });
    },
  };
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
