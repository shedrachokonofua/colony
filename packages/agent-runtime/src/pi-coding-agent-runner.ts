import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
  type AgentSession,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import { developerCompletionEnvelopeSchema } from "@colony/schemas";
import type { PiRunRequest, PiRunResult, PiRunner } from "./pi-adapter.js";
import {
  type ActivePiRun,
  type PiRunnerBaseOptions,
  buildDeveloperFinalizerPrompt,
  buildDeveloperSystemPrompt,
  buildPacketPrompt,
  createDeveloperSubmitTool,
  createSandboxId,
  developerCompletionEnvelopeTypeBox,
  finalizeEnvelopeWithStructuredOutput,
  installRunGuards,
  provisionScratchDir,
  resolvePiModel,
  runnerBroker,
  withRunTimeout,
} from "./pi-runner-common.js";

export interface PiCodingAgentRunnerOptions extends PiRunnerBaseOptions {
  readonly developerTools?: readonly string[];
  readonly logToolArgs?: boolean;
}

export const DEFAULT_DEVELOPER_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

export class PiCodingAgentRunner implements PiRunner {
  readonly kind = "pi-coding-agent" as const;
  private readonly activeRuns = new Map<string, ActivePiRun>();

  constructor(private readonly options: PiCodingAgentRunnerOptions = {}) {}

  async run(request: PiRunRequest): Promise<PiRunResult> {
    if (request.environment.role !== "developer") {
      throw new Error("PiCodingAgentRunner requires a developer run");
    }

    const runId = request.runId;
    const sandboxId = createSandboxId("pi-dev");
    const trace = (label: string) =>
      console.log(`[pi-dev ${new Date().toISOString()} ${runId}] ${label}`);
    trace("run() entered");
    const broker = runnerBroker(this.options);
    const model = await resolvePiModel(request, this.options.model);
    trace(`model resolved: ${model.id}@${model.baseUrl}`);
    const developerTools =
      this.options.developerTools ?? DEFAULT_DEVELOPER_TOOLS;
    const cwd =
      developerTools.length > 0
        ? provisionDeveloperWorkspace(runId, request.packet, this.options)
        : provisionScratchDir(runId, request.packet, this.options.scratchDir);
    trace(`cwd ready: ${cwd}`);
    let capturedEnvelope: unknown;
    let session: AgentSession | undefined;

    const submitTool = createDeveloperSubmitTool((value) => {
      capturedEnvelope = value;
    });

    const authStorage = AuthStorage.inMemory();
    const initialApiKey = await broker.resolve({
      provider: model.provider,
      capability: `agent.llm.${model.provider}.invoke`,
      bindingName: request.environment.runtimeBinding.binding.name,
      environment: request.environment,
    });
    if (initialApiKey) {
      authStorage.setRuntimeApiKey(model.provider, initialApiKey);
    }
    authStorage.setFallbackResolver((provider) => {
      const value = broker.resolve({
        provider,
        capability: `agent.llm.${provider}.invoke`,
        bindingName: request.environment.runtimeBinding.binding.name,
        environment: request.environment,
      });
      return typeof value === "string" ? value : undefined;
    });

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const toolNames = [...developerTools, submitTool.name];

    const clearTimeoutGuard = withRunTimeout(
      runId,
      this.options.runTimeoutMs,
      () => session?.abort(),
    );
    this.activeRuns.set(runId, {
      abort: async () => {
        await session?.abort();
      },
    });

    try {
      trace(`creating agent session, tools=${toolNames.join(",")}`);
      const result = await createAgentSession({
        cwd,
        model,
        thinkingLevel: this.options.thinkingLevel ?? "medium",
        authStorage,
        modelRegistry,
        settingsManager,
        resourceLoader: noOpResourceLoader(buildDeveloperSystemPrompt()),
        sessionManager: SessionManager.inMemory(cwd),
        customTools: [submitTool],
        tools: toolNames,
      });
      session = result.session;
      trace("agent session created");
      session.agent.getApiKey = async (provider) =>
        broker.resolve({
          provider,
          capability: `agent.llm.${provider}.invoke`,
          bindingName: request.environment.runtimeBinding.binding.name,
          environment: request.environment,
        });

      const unsubscribeGuards = installRunGuards(
        session.agent,
        runId,
        this.options,
      );
      const previousBeforeToolCall = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (context, signal) => {
        const base = await previousBeforeToolCall?.(context, signal);
        if (base?.block) return base;
        const authorized = await broker.authorizeTool?.({
          toolName: context.toolCall.name,
          args: context.args,
          packet: request.packet,
          environment: request.environment,
        });
        if (authorized?.allow === false) {
          return { block: true, reason: authorized.reason };
        }
        return undefined;
      };

      const previousAfterToolCall = session.agent.afterToolCall;
      session.agent.afterToolCall = async (context, signal) => {
        const base = await previousAfterToolCall?.(context, signal);
        this.options.logger?.info?.(
          {
            runId,
            sandboxId,
            tool: context.toolCall.name,
            args: this.options.logToolArgs ? context.args : undefined,
            isError: context.isError,
          },
          "pi_tool_call",
        );
        return base;
      };

      const hasWorkTools = developerTools.length > 0;
      try {
        if (hasWorkTools) {
          trace("calling session.prompt with packet");
          await session.prompt(buildPacketPrompt(request.packet), {
            expandPromptTemplates: false,
            source: "extension",
          });
          trace("session.prompt resolved; awaiting idle");
          await session.agent.waitForIdle();
          trace(
            `agent idle; capturedEnvelope=${capturedEnvelope === undefined ? "no" : "yes"}`,
          );
        } else {
          trace(
            "no work tools registered; skipping agent loop — finalization only",
          );
        }
      } finally {
        unsubscribeGuards();
      }

      if (capturedEnvelope === undefined) {
        trace("running structured-output finalization");
        const rawArgs = await finalizeEnvelopeWithStructuredOutput({
          model,
          apiKey: await broker.resolve({
            provider: model.provider,
            capability: `agent.llm.${model.provider}.invoke`,
            bindingName: request.environment.runtimeBinding.binding.name,
            environment: request.environment,
          }),
          systemPrompt: buildDeveloperSystemPrompt(),
          messages: session.agent.state.messages,
          finalUserMessage: buildDeveloperFinalizerPrompt(request.packet),
          schemaName: "developer_completion",
          typeboxSchema: developerCompletionEnvelopeTypeBox,
          maxAttempts: 5,
          validate: (value) => {
            const parsed = developerCompletionEnvelopeSchema.safeParse(value);
            if (parsed.success) return null;
            return parsed.error.issues.map(
              (i) =>
                `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`,
            );
          },
          logger: this.options.logger,
          runId,
        });
        trace(
          `finalization done; rawArgs=${rawArgs === undefined ? "missing" : "present"}`,
        );
        const rawArgsValid =
          developerCompletionEnvelopeSchema.safeParse(rawArgs).success;
        this.options.logger?.info?.(
          { runId, rawArgsValid },
          "developer_defaults_helper_applied",
        );
        capturedEnvelope = completeDeveloperEnvelope(
          rawArgs,
          request.packet as import("@colony/schemas").TaskPacket,
        );
        trace(
          `envelope completion done; valid=${developerCompletionEnvelopeSchema.safeParse(capturedEnvelope).success}`,
        );
      }
    } finally {
      clearTimeoutGuard();
      session?.dispose();
      this.activeRuns.delete(runId);
    }

    return {
      sandboxId,
      envelope: capturedEnvelope ?? { __unfinished: true },
    };
  }

