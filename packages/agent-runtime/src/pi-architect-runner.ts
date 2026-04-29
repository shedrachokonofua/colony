import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { architectDecompositionEnvelopeSchema } from "@colony/schemas";
import type { PiRunRequest, PiRunResult, PiRunner } from "./pi-adapter.js";
import {
  type ActivePiRun,
  type PiRunnerBaseOptions,
  architectDecompositionEnvelopeTypeBox,
  buildArchitectSystemPrompt,
  buildPacketPrompt,
  createArchitectSubmitTool,
  createSandboxId,
  finalizeEnvelopeWithStructuredOutput,
  installRunGuards,
  resolvePiModel,
  runnerBroker,
  withRunTimeout,
} from "./pi-runner-common.js";

export type PiArchitectRunnerOptions = PiRunnerBaseOptions;

export class PiArchitectRunner implements PiRunner {
  readonly kind = "pi-architect" as const;
  private readonly activeRuns = new Map<string, ActivePiRun>();

  constructor(private readonly options: PiArchitectRunnerOptions = {}) {}

  async run(request: PiRunRequest): Promise<PiRunResult> {
    if (request.environment.role !== "architect") {
      throw new Error("PiArchitectRunner requires an architect run");
    }

    const runId = request.runId;
    const sandboxId = createSandboxId("pi-architect");
    const broker = runnerBroker(this.options);
    const model = await resolvePiModel(request, this.options.model);
    let capturedEnvelope: unknown;

    const submitTool = createArchitectSubmitTool((value) => {
      capturedEnvelope = value;
    });

    const agent = new Agent({
      initialState: {
        systemPrompt: buildArchitectSystemPrompt(),
        model,
        thinkingLevel: this.options.thinkingLevel ?? "medium",
        tools: [submitTool],
        messages: [],
      },
      convertToLlm: (messages) => messages.filter(isLlmMessage),
      toolExecution: "sequential",
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      sessionId: runId,
      getApiKey: (provider) =>
        broker.resolve({
          provider,
          capability: `agent.llm.${provider}.invoke`,
          bindingName: request.environment.runtimeBinding.binding.name,
          environment: request.environment,
        }),
      beforeToolCall: async (context) => {
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
      },
      afterToolCall: (context) => {
        this.options.logger?.info?.(
          {
            runId,
            sandboxId,
            tool: context.toolCall.name,
            isError: context.isError,
          },
          "pi_tool_call",
        );
        return Promise.resolve(undefined);
      },
    });

    const unsubscribeGuards = installRunGuards(agent, runId, {
      maxTurns: this.options.maxTurns ?? 80,
      maxUsd: this.options.maxUsd ?? 25,
      logger: this.options.logger,
    });
    const clearTimeoutGuard = withRunTimeout(
      runId,
      this.options.runTimeoutMs,
      () => agent.abort(),
    );
    this.activeRuns.set(runId, {
      abort: () => agent.abort(),
    });

    try {
      await agent.prompt(buildPacketPrompt(request.packet));
      await agent.waitForIdle();

      if (capturedEnvelope === undefined) {
        capturedEnvelope = await finalizeEnvelopeWithStructuredOutput({
          model,
          apiKey: await broker.resolve({
            provider: model.provider,
            capability: `agent.llm.${model.provider}.invoke`,
            bindingName: request.environment.runtimeBinding.binding.name,
            environment: request.environment,
          }),
          systemPrompt: buildArchitectSystemPrompt(),
          messages: agent.state.messages,
          finalUserMessage:
            "Decomposition is complete. Submit exactly one schema-conforming architect_decomposition envelope as JSON, with at least one proposed task. Each proposed_task_id must be `<scope_id>.<n>` and unique within the proposal.",
          schemaName: "architect_decomposition",
          typeboxSchema: architectDecompositionEnvelopeTypeBox,
          validate: (value) => {
            const parsed =
              architectDecompositionEnvelopeSchema.safeParse(value);
            if (parsed.success) return null;
            return parsed.error.issues.map(
              (i) =>
                `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`,
            );
          },
          logger: this.options.logger,
          runId,
        });
      }
    } finally {
      clearTimeoutGuard();
      unsubscribeGuards();
      agent.abort();
      await agent.waitForIdle();
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

function isLlmMessage(message: AgentMessage): message is Message {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
  );
}
