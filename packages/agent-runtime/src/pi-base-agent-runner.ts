import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  ModelRegistry,
  SessionManager,
  Settings,
  buildWorkspaceTree,
  createAgentSession,
  discoverAuthStorage,
  discoverContextFiles,
  type AgentSession,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import {
  ThinkingLevel,
  type ThinkingLevel as SdkThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import { context } from "@opentelemetry/api";
import type { z } from "zod";
import type {
  AgentRunEnvironment,
  AgentRuntimePacket,
  AgentRuntimeRole,
} from "./adapter.js";
import {
  buildArchitectExtensionSystemPrompt,
  createArchitectExtensionSubmitTool,
  extensionTasksFromPacket,
  isArchitectExtensionPacket,
} from "./architect-extension.js";
import type { PiRunRequest, PiRunResult, PiRunner } from "./pi-adapter.js";
import {
  type ActivePiRun,
  type PiRunnerBaseOptions,
  type PiModelSpec,
  type ArchitectSizeGate,
  DEFAULT_PI_RUN_TIMEOUT_MS,
  buildArchitectFinalizerPrompt,
  buildArchitectSystemPrompt,
  buildImplementerFinalizerPrompt,
  buildImplementerSystemPrompt,
  buildPacketPrompt,
  buildReviewerFinalizerPrompt,
  buildReviewerSystemPrompt,
  buildSubagentSystemPrompt,
  createImplementerSubmitTool,
  createReviewerSubmitTool,
  createSandboxId,
  implementerCompletionEnvelopeTypeBox,
  installRunGuards,
  installWorkspaceProbe,
  WORKSPACE_LOST_REASON,
  packetRepo,
  provisionRepoWorkspace,
  provisionScratchDir,
  resolvePiModel,
  reviewerVerdictEnvelopeTypeBox,
  runnerBroker,
  waitForIdleOrCapturedEnvelope,
  withRunTimeout,
} from "./pi-runner-common.js";
import {
  architectDecompositionEnvelopeTypeBox,
  buildArchitectStages,
  createArchitectSubmitTool,
  createPlanReviewSubmitTool,
  PLAN_REVIEW_SYSTEM_PROMPT,
  planReviewVerdictTypeBox,
  type ArchitectStage,
  type InspectionManifest,
  type StageArtifacts,
} from "./architect-stages.js";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { createSubagentTool } from "./subagent-tool.js";
import { RunSteering, packetObjective } from "./run-steering.js";
import {
  captureTranscript,
  quarantineTranscript,
} from "./transcript-capture.js";
import { captureWorkspace } from "./workspace-capture.js";
import { buildSandboxTools, verifyPushedHead } from "./sandbox-tools.js";
import { RunEvidenceCollector } from "./run-evidence.js";
import {
  buildSandboxLaunchProfile,
  type SandboxEngine,
  type SandboxHandle,
  type SandboxRole,
} from "@colony/sandbox";
import {
  createWebTools,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_TOOL_NAMES,
} from "./web-tools.js";
import type { WebToolsConfig } from "./web-tools.js";
import { createFileSessionManager } from "./session-store.js";
import {
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
  ImplementerCompletionV2 as implementerCompletionV2Schema,
  ReviewerVerdictV2 as reviewerVerdictV2Schema,
  PlanReviewVerdictV1,
} from "@colony/schemas";

export type PiWorkspaceMode = "repo-required" | "scratch";

/** Binding name reported to the credential broker for colonyd runs. */
export const PI_RUNTIME_BINDING_NAME = "colonyd";

export const COLONY_ADVISOR_NAME = "colony-critic";
export const COLONY_ADVISOR_INSTRUCTIONS = [
  "Emit nit for feedback that can wait.",
  "Emit blocker only when the primary must stop or change course immediately.",
  "Never emit concern.",
].join(" ");
export function shouldEnableColonyAdvisor(
  role: AgentRuntimeRole,
  journal: "run" | "transient",
  hasAdvisorModel: boolean,
): boolean {
  return hasAdvisorModel && role !== "architect" && journal === "run";
}

function provisionAdvisorAgentDir(model: PiModelSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-advisor-"));
  try {
    const instructions = COLONY_ADVISOR_INSTRUCTIONS.replaceAll("\n", " ");
    writeFileSync(
      join(dir, "WATCHDOG.yml"),
      [
        "advisors:",
        `  - name: ${COLONY_ADVISOR_NAME}`,
        `    model: ${model.provider}/${model.id}:xhigh`,
        "    tools: [read, grep, glob]",
        "    instructions: |",
        `      ${instructions}`,
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Run `fn` inside the run root's span context when one was bound, so SDK
 * GenAI spans (invoke_agent/chat/execute_tool) nest under it. Without a
 * traceContext this is a plain call — no tracing code path activates.
 */
function inTraceContext<T>(environment: AgentRunEnvironment, fn: () => T): T {
  return environment.traceContext
    ? context.with(environment.traceContext, fn)
    : fn();
}

/** Colony's configured levels as they appear in colony.yaml. */
type ColonyThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

/**
 * Colony's config carries plain strings; the SDK's selector values come from its
 * own effort enum, so map rather than cast.
 */
const SDK_THINKING_LEVELS = {
  off: ThinkingLevel.Off,
  minimal: ThinkingLevel.Minimal,
  low: ThinkingLevel.Low,
  medium: ThinkingLevel.Medium,
  high: ThinkingLevel.High,
  xhigh: ThinkingLevel.XHigh,
} as const satisfies Record<ColonyThinkingLevel, SdkThinkingLevel>;

function toSdkThinkingLevel(level: ColonyThinkingLevel): SdkThinkingLevel {
  return SDK_THINKING_LEVELS[level];
}
export interface PiRoleProfile {
  readonly role: AgentRuntimeRole;
  readonly kind: PiRunner["kind"];
  readonly sandboxPrefix: string;
  readonly systemPrompt: (packet?: AgentRuntimePacket) => string;
  finalizerPrompt: (packet: AgentRuntimePacket) => string;
  readonly schemaName:
    | "implementer_completion"
    | "architect_decomposition"
    | "reviewer_verdict"
    | "plan_review_verdict";
  readonly typeboxSchema: unknown;
  readonly submitTool: (
    capture: (value: unknown) => void,
    sizeGate?: ArchitectSizeGate,
    packet?: AgentRuntimePacket,
  ) => ToolDefinition;
  readonly validate: (value: unknown) => string[] | null;
  readonly defaultTools: readonly string[];
  readonly defaultThinkingLevel:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";
  readonly defaultLimits: {
    readonly maxTurns: number;
  };
  readonly workspaceMode: PiWorkspaceMode;
  readonly skipPromptWithoutWorkTools?: boolean;
  readonly requireRepositoryInspection?: boolean;
  /**
   * The submit gate checks, from inside the sandbox, that the envelope's
   * head_sha is what origin/<branch> points at. A claimed-but-unpushed
   * commit becomes a tool error the model can fix, not a burned attempt.
   */
  readonly verifyPushedHead?: boolean;
  /**
   * When set and non-empty for a packet, run() drives the staged pipeline:
   * one fresh session per stage with typed hand-offs (architect-stages.ts).
   * Roles without it, and packets it returns [] for, keep the single-prompt
   * shape.
   */
  readonly stages?: (packet: AgentRuntimePacket) => readonly ArchitectStage[];
}

export interface PiBaseAgentRunnerOptions extends PiRunnerBaseOptions {
  readonly tools?: readonly string[];
  readonly logToolArgs?: boolean;
  /**
   * Lazy architect size gate: called per session, not per runner, so each
   * session reads fresh runs history. `undefined` means no gate — the
   * submit tool accepts any decomposition shape.
   */
  readonly architectSizeGate?: () => ArchitectSizeGate | undefined;
  /** Workspace-loss probe cadence; tests shrink it. Default 120s. */
  readonly workspaceProbeIntervalMs?: number;
}

export { WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME, WEB_TOOL_NAMES };

export function buildRunTools(
  profile: PiRoleProfile,
  options: PiBaseAgentRunnerOptions,
): { customTools: ToolDefinition[]; toolNames: readonly string[] } {
  const workTools = options.tools ?? profile.defaultTools;
  // capture helper for submit tool — caller replaces it with real capture when wiring session
  const dummyCapture = () => {};
  const submitTool = profile.submitTool(dummyCapture);
  const baseCustomTools: ToolDefinition[] = [submitTool];
  const baseToolNames = [...workTools, submitTool.name];
  if (!options.webTools) {
    return { customTools: baseCustomTools, toolNames: baseToolNames };
  }
  const webTools = createWebTools(options.webTools);
  return {
    customTools: [...baseCustomTools, ...webTools],
    toolNames: [...baseToolNames, "web_search", "web_fetch"],
  };
}

export class PiBaseAgentRunner implements PiRunner {
  readonly kind: PiRunner["kind"];
  private readonly activeRuns = new Map<string, ActivePiRun>();

  constructor(
    private readonly profile: PiRoleProfile,
    private readonly options: PiBaseAgentRunnerOptions = {},
  ) {
    this.kind = profile.kind;
  }

  async run(request: PiRunRequest): Promise<PiRunResult> {
    if (request.environment.role !== this.profile.role) {
      throw new Error(
        `${this.constructor.name} requires a ${this.profile.role} run`,
      );
    }

    const runId = request.runId;
    const sandboxId = createSandboxId(this.profile.sandboxPrefix);
    // Runs-table write-back: report the sandbox id the moment the sandbox is
    // created, so a crash after this point still leaves an adoptable row.
    this.options.onSandboxId?.(runId, sandboxId);
    const broker = runnerBroker(this.options);
    // The run's own provider token; redaction secrets for persisted evidence.
    const runToken = packetRepo(request.packet)?.credentials?.token;
    let model = await resolvePiModel(request, this.options.model);
    const models = [model, ...(this.options.fallbackModels ?? [])];
    const availableModels =
      this.options.advisorModel &&
      !models.some(
        (candidate) =>
          candidate.provider === this.options.advisorModel!.provider &&
          candidate.id === this.options.advisorModel!.id,
      )
        ? [...models, this.options.advisorModel]
        : models;
    const workTools = this.options.tools ?? this.profile.defaultTools;
    let failureReason: string | undefined;
    let timeoutTriggered = false;
    /**
     * Tools whose successful use proves the agent actually looked at the
     * repository. Deliberately broad: grok-4.6 (Cursor-native priors)
     * inspected a diff with glob + no-op edit probes + reading subagents,
     * never once calling read/grep, and the old read/grep-only gate
     * rejected its honest submits three times in one run (2026-09-01,
     * b2896f12: 216 edit probes, 45 minutes, no envelope).
     */
    const REPOSITORY_INSPECTION_TOOLS: Record<string, true> = {
      read: true,
      grep: true,
      glob: true,
      bash: true,
      task: true,
    };
    let repositoryInspected = false;
    let cancellationTriggered = false;

    let cwd: string;
    // Provisioning keeps its own catch: it returns a reasoned PiRunResult
    // instead of throwing. The teardown try below starts after this so a
    // failed provision never runs rmSync on an unassigned cwd.
    try {
      cwd = provisionProfileWorkspace(
        runId,
        request.packet,
        this.profile,
        this.options,
      );
    } catch (err) {
      return {
        sandboxId,
        envelope: { __unfinished: true },
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    let clearTimeoutGuard: (() => void) | undefined;
    let capturedEnvelope: unknown;
    let resolveCapturedEnvelope: (() => void) | undefined;
    const capturedEnvelopePromise = new Promise<void>((resolve) => {
      resolveCapturedEnvelope = resolve;
    });
    let session: AgentSession | undefined;
    /** Path of the session JSONL that becomes the transcript artifact. */
    let runSessionFile: string | undefined;
    let handle: SandboxHandle | undefined;
    let advisorAgentDir: string | undefined;
    let workspaceProbe: (() => void) | undefined;
    // Live subagent sessions. A parent abort that leaves children running
    // can never finalize: the task tool awaits a child that nobody told to
    // stop, so the wedge watchdog, the run wall, and cancellation all fire
    // and the run lives on as a lease-heartbeating zombie (71 minutes past
    // a 45-minute wall, 2026-09-01). Every parent abort drains this first.
    const childSessions = new Set<AgentSession>();
    const abortRun = async (): Promise<void> => {
      for (const child of childSessions) {
        try {
          await child.abort();
        } catch {
          // a child already gone is the goal
        }
      }
      await session?.abort();
    };

    const stages = this.profile.stages?.(request.packet) ?? [];
    const sizeGate = this.options.architectSizeGate?.();
    const submitTool = this.profile.submitTool(
      (value) => {
        capturedEnvelope = value;
        resolveCapturedEnvelope?.();
      },
      sizeGate,
      request.packet,
    );
    const submissionCaptured = (): boolean => capturedEnvelope !== undefined;
    const submissionPromise = (): Promise<void> => capturedEnvelopePromise;

    // The try starts here rather than at the run body so its finally also
    // covers the setup window: a throw in between (discoverAuthStorage on an
    // unreachable auth store, broker resolution, no credentialed provider)
    // would otherwise strand /tmp/colony-pi-runs/<runId> with its
    // credential-bearing PACKET.json — the leak this teardown exists to prevent.
    try {
      // The credential broker owns key resolution; the registry only needs a
      // provider record per model so `createAgentSession` can resolve selectors.
      // Advisor-only providers are optional: an unavailable advisor must not
      // turn a healthy primary run into a failed run. Providers used by the
      // primary chain keep the existing failure behavior.
      const primaryProviders = new Set(
        models.map((candidate) => candidate.provider),
      );
      const providerApiKeys = new Map<string, string>();
      for (const candidate of availableModels) {
        if (providerApiKeys.has(candidate.provider)) continue;
        const advisorOnlyProvider =
          this.options.advisorModel?.provider === candidate.provider &&
          !primaryProviders.has(candidate.provider);
        let apiKey: string | undefined;
        try {
          apiKey = await broker.resolve({
            provider: candidate.provider,
            capability: `agent.llm.${candidate.provider}.invoke`,
            bindingName: PI_RUNTIME_BINDING_NAME,
            environment: request.environment,
          });
        } catch (error) {
          if (!advisorOnlyProvider) throw error;
          this.options.logger?.warn?.(
            {
              runId,
              provider: candidate.provider,
              error: error instanceof Error ? error.message : String(error),
            },
            "pi_advisor_credential_unavailable",
          );
          continue;
        }
        if (!apiKey) continue;
        providerApiKeys.set(candidate.provider, apiKey);
      }
      const authStorage = await discoverAuthStorage();
      const modelRegistry = new ModelRegistry(authStorage);
      for (const [provider, apiKey] of providerApiKeys) {
        const providerModels = availableModels.filter(
          (candidate) => candidate.provider === provider,
        );
        const first = providerModels[0]!;
        modelRegistry.registerProvider(provider, {
          apiKey,
          api: first.api,
          baseUrl: first.baseUrl,
          models: providerModels.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            api: candidate.api,
            baseUrl: candidate.baseUrl,
            reasoning: candidate.reasoning,
            input: [...candidate.input],
            cost: { ...candidate.cost },
            // Every Colony route is an OpenAI-compatible gateway that speaks
            // native tool calls. Left unset, the registry falls back to the
            // SDK's reference catalog, which marks the qwen family
            // supportsTools=false; the agent loop then inlines the tool
            // catalog as prompt text and sends no `tools` array, and the model
            // answers with literal `<tool_call>` text that nothing parses
            // (qwen3.8-max as reviewer, 0/4 with zero tool calls, 2026-09-03).
            supportsTools: true,
            // Colony's config leaves these nullable; the registry wants numbers.
            contextWindow: candidate.contextWindow ?? 128_000,
            maxTokens: candidate.maxTokens ?? 16_384,
            headers: candidate.headers,
          })),
        });
      }

      // Specs are registered above; the registry owns compat resolution, so ask it
      // for the real models the session and its fallbacks will use.
      let resolvedModels = models.flatMap((candidate) => {
        const resolved = modelRegistry.find(candidate.provider, candidate.id);
        return resolved ? [resolved] : [];
      });
      // A saturated primary overflows to the dispatch-selected fallback model.
      const startIndex = resolvedModels.findIndex(
        (candidate) => candidate.id === request.environment.startModelId,
      );
      if (startIndex > 0) {
        const [startModel] = resolvedModels.splice(startIndex, 1);
        resolvedModels.unshift(startModel!);
      }
      const primaryModel = resolvedModels[0];
      if (!primaryModel) {
        throw new Error(
          `no credentialed provider for ${models[0]?.provider}/${models[0]?.id}; check the ${request.environment.role} agent's provider auth`,
        );
      }
      const resolvedAdvisorModel = this.options.advisorModel
        ? modelRegistry.find(
            this.options.advisorModel.provider,
            this.options.advisorModel.id,
          )
        : undefined;
      // Advisor resolution is optional. A missing registry entry means the
      // primary session runs without an advisor; never add an alternate model
      // to the advisor role or alter Colony's primary fallback chain.

      const { customTools, toolNames } = (() => {
        // use the session-local capture so the submit envelope is wired
        const base = [submitTool];
        if (!this.options.webTools)
          return {
            customTools: base,
            toolNames: [...workTools, submitTool.name],
          };
        // web_search is the SDK builtin (SearXNG provider). Its provider reads
        // the GLOBAL settings singleton, not the session's isolated settings,
        // so the endpoint travels via SEARXNG_ENDPOINT - process-wide, which is
        // correct: one gateway per daemon. Colony supplies only web_fetch; the
        // SDK folds URL fetching into its builtin read, which Colony replaces
        // with the sandbox-routed one.
        process.env["SEARXNG_ENDPOINT"] = this.options.webTools.searxngUrl;
        const webTools = createWebTools(this.options.webTools);
        return {
          customTools: [...base, ...webTools],
          toolNames: [...workTools, submitTool.name, "web_search", "web_fetch"],
        };
      })();
      const steering = new RunSteering({
        runTimeoutMs: this.options.runTimeoutMs ?? DEFAULT_PI_RUN_TIMEOUT_MS,
        branch: packetRepo(request.packet)?.branch,
      });
      clearTimeoutGuard = withRunTimeout(
        runId,
        this.options.runTimeoutMs,
        () => void abortRun(),
        () => {
          failureReason ??= "timeout_without_envelope";
          timeoutTriggered = true;
        },
      );
      this.activeRuns.set(runId, {
        abort: async () => {
          cancellationTriggered = true;
          await abortRun();
        },
      });

      let sandboxTools: readonly ToolDefinition[] = [];
      if (this.options.engine) {
        handle = await this.options.engine.provision(
          buildSandboxLaunchProfile(toSandboxRole(this.profile.role)),
          cwd,
        );
        sandboxTools = buildSandboxTools(handle, cwd, {
          ...(this.options.auditSink
            ? { auditSink: this.options.auditSink }
            : {}),
          runId,
          // The packet's repo token is a live secret: every exec ledger string
          // must redact it, not just the well-known token patterns.
          runToken,
          // Ledger emission is best-effort: a sink that throws must be
          // visible in the run logs, never swallowed silently.
          logger: this.options.logger,
        });

        workspaceProbe = installWorkspaceProbe(handle, {
          intervalMs: this.options.workspaceProbeIntervalMs,
          logger: this.options.logger,
          runId,
          sandboxId,
          onLost: () => {
            failureReason ??= WORKSPACE_LOST_REASON;
            void abortRun();
          },
        });
      }
      const deadline =
        Date.now() + (this.options.runTimeoutMs ?? DEFAULT_PI_RUN_TIMEOUT_MS);
      const thinkingLevel = toSdkThinkingLevel(
        this.options.thinkingLevel ?? this.profile.defaultThinkingLevel,
      );
      const advisorConfigured =
        resolvedAdvisorModel !== undefined && this.profile.role !== "architect";
      if (advisorConfigured) {
        advisorAgentDir = provisionAdvisorAgentDir(this.options.advisorModel!);
      }
      const advisorContextFiles = advisorConfigured
        ? discoverContextFiles(cwd)
        : undefined;
      const advisorWorkspaceTree = advisorConfigured
        ? buildWorkspaceTree(cwd)
        : undefined;
      const buildSettings = (enableAdvisor: boolean) =>
        Settings.isolated({
          "compaction.enabled": true,
          "retry.enabled": true,
          // The SDK's auto-retry re-prompts a transient failure same-model
          // with exponential backoff, defaulting to 10 attempts. On a dead
          // leg that spends the whole run wall inside one prompt, so bound
          // the budget the leg may burn before the runner sees an error.
          "retry.maxRetries": this.options.retryMaxRetries ?? 4,
          "todo.enabled": true,
          "todo.reminders": true,
          "goal.enabled": true,
          "advisor.enabled": enableAdvisor,
          ...(enableAdvisor
            ? {
                "advisor.syncBacklog": "off" as const,
                "retry.modelFallback": false,
                modelRoles: {
                  advisor: `${this.options.advisorModel!.provider}/${this.options.advisorModel!.id}:xhigh`,
                },
              }
            : {}),
          // A dead upstream stream must become a bounded retry, not a
          // run-long hang: muse once sat 31 minutes emitting zero tokens and
          // only the wall clock killed the run. Defaults are -1 (disabled).
          // First-event tolerates worst-case local prefill on a loaded GPU;
          // idle after first token means the generation died mid-stream.
          "providers.streamFirstEventTimeoutSeconds": 600,
          "providers.streamIdleTimeoutSeconds": 300,
          // Builtin web_search: pin the provider so auto-detection never
          // wanders to keyed providers this daemon does not carry.
          ...(this.options.webTools
            ? { "providers.webSearchOrder": ["searxng"] }
            : {}),
        });
      /**
       * Shared session wiring for the run session and its subagents: same
       * models, broker credentials, restriction, and deadline. Only the
       * prompt and tool set vary, so a child can never reach anything the
       * parent could not.
       */
      const buildSessionOptions = async (perSession: {
        systemPrompt: string;
        customTools: ToolDefinition[];
        toolNames: string[];
        prewalk: boolean;
        /**
         * Which journal this session persists to. Only the run's own session
         * is evidence, so it alone gets the file-backed manager whose path
         * teardown uploads as the transcript artifact. Subagent and critic
         * sessions are in-memory: they exist to answer one question, and a
         * shared SessionManager path would have every sibling appending to
         * (and rewriting) the run's transcript.
         */
        journal: "run" | "transient";
      }) => {
        const useAdvisor = shouldEnableColonyAdvisor(
          this.profile.role,
          perSession.journal,
          resolvedAdvisorModel !== undefined,
        );
        return {
          // Advisor discovery must not walk the untrusted checkout: a project
          // WATCHDOG.yml could otherwise add mutating advisors that bypass the
          // sandbox. The supplied SessionManager still owns the real workspace
          // cwd used by tools and prompts.
          cwd: useAdvisor ? advisorAgentDir! : cwd,
          ...(useAdvisor
            ? {
                agentDir: advisorAgentDir!,
                contextFiles: await advisorContextFiles,
                workspaceTree: await advisorWorkspaceTree,
              }
            : {}),
          model: primaryModel,
          thinkingLevel,
          authStorage,
          modelRegistry,
          getApiKey: async (candidate: { provider: string }) =>
            broker.resolve({
              provider: candidate.provider,
              capability: `agent.llm.${candidate.provider}.invoke`,
              bindingName: PI_RUNTIME_BINDING_NAME,
              environment: request.environment,
            }),
          scopedModels: [
            ...resolvedModels.map((candidate) => ({ model: candidate })),
            ...(resolvedAdvisorModel ? [{ model: resolvedAdvisorModel }] : []),
          ],
          settings: buildSettings(useAdvisor),
          systemPrompt: perSession.systemPrompt,
          // Only the run session is file-backed: the SDK writes its JSONL under
          // the durable sessions root (<sessionsDir>/sessions/<runId>/session.jsonl)
          // so teardown can persist it as a transcript artifact, and the agent's
          // git worktree never sees the file. Without a configured root the run
          // dir is the sessions root, which is why teardown deletes the scratch
          // copy (or relocates it when the upload failed) before removing it.
          sessionManager:
            perSession.journal === "run"
              ? await createFileSessionManager(
                  this.options.sessionsDir ?? cwd,
                  runId,
                  cwd,
                )
              : SessionManager.inMemory(cwd),
          // Colony owns every tool a run may call: the sandbox-routed file/shell
          // tools when an engine is configured, plus the role's submit tool and
          // any web tools. Nothing may reach the daemon's own filesystem.
          customTools: perSession.customTools,
          toolNames: perSession.toolNames,
          restrictToolNames: true,
          allowRestrictedCustomTools: true,
          // Arming prewalk keeps the todo tool active, which is what drives omp's
          // mid-run progress reminders.
          ...(perSession.prewalk ? { prewalk: { target: primaryModel } } : {}),
          deadline,
          enableMCP: false,
          enableLsp: false,
          disableExtensionDiscovery: true,
          // GenAI spans only when the caller bound a run root span context:
          // without it no tracing code path may activate. The SDK parents its
          // spans on whatever OTEL context is active at prompt time, which the
          // prompt wrappers below bind to environment.traceContext.
          ...(request.environment.traceContext !== undefined
            ? {
                telemetry: {
                  attributes: { "colony.run_id": runId },
                },
              }
            : {}),
        };
      };

      // Subagents: Colony's own task tool. The SDK's native one is unusable
      // here - its child sessions do not inherit customTools/restrictToolNames,
      // which would hand a nested agent builtin tools on the daemon's own
      // filesystem. Children share the sandbox handle and workspace, get the
      // work tools but never submit/goal/task (depth 1, no envelope authority).
      const childCustomTools = [
        ...customTools.filter((tool) => tool.name !== submitTool.name),
        ...sandboxTools,
      ];
      const childToolNames = [
        ...toolNames.filter((name) => name !== submitTool.name),
        ...sandboxTools.map((tool) => tool.name),
      ];
      const subagentTool = createSubagentTool(async ({ prompt, signal }) => {
        const child = await createAgentSession(
          await buildSessionOptions({
            systemPrompt: buildSubagentSystemPrompt(),
            customTools: childCustomTools,
            toolNames: childToolNames,
            prewalk: false,
            journal: "transient",
          }),
        );
        let report = "";
        const unsubscribeReport = child.session.agent.subscribe((event) => {
          if (
            event.type === "message_end" &&
            event.message.role === "assistant"
          ) {
            const text = event.message.content
              .filter(
                (block): block is { type: "text"; text: string } =>
                  block.type === "text" && typeof block.text === "string",
              )
              .map((block) => block.text)
              .join("\n");
            if (text.trim()) report = text;
          }
        });
        const unsubscribeChildGuards = installRunGuards(
          child.session.agent,
          `${runId}.sub`,
          {
            maxTurns: 24,
            logger: this.options.logger,
            abort: () => void child.session.abort(),
          },
        );
        childSessions.add(child.session);
        // The parent's turn abort (wall, watchdog, cancel) reaches the child
        // directly; the tool's own race returns the parent's turn regardless.
        const abortChild = () => void child.session.abort();
        signal?.addEventListener("abort", abortChild, { once: true });
        if (signal?.aborted) abortChild();
        try {
          await inTraceContext(request.environment, () =>
            child.session.prompt(prompt, { expandPromptTemplates: false }),
          );
          await child.session.agent.waitForIdle();
          return report;
        } finally {
          signal?.removeEventListener("abort", abortChild);
          childSessions.delete(child.session);
          unsubscribeChildGuards();
          unsubscribeReport();
          child.session.dispose();
        }
      });

      // Goal mode: the hidden goal tool is only registered by the SDK when
      // restrictToolNames is off, so Colony registers the SDK's own GoalTool
      // as a custom tool bound to this session through a late-bound adapter
      // (tools are constructed before the session exists).
      const goalTool = new GoalTool({
        getGoalRuntime: () => session?.goalRuntime,
        getGoalModeState: () => session?.getGoalModeState(),
      } as never) as unknown as ToolDefinition;

      // The SDK's injected goal context claims goal completion "ends the
      // autonomous loop" - in Colony only an accepted submission does. This
      // block outranks that copy; without it a model could complete the goal
      // and stop without submitting.
      const harnessBlock = [
        "# Goal and delegation",
        '- Your packet objective is registered as this session\'s persistent goal. Completing the goal NEVER replaces the submit call: your run counts only when a submission is accepted. Call goal({op:"complete"}) at most once, only after your submission is accepted.',
        "- The task tool runs subagents in this same workspace with your work tools (but no submit authority). Delegate independent, self-contained subtasks - research, scoped edits, running checks - and parallelize by issuing several task calls in one turn.",
      ].join("\n");

      const result = await createAgentSession(
        await buildSessionOptions({
          systemPrompt: `${this.profile.systemPrompt(request.packet)}\n\n${steering.budgetBlock()}\n\n${harnessBlock}`,
          customTools: [
            ...customTools,
            ...sandboxTools,
            goalTool,
            subagentTool,
          ],
          toolNames: [
            ...toolNames,
            ...sandboxTools.map((tool) => tool.name),
            goalTool.name,
            subagentTool.name,
          ],
          prewalk: true,
          // Staged roles bring their own file-backed first session; this one
          // is never prompted and must not own the transcript path.
          journal: stages.length > 0 ? "transient" : "run",
        }),
      );
      session = result.session;
      if (stages.length === 0) {
        runSessionFile = session.sessionManager.getSessionFile() ?? undefined;
      }
      // The packet objective becomes the session's persistent goal: omp's
      // goal runtime re-injects it across turns, accounts token/time usage,
      // and enforces evidence-based completion discipline.
      session.setGoalModeState({
        enabled: true,
        mode: "active",
        goal: {
          id: runId,
          objective: packetObjective(request.packet),
          status: "active",
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
      await session.sendGoalModeContext({ deliverAs: "nextTurn" });
      if (timeoutTriggered) {
        void abortRun();
      }
      let zeroOutputStalled = false;
      // Jiggle before failover: a provider that rate-limits by going mute
      // often recovers within a minute. Give the CURRENT model two wakes with
      // increasing backoff before abandoning it; any real progress (a tool
      // call) resets the budget.
      const ZERO_OUTPUT_JIGGLES = 2;
      const jiggleBackoffMs = this.options.jiggleBackoffMs ?? 15_000;
      // Quota exhaustion (weekly caps, frequency limits with a distant reset)
      // never recovers inside a jiggle window: fail over immediately instead
      // of burning wake cycles against a benched provider. "No deployments
      // available" is litellm's cooldown wrapper - once a leg is benched every
      // caller sees it instead of the underlying quota error, and waiting out
      // 300s cooldown windows one empty turn at a time is never better than
      // moving to the fallback (the next run returns to the primary anyway).
      // Includes credit exhaustion: a 402 "Insufficient balance" from a
      // provider leg (Cline, 2026-09-03) is a dead leg, not a model failure.
      const QUOTA_ERROR_RE =
        /usage exceeds|frequency limit|weekly.*(usage|limit)|quota.*(exceed|exhaust|reset)|rate.?limit.*reset at|no deployments available|insufficient balance|\b402\b/i;
      // A leg whose only answers are transport/5xx failures is dead, but a
      // single blip is not a verdict: five consecutive connection-class
      // errors on the CURRENT model with no successful turn in between is
      // the budget. Deliberately free of 429/rate-limit/quota/overload arms —
      // those are the quota path's job and must keep failing over at once.
      const CONNECTION_ERROR_RE =
        /\b50[0234]\b|\b529\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|connection.{0,12}(?:error|refused|reset|closed|timed? ?out)|service unavailable|bad gateway|gateway timeout|upstream.{0,8}(?:connect|request failed)|no capacity|network error|stream stall|Request timed out\b/i;
      const CONNECTION_RETRY_PROMPT =
        "The previous model request failed with a transient provider connection error. Continue the same task from the current conversation and workspace state, then submit the required envelope.";
      const MODEL_CONNECTION_ERROR_LIMIT = 5;
      // Scoped to messages produced by the CURRENT model: an errored turn
      // survives in history across setModel, and tool-call/reasoning turns
      // don't append plain assistant text - so an unscoped "newest assistant
      // error" can be a different model's quota 403 from twenty minutes ago
      // (2026-08-31: grok was demoted mid-run on kimi's stale error).
      let quotaScanFloor = 0;
      // Runtime failover honors the same per-model caps dispatch does. A
      // dead primary used to funnel every concurrent run onto the first
      // fallback regardless of its cap (five reviews on a cap-1 leg, all
      // walling; 2026-09-01). Skip capped candidates; when every remaining
      // candidate is capped, take the next one anyway - a slow lane beats
      // no lane, and dispatch will have seen the cap by the next attempt.
      const nextCandidateIndex = (fromIndex: number): number | null => {
        if (fromIndex + 1 >= resolvedModels.length) return null;
        const hasCapacity = this.options.modelHasCapacity;
        if (hasCapacity) {
          for (let i = fromIndex + 1; i < resolvedModels.length; i += 1) {
            if (hasCapacity(resolvedModels[i]!.id)) return i;
          }
          this.options.logger?.warn?.(
            { runId, from: resolvedModels[fromIndex]?.id },
            "pi_model_fallback_all_capped",
          );
        }
        return fromIndex + 1;
      };
      const lastAssistantQuotaError = (): string | null => {
        const messages = session?.agent.state.messages ?? [];
        for (let i = messages.length - 1; i >= quotaScanFloor; i -= 1) {
          const message = messages[i]!;
          if (message.role !== "assistant") continue;
          const err = message.errorMessage;
          return err && QUOTA_ERROR_RE.test(err) ? err : null;
        }
        return null;
      };
      // Consecutive connection-class errors on the CURRENT model. Reset by
      // any non-error turn and by every setModel, so a leg's budget is never
      // spent by its predecessor.
      let connectionErrors = 0;
      let lastConnectionError: string | undefined;
      let jigglesUsed = 0;
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));
      // Rich evidence rows flow through the run's own audit sink; the
      // provider token is a live secret, so it rides the redaction secrets.
      const evidence = new RunEvidenceCollector(
        runId,
        this.options.auditSink,
        runToken ? [runToken] : [],
      );
      // Re-steering normally fires only when a model stops. A near-deadline
      // reminder also reaches models that keep investigating, but does not
      // advertise a time allowance: models given a number tend to spend it.
      const SUBMIT_DEADLINE_NUDGE_MS = 8 * 60_000;
      let lastDeadlineNudgeAt = Number.NEGATIVE_INFINITY;
      const takeSubmitDeadlineNudge = (force = false): string | null => {
        if (submissionCaptured()) return null;
        const remainingMs = deadline - Date.now();
        if (remainingMs > SUBMIT_DEADLINE_NUDGE_MS) return null;
        if (!force && performance.now() - lastDeadlineNudgeAt < 60_000)
          return null;
        lastDeadlineNudgeAt = performance.now();
        return [
          "<system-reminder>",
          `The submission window is closing. Stop investigating NOW and call ${activeStage?.submitName ?? submitTool.name} with the envelope built from what you already know. An unsubmitted run counts for nothing; a conservative submitted verdict beats a perfect unsubmitted one.`,
          "</system-reminder>",
        ].join("\n");
      };
      /**
       * Arm one session with the run's guards and hooks: turn/usd limits,
       * stall and connection accounting, repository-inspection gating on the
       * submit tool, broker authorization, tool observation, and the
       * deadline/drift nudges. The run session and every stage session get
       * the same protection; only the submit tool name varies.
       */
      let activeStage: { name: string; submitName: string } | null = null;
      // Active model index survives past the prompt loop so submit-gate
      // failures and stall recovery share one fallback chain.
      let index = 0;
      let unchangedRepairSubmissions = 0;
      const packetRepair = request.packet.repair;
      const rejectedRepairHead =
        packetRepair &&
        typeof packetRepair === "object" &&
        "rejected_head_sha" in packetRepair &&
        typeof packetRepair.rejected_head_sha === "string"
          ? packetRepair.rejected_head_sha
          : undefined;
      const armSession = (
        target: AgentSession,
        submitName: string,
        observeInspection?: (toolName: string, args: unknown) => void,
      ): (() => void) => {
        const unsubscribeGuards = installRunGuards(target.agent, runId, {
          maxTurns:
            this.options.maxTurns ?? this.profile.defaultLimits.maxTurns,
          logger: this.options.logger,
          evidence,
          redactSecrets: runToken ? [runToken] : [],
          rejectionToolName: submitName,
          onFailure: (reason) => {
            failureReason ??= reason;
          },
          abort: () => void abortRun(),
          onZeroOutputStall: () => {
            zeroOutputStalled = true;
          },
          // The only place connectionErrors moves. A successful turn - even a
          // text-only one the runner would otherwise never see - proves the
          // leg is alive and clears the budget.
          onAssistantMessage: (message) => {
            if (message.stopReason !== "error") {
              connectionErrors = 0;
              lastConnectionError = undefined;
              return;
            }
            if (
              message.errorMessage !== undefined &&
              CONNECTION_ERROR_RE.test(message.errorMessage)
            ) {
              connectionErrors += 1;
              lastConnectionError = message.errorMessage;
            }
          },
        });
        const previousBeforeToolCall = target.agent.beforeToolCall;
        target.agent.beforeToolCall = async (context, signal) => {
          const base = await previousBeforeToolCall?.(context, signal);
          if (base?.block) return base;
          if (
            context.toolCall.name === submitName &&
            this.profile.requireRepositoryInspection &&
            !repositoryInspected
          ) {
            return {
              block: true,
              reason:
                "Inspect the repository first: read or search real source/test files (read, grep, glob, bash, or a task subagent) before submitting.",
            };
          }
          if (
            context.toolCall.name === submitName &&
            rejectedRepairHead !== undefined
          ) {
            const args = context.args as {
              status?: unknown;
              head_sha?: unknown;
            };
            if (
              args.status === "complete" &&
              args.head_sha === rejectedRepairHead
            ) {
              unchangedRepairSubmissions += 1;
              if (unchangedRepairSubmissions >= 2) {
                const nextIndex = nextCandidateIndex(index);
                if (nextIndex === null) {
                  failureReason = "repair_no_change";
                  void abortRun();
                } else {
                  const from = resolvedModels[index]?.id;
                  index = nextIndex;
                  const next = resolvedModels[index]!;
                  unchangedRepairSubmissions = 0;
                  await target.setModel(next);
                  this.options.logger?.warn?.(
                    {
                      runId,
                      from,
                      to: next.id,
                      error: "repair_no_change",
                    },
                    "pi_model_fallback",
                  );
                }
              }
              return {
                block: true,
                reason: `Submission rejected: reviewer repair did not change rejected head ${rejectedRepairHead}. Commit and push a fix, then submit the new remote head SHA.`,
              };
            }
          }
          if (
            context.toolCall.name === submitName &&
            this.profile.verifyPushedHead &&
            handle
          ) {
            const args = context.args as {
              head_sha?: unknown;
              branch?: unknown;
            };
            if (
              typeof args.head_sha === "string" &&
              typeof args.branch === "string"
            ) {
              const pushed = await verifyPushedHead(
                handle,
                args.branch,
                args.head_sha,
              );
              if (pushed && !pushed.ok) {
                return {
                  block: true,
                  reason: pushed.remoteHead
                    ? `origin/${args.branch} is at ${pushed.remoteHead}, not the envelope's head_sha ${args.head_sha}. Push your final commit (git push origin ${args.branch}), confirm with git ls-remote --heads origin ${args.branch}, then submit the SHA that is actually on the remote.`
                    : `origin/${args.branch} does not exist on the remote. Push the work branch (git push origin ${args.branch}) before submitting.`,
                };
              }
            }
          }
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

        const previousAfterToolCall = target.agent.afterToolCall;
        target.agent.afterToolCall = async (context, signal) => {
          const base = await previousAfterToolCall?.(context, signal);
          if (
            !context.isError &&
            REPOSITORY_INSPECTION_TOOLS[context.toolCall.name] === true
          ) {
            repositoryInspected = true;
          }
          if (!context.isError) {
            observeInspection?.(context.toolCall.name, context.args);
          }
          jigglesUsed = 0;
          connectionErrors = 0;
          steering.observeToolCall(
            context.toolCall.name,
            context.args,
            context.isError,
          );
          // Rejection evidence lives in the guard subscription's end-event
          // seam (see pi-runner-common): it is the only path that sees TypeBox
          // argument-validation refusals, which never reach afterToolCall.
          this.options.logger?.info?.(
            {
              runId,
              sandboxId,
              tool: context.toolCall.name,
              args: this.options.logToolArgs ? context.args : undefined,
              isError: context.isError,
            },
            "pi_tool_observation",
          );
          const deadlineNudge = takeSubmitDeadlineNudge();
          const repeatNudge = deadlineNudge
            ? null
            : steering.takeRepeatFailureNudge();
          const nudge =
            deadlineNudge ?? repeatNudge ?? steering.takeDriftNudge();
          if (!nudge) return base;
          // Fold the reminder in ahead of the tool's own output, the way the omp
          // harness delivers non-interrupting rule reminders.
          this.options.logger?.warn?.(
            { runId, sandboxId, stage: activeStage?.name },
            deadlineNudge
              ? "pi_submit_deadline_nudge"
              : repeatNudge
                ? "pi_repeat_failure_nudge"
                : "pi_drift_nudge",
          );
          return {
            ...base,
            content: [
              { type: "text" as const, text: nudge },
              ...(base?.content ?? context.result.content),
            ],
          };
        };
        return unsubscribeGuards;
      };
      const unsubscribeGuards = armSession(session, submitTool.name);

      try {
        const MODEL_FAILED_PROMPT =
          "The previous model failed. Continue the same task from the current conversation and workspace state, then submit the required envelope.";
        /**
         * Send one prompt to a session and classify how it ended. Resolves
         * true when the caller should stop advancing candidates (a submission
         * landed, the model loop stopped cleanly, or the wall closed);
         * false when the caller should fall over to the next candidate
         * (`index` already steered so the caller's `+= 1` lands on it);
         * throws fatal errors (last candidate, classified failure, operator
         * cancellation).
         */
        const driveSession = async (
          target: AgentSession,
          prompt: string,
          candidate: { provider: string; id: string },
          landed: () => boolean,
          landedPromise: Promise<void>,
        ): Promise<boolean> => {
          try {
            const promptPromise = inTraceContext(request.environment, () =>
              target.prompt(prompt, { expandPromptTemplates: false }),
            ).catch((err) => {
              if (landed()) return;
              throw err;
            });
            await Promise.race([promptPromise, landedPromise]);
            if (!landed()) {
              await waitForIdleOrCapturedEnvelope(target.agent, landedPromise);
            }
            const lastMessage = target.agent.state.messages.at(-1);
            if (
              !landed() &&
              lastMessage?.role === "assistant" &&
              lastMessage.stopReason === "error"
            ) {
              throw new Error(
                lastMessage.errorMessage ??
                  `model ${candidate.provider}/${candidate.id} failed`,
              );
            }
            return true;
          } catch (err) {
            // The run-timeout guard aborts the session, which rejects the
            // in-flight prompt with the SDK's opaque "This operation was
            // aborted". Rethrowing loses the classified reason and skips
            // envelope finalization, so a run that did the work but ran out
            // of budget reports nothing. Stop the model loop instead and let
            // finalization salvage a submission. Operator cancellation still
            // ends the run immediately.
            if (cancellationTriggered) throw err;
            if (timeoutTriggered) return true;
            // The candidate loop advances by one; steer it onto the next
            // candidate WITH capacity (see nextCandidateIndex).
            const nextIndex = nextCandidateIndex(index);
            const next =
              nextIndex === null ? undefined : resolvedModels[nextIndex];
            const advance = () => {
              if (nextIndex !== null) index = nextIndex - 1;
              return false;
            };
            const errText = err instanceof Error ? err.message : String(err);
            if (CONNECTION_ERROR_RE.test(errText)) {
              // Under budget this was a blip: the model stays and the
              // continuation loop re-prompts it. Over budget the leg is
              // dead, and with no candidate left the failure is
              // classified as infrastructure so the run keeps its
              // attempt budget instead of throwing past finalization.
              if (connectionErrors < MODEL_CONNECTION_ERROR_LIMIT) return true;
              if (!next) {
                failureReason = `provider_connection_failure: ${(
                  lastConnectionError ?? errText
                ).slice(0, 160)}`;
                return false;
              }
              this.options.logger?.warn?.(
                {
                  runId,
                  from: candidate.id,
                  to: next.id,
                  error: `provider_connection_exhausted: ${(
                    lastConnectionError ?? errText
                  ).slice(0, 160)}`,
                },
                "pi_model_fallback",
              );
              return advance();
            }
            if (!next || failureReason !== undefined) {
              throw err;
            }
            this.options.logger?.warn?.(
              { runId, from: candidate.id, to: next.id, error: errText },
              "pi_model_fallback",
            );
            return advance();
          }
        };

        /**
         * The staged pipeline (architect-stages.ts): one fresh session per
         * stage, armed like the run session, its tools narrowed to what the
         * stage may do plus its own submit tool. A stage ends only by that
         * tool; past its turn cap the tools collapse to the submit tool
         * alone. The planning stage discovers and drafts; successful
         * inspection inputs become a compact manifest for the independent
         * verifier. The verifier's submission is the run envelope.
         */
        const runStagedPlan = async (): Promise<void> => {
          const artifacts: {
            inspection?: InspectionManifest;
            draft?: StageArtifacts["draft"];
          } = {};
          const inspectedPaths = new Set<string>();
          const searches = new Set<string>();
          const commands = new Set<string>();
          const stringArg = (
            args: unknown,
            key: string,
          ): string | undefined => {
            if (!args || typeof args !== "object" || !(key in args)) return;
            const value = Reflect.get(args, key);
            return typeof value === "string" && value.trim()
              ? value.trim()
              : undefined;
          };
          const observeInspection = (toolName: string, args: unknown): void => {
            if (toolName === "read" || toolName === "ls") {
              const path = stringArg(args, "path");
              if (path) inspectedPaths.add(path);
              return;
            }
            if (toolName === "grep") {
              const pattern = stringArg(args, "pattern");
              const path = stringArg(args, "path");
              if (pattern)
                searches.add(path ? `${pattern} @ ${path}` : pattern);
              return;
            }
            if (toolName === "glob") {
              const path = stringArg(args, "path");
              if (path) searches.add(`glob: ${path}`);
              return;
            }
            if (toolName === "bash") {
              const command = stringArg(args, "command");
              if (command) commands.add(command);
            }
          };
          const inspectionManifest = (): InspectionManifest => ({
            paths: [...inspectedPaths],
            searches: [...searches],
            commands: [...commands],
          });
          // The run session was built for the single-prompt shape; stages
          // bring their own. Drop it so its guards never fire on a stage.
          unsubscribeGuards();
          session?.dispose();
          session = undefined;
          const lastStage = stages.at(-1)!;
          for (const stage of stages) {
            if (
              timeoutTriggered ||
              cancellationTriggered ||
              failureReason !== undefined
            )
              return;
            const isFinal = stage === lastStage;
            let stageCaptured: unknown;
            let resolveStage: (() => void) | undefined;
            const stagePromise = isFinal
              ? capturedEnvelopePromise
              : new Promise<void>((resolve) => {
                  resolveStage = resolve;
                });
            const stageSubmit = isFinal
              ? submitTool
              : stage.submitTool((value) => {
                  stageCaptured = value;
                  resolveStage?.();
                });
            const landed = (): boolean =>
              isFinal ? submissionCaptured() : stageCaptured !== undefined;
            const stageSandboxTools =
              stage.tools === "inspect"
                ? sandboxTools
                : sandboxTools.filter((tool) => tool.name === "read");
            const stageCustomTools = [
              stageSubmit,
              ...stageSandboxTools,
              ...customTools.filter(
                (tool) =>
                  tool.name !== submitTool.name && tool.name !== goalTool.name,
              ),
              ...(stage.subagents ? [subagentTool] : []),
            ];
            // Without a sandbox engine the work tools are SDK builtins that
            // exist only by name. Listing custom tools alone would leave an
            // inspection stage unable to read.
            const stageBuiltinNames = toolNames.filter(
              (name) =>
                name !== submitTool.name &&
                name !== goalTool.name &&
                (stage.tools === "inspect" || name === "read"),
            );
            const stageSession = (
              await createAgentSession(
                await buildSessionOptions({
                  systemPrompt: stage.systemPrompt,
                  customTools: stageCustomTools,
                  toolNames: [
                    ...stageCustomTools.map((tool) => tool.name),
                    ...stageBuiltinNames,
                  ],
                  prewalk: false,
                  // The first stage owns the durable transcript; later stages
                  // are compact checks whose artifacts are logged below.
                  journal: stage === stages[0] ? "run" : "transient",
                }),
              )
            ).session;
            session = stageSession;
            if (stage === stages[0]) {
              runSessionFile =
                stageSession.sessionManager.getSessionFile() ?? undefined;
            }
            activeStage = { name: stage.name, submitName: stageSubmit.name };
            const unarm = armSession(
              stageSession,
              stageSubmit.name,
              stage.name === "plan" ? observeInspection : undefined,
            );
            // Turn cap: past it, only the submit tool remains. Measured on
            // grok-4.6: a phase-budget trigger never fired because it does
            // not overstay phases, it overstays the run; turns are the unit
            // it actually spends.
            let assistantTurns = 0;
            let capped = false;
            const forceStageSubmit = (turn: number): void => {
              try {
                stageSession.setForcedToolChoice(stageSubmit.name);
                this.options.logger?.info?.(
                  { runId, sandboxId, stage: stage.name, turn },
                  "architect_stage_submit_forced",
                );
              } catch (err: unknown) {
                this.options.logger?.warn?.(
                  {
                    runId,
                    sandboxId,
                    stage: stage.name,
                    turn,
                    error: err instanceof Error ? err.message : String(err),
                  },
                  "architect_stage_submit_force_failed",
                );
              }
            };
            const unsubscribeTurns = stageSession.agent.subscribe((event) => {
              if (
                event.type !== "message_end" ||
                event.message.role !== "assistant"
              )
                return;
              assistantTurns += 1;
              if (capped || landed() || assistantTurns < stage.turnCap) return;
              capped = true;
              this.options.logger?.warn?.(
                { runId, sandboxId, stage: stage.name, turns: assistantTurns },
                "architect_stage_turn_cap",
              );
              forceStageSubmit(assistantTurns);
              stageSession
                .setActiveToolsByName([stageSubmit.name])
                .catch((err: unknown) => {
                  this.options.logger?.warn?.(
                    {
                      runId,
                      stage: stage.name,
                      error: err instanceof Error ? err.message : String(err),
                    },
                    "architect_stage_turn_cap_failed",
                  );
                });
            });
            this.options.logger?.info?.(
              {
                runId,
                sandboxId,
                stage: stage.name,
                model: resolvedModels[index]?.id,
              },
              "architect_stage",
            );
            const startedAt = performance.now();
            try {
              // Candidate loop for this stage: the first prompt carries the
              // stage's turn; a fallback candidate continues the same session.
              let prompt = stage.prompt({
                packet: request.packet,
                ...artifacts,
              });
              for (; index < resolvedModels.length; index += 1) {
                const candidate = resolvedModels[index]!;
                if (stageSession.model?.id !== candidate.id) {
                  await stageSession.setModel(candidate);
                  jigglesUsed = 0;
                  connectionErrors = 0;
                  quotaScanFloor = stageSession.agent.state.messages.length;
                  prompt = MODEL_FAILED_PROMPT;
                }
                if (
                  await driveSession(
                    stageSession,
                    prompt,
                    candidate,
                    landed,
                    stagePromise,
                  )
                )
                  break;
              }
              // A model that stopped without submitting gets two direct
              // steers with nothing but the submit tool in reach.
              for (
                let steer = 0;
                steer < 2 &&
                !landed() &&
                !timeoutTriggered &&
                !cancellationTriggered &&
                failureReason === undefined;
                steer += 1
              ) {
                await stageSession
                  .setActiveToolsByName([stageSubmit.name])
                  .catch(() => undefined);
                forceStageSubmit(assistantTurns);
                const candidate = resolvedModels[index] ?? resolvedModels[0]!;
                await driveSession(
                  stageSession,
                  `This stage ends only when you call ${stageSubmit.name}. Call it now with what you have; nothing else you write counts.`,
                  candidate,
                  landed,
                  stagePromise,
                );
              }
            } finally {
              unsubscribeTurns();
              unarm();
              activeStage = null;
              this.options.logger?.info?.(
                {
                  runId,
                  sandboxId,
                  stage: stage.name,
                  turns: assistantTurns,
                  minutes:
                    Math.round((performance.now() - startedAt) / 6000) / 10,
                  landed: landed(),
                  artifact: isFinal ? undefined : stageCaptured,
                },
                "architect_stage_done",
              );
            }
            if (!landed()) {
              if (
                failureReason === undefined &&
                !timeoutTriggered &&
                !cancellationTriggered
              ) {
                failureReason = `architect_stage_${stage.name}_no_submission`;
              }
              return;
            }
            if (!isFinal) {
              artifacts.draft = stageCaptured as StageArtifacts["draft"];
              artifacts.inspection = inspectionManifest();
              stageSession.dispose();
              if (session === stageSession) session = undefined;
            }
          }
        };

        if (stages.length > 0) {
          await runStagedPlan();
        } else if (
          workTools.length > 0 ||
          !this.profile.skipPromptWithoutWorkTools
        ) {
          const activeSession = session;
          if (!activeSession) throw new Error("run session missing");
          for (; index < resolvedModels.length; index += 1) {
            const candidate = resolvedModels[index]!;
            if (index > 0) {
              await activeSession.setModel(candidate);
              jigglesUsed = 0;
              connectionErrors = 0;
              quotaScanFloor = activeSession.agent.state.messages.length;
            }
            // The packet prompt once, or just the failure prompt on a later
            // candidate - the packet is already in the continued conversation.
            const prompt =
              index > 0
                ? MODEL_FAILED_PROMPT
                : buildPacketPrompt(request.packet);
            if (
              await driveSession(
                activeSession,
                prompt,
                candidate,
                submissionCaptured,
                submissionPromise(),
              )
            )
              break;
          }
        }
        // A model that stops without submitting gets re-steered instead of
        // finalized on the spot: restate the objective, the clock, and whether
        // anything is pushed. The omp harness does the same on incomplete work,
        // and Colony's run data showed models idling out with the task unfinished.
        // A mute model (consecutive zero-output turns; the guard only flags,
        // never aborts - an empty turn resolves the prompt naturally) gets
        // jiggled first: dedicated wake prompts with increasing backoff outside
        // the drift-steer budget, then failover to the next candidate on the
        // same session.
        while (
          stages.length === 0 &&
          (workTools.length > 0 || !this.profile.skipPromptWithoutWorkTools) &&
          !submissionCaptured() &&
          !timeoutTriggered &&
          !cancellationTriggered &&
          failureReason === undefined
        ) {
          let prompt: string;
          if (connectionErrors >= MODEL_CONNECTION_ERROR_LIMIT) {
            // The leg settled its whole budget in transport errors. Fail over
            // now instead of spending jiggle backoff on a dead upstream (it
            // can be mute AND unreachable, so this precedes the stall path
            // the way a quota verdict forces the jiggle skip).
            const from = resolvedModels[index]?.id;
            const nextIndex = nextCandidateIndex(index);
            const next =
              nextIndex === null ? undefined : resolvedModels[nextIndex];
            if (!next || nextIndex === null) {
              failureReason = `provider_connection_failure: ${(
                lastConnectionError ?? "repeated connection errors"
              ).slice(0, 160)}`;
              break;
            }
            index = nextIndex;
            jigglesUsed = 0;
            connectionErrors = 0;
            await session.setModel(next);
            quotaScanFloor = session.agent.state.messages.length;
            this.options.logger?.warn?.(
              {
                runId,
                from,
                to: next.id,
                error: `provider_connection_exhausted: ${(
                  lastConnectionError ?? "repeated connection errors"
                ).slice(0, 160)}`,
              },
              "pi_model_fallback",
            );
            prompt = CONNECTION_RETRY_PROMPT;
          } else if (connectionErrors > 0) {
            // Under budget: a blip, not a dead leg. Re-prompt the same model
            // so one transient never costs a configured candidate.
            prompt = CONNECTION_RETRY_PROMPT;
          } else if (zeroOutputStalled) {
            zeroOutputStalled = false;
            const quotaError = lastAssistantQuotaError();
            if (quotaError) jigglesUsed = ZERO_OUTPUT_JIGGLES;
            if (jigglesUsed < ZERO_OUTPUT_JIGGLES) {
              jigglesUsed += 1;
              this.options.logger?.warn?.(
                {
                  runId,
                  model: resolvedModels[index]?.id,
                  jiggle: jigglesUsed,
                  backoffMs: jiggleBackoffMs * jigglesUsed,
                },
                "pi_zero_output_jiggle",
              );
              await sleep(jiggleBackoffMs * jigglesUsed);
            } else if (nextCandidateIndex(index) !== null) {
              const from = resolvedModels[index]?.id;
              index = nextCandidateIndex(index)!;
              jigglesUsed = 0;
              connectionErrors = 0;
              const next = resolvedModels[index]!;
              await session.setModel(next);
              quotaScanFloor = session.agent.state.messages.length;
              this.options.logger?.warn?.(
                {
                  runId,
                  from,
                  to: next.id,
                  error: quotaError
                    ? `provider_quota_exhausted: ${quotaError.slice(0, 160)}`
                    : "zero_output_stall",
                },
                "pi_model_fallback",
              );
            } else {
              failureReason = "zero_output_stall";
              break;
            }
            prompt =
              "Your last several replies were empty. Continue the task from the current conversation and workspace state; if the work is already complete, submit the required envelope now.";
          } else {
            const steer = steering.takeContinuationSteer(
              packetObjective(request.packet),
            );
            if (!steer) break;
            this.options.logger?.warn?.(
              { runId, sandboxId },
              "pi_run_continuation",
            );
            // A model that stops without tool calls never sees the
            // tool-result nudge (qwen wrote a 13k-token prose review with
            // zero tool calls and no submit, 2026-09-01); the stop-steer is
            // its only channel, so the clock rides here too, unthrottled.
            const deadlineOnStop = takeSubmitDeadlineNudge(true);
            prompt = deadlineOnStop ? `${deadlineOnStop}\n\n${steer}` : steer;
          }
          try {
            const waitPromise = submissionPromise();
            const steerPromise = inTraceContext(request.environment, () =>
              session!.prompt(prompt, {
                expandPromptTemplates: false,
              }),
            ).catch((err: unknown) => {
              if (submissionCaptured()) return;
              throw err;
            });
            await Promise.race([steerPromise, waitPromise]);
            if (!submissionCaptured()) {
              await waitForIdleOrCapturedEnvelope(session.agent, waitPromise);
            }
          } catch (err) {
            if (cancellationTriggered) throw err;
            // A transient thrown out of the steer prompt is the same blip the
            // counter already tracks: stay on the model and re-prompt. Only a
            // settled leg (budget spent) or a non-connection failure ends the
            // loop, and neither is logged as a continuation failure.
            if (
              connectionErrors > 0 &&
              connectionErrors < MODEL_CONNECTION_ERROR_LIMIT
            ) {
              continue;
            }
            this.options.logger?.warn?.(
              {
                runId,
                error: err instanceof Error ? err.message : String(err),
              },
              "pi_run_continuation_failed",
            );
            break;
          }
        }
      } finally {
        unsubscribeGuards();
      }

      if (
        capturedEnvelope === undefined &&
        this.profile.requireRepositoryInspection &&
        !repositoryInspected
      ) {
        failureReason ??= "repository_inspection_required";
      } else if (capturedEnvelope === undefined) {
        // No separate finalizer pass: a rejected submission surfaces as a tool
        // error and keeps the session open, the SDK retries transport failures,
        // and the continuation steer re-prompts a model that stopped early. If
        // the run still produced no envelope, colonyd retries the attempt.
        failureReason ??= "finalize_no_submission";
      }
    } finally {
      // Audit capture is strictly post-decision: the PiRunResult below (and
      // the envelope/failureReason it reads) was decided before this block,
      // and nothing here may change it. Every step is guarded so a failure
      // in one never skips the others. Transcript capture adds well under
      // the 5s teardown budget: one readFileSync, a redact pass, and a
      // gzipSync of the run's JSONL.
      clearTimeoutGuard?.();
      workspaceProbe?.();
      // (1) Transcript capture. Must precede dispose (dispose drops the
      //     session manager that owns the file path) and the run-dir removal
      //     in (3). A session that never reached disk leaves no transcript,
      //     which capture treats as a silent skip, not an outage.
      // The file-backed session is the run session, or the first stage of a
      // staged run—not whichever session happens to be live at teardown.
      const sessionFile =
        runSessionFile ?? session?.sessionManager.getSessionFile() ?? undefined;
      let uploaded = false;
      if (sessionFile && this.options.auditSink) {
        try {
          uploaded =
            (await captureTranscript({
              runId,
              sessionFile,
              secrets: runToken ? [runToken] : [],
              sink: this.options.auditSink,
            })) !== undefined;
        } catch (err) {
          // captureTranscript is contractually non-throwing; a foreign sink
          // that throws must still never unwind the teardown.
          this.options.auditSink.appendEvent(
            runId,
            "transcript_upload_failed",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
        // A failed upload keeps its transcript. captureTranscript already
        // leaves the source in place; only relocate it when the journal
        // lives under cwd, because the sweep in (3) would otherwise delete
        // the only remaining copy. Production pins the journal under
        // sessionsDir — outside the run dir — and moving that copy into
        // ephemeral /tmp would lose it on a pod restart.
        if (!uploaded && isInsideDir(cwd, sessionFile)) {
          quarantineTranscript(runId, sessionFile);
        }
      }
      // (1.5) Workspace capture: for developer and reviewer roles only (credential-carrying roles).
      // Architect and validate roles are skipped, as are scratch-mode runs (no repo / base_commit).
      const repoRef = packetRepo(request.packet);
      if (
        (this.profile.role === "developer" ||
          this.profile.role === "reviewer") &&
        repoRef &&
        handle &&
        this.options.auditSink
      ) {
        try {
          await captureWorkspace({
            runId,
            handle,
            repo: repoRef,
            parentSha: repoRef.base_commit,
            secrets: runToken ? [runToken] : [],
            sink: this.options.auditSink,
          });
        } catch (err) {
          this.options.auditSink.appendEvent(
            runId,
            "workspace_capture_failed",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      // (2) Ordered teardown.
      session?.dispose();
      this.activeRuns.delete(runId);
      // (3) Leak fix: /tmp/colony-pi-runs/<runId> (or <scratchDir>/<runId>)
      //     must not survive the run. Removing only cwd never touches a shared
      //     override root, and a failed upload has already parked its copy
      //     outside this tree.
      rmSync(cwd, { recursive: true, force: true });
      if (advisorAgentDir) {
        rmSync(advisorAgentDir, { recursive: true, force: true });
      }
      // (4) The sandbox pod goes last: destroy after the workspace is gone.
      await handle?.destroy();
    }

    return {
      sandboxId,
      envelope: capturedEnvelope ?? { __unfinished: true },
      reason:
        capturedEnvelope === undefined
          ? (failureReason ?? "finalize_no_submission")
          : undefined,
    };
  }

  async cancel(runId: string): Promise<void> {
    await this.activeRuns.get(runId)?.abort();
  }
}

function provisionProfileWorkspace(
  runId: string,
  packet: AgentRuntimePacket,
  profile: PiRoleProfile,
  options: PiBaseAgentRunnerOptions,
): string {
  if (profile.workspaceMode === "scratch") {
    return provisionScratchDir(runId, packet, options.scratchDir);
  }
  return provisionRepoWorkspace(runId, packet, {
    ...options,
    requireCredentials: true,
  });
}

/** True when `file` is inside `dir`, so `rmSync(dir)` would delete it. */
function isInsideDir(dir: string, file: string): boolean {
  const rel = relative(resolve(dir), resolve(file));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Map a pi runner role onto a sandbox launch role. The architect is a
 * read-only developer-style role, so it shares the reviewer sandbox profile
 * (no branch-push capability, read-only root filesystem).
 */
function toSandboxRole(role: AgentRuntimeRole): SandboxRole {
  return role === "developer" ? "developer" : "reviewer";
}

function zodValidator(
  schema: z.ZodTypeAny,
): (value: unknown) => string[] | null {
  return (value) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return null;
    return parsed.error.issues.map(
      (issue) =>
        `${issue.path.length ? issue.path.join(".") : "<root>"}: ${issue.message}`,
    );
  };
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

export const DEFAULT_ARCHITECT_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

export const DEVELOPER_ROLE_PROFILE: PiRoleProfile = {
  role: "developer",
  kind: "pi-coding-agent",
  sandboxPrefix: "pi-dev",
  systemPrompt: buildImplementerSystemPrompt,
  finalizerPrompt: buildImplementerFinalizerPrompt,
  schemaName: "implementer_completion",
  typeboxSchema: implementerCompletionEnvelopeTypeBox,
  submitTool: createImplementerSubmitTool,
  validate: zodValidator(implementerCompletionV2Schema),
  defaultTools: DEFAULT_DEVELOPER_TOOLS,
  defaultThinkingLevel: "medium",
  defaultLimits: { maxTurns: 60 },
  workspaceMode: "repo-required",
  skipPromptWithoutWorkTools: true,
  verifyPushedHead: true,
};

export const ARCHITECT_ROLE_PROFILE: PiRoleProfile = {
  stages: (packet) =>
    isArchitectExtensionPacket(packet) ? [] : buildArchitectStages(),
  role: "architect",
  kind: "pi-architect",
  sandboxPrefix: "pi-architect",
  systemPrompt: (packet) =>
    isArchitectExtensionPacket(packet)
      ? buildArchitectExtensionSystemPrompt()
      : buildArchitectSystemPrompt(),
  finalizerPrompt: buildArchitectFinalizerPrompt,
  schemaName: "architect_decomposition",
  typeboxSchema: architectDecompositionEnvelopeTypeBox,
  submitTool: (capture, sizeGate, packet) =>
    isArchitectExtensionPacket(packet)
      ? createArchitectExtensionSubmitTool(
          capture as Parameters<typeof createArchitectExtensionSubmitTool>[0],
          extensionTasksFromPacket(packet),
        )
      : createArchitectSubmitTool(capture, sizeGate),
  validate: zodValidator(architectDecompositionV2Schema),
  defaultTools: DEFAULT_ARCHITECT_TOOLS,
  defaultThinkingLevel: "medium",
  defaultLimits: { maxTurns: 80 },
  workspaceMode: "repo-required",
  requireRepositoryInspection: true,
};

export const REVIEWER_ROLE_PROFILE: PiRoleProfile = {
  role: "reviewer",
  kind: "pi-reviewer",
  sandboxPrefix: "pi-reviewer",
  systemPrompt: buildReviewerSystemPrompt,
  finalizerPrompt: buildReviewerFinalizerPrompt,
  schemaName: "reviewer_verdict",
  typeboxSchema: reviewerVerdictEnvelopeTypeBox,
  submitTool: createReviewerSubmitTool,
  validate: zodValidator(reviewerVerdictV2Schema),
  defaultTools: DEFAULT_ARCHITECT_TOOLS,
  defaultThinkingLevel: "medium",
  defaultLimits: { maxTurns: 20 },
  workspaceMode: "repo-required",
  requireRepositoryInspection: true,
};

/**
 * The plan reviewer: the code reviewer's loop applied to an architect's plan
 * before any implementer starts. Runs on the reviewer model chain with the
 * repository checked out, so the plan is judged against the code it names.
 */
export const PLAN_REVIEWER_ROLE_PROFILE: PiRoleProfile = {
  role: "plan_reviewer",
  kind: "pi-plan-reviewer",
  sandboxPrefix: "pi-plan-reviewer",
  systemPrompt: () => PLAN_REVIEW_SYSTEM_PROMPT,
  finalizerPrompt: () =>
    "Review is complete. Submit exactly one plan_review_verdict by calling submit_plan_review_verdict: request_changes needs findings that name the task and the correction; approve needs `inspected` and a summary of at least 80 chars.",
  schemaName: "plan_review_verdict",
  typeboxSchema: planReviewVerdictTypeBox,
  submitTool: (capture) => createPlanReviewSubmitTool(capture),
  validate: zodValidator(PlanReviewVerdictV1),
  defaultTools: DEFAULT_ARCHITECT_TOOLS,
  defaultThinkingLevel: "medium",
  defaultLimits: { maxTurns: 40 },
  workspaceMode: "repo-required",
  requireRepositoryInspection: true,
};