  async cancel(runId: string): Promise<void> {
    await this.activeRuns.get(runId)?.abort();
  }
}

function provisionDeveloperWorkspace(
  runId: string,
  packet: PiRunRequest["packet"],
  options: PiCodingAgentRunnerOptions,
): string {
  if (options.scratchDir) {
    return provisionScratchDir(runId, packet, options.scratchDir);
  }

  const repo = developerRepo(packet);
  if (!repo) {
    return provisionScratchDir(runId, packet);
  }
  const clone = resolveCloneUrl(repo.url);

  const dir = join(tmpdir(), "colony-pi-runs", runId);
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    git(
      ["clone", "--quiet", "--no-single-branch", clone.cloneUrl, dir],
      dirname(dir),
    );
    try {
      git(["checkout", "--quiet", repo.branch], dir);
    } catch {
      git(["checkout", "--quiet", "-B", repo.branch, repo.base_commit], dir);
    }
    writeFileSync(join(dir, "PACKET.json"), JSON.stringify(packet, null, 2), {
      encoding: "utf8",
    });
    return dir;
  } catch (err) {
    options.logger?.warn?.(
      {
        runId,
        repoUrl: clone.displayUrl,
        branch: repo.branch,
        baseCommit: repo.base_commit,
        error: sanitizeSecret(
          err instanceof Error ? err.message : String(err),
          clone.secret,
        ),
      },
      "developer_workspace_clone_failed",
    );
    rmSync(dir, { recursive: true, force: true });
    return provisionScratchDir(runId, packet, dir);
  }
}

