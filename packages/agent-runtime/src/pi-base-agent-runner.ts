import {
  ModelRegistry,
  SessionManager,
  Settings,
  createAgentSession,
  discoverAuthStorage,
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
import type { PiRunRequest, PiRunResult, PiRunner } from "./pi-adapter.js";
import {
  type ActivePiRun,
  type PiRunnerBaseOptions,
  type ArchitectSizeGate,
  DEFAULT_PI_RUN_TIMEOUT_MS,
  architectDecompositionEnvelopeTypeBox,
  buildArchitectFinalizerPrompt,
  buildArchitectSystemPrompt,
  buildImplementerFinalizerPrompt,
  buildImplementerSystemPrompt,
  buildPacketPrompt,
  buildReviewerFinalizerPrompt,
  buildReviewerSystemPrompt,
  buildSubagentSystemPrompt,
  createArchitectSubmitTool,
  createImplementerSubmitTool,
  createReviewerSubmitTool,
  createSandboxId,
  implementerCompletionEnvelopeTypeBox,
  installRunGuards,
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
  buildArchitectPhases,
  buildRevisionPrompt,
  type ArchitectCritiqueSpec,
  type ArchitectPhase,
  type CritiqueReport,
} from "./architect-phases.js";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { createSubagentTool } from "./subagent-tool.js";
import { RunSteering, packetObjective } from "./run-steering.js";
import { buildSandboxTools } from "./sandbox-tools.js";
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
import {
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
  ImplementerCompletionV2 as implementerCompletionV2Schema,
  ReviewerVerdictV2 as reviewerVerdictV2Schema,
} from "@colony/schemas";

export type PiWorkspaceMode = "repo-required" | "scratch";

/** Binding name reported to the credential broker for colonyd runs. */
export const PI_RUNTIME_BINDING_NAME = "colonyd";

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
  readonly systemPrompt: () => string;
  finalizerPrompt: (packet: AgentRuntimePacket) => string;
  readonly schemaName:
    | "implementer_completion"
    | "architect_decomposition"
    | "reviewer_verdict";
  readonly typeboxSchema: unknown;
  readonly submitTool: (
    capture: (value: unknown) => void,
    sizeGate?: ArchitectSizeGate,
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
   * When set, run() drives this deterministic phase pipeline instead of one
   * initial packet prompt. Roles without it keep single-prompt behavior.
   */
  readonly phases?: (packet: AgentRuntimePacket) => readonly ArchitectPhase[];
}

export interface PiBaseAgentRunnerOptions extends PiRunnerBaseOptions {
  readonly tools?: readonly string[];
  readonly logToolArgs?: boolean;
  /**
   * Opt-in bounded critique pass for phased roles: after the phase sequence
   * produces a draft envelope, a fresh session reviews it adversarially and
   * gets at most one revision cycle. Ignored on profiles without `phases`.
   */
  readonly critique?: ArchitectCritiqueSpec;
  /**
   * Lazy architect size gate: called per session, not per runner, so each
   * session reads fresh runs history. `undefined` means no gate — the
   * submit tool accepts any decomposition shape.
   */
  readonly architectSizeGate?: () => ArchitectSizeGate | undefined;
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
    const broker = runnerBroker(this.options);
    let model = await resolvePiModel(request, this.options.model);
    const models = [model, ...(this.options.fallbackModels ?? [])];
    const workTools = this.options.tools ?? this.profile.defaultTools;
    let failureReason: string | undefined;
    let timeoutTriggered = false;
    let repositoryInspected = false;
    let cancellationTriggered = false;

    let cwd: string;
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
    let capturedEnvelope: unknown;
    let resolveCapturedEnvelope: (() => void) | undefined;
    const capturedEnvelopePromise = new Promise<void>((resolve) => {
      resolveCapturedEnvelope = resolve;
    });
    // Critique mode: submissions before the revision cycle are DRAFTS. They
    // must not satisfy the run's envelope waits, so they resolve a separate
    // promise; only an accepted (post-critique or revised) envelope counts.
    let draftEnvelope: unknown;
    let resolveDraftEnvelope: (() => void) | undefined;
    const draftEnvelopePromise = new Promise<void>((resolve) => {
      resolveDraftEnvelope = resolve;
    });
    let critiqueCompleted = false;
    let session: AgentSession | undefined;
    let handle: SandboxHandle | undefined;

    const submitTool = this.profile.submitTool((value) => {
      if (this.options.critique && this.profile.phases && !critiqueCompleted) {
        draftEnvelope = value;
        resolveDraftEnvelope?.();
        // A draft closes this candidate's phase pipeline. The SDK ignores the
        // submit tool's terminate hint, so the in-flight generation would keep
        // issuing provider calls against the stale conversation and could
        // interleave with the critique/revision turns below - abort it the way
        // acceptance ends the run in non-critique mode.
        void session?.abort();
        return;
      }
      capturedEnvelope = value;
      resolveCapturedEnvelope?.();
    }, this.options.architectSizeGate?.());
    /** True while submissions route to the draft slot pending critique. */
    const critiqueEngaged = Boolean(
      this.options.critique && this.profile.phases,
    );
    /** Whether a submission has landed: accepted, or a draft awaiting critique. */
    const submissionCaptured = (): boolean =>
      critiqueEngaged && !critiqueCompleted
        ? draftEnvelope !== undefined
        : capturedEnvelope !== undefined;
    /** The wait promise that resolves once a submission lands. */
    const submissionPromise = (): Promise<void> =>
      critiqueEngaged && !critiqueCompleted
        ? draftEnvelopePromise
        : capturedEnvelopePromise;

    // The credential broker owns key resolution; the registry only needs a
    // provider record per model so `createAgentSession` can resolve selectors.
    const providerApiKeys = new Map<string, string>();
    for (const candidate of models) {
      if (providerApiKeys.has(candidate.provider)) continue;
      const apiKey = await broker.resolve({
        provider: candidate.provider,
        capability: `agent.llm.${candidate.provider}.invoke`,
        bindingName: PI_RUNTIME_BINDING_NAME,
        environment: request.environment,
      });
      if (!apiKey) continue;
      providerApiKeys.set(candidate.provider, apiKey);
    }
    const authStorage = await discoverAuthStorage();
    const modelRegistry = new ModelRegistry(authStorage);
    for (const [provider, apiKey] of providerApiKeys) {
      const providerModels = models.filter(
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
          // Colony's config leaves these nullable; the registry wants numbers.
          contextWindow: candidate.contextWindow ?? 128_000,
          maxTokens: candidate.maxTokens ?? 16_384,
          headers: candidate.headers,
        })),
      });
    }

    // Specs are registered above; the registry owns compat resolution, so ask it
    // for the real models the session and its fallbacks will use.
    const resolvedModels = models.flatMap((candidate) => {
      const resolved = modelRegistry.find(candidate.provider, candidate.id);
      return resolved ? [resolved] : [];
    });
    const primaryModel = resolvedModels[0];
    if (!primaryModel) {
      throw new Error(
        `no credentialed provider for ${models[0]?.provider}/${models[0]?.id}; check the ${request.environment.role} agent's provider auth`,
      );
    }

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
    const clearTimeoutGuard = withRunTimeout(
      runId,
      this.options.runTimeoutMs,
      () => session?.abort(),
      () => {
        failureReason ??= "timeout_without_envelope";
        timeoutTriggered = true;
      },
    );
    this.activeRuns.set(runId, {
      abort: async () => {
        cancellationTriggered = true;
        await session?.abort();
      },
    });

    try {
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
          runToken: packetRepo(request.packet)?.credentials?.token,
        });
      }
      const deadline =
        Date.now() + (this.options.runTimeoutMs ?? DEFAULT_PI_RUN_TIMEOUT_MS);
      const thinkingLevel = toSdkThinkingLevel(
        this.options.thinkingLevel ?? this.profile.defaultThinkingLevel,
      );
      const buildSettings = () =>
        Settings.isolated({
          "compaction.enabled": true,
          "retry.enabled": true,
          "todo.enabled": true,
          "todo.reminders": true,
          "goal.enabled": true,
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
      const buildSessionOptions = (perSession: {
        systemPrompt: string;
        customTools: ToolDefinition[];
        toolNames: string[];
        prewalk: boolean;
      }) => ({
        cwd,
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
        scopedModels: resolvedModels.map((candidate) => ({ model: candidate })),
        settings: buildSettings(),
        systemPrompt: perSession.systemPrompt,
        sessionManager: SessionManager.inMemory(cwd),
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
          ? { telemetry: {} }
          : {}),
      });

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
      const subagentTool = createSubagentTool(async ({ prompt }) => {
        const child = await createAgentSession(
          buildSessionOptions({
            systemPrompt: buildSubagentSystemPrompt(),
            customTools: childCustomTools,
            toolNames: childToolNames,
            prewalk: false,
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
          },
        );
        try {
          await inTraceContext(request.environment, () =>
            child.session.prompt(prompt, { expandPromptTemplates: false }),
          );
          await child.session.agent.waitForIdle();
          return report;
        } finally {
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
        buildSessionOptions({
          systemPrompt: `${this.profile.systemPrompt()}\n\n${steering.budgetBlock()}\n\n${harnessBlock}`,
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
        }),
      );
      session = result.session;
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
        void session.abort();
      }
      let zeroOutputStalled = false;
      // Jiggle before failover: a provider that rate-limits by going mute
      // often recovers within a minute. Give the CURRENT model two wakes with
      // increasing backoff before abandoning it; any real progress (a tool
      // call) resets the budget.
      const ZERO_OUTPUT_JIGGLES = 2;
      const JIGGLE_BACKOFF_MS = 15_000;
      let jigglesUsed = 0;
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));
      const unsubscribeGuards = installRunGuards(session.agent, runId, {
        maxTurns: this.options.maxTurns ?? this.profile.defaultLimits.maxTurns,
        logger: this.options.logger,
        onFailure: (reason) => {
          failureReason ??= reason;
        },
        onZeroOutputStall: () => {
          zeroOutputStalled = true;
        },
      });
      const previousBeforeToolCall = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (context, signal) => {
        const base = await previousBeforeToolCall?.(context, signal);
        if (base?.block) return base;
        if (
          context.toolCall.name === submitTool.name &&
          this.profile.requireRepositoryInspection &&
          !repositoryInspected
        ) {
          return {
            block: true,
            reason:
              "Inspect repository source or tests with read/grep before submitting.",
          };
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

      // Per-phase wall-clock enforcement for phased roles. The runner cannot
      // interrupt a live prompt without poisoning the session, so an
      // over-budget phase is closed the way drift is handled: a reminder
      // folded into every tool result (rate-limited) until the model stops
      // exploring and emits the phase deliverable. Run 1 of the phased
      // architect spent 44 of 45 minutes in survey; budgets exist so every
      // phase gets its turn.
      let activePhase: {
        name: string;
        budgetMs: number;
        startedAt: number;
      } | null = null;
      let lastPhaseNudgeAt = 0;
      const takePhaseBudgetNudge = (): string | null => {
        if (!activePhase) return null;
        const now = performance.now();
        if (now - activePhase.startedAt <= activePhase.budgetMs) return null;
        if (now - lastPhaseNudgeAt < 45_000) return null;
        lastPhaseNudgeAt = now;
        const overMin = Math.round(
          (now - activePhase.startedAt - activePhase.budgetMs) / 60_000,
        );
        return [
          "<system-reminder>",
          `Phase "${activePhase.name}" is over its wall-clock budget${overMin > 0 ? ` by ~${overMin} min` : ""}. Stop exploring NOW. Produce this phase's deliverable in your next message from what you already have - no further tool calls in this phase. Remaining depth belongs to the later phases.`,
          "</system-reminder>",
        ].join("\n");
      };
      const previousAfterToolCall = session.agent.afterToolCall;
      session.agent.afterToolCall = async (context, signal) => {
        const base = await previousAfterToolCall?.(context, signal);
        if (
          !context.isError &&
          (context.toolCall.name === "read" || context.toolCall.name === "grep")
        ) {
          repositoryInspected = true;
        }
        jigglesUsed = 0;
        steering.observeToolCall(
          context.toolCall.name,
          context.args,
          context.isError,
        );
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
        const phaseNudge = takePhaseBudgetNudge();
        const repeatNudge = phaseNudge
          ? null
          : steering.takeRepeatFailureNudge();
        const nudge = phaseNudge ?? repeatNudge ?? steering.takeDriftNudge();
        if (!nudge) return base;
        // Fold the reminder in ahead of the tool's own output, the way the omp
        // harness delivers non-interrupting rule reminders.
        this.options.logger?.warn?.(
          { runId, sandboxId, phase: activePhase?.name },
          phaseNudge
            ? "pi_phase_budget_nudge"
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

      // Active model index survives past the prompt loop so the continuation
      // loop can keep falling over to remaining candidates on stalls.
      let index = 0;
      try {
        const phases = this.profile.phases?.(request.packet) ?? [];
        const isPhased = phases.length > 0;
        const MODEL_FAILED_PROMPT =
          "The previous model failed. Continue the same task from the current conversation and workspace state, then submit the required envelope.";
        /** One prompt turn of a candidate's plan, tagged with its phase when phased. */
        interface PlanStep {
          readonly prompt: string;
          readonly phase?: (typeof phases)[number];
        }
        /** A candidate's full prompt plan: fallback roles restart from survey. */
        const planSteps = (): readonly PlanStep[] => {
          // Non-phased roles keep today's single-prompt shape exactly: the
          // packet prompt once, or just the failure prompt on a later
          // candidate - the packet is already in the continued conversation.
          if (!isPhased) {
            return [
              index > 0
                ? { prompt: MODEL_FAILED_PROMPT }
                : { prompt: buildPacketPrompt(request.packet) },
            ];
          }
          const lead: PlanStep[] =
            index > 0 ? [{ prompt: MODEL_FAILED_PROMPT }] : [];
          return [
            ...lead,
            ...phases.map((phase) => ({ prompt: phase.prompt, phase })),
          ];
        };
        const activeSession = session;
        if (!activeSession) throw new Error("run session missing");
        /**
         * Drive one model candidate through its whole prompt plan: either the
         * role's phase pipeline or the single packet prompt. Resolves true
         * when the plan ran to completion (the model loop stops); resolves
         * false after a mid-sequence provider error so the caller can fall
         * over to the next candidate; throws fatal errors (last candidate,
         * classified failure, operator cancellation).
         */
        const runPromptPlan = async (candidate: {
          provider: string;
          id: string;
        }): Promise<boolean> => {
          for (const step of planSteps()) {
            if (submissionCaptured()) return true;
            if (step.phase) {
              activePhase = {
                name: step.phase.name,
                budgetMs: step.phase.budgetMs,
                startedAt: performance.now(),
              };
              lastPhaseNudgeAt = 0;
              this.options.logger?.info?.(
                { runId, sandboxId, phase: step.phase.name },
                "architect_phase",
              );
            } else {
              activePhase = null;
            }
            try {
              const waitPromise = submissionPromise();
              const promptPromise = inTraceContext(request.environment, () =>
                activeSession.prompt(step.prompt, {
                  expandPromptTemplates: false,
                }),
              ).catch((err) => {
                if (submissionCaptured()) return;
                throw err;
              });
              await Promise.race([promptPromise, waitPromise]);
              if (!submissionCaptured()) {
                await waitForIdleOrCapturedEnvelope(
                  activeSession.agent,
                  waitPromise,
                );
              }
              const lastMessage = activeSession.agent.state.messages.at(-1);
              if (
                !submissionCaptured() &&
                lastMessage?.role === "assistant" &&
                lastMessage.stopReason === "error"
              ) {
                throw new Error(
                  lastMessage.errorMessage ??
                    `model ${candidate.provider}/${candidate.id} failed`,
                );
              }
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
              const next = models[index + 1];
              if (!next || failureReason !== undefined) {
                throw err;
              }
              this.options.logger?.warn?.(
                {
                  runId,
                  from: candidate.id,
                  to: next.id,
                  error: err instanceof Error ? err.message : String(err),
                },
                "pi_model_fallback",
              );
              return false;
            }
          }
          activePhase = null;
          return true;
        };
        if (workTools.length > 0 || !this.profile.skipPromptWithoutWorkTools) {
          for (; index < resolvedModels.length; index += 1) {
            const candidate = resolvedModels[index]!;
            if (index > 0) {
              await session.setModel(candidate);
              jigglesUsed = 0;
            }
            if (await runPromptPlan(candidate)) break;
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
          (workTools.length > 0 || !this.profile.skipPromptWithoutWorkTools) &&
          !submissionCaptured() &&
          !timeoutTriggered &&
          !cancellationTriggered &&
          failureReason === undefined
        ) {
          let prompt: string;
          if (zeroOutputStalled) {
            zeroOutputStalled = false;
            if (jigglesUsed < ZERO_OUTPUT_JIGGLES) {
              jigglesUsed += 1;
              this.options.logger?.warn?.(
                {
                  runId,
                  model: resolvedModels[index]?.id,
                  jiggle: jigglesUsed,
                  backoffMs: JIGGLE_BACKOFF_MS * jigglesUsed,
                },
                "pi_zero_output_jiggle",
              );
              await sleep(JIGGLE_BACKOFF_MS * jigglesUsed);
            } else if (resolvedModels[index + 1]) {
              index += 1;
              jigglesUsed = 0;
              const next = resolvedModels[index]!;
              await session.setModel(next);
              this.options.logger?.warn?.(
                { runId, to: next.id, error: "zero_output_stall" },
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
            prompt = steer;
          }
          try {
            const waitPromise = submissionPromise();
            const steerPromise = inTraceContext(request.environment, () =>
              activeSession.prompt(prompt, {
                expandPromptTemplates: false,
              }),
            ).catch((err) => {
              if (submissionCaptured()) return;
              throw err;
            });
            await Promise.race([steerPromise, waitPromise]);
            if (!submissionCaptured()) {
              await waitForIdleOrCapturedEnvelope(session.agent, waitPromise);
            }
          } catch (err) {
            if (cancellationTriggered) throw err;
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

      // The bounded adversarial critique pass. Runs only when the option is
      // set AND the role is phased; one critique session and at most one
      // revision prompt per run, all under the run deadline already armed.
      if (
        this.options.critique &&
        (this.profile.phases?.(request.packet)?.length ?? 0) > 0 &&
        draftEnvelope !== undefined &&
        !critiqueCompleted &&
        !timeoutTriggered &&
        !cancellationTriggered &&
        failureReason === undefined
      ) {
        try {
          const critique = this.options.critique;
          const critic = await createAgentSession(
            buildSessionOptions({
              systemPrompt: critique.systemPrompt,
              customTools: [],
              toolNames: [],
              prewalk: false,
            }),
          );
          let reportText = "";
          const unsubscribeReport = critic.session.agent.subscribe((event) => {
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
              if (text.trim()) reportText = text;
            }
          });
          let report: CritiqueReport;
          try {
            await inTraceContext(request.environment, () =>
              critic.session.prompt(
                critique.buildPrompt({
                  goal: packetObjective(request.packet),
                  projectContext:
                    typeof (
                      request.packet as { project?: { context_doc?: unknown } }
                    ).project?.context_doc === "string"
                      ? (request.packet as { project: { context_doc: string } })
                          .project.context_doc
                      : null,
                  envelope: draftEnvelope,
                }),
                { expandPromptTemplates: false },
              ),
            );
            await critic.session.agent.waitForIdle();
          } finally {
            unsubscribeReport();
            critic.session.dispose();
          }
          report = critique.parseReport(reportText);
          this.options.logger?.info?.(
            {
              runId,
              sandboxId,
              verdict: report.verdict,
              findings: report.findings.length,
            },
            "architect_critique",
          );
          if (report.verdict === "approve" || report.findings.length === 0) {
            capturedEnvelope = draftEnvelope;
            resolveCapturedEnvelope?.();
          } else {
            critiqueCompleted = true;
            const revisionPromise = inTraceContext(request.environment, () =>
              session!.prompt(buildRevisionPrompt(report.findings), {
                expandPromptTemplates: false,
              }),
            ).catch((err) => {
              if (capturedEnvelope !== undefined) return;
              throw err;
            });
            await Promise.race([revisionPromise, capturedEnvelopePromise]);
            if (!submissionCaptured()) {
              await waitForIdleOrCapturedEnvelope(
                session!.agent,
                capturedEnvelopePromise,
              );
            }
            if (capturedEnvelope === undefined) {
              const lastMessage = session!.agent.state.messages.at(-1);
              if (
                lastMessage?.role === "assistant" &&
                lastMessage.stopReason === "error"
              ) {
                failureReason ??=
                  lastMessage.errorMessage ?? "critique_revision_failed";
              }
            }
          }
        } catch (err) {
          if (cancellationTriggered || timeoutTriggered) {
            // Cancellation/timeouts are handled by their own guards; keep
            // their classified reasons instead of masking them.
          } else {
            failureReason ??= "critique_failed";
            this.options.logger?.warn?.(
              {
                runId,
                error: err instanceof Error ? err.message : String(err),
              },
              "architect_critique_failed",
            );
          }
        }
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
      clearTimeoutGuard();
      session?.dispose();
      this.activeRuns.delete(runId);
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
};

export const ARCHITECT_ROLE_PROFILE: PiRoleProfile = {
  phases: buildArchitectPhases,
  role: "architect",
  kind: "pi-architect",
  sandboxPrefix: "pi-architect",
  systemPrompt: buildArchitectSystemPrompt,
  finalizerPrompt: buildArchitectFinalizerPrompt,
  schemaName: "architect_decomposition",
  typeboxSchema: architectDecompositionEnvelopeTypeBox,
  submitTool: createArchitectSubmitTool,
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
