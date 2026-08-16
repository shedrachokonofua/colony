import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { z } from "zod";
import type { AgentRuntimePacket, AgentRuntimeRole } from "./adapter.js";
import type { PiRunRequest, PiRunResult, PiRunner } from "./pi-adapter.js";
import {
  type ActivePiRun,
  type PiRunnerBaseOptions,
  architectDecompositionEnvelopeTypeBox,
  buildArchitectFinalizerPrompt,
  buildArchitectSystemPrompt,
  buildImplementerFinalizerPrompt,
  buildImplementerSystemPrompt,
  buildPacketPrompt,
  buildReviewerFinalizerPrompt,
  buildReviewerSystemPrompt,
  createArchitectSubmitTool,
  createImplementerSubmitTool,
  createReviewerSubmitTool,
  createSandboxId,
  finalizeEnvelopeWithStructuredOutput,
  implementerCompletionEnvelopeTypeBox,
  installRunGuards,
  noOpResourceLoader,
  provisionRepoWorkspace,
  provisionScratchDir,
  resolvePiModel,
  reviewerVerdictEnvelopeTypeBox,
  runnerBroker,
  waitForIdleOrCapturedEnvelope,
  withRunTimeout,
} from "./pi-runner-common.js";
import {
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
  ImplementerCompletionV2 as implementerCompletionV2Schema,
  ReviewerVerdictV2 as reviewerVerdictV2Schema,
} from "@colony/schemas";

export type PiWorkspaceMode = "repo-required" | "scratch";

/** Binding name reported to the credential broker for colonyd runs. */
export const PI_RUNTIME_BINDING_NAME = "colonyd";

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

    const submitTool = this.profile.submitTool((value) => {
      capturedEnvelope = value;
      resolveCapturedEnvelope?.();
    });

    const credentials = new InMemoryCredentialStore();
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
      await credentials.modify(candidate.provider, async () => ({
        type: "api_key",
        key: apiKey,
      }));
    }
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
    });
    for (const [provider, apiKey] of providerApiKeys) {
      const providerModels = models.filter(
        (candidate) => candidate.provider === provider,
      );
      const first = providerModels[0]!;
      modelRuntime.registerProvider(provider, {
        apiKey,
        api: first.api,
        baseUrl: first.baseUrl,
        models: providerModels.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          api: candidate.api,
          baseUrl: candidate.baseUrl,
          reasoning: candidate.reasoning,
          thinkingLevelMap: candidate.thinkingLevelMap,
          input: candidate.input,
          cost: candidate.cost,
          contextWindow: candidate.contextWindow,
          maxTokens: candidate.maxTokens,
          samplingParams: candidate.samplingParams,
          headers: candidate.headers,
          compat: candidate.compat,
        })),
      });
    }

    const customTools: ToolDefinition[] = [submitTool];
    const toolNames = [...workTools, submitTool.name];
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
      const result = await createAgentSession({
        cwd,
        model,
        thinkingLevel:
          this.options.thinkingLevel ?? this.profile.defaultThinkingLevel,
        modelRuntime,
        scopedModels: models.map((candidate) => ({ model: candidate })),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 1 },
        }),
        resourceLoader: noOpResourceLoader(this.profile.systemPrompt()),
        sessionManager: SessionManager.inMemory(cwd),
        customTools,
        tools: toolNames,
      });
      session = result.session;
      if (timeoutTriggered) {
        void session.abort();
      }
      session.agent.getApiKey = async (provider) =>
        broker.resolve({
          provider,
          capability: `agent.llm.${provider}.invoke`,
          bindingName: PI_RUNTIME_BINDING_NAME,
          environment: request.environment,
        });

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

      try {
        if (workTools.length > 0 || !this.profile.skipPromptWithoutWorkTools) {
          for (let index = 0; index < models.length; index += 1) {
            const candidate = models[index]!;
            if (index > 0) {
              await session.setModel(candidate);
              model = candidate;
            }
            const prompt =
              index === 0
                ? buildPacketPrompt(request.packet)
                : "The previous model failed. Continue the same task from the current conversation and workspace state, then submit the required envelope.";
            try {
              const promptPromise = session
                .prompt(prompt, {
                  expandPromptTemplates: false,
                  source: "extension",
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
              const next = models[index + 1];
              if (
                !next ||
                failureReason !== undefined ||
                cancellationTriggered
              ) {
                throw err;
              }
              this.options.logger?.warn?.(
                {
                  runId,
                  failedModel: candidate.id,
                  fallbackModel: next.id,
                  error: err instanceof Error ? err.message : String(err),
                },
                "pi_model_fallback",
              );
            }
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
        const rawEnvelope = await finalizeEnvelopeWithStructuredOutput({
          model,
          stream: (finalizerModel, context, options) =>
            modelRuntime.streamSimple(finalizerModel, context, options),
          systemPrompt: this.profile.systemPrompt(),
          messages: session.agent.state.messages,
          finalUserMessage: this.profile.finalizerPrompt(request.packet),
          schemaName: this.profile.schemaName,
          typeboxSchema: this.profile.typeboxSchema,
          maxAttempts:
            this.profile.schemaName === "implementer_completion" ? 5 : 3,
          validate: this.profile.validate,
          logger: this.options.logger,
          runId,
        });
        if (rawEnvelope === undefined) {
          failureReason ??= "finalize_no_submission";
        } else {
          capturedEnvelope = rawEnvelope;
        }
      }
    } finally {
      clearTimeoutGuard();
      session?.dispose();
      this.activeRuns.delete(runId);
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