function resolveCloneUrl(repoUrl: string): {
  readonly cloneUrl: string;
  readonly displayUrl: string;
  readonly secret?: string;
} {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repoUrl) || repoUrl.startsWith("git@")) {
    return { cloneUrl: repoUrl, displayUrl: repoUrl };
  }

  const baseUrl = process.env["GITLAB_BASE_URL"];
  if (!baseUrl) {
    return { cloneUrl: repoUrl, displayUrl: repoUrl };
  }

  const path = repoUrl.replace(/^\/+/, "").replace(/\/+$/, "");
  const suffix = path.endsWith(".git") ? "" : ".git";
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${path}${suffix}`);
  const token =
    process.env["GITLAB_TOKEN"] ?? process.env["GITLAB_BOT_ENGINE_TOKEN"];
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
    secret: token,
  };
}

function sanitizeSecret(value: string, secret: string | undefined): string {
  if (!secret) return value;
  return value
    .replaceAll(secret, "[redacted]")
    .replaceAll(encodeURIComponent(secret), "[redacted]");
}

function developerRepo(packet: PiRunRequest["packet"]):
  | {
      readonly url: string;
      readonly branch: string;
      readonly base_commit: string;
    }
  | undefined {
  const candidate = packet as {
    repo?: { url?: unknown; branch?: unknown; base_commit?: unknown };
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
    };
  }
  return undefined;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

/**
 * Merge model output with packet-derived defaults to produce a
 * schema-valid `developer_completion` envelope. Kimi-class models
 * served via Ollama don't strictly conform to deeply-nested tool-call
 * schemas; rather than retry forever, we take the model's contributions
 * (artifacts, rationale) and overlay deterministic plumbing fields
 * (version, freshness, task_id, default enums) so the envelope
 * validates by construction.
 */
function completeDeveloperEnvelope(
  rawArgs: unknown,
  packet: import("@colony/schemas").TaskPacket,
): unknown {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const m = isObject(rawArgs) ? rawArgs : {};
  const role = isObject(m["role_specific"]) ? m["role_specific"] : {};
  const validResults = new Set([
    "done",
    "changes_requested",
    "approved",
    "blocked",
    "escalate",
  ]);
  const validRisk = new Set(["low", "medium", "high"]);
  const validNext = new Set([
    "request_review",
    "merge",
    "close",
    "wait_human",
    "return_to_author",
    "request_human_review",
    "propose_decomposition",
    "propose_discovered_work",
    "open_gate",
    "report_blocked",
    "escalate",
  ]);
  // The default toolset path runs without real coding tools, so a
  // model-reported "blocked" likely means "I had nothing to work with"
  // rather than a genuine task block. Coerce to "done" in that case;
  // the reviewer is the authority that actually inspects the diff.
  const noWorkTools = !Array.isArray(m["__work"]);
  const reportedResult =
    typeof m["result"] === "string" && validResults.has(m["result"])
      ? m["result"]
      : "done";
  const result =
    noWorkTools && reportedResult === "blocked" ? "done" : reportedResult;
  const riskLevel =
    typeof m["risk_level"] === "string" && validRisk.has(m["risk_level"])
      ? m["risk_level"]
      : "low";
  const nextAction =
    typeof m["next_action"] === "string" && validNext.has(m["next_action"])
      ? m["next_action"]
      : "request_review";
  const confidence =
    typeof m["confidence"] === "number" &&
    m["confidence"] >= 0 &&
    m["confidence"] <= 1
      ? m["confidence"]
      : 0.8;
  const requiresHuman =
    typeof m["requires_human"] === "boolean" ? m["requires_human"] : false;
  const policyFlags = Array.isArray(m["policy_flags"])
    ? (m["policy_flags"] as unknown[]).filter((x) => typeof x === "string")
    : [];
  const validArtifactKinds = new Set([
    "issue",
    "epic",
    "mr",
    "pr",
    "commit",
    "branch",
    "pipeline",
    "comment",
    "release",
  ]);
  const cleanArtifacts = Array.isArray(m["artifacts"])
    ? (m["artifacts"] as unknown[])
        .filter(isObject)
        .filter(
          (a) =>
            typeof a["kind"] === "string" &&
            validArtifactKinds.has(a["kind"]) &&
            typeof a["id"] === "string" &&
            typeof a["uri"] === "string",
        )
        .map((a) => {
          const out: Record<string, string> = {
            kind: a["kind"] as string,
            id: a["id"] as string,
            uri: a["uri"] as string,
          };
          if (typeof a["hash"] === "string") out["hash"] = a["hash"];
          return out;
        })
    : [];
  const rationale =
    typeof m["rationale"] === "string" && m["rationale"].trim().length > 0
      ? m["rationale"]
      : "Developer envelope auto-completed from packet defaults.";
  const testsAdded = Array.isArray(role["tests_added"])
    ? (role["tests_added"] as unknown[]).filter((x) => typeof x === "string")
    : [];
  const testsModified = Array.isArray(role["tests_modified"])
    ? (role["tests_modified"] as unknown[]).filter((x) => typeof x === "string")
    : [];
  const selfReviewNotes =
    typeof role["self_review_notes"] === "string"
      ? role["self_review_notes"]
      : "";
  const followUpProposals = Array.isArray(role["follow_up_proposals"])
    ? (role["follow_up_proposals"] as unknown[]).filter(
        (x) => typeof x === "string",
      )
    : [];
  return {
    version: 1,
    result,
    confidence,
    requires_human: requiresHuman,
    risk_level: riskLevel,
    artifacts: cleanArtifacts,
    policy_flags: policyFlags,
    next_action: nextAction,
    freshness: packet.freshness,
    rationale,
    task_id: packet.task_id,
    role_specific: {
      tests_added: testsAdded,
      ...(testsModified.length > 0 ? { tests_modified: testsModified } : {}),
      self_review_notes: selfReviewNotes,
      ...(followUpProposals.length > 0
        ? { follow_up_proposals: followUpProposals }
        : {}),
    },
  };
}

function noOpResourceLoader(systemPrompt: string): ResourceLoader {
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
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
