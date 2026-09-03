import { rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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
  buildArchitectPhases,
  buildRevisionPrompt,
  type ArchitectCritiqueSpec,
  type ArchitectPhase,
  type CritiqueReport,
} from "./architect-phases.js";
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
  readonly systemPrompt: (packet?: AgentRuntimePacket) => string;
  finalizerPrompt: (packet: AgentRuntimePacket) => string;
  readonly schemaName:
    | "implementer_completion"
    | "architect_decomposition"
    | "reviewer_verdict";
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

    // Critique engages only for a PHASED run of this packet. The capture used
    // to test `this.profile.phases` for existence - always true for the
    // architect - while the critique loop tested `phases(packet).length`,
    // which is 0 for extension packets. An extension submission was parked
    // as a draft nothing promoted, and every validation replan on every
    // model ended 'finalize_no_submission' after an ACCEPTED submit
    // (2026-09-02, nine runs in an hour). One predicate, both sides.
    const phased = (this.profile.phases?.(request.packet)?.length ?? 0) > 0;
    const submitTool = this.profile.submitTool(
      (value) => {
        if (this.options.critique && phased && !critiqueCompleted) {
          draftEnvelope = value;
          resolveDraftEnvelope?.();
          // A draft closes this candidate's phase pipeline. The SDK ignores the
          // submit tool's terminate hint, so abort the stale generation.
          void abortRun();
          return;
        }
        capturedEnvelope = value;
        resolveCapturedEnvelope?.();
      },
      this.options.architectSizeGate?.(),
      request.packet,
    );
    /** True while submissions route to the draft slot pending critique. */
    const critiqueEngaged = Boolean(this.options.critique && phased);
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

    // The try starts here rather than at the run body so its finally also
    // covers the setup window: a throw in between (discoverAuthStorage on an
    // unreachable auth store, broker resolution, no credentialed provider)
    // would otherwise strand /tmp/colony-pi-runs/<runId> with its
    // credential-bearing PACKET.json — the leak this teardown exists to prevent.
    try {
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
      const buildSettings = () =>
        Settings.isolated({
          "compaction.enabled": true,
          "retry.enabled": true,
          // The SDK's auto-retry re-prompts a transient failure same-model
          // with exponential backoff, defaulting to 10 attempts. On a dead
          // leg that spends the whole run wall inside one prompt, so bound
          // the budget the leg may burn before the runner sees an error.
          "retry.maxRetries": 4,
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
          journal: "run",
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
        void abortRun();
      }
      let zeroOutputStalled = false;
      // Jiggle before failover: a provider that rate-limits by going mute
      // often recovers within a minute. Give the CURRENT model two wakes with
      // increasing backoff before abandoning it; any real progress (a tool
      // call) resets the budget.
      const ZERO_OUTPUT_JIGGLES = 2;
      const JIGGLE_BACKOFF_MS = 15_000;
      // Quota exhaustion (weekly caps, frequency limits with a distant reset)
      // never recovers inside a jiggle window: fail over immediately instead
      // of burning wake cycles against a benched provider. "No deployments
      // available" is litellm's cooldown wrapper - once a leg is benched every
      // caller sees it instead of the underlying quota error, and waiting out
      // 300s cooldown windows one empty turn at a time is never better than
      // moving to the fallback (the next run returns to the primary anyway).
      const QUOTA_ERROR_RE =
        /usage exceeds|frequency limit|weekly.*(usage|limit)|quota.*(exceed|exhaust|reset)|rate.?limit.*reset at|no deployments available/i;
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
      const unsubscribeGuards = installRunGuards(session.agent, runId, {
        maxTurns: this.options.maxTurns ?? this.profile.defaultLimits.maxTurns,
        logger: this.options.logger,
        evidence,
        rejectionToolName: submitTool.name,
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
              "Inspect the repository first: read or search real source/test files (read, grep, glob, bash, or a task subagent) before submitting.",
          };
        }
        if (
          context.toolCall.name === submitTool.name &&
          this.profile.verifyPushedHead &&
          handle
        ) {
          const args = context.args as { head_sha?: unknown; branch?: unknown };
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

      // Submit-deadline enforcement: re-steering only fires when a model
      // STOPS without submitting, so a model that investigates forever never
      // hears it (grok-4.6 spent 44 of 45 minutes probing a diff with zero
      // submit attempts, twice, 2026-09-01). When the wall is near and
      // nothing is submitted, every tool result carries the clock.
      const SUBMIT_DEADLINE_NUDGE_MS = 8 * 60_000;
      let lastDeadlineNudgeAt = 0;
      const takeSubmitDeadlineNudge = (force = false): string | null => {
        if (submissionCaptured()) return null;
        const remainingMs = deadline - Date.now();
        if (remainingMs > SUBMIT_DEADLINE_NUDGE_MS) return null;
        if (!force && performance.now() - lastDeadlineNudgeAt < 60_000)
          return null;
        lastDeadlineNudgeAt = performance.now();
        const remainingMin = Math.max(1, Math.round(remainingMs / 60_000));
        return [
          "<system-reminder>",
          `~${remainingMin} minute(s) of wall clock remain and nothing has been submitted. Stop investigating NOW and call ${submitTool.name} with the envelope built from what you already know. An unsubmitted run counts for nothing; a conservative submitted verdict beats a perfect unsubmitted one.`,
          "</system-reminder>",
        ].join("\n");
      };
      const previousAfterToolCall = session.agent.afterToolCall;
      session.agent.afterToolCall = async (context, signal) => {
        const base = await previousAfterToolCall?.(context, signal);
        if (
          !context.isError &&
          REPOSITORY_INSPECTION_TOOLS[context.toolCall.name] === true
        ) {
          repositoryInspected = true;
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
        const phaseNudge = deadlineNudge ? null : takePhaseBudgetNudge();
        const repeatNudge =
          deadlineNudge || phaseNudge
            ? null
            : steering.takeRepeatFailureNudge();
        const nudge =
          deadlineNudge ??
          phaseNudge ??
          repeatNudge ??
          steering.takeDriftNudge();
        if (!nudge) return base;
        // Fold the reminder in ahead of the tool's own output, the way the omp
        // harness delivers non-interrupting rule reminders.
        this.options.logger?.warn?.(
          { runId, sandboxId, phase: activePhase?.name },
          deadlineNudge
            ? "pi_submit_deadline_nudge"
            : phaseNudge
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
              // The candidate loop below advances by one; steer it onto
              // the next candidate WITH capacity (see nextCandidateIndex).
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
                if (connectionErrors < MODEL_CONNECTION_ERROR_LIMIT)
                  return true;
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
                {
                  runId,
                  from: candidate.id,
                  to: next.id,
                  error: errText,
                },
                "pi_model_fallback",
              );
              return advance();
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
              connectionErrors = 0;
              quotaScanFloor = session.agent.state.messages.length;
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
                  backoffMs: JIGGLE_BACKOFF_MS * jigglesUsed,
                },
                "pi_zero_output_jiggle",
              );
              await sleep(JIGGLE_BACKOFF_MS * jigglesUsed);
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

      // The bounded adversarial critique pass. Runs only when the option is
      // set AND the role is phased; one critique session and at most one
      // revision prompt per run, all under the run deadline already armed.
      if (
        this.options.critique &&
        phased &&
        draftEnvelope !== undefined &&
        !critiqueCompleted &&
        !timeoutTriggered &&
        !cancellationTriggered &&
        failureReason === undefined
      ) {
        try {
          const critique = this.options.critique;
          const critic = await createAgentSession(
            await buildSessionOptions({
              systemPrompt: critique.systemPrompt,
              customTools: [],
              toolNames: [],
              prewalk: false,
              journal: "transient",
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
      const sessionFile = session?.sessionManager.getSessionFile() ?? undefined;
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
  phases: (packet) =>
    isArchitectExtensionPacket(packet) ? [] : buildArchitectPhases(packet),
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
