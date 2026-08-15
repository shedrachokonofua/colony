import type { Api, Model } from "@mariozechner/pi-ai";
import {
  FakeAgentRuntimeAdapter,
  PiAgentRuntimeAdapter,
  type AgentRuntimeAdapter,
  type CredentialBroker,
} from "@colony/agent-runtime";
import type { ColonyConfig, ResolvedAgentConfig } from "@colony/config";

export interface AgentWiring {
  readonly runtime: "fake" | "pi";
  readonly architect: AgentRuntimeAdapter;
  readonly developer: AgentRuntimeAdapter;
  readonly reviewer?: AgentRuntimeAdapter;
}

/**
 * Build the agent runtime wiring once at boot.
 *
 * `fake` -> shared FakeAgentRuntimeAdapter (tests).
 * `pi`   -> PiAgentRuntimeAdapter with PiArchitectRunner / PiCodingAgentRunner,
 *           model/thinking/limits from colony config, credential broker that
 *           resolves provider auth (env var / !cmd / literal already resolved
 *           by loadColonyConfig; oauth is unsupported in V2).
 */
export async function createAgentWiring(
  config: ColonyConfig,
): Promise<AgentWiring> {
  if (config.agentRuntime === "fake") {
    const fake = new FakeAgentRuntimeAdapter();
    return {
      runtime: "fake",
      architect: fake,
      developer: fake,
      reviewer: fake,
    };
  }

  const architectConfig = config.forAgent("architect");
  const developerConfig = config.forAgent("developer");
  const reviewerConfig =
    config.reviewMode === "required" ? config.forAgent("reviewer") : undefined;
  const agentsToCheck = reviewerConfig
    ? [architectConfig, developerConfig, reviewerConfig]
    : [architectConfig, developerConfig];
  for (const agent of agentsToCheck) {
    if (agent.auth.kind === "oauth") {
      throw new Error(
        `agent ${agent.role} uses oauth auth; oauth is unsupported in colony v2 — use an api_key provider`,
      );
    }
  }

  const broker = createConfigCredentialBroker(agentsToCheck);
  const { PiArchitectRunner } =
    await import("@colony/agent-runtime/pi-architect-runner");
  const { PiCodingAgentRunner } =
    await import("@colony/agent-runtime/pi-coding-agent-runner");

  const architectLogger = consoleLogger("architect");
  const developerLogger = consoleLogger("developer");

  let reviewer: AgentRuntimeAdapter | undefined;
  if (reviewerConfig) {
    const { PiReviewerRunner } =
      await import("@colony/agent-runtime/pi-reviewer-runner");
    const reviewerLogger = consoleLogger("reviewer");
    reviewer = new PiAgentRuntimeAdapter(
      new PiReviewerRunner({
        broker,
        model: modelFromConfig(reviewerConfig),
        maxTurns: reviewerConfig.ceilings.maxTurns,
        maxUsd: reviewerConfig.ceilings.maxUsdPerRun,
        runTimeoutMs: reviewerConfig.ceilings.timeoutMs,
        thinkingLevel: reviewerConfig.thinkingLevel,
        logger: reviewerLogger,
      }),
      {
        provider: reviewerConfig.providerKey,
        model: reviewerConfig.model.id,
      },
    );
  }

  return {
    runtime: "pi",
    architect: new PiAgentRuntimeAdapter(
      new PiArchitectRunner({
        broker,
        model: modelFromConfig(architectConfig),
        maxTurns: architectConfig.ceilings.maxTurns,
        maxUsd: architectConfig.ceilings.maxUsdPerRun,
        runTimeoutMs: architectConfig.ceilings.timeoutMs,
        thinkingLevel: architectConfig.thinkingLevel,
        logger: architectLogger,
      }),
      {
        provider: architectConfig.providerKey,
        model: architectConfig.model.id,
      },
    ),
    developer: new PiAgentRuntimeAdapter(
      new PiCodingAgentRunner({
        broker,
        model: modelFromConfig(developerConfig),
        maxTurns: developerConfig.ceilings.maxTurns,
        maxUsd: developerConfig.ceilings.maxUsdPerRun,
        runTimeoutMs: developerConfig.ceilings.timeoutMs,
        thinkingLevel: developerConfig.thinkingLevel,
        logger: developerLogger,
      }),
      {
        provider: developerConfig.providerKey,
        model: developerConfig.model.id,
      },
    ),
    reviewer,
  };
}

function createConfigCredentialBroker(
  agents: readonly ResolvedAgentConfig[],
): CredentialBroker {
  const byProvider = new Map<string, ResolvedAgentConfig>();
  for (const agent of agents) {
    byProvider.set(agent.providerKey, agent);
    byProvider.set(piProviderId(agent), agent);
  }
  return {
    resolve(request) {
      const agent = byProvider.get(request.provider);
      if (!agent) return undefined;
      if (agent.auth.kind === "oauth") {
        throw new Error(
          `agent ${agent.role} provider ${agent.providerKey} resolved oauth auth; oauth is unsupported in colony v2`,
        );
      }
      return agent.auth.apiKey;
    },
  };
}

function piProviderId(agent: ResolvedAgentConfig): string {
  if (agent.api === "openai-codex-responses") return "openai-codex";
  if (agent.api === "anthropic-messages") return "anthropic";
  return agent.providerKey;
}

export function modelFromConfig(config: ResolvedAgentConfig): Model<Api> {
  const provider = piProviderId(config);
  const baseUrl =
    config.baseUrl ??
    (config.api === "openai-codex-responses"
      ? "https://chatgpt.com/backend-api"
      : undefined);
  if (!baseUrl) {
    throw new Error(
      `agent ${config.role} provider ${config.providerKey} requires base_url for pi mode`,
    );
  }
  return {
    id: config.model.id,
    name: config.model.name,
    api: config.api,
    provider,
    baseUrl,
    reasoning: config.model.reasoning ?? false,
    input: ["text"],
    cost: {
      input: config.model.cost?.input ?? 0,
      output: config.model.cost?.output ?? 0,
      cacheRead: config.model.cost?.cacheRead ?? 0,
      cacheWrite: config.model.cost?.cacheWrite ?? 0,
    },
    contextWindow: config.model.contextWindow ?? 128_000,
    maxTokens: config.model.maxTokens ?? 16_384,
    headers: config.headers ? { ...config.headers } : undefined,
    compat:
      config.api === "openai-completions"
        ? { supportsStore: false }
        : undefined,
  };
}

interface RuntimeLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

function consoleLogger(role: string): RuntimeLogger {
  const fmt = (level: string, fields: Record<string, unknown>, msg: string) =>
    `[${role} ${new Date().toISOString()} ${level}] ${msg} ${JSON.stringify(fields)}`;
  return {
    info: (fields, message) => console.log(fmt("info", fields, message)),
    warn: (fields, message) => console.warn(fmt("warn", fields, message)),
    error: (fields, message) => console.error(fmt("error", fields, message)),
  };
}
