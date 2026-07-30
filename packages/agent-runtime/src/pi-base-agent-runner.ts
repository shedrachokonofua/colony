import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { z } from "zod";
import type { AgentRuntimePacket, AgentRuntimeRole } from "./adapter.js";
import type { PiRunRequest, PiRunResult, PiRunner } from "./pi-adapter.js";
import {
  type ActivePiRun,
  type PiRunnerBaseOptions,
  architectDecompositionEnvelopeTypeBox,
  buildArchitectFinalizerPrompt,
  buildArchitectSystemPrompt,
  buildDeveloperFinalizerPrompt,
  buildDeveloperPlannerSystemPrompt,
  buildDeveloperPlanFinalizerPrompt,
  buildDeveloperSystemPrompt,
  buildPacketPrompt,
  buildPlanReviewFinalizerPrompt,
  buildPlanReviewerSystemPrompt,
  buildReviewerFinalizerPrompt,
  buildReviewerSystemPrompt,
  createArchitectSubmitTool,
  createDeveloperPlanSubmitTool,
  createDeveloperSubmitTool,
  createPlanReviewSubmitTool,
  createPostProgressNoteTool,
  createReviewerSubmitTool,
  createSandboxId,
  developerCompletionEnvelopeTypeBox,
  developerPlanEnvelopeTypeBox,
  finalizeEnvelopeWithStructuredOutput,
  installRunGuards,
  noOpResourceLoader,
  planReviewEnvelopeTypeBox,
  provisionRepoWorkspace,
  provisionScratchDir,
  resolvePiModel,
  reviewerReviewEnvelopeTypeBox,
  runnerBroker,
  waitForIdleOrCapturedEnvelope,
  withRunTimeout,
} from "./pi-runner-common.js";
import {
  architectDecompositionEnvelopeSchema,
  developerCompletionEnvelopeSchema,
  developerPlanEnvelopeSchema,
  planReviewEnvelopeSchema,
  reviewerReviewEnvelopeSchema,
} from "@colony/schemas";

export type PiWorkspaceMode = "repo-required" | "scratch";

