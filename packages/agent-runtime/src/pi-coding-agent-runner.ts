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
import type { PiRunRequest, PiRunResult, PiRunner } from "./pi-adapter.js";
import {
  type ActivePiRun,
  type PiRunnerBaseOptions,
  buildDeveloperSystemPrompt,
  buildPacketPrompt,
  createDeveloperSubmitTool,
  createSandboxId,
  forceSubmitToolStream,
  installRunGuards,
  resolvePiModel,
  runnerBroker,
  sandboxCwd,
  withRunTimeout,
} from "./pi-runner-common.js";

export interface PiCodingAgentRunnerOptions extends PiRunnerBaseOptions {
  readonly developerTools?: readonly string[];
}

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
    const broker = runnerBroker(this.options);
    const model = await resolvePiModel(request, this.options.model);
    const cwd = sandboxCwd(request.environment, this.options.scratchDir);
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
    const toolNames = [
      ...(this.options.developerTools ?? [
        "read",
        "write",
        "edit",
        "bash",
        "grep",
        "find",
        "ls",
      ]),
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
      session.agent.streamFn = forceSubmitToolStream(
        submitTool.name,
        session.agent.streamFn,
      );
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
            isError: context.isError,
          },
          "pi_tool_call",
        );
        return base;
      };

      try {
        await session.prompt(buildPacketPrompt(request.packet), {
          expandPromptTemplates: false,
          source: "extension",
        });
        await session.agent.waitForIdle();
      } finally {
        unsubscribeGuards();
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
