import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
  type AgentSession,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import type { Context } from "@opentelemetry/api";
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
import type {
  PiRunRequest,
  PiRunResumeRequest,
  PiRunResult,
  PiRunner,
} from "./pi-adapter.js";
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
  sanitizeSecret,
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
import { RunSteering, packetObjective } from "./run-steering.js";
import {
  captureTranscript,
  quarantineTranscript,
} from "./transcript-capture.js";
import { captureWorkspace } from "./workspace-capture.js";
import { buildSandboxTools } from "./sandbox-tools.js";
import {
  buildPiSession,
  CONNECTION_ERROR_RE,
  MODEL_CONNECTION_ERROR_LIMIT,
  type PiRunState,
} from "./pi-session.js";
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
import { inTraceContext } from "./trace-context.js";
import { PI_RUNTIME_BINDING_NAME, toSandboxRole } from "./pi-roles.js";
import {
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
  ImplementerCompletionV2 as implementerCompletionV2Schema,
  ReviewerVerdictV2 as reviewerVerdictV2Schema,
  PlanReviewVerdictV1,
} from "@colony/schemas";

export type PiWorkspaceMode = "repo-required" | "scratch";

// The advisor helpers live with the session builder that consumes them;
// re-exported because callers and tests import them from the runner.
export {
  COLONY_ADVISOR_INSTRUCTIONS,
  COLONY_ADVISOR_NAME,
  shouldEnableColonyAdvisor,
} from "./pi-session.js";
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
    return this.executeRun(request);
  }

  /**
   * Continue a run whose journal and sandbox survived the process that
   * started it. Everything except the first prompt is the fresh path's
   * machinery: same builder, same guards, same prompt loop.
   */
  async resume(request: PiRunResumeRequest): Promise<PiRunResult> {
    return this.executeRun(request, {
      handle: request.handle,
      sessionManager: request.sessionManager,
      steerPrompt: request.steerPrompt,
      ...(request.onRunning ? { onRunning: request.onRunning } : {}),
      ...(request.traceContext ? { traceContext: request.traceContext } : {}),
    });
  }

  private async executeRun(
    request: PiRunRequest,
    resumed?: {
      /** The sandbox the pre-restart run was working in, re-attached. */
      handle: SandboxHandle;
      /** The reloaded journal the continuation builds on. */
      sessionManager: SessionManager;
      /** The turn that opens the resumed segment. */
      steerPrompt: string;
      /** Reports the resumed loop live, once its first prompt is driving. */
      onRunning?: () => void;
      /**
       * Root span context this segment nests under; a resumed run supplies
       * its FRESH root, never the pre-restart trace's context.
       */
      traceContext?: Context;
    },
  ): Promise<PiRunResult> {
    if (request.environment.role !== this.profile.role) {
      throw new Error(
        `${this.constructor.name} requires a ${this.profile.role} run`,
      );
    }

    const runId = request.runId;
    /**
     * The id the run is known by everywhere it is persisted. `connect()`
     * re-attaches by exactly this string, so it must be the sandbox's OWN
     * id: a runner-minted parallel identity would leave every adopted run
     * unresumable. A run that provisions no sandbox has no handle to take
     * an id from, so the minted fallback stands for it.
     */
    let sandboxId = resumed
      ? resumed.handle.sandboxId
      : createSandboxId(this.profile.sandboxPrefix);
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
    /**
     * The run's live state, owned here and shared with the session builder:
     * its guards and hooks write back into it and the prompt loop below
     * reads it, so one object is the single source of truth across both.
     */
    const state: PiRunState = {
      repositoryInspected: false,
      zeroOutputStalled: false,
      timeoutTriggered: false,
      cancellationTriggered: false,
      jigglesUsed: 0,
      connectionErrors: 0,
      quotaScanFloor: 0,
    };

    /**
     * The span context every prompt nests under: a resumed segment supplies
     * its own FRESH root, so its work is never attributed to the trace the
     * pre-restart process was emitting into.
     */
    const traceContext = resumed?.traceContext;
    let cwd: string;
    // Provisioning keeps its own catch: it returns a reasoned PiRunResult
    // instead of throwing. The teardown try below starts after this so a
    // failed provision never runs rmSync on an unassigned cwd.
    if (resumed) {
      cwd = provisionScratchDir(runId, request.packet, this.options.scratchDir);
    } else {
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
    }
    let clearTimeoutGuard: (() => void) | undefined;
    let capturedEnvelope: unknown;
    let resolveCapturedEnvelope: (() => void) | undefined;
    let submissionRejectionReason: string | undefined;
    const capturedEnvelopePromise = new Promise<void>((resolve) => {
      resolveCapturedEnvelope = resolve;
    });
    let session: AgentSession | undefined;
    /** Path of the session JSONL that becomes the transcript artifact. */
    let runSessionFile: string | undefined;
    let handle: SandboxHandle | undefined;
    /**
     * Set once the session is built: the advisor's private agent dir lives
     * outside the checkout and must be removed in teardown.
     */
    let removeAdvisorDir: (() => void) | undefined;
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
    /**
     * The stages this run will actually be driven through. A resumed run
     * drives none of them: the pipeline opens at its first stage and every
     * later stage runs on a transient journal, so re-entering it on a
     * reloaded transcript re-sends a prompt the agent already answered -
     * a duplicate plan for an architect that was mid-verify. Its reloaded
     * run session carries the role's own submit tool and system prompt, so
     * it can finish from where it stopped.
     */
    const pipeline = resumed ? [] : stages;
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
            thinking: candidate.thinking,
            input: [...candidate.input],
            cost: { ...candidate.cost },
            // Every Colony route is an OpenAI-compatible gateway that speaks
            // native tool calls. Left unset, the registry falls back to the
            // SDK's reference catalog, which marks the qwen family
            // supportsTools=false; the agent loop then inlines the tool
            // catalog as prompt text and sends no `tools` array, and the model
            // answers with literal `<tool_call>` text that nothing parses
            // (qwen3.8-max as reviewer, 0/4 with zero tool calls, 2026-09-03).
            supportsTools: candidate.supportsTools ?? true,
            // Preserve route-level compatibility policy across registry
            // resolution and runtime fallback (e.g. disabling reasoning when
            // a named tool choice is forced on a thinking-incompatible relay).
            compat: candidate.compat,
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
        role: this.profile.role,
        runTimeoutMs: this.options.runTimeoutMs ?? DEFAULT_PI_RUN_TIMEOUT_MS,
        branch: packetRepo(request.packet)?.branch,
      });
      clearTimeoutGuard = withRunTimeout(
        runId,
        this.options.runTimeoutMs,
        () => void abortRun(),
        () => {
          state.failureReason ??= "timeout_without_envelope";
          state.timeoutTriggered = true;
        },
      );
      this.activeRuns.set(runId, {
        abort: async () => {
          state.cancellationTriggered = true;
          await abortRun();
        },
      });

      let sandboxTools: readonly ToolDefinition[] = [];
      if (resumed) {
        // The sandbox outlived the process, not the workspace: the journal
        // is reloaded but this process's cwd is fresh, so the tools below
        // operate on the scratch dir, not on the pre-restart path.
        handle = resumed.handle;
      } else if (this.options.engine) {
        handle = await this.options.engine.provision(
          buildSandboxLaunchProfile(toSandboxRole(this.profile.role)),
          cwd,
        );
        sandboxId = handle.sandboxId;
      }
      if (handle) {
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
            state.failureReason ??= WORKSPACE_LOST_REASON;
            void abortRun();
          },
        });
        // Runs-table write-back, deliberately AFTER provision: a minted id
        // reported before the sandbox exists would persist an identity no
        // engine re-attaches by, leaving the run adoptable only on paper.
        // Crash safety still holds - it precedes the first agent prompt.
        this.options.onSandboxId?.(runId, sandboxId);
      }
      /** The stage whose tools and submit name the nudges currently name. */
      let activeStage: { name: string; submitName: string } | null = null;
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

      // A reviewer repair that re-submits the head the reviewer already
      // rejected changed nothing: two such submissions fall over to the next
      // candidate, and exhausting them fails the run rather than scoring a
      // repair that never happened.
      let unchangedRepairSubmissions = 0;
      const packetRepair = request.packet.repair;
      const rejectedRepairHead =
        packetRepair &&
        typeof packetRepair === "object" &&
        "rejected_head_sha" in packetRepair &&
        typeof packetRepair.rejected_head_sha === "string"
          ? packetRepair.rejected_head_sha
          : undefined;
      // Active model index survives past the prompt loop so submit-gate
      // failures and stall recovery share one fallback chain.
      let index = 0;

      /**
       * The ONE session construction, shared by the fresh-start and the
       * resume path: tools, guards, hooks, goal-mode wiring, and
       * createAgentSession. A resumed agent is registered identically to a
       * fresh one, so the two paths cannot drift apart.
       */
      const built = await buildPiSession(
        {
          runId,
          sandboxId,
          cwd,
          packet: request.packet,
          environment: request.environment,
          ...(traceContext ? { traceContext } : {}),
          sessionManager:
            resumed?.sessionManager ??
            (await createFileSessionManager(
              this.options.sessionsDir ?? cwd,
              runId,
              cwd,
            )),
          submitTool,
          customTools,
          toolNames,
          primaryModel,
          scopedModels: resolvedModels,
          authStorage,
          modelRegistry,
          broker,
          steering,
          sandboxTools,
          systemPrompt: this.profile.systemPrompt(request.packet),
          // Staged roles bring their own file-backed first session; this one
          // is never prompted and must not own the transcript path.
          journal: pipeline.length > 0 ? "transient" : "run",
          role: this.profile.role,
          ...(resolvedAdvisorModel !== undefined
            ? { advisorModel: resolvedAdvisorModel }
            : {}),
          ...(this.options.advisorModel !== undefined
            ? { advisorSpec: this.options.advisorModel }
            : {}),
        },
        {
          ...(this.options.webTools ? { webTools: this.options.webTools } : {}),
          ...(this.options.thinkingLevel
            ? { thinkingLevel: this.options.thinkingLevel }
            : {}),
          defaultThinkingLevel: this.profile.defaultThinkingLevel,
          maxTurns:
            this.options.maxTurns ?? this.profile.defaultLimits.maxTurns,
          ...(this.options.runTimeoutMs
            ? { runTimeoutMs: this.options.runTimeoutMs }
            : {}),
          ...(this.options.retryMaxRetries !== undefined
            ? { retryMaxRetries: this.options.retryMaxRetries }
            : {}),
          ...(this.options.logger ? { logger: this.options.logger } : {}),
          ...(this.options.auditSink
            ? { auditSink: this.options.auditSink }
            : {}),
          ...(this.options.logToolArgs
            ? { logToolArgs: this.options.logToolArgs }
            : {}),
          ...(runToken ? { runToken } : {}),
          ...(this.options.scratchDir !== undefined
            ? { scratchDir: this.options.scratchDir }
            : {}),
        },
        {
          state,
          requireRepositoryInspection:
            this.profile.requireRepositoryInspection === true,
          ...(this.profile.verifyPushedHead
            ? { verifyPushedHead: this.profile.verifyPushedHead }
            : {}),
          ...(handle ? { handle } : {}),
          ...(rejectedRepairHead !== undefined
            ? {
                repairRejection: {
                  rejectedHead: rejectedRepairHead,
                  onUnchanged: () => {
                    // Two unchanged submissions is a repair that never
                    // happened: fall over to the next candidate with
                    // capacity, or end the run when none is left.
                    unchangedRepairSubmissions += 1;
                    if (unchangedRepairSubmissions < 2)
                      return { action: "reject" as const };
                    const nextCandidate = nextCandidateIndex(index);
                    if (nextCandidate === null)
                      return { action: "exhausted" as const };
                    const from = resolvedModels[index]?.id;
                    index = nextCandidate;
                    unchangedRepairSubmissions = 0;
                    this.options.logger?.warn?.(
                      {
                        runId,
                        from,
                        to: resolvedModels[index]!.id,
                        error: "repair_no_change",
                      },
                      "pi_model_fallback",
                    );
                    return {
                      action: "failover" as const,
                      model: resolvedModels[index]!,
                    };
                  },
                },
              }
            : {}),
          abortRun,
          childSessions,
          submissionCaptured,
          submitNameOf: () => activeStage?.submitName ?? submitTool.name,
          stageNameOf: () => activeStage?.name,
        },
      );
      session = built.session;
      removeAdvisorDir = built.removeAdvisorDir;
      if (pipeline.length === 0 && !resumed) {
        runSessionFile = session.sessionManager.getSessionFile() ?? undefined;
      }
      const { armSession, takeSubmitDeadlineNudge, lastAssistantQuotaError } =
        built;
      const { evidence, goalTool, subagentTool, buildSessionOptions } = built;
      if (state.timeoutTriggered) {
        void abortRun();
      }
      const unsubscribeGuards = built.unsubscribeGuards;
      // Jiggle before failover: a provider that rate-limits by going mute
      // often recovers within a minute. Give the CURRENT model two wakes with
      // increasing backoff before abandoning it; any real progress (a tool
      // call) resets the budget.
      const ZERO_OUTPUT_JIGGLES = 2;
      const jiggleBackoffMs = this.options.jiggleBackoffMs ?? 15_000;
      const CONNECTION_RETRY_PROMPT =
        "The previous model request failed with a transient provider connection error. Continue the same task from the current conversation and workspace state, then submit the required envelope.";
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));

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
            if (state.cancellationTriggered) throw err;
            if (state.timeoutTriggered) return true;
            // A guard/runtime failure is already the decisive cause. The
            // session abort rejects the prompt with an opaque SDK error;
            // never relabel that error as a provider failure.
            if (state.failureReason !== undefined) return true;
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
              if (state.connectionErrors < MODEL_CONNECTION_ERROR_LIMIT)
                return true;
              if (!next) {
                state.failureReason = `provider_connection_failure: ${(
                  state.lastConnectionError ?? errText
                ).slice(0, 160)}`;
                return false;
              }
              this.options.logger?.warn?.(
                {
                  runId,
                  from: candidate.id,
                  to: next.id,
                  error: `provider_connection_exhausted: ${(
                    state.lastConnectionError ?? errText
                  ).slice(0, 160)}`,
                },
                "pi_model_fallback",
              );
              return advance();
            }
            if (!next) {
              // No candidate left to steer to: classify the protocol failure
              // instead of throwing past finalization, so the run keeps a
              // reason rather than surfacing an opaque SDK error.
              state.failureReason = `provider_protocol_failure: ${sanitizeSecret(
                errText.replace(/\s+/g, " ").trim(),
                runToken,
              ).slice(0, 160)}`;
              return false;
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
              state.timeoutTriggered ||
              state.cancellationTriggered ||
              state.failureReason !== undefined
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
            const sameCandidate = (
              left: { provider: string; id: string } | undefined,
              right: { provider: string; id: string },
            ): boolean =>
              left?.provider === right.provider && left.id === right.id;
            const activateStageCandidate = async (
              candidate: (typeof resolvedModels)[number],
            ): Promise<void> => {
              if (sameCandidate(stageSession.model, candidate)) return;
              // A failed forced call is requeued by the SDK. It was built from
              // the previous model; discard it before switching and let the
              // finalizer arm a fresh directive for the active candidate.
              stageSession.toolChoiceQueue.removeByLabel("user-force");
              await stageSession.setModel(candidate);
              state.zeroOutputStalled = false;
              state.jigglesUsed = 0;
              state.connectionErrors = 0;
              state.quotaScanFloor = stageSession.agent.state.messages.length;
            };
            const forceStageSubmit = (turn: number): void => {
              // Never carry a forced directive across a model switch.
              stageSession.toolChoiceQueue.removeByLabel("user-force");
              const compat = stageSession.model?.compat;
              if (
                compat !== undefined &&
                typeof compat === "object" &&
                "supportsForcedToolChoice" in compat &&
                compat.supportsForcedToolChoice === false
              ) {
                this.options.logger?.info?.(
                  { runId, sandboxId, stage: stage.name, turn },
                  "architect_stage_submit_force_unsupported",
                );
                return;
              }
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
              let firstCandidate = true;
              for (; index < resolvedModels.length; index += 1) {
                const candidate = resolvedModels[index]!;
                if (!sameCandidate(stageSession.model, candidate)) {
                  await activateStageCandidate(candidate);
                  // A fresh stage session is created on primaryModel even
                  // when the prior stage fell back. Preserve this stage's
                  // complete prompt for that active candidate; only later
                  // same-stage fallbacks need the abbreviated continuation.
                  if (!firstCandidate) prompt = MODEL_FAILED_PROMPT;
                }
                firstCandidate = false;
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
                !state.timeoutTriggered &&
                !state.cancellationTriggered &&
                state.failureReason === undefined;
                steer += 1
              ) {
                await stageSession
                  .setActiveToolsByName([stageSubmit.name])
                  .catch(() => undefined);
                const candidate =
                  resolvedModels[Math.min(index, resolvedModels.length - 1)]!;
                await activateStageCandidate(candidate);
                forceStageSubmit(assistantTurns);
                const stopped = await driveSession(
                  stageSession,
                  `This stage ends only when you call ${stageSubmit.name}. Call it now with what you have; nothing else you write counts.`,
                  candidate,
                  landed,
                  stagePromise,
                );
                // driveSession uses index=next-1 for its candidate-loop
                // caller. This loop has no increment expression, so advance
                // explicitly or the same failed model is forced forever.
                if (
                  !stopped &&
                  state.failureReason === undefined &&
                  index + 1 < resolvedModels.length
                ) {
                  index += 1;
                }
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
                state.failureReason === undefined &&
                !state.timeoutTriggered &&
                !state.cancellationTriggered
              ) {
                state.failureReason =
                  state.submissionRejectionReason !== undefined
                    ? `submission_rejected: ${state.submissionRejectionReason}`
                    : `architect_stage_${stage.name}_no_submission`;
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

        if (pipeline.length > 0) {
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
              state.zeroOutputStalled = false;
              state.jigglesUsed = 0;
              state.connectionErrors = 0;
              state.quotaScanFloor = activeSession.agent.state.messages.length;
            }
            // The packet prompt once, or just the failure prompt on a later
            // candidate - the packet is already in the continued
            // conversation. A resumed segment opens with its steer instead:
            // the transcript shows pre-restart shell state (cwd, exports,
            // background jobs) as live, and the steer tells the agent to
            // re-verify rather than trust it.
            const prompt =
              index > 0
                ? MODEL_FAILED_PROMPT
                : (resumed?.steerPrompt ?? buildPacketPrompt(request.packet));
            // The loop is live: the prompt is about to drive the reloaded
            // session, so the run counts as resumed from here - not from the
            // moment its journal was read off disk.
            resumed?.onRunning?.();
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
          pipeline.length === 0 &&
          (workTools.length > 0 || !this.profile.skipPromptWithoutWorkTools) &&
          !submissionCaptured() &&
          !state.timeoutTriggered &&
          !state.cancellationTriggered &&
          state.failureReason === undefined
        ) {
          let prompt: string;
          if (state.connectionErrors >= MODEL_CONNECTION_ERROR_LIMIT) {
            // The leg settled its whole budget in transport errors. Fail over
            // now instead of spending jiggle backoff on a dead upstream (it
            // can be mute AND unreachable, so this precedes the stall path
            // the way a quota verdict forces the jiggle skip).
            const from = resolvedModels[index]?.id;
            const nextIndex = nextCandidateIndex(index);
            const next =
              nextIndex === null ? undefined : resolvedModels[nextIndex];
            if (!next || nextIndex === null) {
              state.failureReason = `provider_connection_failure: ${(
                state.lastConnectionError ?? "repeated connection errors"
              ).slice(0, 160)}`;
              break;
            }
            index = nextIndex;
            state.jigglesUsed = 0;
            state.connectionErrors = 0;
            await session.setModel(next);
            state.zeroOutputStalled = false;
            state.quotaScanFloor = session.agent.state.messages.length;
            this.options.logger?.warn?.(
              {
                runId,
                from,
                to: next.id,
                error: `provider_connection_exhausted: ${(
                  state.lastConnectionError ?? "repeated connection errors"
                ).slice(0, 160)}`,
              },
              "pi_model_fallback",
            );
            prompt = CONNECTION_RETRY_PROMPT;
          } else if (state.connectionErrors > 0) {
            // Under budget: a blip, not a dead leg. Re-prompt the same model
            // so one transient never costs a configured candidate.
            prompt = CONNECTION_RETRY_PROMPT;
          } else if (state.zeroOutputStalled) {
            // Deliberately NOT cleared here: the flag is the loop's memory
            // that the current leg has gone mute. Only real progress (a tool
            // call, output tokens) or a model switch clears it, so an
            // exhausted continuation budget still falls over instead of
            // resetting the jiggle budget on every steer.
            const quotaError = lastAssistantQuotaError();
            if (quotaError) state.jigglesUsed = ZERO_OUTPUT_JIGGLES;
            if (state.jigglesUsed < ZERO_OUTPUT_JIGGLES) {
              state.jigglesUsed += 1;
              this.options.logger?.warn?.(
                {
                  runId,
                  model: resolvedModels[index]?.id,
                  jiggle: state.jigglesUsed,
                  backoffMs: jiggleBackoffMs * state.jigglesUsed,
                },
                "pi_zero_output_jiggle",
              );
              await sleep(jiggleBackoffMs * state.jigglesUsed);
            } else if (nextCandidateIndex(index) !== null) {
              const from = resolvedModels[index]?.id;
              index = nextCandidateIndex(index)!;
              state.jigglesUsed = 0;
              state.connectionErrors = 0;
              const next = resolvedModels[index]!;
              await session.setModel(next);
              state.zeroOutputStalled = false;
              state.quotaScanFloor = session.agent.state.messages.length;
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
              state.failureReason = "zero_output_stall";
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
            if (state.cancellationTriggered) throw err;
            // A transient thrown out of the steer prompt is the same blip the
            // counter already tracks: stay on the model and re-prompt. Only a
            // settled leg (budget spent) or a non-connection failure ends the
            // loop, and neither is logged as a continuation failure.
            if (
              state.connectionErrors > 0 &&
              state.connectionErrors < MODEL_CONNECTION_ERROR_LIMIT
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

      if (capturedEnvelope === undefined && state.failureReason === undefined) {
        if (state.submissionRejectionReason !== undefined) {
          state.failureReason = `submission_rejected: ${state.submissionRejectionReason}`;
        } else if (
          this.profile.requireRepositoryInspection &&
          !state.repositoryInspected
        ) {
          state.failureReason = "repository_inspection_required";
        } else {
          // A clean run that never invoked the terminal tool is distinct
          // from a provider/protocol failure or a rejected submission.
          state.failureReason = "finalize_no_submission";
        }
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
      // The advisor's private agent dir lives outside the checkout, so it
      // outlives the workspace removal above unless it is taken here.
      removeAdvisorDir?.();
      // (4) The sandbox pod goes last: destroy after the workspace is gone.
      await handle?.destroy();
    }

    return {
      sandboxId,
      envelope: capturedEnvelope ?? { __unfinished: true },
      reason:
        capturedEnvelope === undefined
          ? (state.failureReason ?? "finalize_no_submission")
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
