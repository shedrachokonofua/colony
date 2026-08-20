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
import type { z } from "zod";
import type { AgentRuntimePacket, AgentRuntimeRole } from "./adapter.js";
import type { PiRunRequest, PiRunResult, PiRunner } from "./pi-adapter.js";
import {
  type ActivePiRun,
  type PiRunnerBaseOptions,
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
  readonly submitTool: (capture: (value: unknown) => void) => ToolDefinition;
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
}

export interface PiBaseAgentRunnerOptions extends PiRunnerBaseOptions {
  readonly tools?: readonly string[];
  readonly logToolArgs?: boolean;
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
    let session: AgentSession | undefined;
    let handle: SandboxHandle | undefined;

    const submitTool = this.profile.submitTool((value) => {
      capturedEnvelope = value;
      resolveCapturedEnvelope?.();
    });

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
        sandboxTools = buildSandboxTools(handle, cwd);
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
          await child.session.prompt(prompt, { expandPromptTemplates: false });
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
      const unsubscribeGuards = installRunGuards(session.agent, runId, {
        maxTurns: this.options.maxTurns ?? this.profile.defaultLimits.maxTurns,
        logger: this.options.logger,
        onFailure: (reason) => {
          failureReason ??= reason;
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

      const previousAfterToolCall = session.agent.afterToolCall;
      session.agent.afterToolCall = async (context, signal) => {
        const base = await previousAfterToolCall?.(context, signal);
        if (
          !context.isError &&
          (context.toolCall.name === "read" || context.toolCall.name === "grep")
        ) {
          repositoryInspected = true;
        }
        steering.observeToolCall(context.toolCall.name, context.args);
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
        const nudge = steering.takeDriftNudge();
        if (!nudge) return base;
        // Fold the reminder in ahead of the tool's own output, the way the omp
        // harness delivers non-interrupting rule reminders.
        this.options.logger?.warn?.({ runId, sandboxId }, "pi_drift_nudge");
        return {
          ...base,
          content: [
            { type: "text" as const, text: nudge },
            ...(base?.content ?? context.result.content),
          ],
        };
      };

      try {
        if (workTools.length > 0 || !this.profile.skipPromptWithoutWorkTools) {
          for (let index = 0; index < resolvedModels.length; index += 1) {
            const candidate = resolvedModels[index]!;
            if (index > 0) {
              await session.setModel(candidate);
            }
            const prompt =
              index === 0
                ? buildPacketPrompt(request.packet)
                : "The previous model failed. Continue the same task from the current conversation and workspace state, then submit the required envelope.";
            try {
              const promptPromise = session
                .prompt(prompt, {
                  expandPromptTemplates: false,
                })
                .catch((err) => {
                  if (capturedEnvelope !== undefined) return;
                  throw err;
                });
              await Promise.race([promptPromise, capturedEnvelopePromise]);
              if (capturedEnvelope === undefined) {
                await waitForIdleOrCapturedEnvelope(
                  session.agent,
                  capturedEnvelopePromise,
                );
              }
              const lastMessage = session.agent.state.messages.at(-1);
              if (
                capturedEnvelope === undefined &&
                lastMessage?.role === "assistant" &&
                lastMessage.stopReason === "error"
              ) {
                throw new Error(
                  lastMessage.errorMessage ??
                    `model ${candidate.provider}/${candidate.id} failed`,
                );
              }
              break;
            } catch (err) {
              // The run-timeout guard aborts the session, which rejects the
              // in-flight prompt with the SDK's opaque "This operation was
              // aborted". Rethrowing loses the classified reason and skips
              // envelope finalization, so a run that did the work but ran out
              // of budget reports nothing. Stop the model loop instead and let
              // finalization salvage a submission. Operator cancellation still
              // ends the run immediately.
              if (cancellationTriggered) throw err;
              if (timeoutTriggered) break;
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
            }
          }
        }
        // A model that stops without submitting gets re-steered instead of
        // finalized on the spot: restate the objective, the clock, and whether
        // anything is pushed. The omp harness does the same on incomplete work,
        // and Colony's run data showed models idling out with the task unfinished.
        while (
          (workTools.length > 0 || !this.profile.skipPromptWithoutWorkTools) &&
          capturedEnvelope === undefined &&
          !timeoutTriggered &&
          !cancellationTriggered &&
          failureReason === undefined
        ) {
          const steer = steering.takeContinuationSteer(
            packetObjective(request.packet),
          );
          if (!steer) break;
          this.options.logger?.warn?.(
            { runId, sandboxId },
            "pi_run_continuation",
          );
          try {
            const steerPromise = session
              .prompt(steer, {
                expandPromptTemplates: false,
              })
              .catch((err) => {
                if (capturedEnvelope !== undefined) return;
                throw err;
              });
            await Promise.race([steerPromise, capturedEnvelopePromise]);
            if (capturedEnvelope === undefined) {
              await waitForIdleOrCapturedEnvelope(
                session.agent,
                capturedEnvelopePromise,
              );
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
