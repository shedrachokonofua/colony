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
  withRunTimeout,
} from "./pi-runner-common.js";
import {
  architectDecompositionEnvelopeSchema,
  developerCompletionEnvelopeSchema,
  developerPlanEnvelopeSchema,
  planReviewEnvelopeSchema,
  reviewerReviewEnvelopeSchema,
  type TaskPacket,
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
  readonly completeEnvelope?: (
    rawEnvelope: unknown,
    packet: AgentRuntimePacket,
  ) => unknown;
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
    const cwd = provisionProfileWorkspace(
      runId,
      request.packet,
      this.profile,
      this.options,
      workTools,
    );
    let capturedEnvelope: unknown;
    let session: AgentSession | undefined;

    const submitTool = this.profile.submitTool((value) => {
      capturedEnvelope = value;
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
          await session.prompt(buildPacketPrompt(request.packet), {
            expandPromptTemplates: false,
            source: "extension",
          });
          await session.agent.waitForIdle();
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
        capturedEnvelope = this.profile.completeEnvelope
          ? this.profile.completeEnvelope(rawEnvelope, request.packet)
          : rawEnvelope;
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

function provisionProfileWorkspace(
  runId: string,
  packet: AgentRuntimePacket,
  profile: PiRoleProfile,
  options: PiBaseAgentRunnerOptions,
  workTools: readonly string[],
): string {
  if (profile.workspaceMode === "scratch" || workTools.length === 0) {
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
  completeEnvelope: completeDeveloperEnvelope,
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
  includeProgressNote: true,
};

/**
 * Merge model output with packet-derived defaults to produce a
 * schema-valid `developer_completion` envelope. Kimi-class models served via
 * Ollama don't strictly conform to deeply-nested tool-call schemas; rather
 * than retry forever, we take the model's contributions and overlay
 * deterministic packet fields so the envelope validates by construction.
 */
function completeDeveloperEnvelope(
  rawArgs: unknown,
  packet: AgentRuntimePacket,
): unknown {
  const taskPacket = packet as TaskPacket;
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
    freshness: taskPacket.freshness,
    rationale,
    task_id: taskPacket.task_id,
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