export interface PiRoleProfile {
  readonly role: AgentRuntimeRole;
  readonly kind: PiRunner["kind"];
  readonly sandboxPrefix: string;
  readonly systemPrompt: () => string;
  readonly finalizerPrompt: (packet: AgentRuntimePacket) => string;
  readonly schemaName:
    | "developer_completion"
    | "developer_plan"
    | "plan_review"
    | "reviewer_review"
    | "architect_decomposition";
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
    readonly maxUsd: number;
  };
  readonly workspaceMode: PiWorkspaceMode;
  readonly includeProgressNote: boolean;
  readonly skipPromptWithoutWorkTools?: boolean;
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
    const model = await resolvePiModel(request, this.options.model);
    const workTools = this.options.tools ?? this.profile.defaultTools;
    let failureReason: string | undefined;
    let timeoutTriggered = false;

    const cwd = provisionProfileWorkspace(
      runId,
      request.packet,
      this.profile,
      this.options,
    );
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
    const progressNote = this.profile.includeProgressNote
      ? createPostProgressNoteTool({
          packet: request.packet,
          baseUrl: process.env["GITLAB_BASE_URL"],
        })
      : null;

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

    const customTools: ToolDefinition[] = progressNote
      ? [submitTool, progressNote.tool as ToolDefinition]
      : [submitTool];
    const toolNames = [
      ...workTools,
      ...(progressNote ? [progressNote.tool.name] : []),
      submitTool.name,
    ];
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
        await session?.abort();
      },
    });

    try {
      const result = await createAgentSession({
        cwd,
        model,
        thinkingLevel:
          this.options.thinkingLevel ?? this.profile.defaultThinkingLevel,
        authStorage,
        modelRegistry: ModelRegistry.inMemory(authStorage),
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
          bindingName: request.environment.runtimeBinding.binding.name,
          environment: request.environment,
        });

      const unsubscribeGuards = installRunGuards(session.agent, runId, {
        maxTurns: this.options.maxTurns ?? this.profile.defaultLimits.maxTurns,
        maxUsd: this.options.maxUsd ?? this.profile.defaultLimits.maxUsd,
        logger: this.options.logger,
        onFailure: (reason) => {
          failureReason ??= reason;
        },
      });
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

      try {
        if (workTools.length > 0 || !this.profile.skipPromptWithoutWorkTools) {
          const promptPromise = session
            .prompt(buildPacketPrompt(request.packet), {
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
        }
      } finally {
        unsubscribeGuards();
      }

      if (capturedEnvelope === undefined) {
        const rawEnvelope = await finalizeEnvelopeWithStructuredOutput({
          model,
          apiKey: await broker.resolve({
            provider: model.provider,
            capability: `agent.llm.${model.provider}.invoke`,
            bindingName: request.environment.runtimeBinding.binding.name,
            environment: request.environment,
          }),
          systemPrompt: this.profile.systemPrompt(),
          messages: session.agent.state.messages,
          finalUserMessage: this.profile.finalizerPrompt(request.packet),
          schemaName: this.profile.schemaName,
          typeboxSchema: this.profile.typeboxSchema,
          maxAttempts:
            this.profile.schemaName === "developer_completion" ? 5 : 3,
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

export const DEFAULT_REVIEWER_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

export const DEFAULT_PLAN_TOOLS = [
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
  systemPrompt: buildDeveloperSystemPrompt,
  finalizerPrompt: buildDeveloperFinalizerPrompt,
  schemaName: "developer_completion",
  typeboxSchema: developerCompletionEnvelopeTypeBox,
  submitTool: createDeveloperSubmitTool,
  validate: zodValidator(developerCompletionEnvelopeSchema),
  defaultTools: DEFAULT_DEVELOPER_TOOLS,
  defaultThinkingLevel: "medium",
  defaultLimits: { maxTurns: 60, maxUsd: 10 },
  workspaceMode: "repo-required",
  includeProgressNote: true,
  skipPromptWithoutWorkTools: true,
};

export const REVIEWER_ROLE_PROFILE: PiRoleProfile = {
  role: "reviewer",
  kind: "pi-mono",
  sandboxPrefix: "pi-review",
  systemPrompt: buildReviewerSystemPrompt,
  finalizerPrompt: buildReviewerFinalizerPrompt,
  schemaName: "reviewer_review",
  typeboxSchema: reviewerReviewEnvelopeTypeBox,
  submitTool: createReviewerSubmitTool,
  validate: zodValidator(reviewerReviewEnvelopeSchema),
  defaultTools: DEFAULT_REVIEWER_TOOLS,
  defaultThinkingLevel: "low",
  defaultLimits: { maxTurns: 30, maxUsd: 5 },
  workspaceMode: "repo-required",
  includeProgressNote: true,
};

export const DEVELOPER_PLANNER_ROLE_PROFILE: PiRoleProfile = {
  role: "developer_planner",
  kind: "pi-developer-plan",
  sandboxPrefix: "pi-dev-plan",
  systemPrompt: buildDeveloperPlannerSystemPrompt,
  finalizerPrompt: buildDeveloperPlanFinalizerPrompt,
  schemaName: "developer_plan",
  typeboxSchema: developerPlanEnvelopeTypeBox,
  submitTool: createDeveloperPlanSubmitTool,
  validate: zodValidator(developerPlanEnvelopeSchema),
  defaultTools: DEFAULT_PLAN_TOOLS,
  defaultThinkingLevel: "low",
  defaultLimits: { maxTurns: 20, maxUsd: 3 },
  workspaceMode: "repo-required",
  includeProgressNote: false,
};

export const PLAN_REVIEWER_ROLE_PROFILE: PiRoleProfile = {
  role: "plan_reviewer",
  kind: "pi-plan-review",
  sandboxPrefix: "pi-plan-review",
  systemPrompt: buildPlanReviewerSystemPrompt,
  finalizerPrompt: buildPlanReviewFinalizerPrompt,
  schemaName: "plan_review",
  typeboxSchema: planReviewEnvelopeTypeBox,
  submitTool: createPlanReviewSubmitTool,
  validate: zodValidator(planReviewEnvelopeSchema),
  defaultTools: DEFAULT_PLAN_TOOLS,
  defaultThinkingLevel: "low",
  defaultLimits: { maxTurns: 20, maxUsd: 3 },
  workspaceMode: "repo-required",
  includeProgressNote: false,
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
  validate: zodValidator(architectDecompositionEnvelopeSchema),
  defaultTools: [],
  defaultThinkingLevel: "medium",
  defaultLimits: { maxTurns: 80, maxUsd: 25 },
  workspaceMode: "scratch",
  includeProgressNote: false,
};
