import type { Api, Model, OAuthCredentials } from "@mariozechner/pi-ai";
import {
  OAuthCredentialRepository,
  SecretEncryption,
  createPool,
} from "@colony/db";
import type { OAuthProviderId } from "@mariozechner/pi-ai";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import {
  FakeAgentRuntimeAdapter,
  PiAgentRuntimeAdapter,
  type AgentRuntimeAdapter,
  type CredentialBroker,
  type CredentialResolveRequest,
  type ToolAuthorizationRequest,
  type ToolAuthorizationResult,
} from "@colony/agent-runtime";
import {
  ColonyConfigError,
  DEFAULT_CEILINGS,
  loadColonyConfig,
  type Env,
  type ColonyConfig,
  type ResolvedAgentConfig,
} from "@colony/config";

const ARCHITECT_FALLBACK_CEILINGS = DEFAULT_CEILINGS.architect;

export interface AgentRuntimeWiring {
  readonly developerPlanner: AgentRuntimeAdapter;
  readonly planReviewer: AgentRuntimeAdapter;
  readonly developer: AgentRuntimeAdapter;
  readonly reviewer: AgentRuntimeAdapter;
  readonly architect: AgentRuntimeAdapter;
}

export async function createAgentRuntimeWiring(
  env: Env,
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AgentRuntimeWiring> {
  const runtime =
    env.AGENT_RUNTIME ?? (env.NODE_ENV === "test" ? "fake" : undefined);
  const config = loadRuntimeConfig(env, runtime, rawEnv);
  if (!runtime && !config && env.NODE_ENV !== "test") {
    throw new Error(
      "Colony agent runtime config is unavailable: set AGENT_RUNTIME or provide a readable COLONY_CONFIG_PATH",
    );
  }
  const choice = runtime ?? config?.agentRuntime ?? "fake";

  if (choice === "fake") {
    const fake = new FakeAgentRuntimeAdapter();
    return {
      developerPlanner: fake,
      planReviewer: fake,
      developer: fake,
      reviewer: fake,
      architect: fake,
    };
  }

  if (!config) {
    throw new Error("AGENT_RUNTIME=pi requires a Colony runtime config");
  }

  const developer = config.forAgent("developer");
  const reviewer = config.forAgent("reviewer");
  // Architect is optional in older configs. Fall back to the developer
  // entry's provider/model wiring with architect-role ceilings — both roles
  // run a Pi agent against the same LLM today.
  const architect = resolveArchitectAgent(config, developer);
  const broker = createConfigCredentialBroker(
    [developer, reviewer, architect],
    env,
    rawEnv,
  );
  const { PiCodingAgentRunner } =
    await import("@colony/agent-runtime/pi-coding-agent-runner");
  const { PiMonoRunner } = await import("@colony/agent-runtime/pi-mono-runner");
  const { PiDeveloperPlanRunner, PiPlanReviewRunner } =
    await import("@colony/agent-runtime/pi-plan-runner");
  const { PiArchitectRunner } =
    await import("@colony/agent-runtime/pi-architect-runner");

  const logger = consoleLogger();
  return {
    developerPlanner: new PiAgentRuntimeAdapter(
      new PiDeveloperPlanRunner({
        broker,
        model: modelFromConfig(developer),
        maxTurns: developer.ceilings.maxTurns,
        maxUsd: developer.ceilings.maxUsdPerRun,
        runTimeoutMs: developer.ceilings.timeoutMs,
        thinkingLevel: developer.thinkingLevel,
        logger,
      }),
    ),
    planReviewer: new PiAgentRuntimeAdapter(
      new PiPlanReviewRunner({
        broker,
        model: modelFromConfig(reviewer),
        maxTurns: reviewer.ceilings.maxTurns,
        maxUsd: reviewer.ceilings.maxUsdPerRun,
        runTimeoutMs: reviewer.ceilings.timeoutMs,
        thinkingLevel: reviewer.thinkingLevel,
        logger,
      }),
    ),
    developer: new PiAgentRuntimeAdapter(
      new PiCodingAgentRunner({
        broker,
        model: modelFromConfig(developer),
        maxTurns: developer.ceilings.maxTurns,
        maxUsd: developer.ceilings.maxUsdPerRun,
        runTimeoutMs: developer.ceilings.timeoutMs,
        thinkingLevel: developer.thinkingLevel,
        logger,
      }),
    ),
    reviewer: new PiAgentRuntimeAdapter(
      new PiMonoRunner({
        broker,
        model: modelFromConfig(reviewer),
        maxTurns: reviewer.ceilings.maxTurns,
        maxUsd: reviewer.ceilings.maxUsdPerRun,
        runTimeoutMs: reviewer.ceilings.timeoutMs,
        thinkingLevel: reviewer.thinkingLevel,
        logger,
      }),
    ),
    architect: new PiAgentRuntimeAdapter(
      new PiArchitectRunner({
        broker,
        model: modelFromConfig(architect),
        maxTurns: architect.ceilings.maxTurns,
        maxUsd: architect.ceilings.maxUsdPerRun,
        runTimeoutMs: architect.ceilings.timeoutMs,
        thinkingLevel: architect.thinkingLevel,
        logger,
      }),
    ),
  };
}

function consoleLogger() {
  const fmt = (level: string, fields: Record<string, unknown>, msg: string) =>
    `[pi ${new Date().toISOString()} ${level}] ${msg} ${JSON.stringify(fields)}`;
  return {
    info: (f: Record<string, unknown>, m: string) =>
      console.log(fmt("info", f, m)),
    warn: (f: Record<string, unknown>, m: string) =>
      console.warn(fmt("warn", f, m)),
    error: (f: Record<string, unknown>, m: string) =>
      console.error(fmt("error", f, m)),
  };
}

function resolveArchitectAgent(
  config: ColonyConfig,
  developer: ResolvedAgentConfig,
): ResolvedAgentConfig {
  try {
    return config.forAgent("architect");
  } catch (error) {
    if (
      error instanceof ColonyConfigError &&
      error.code === "UNRESOLVED_AGENT_PROVIDER"
    ) {
      return {
        ...developer,
        role: "architect",
        ceilings: ARCHITECT_FALLBACK_CEILINGS,
      };
    }
    throw error;
  }
}

function loadRuntimeConfig(
  env: Env,
  runtime: "fake" | "pi" | undefined,
  rawEnv: Readonly<Record<string, string | undefined>>,
): ColonyConfig | undefined {
  if (runtime === "fake") return undefined;
  try {
    return loadColonyConfig({
      path: env.COLONY_CONFIG_PATH,
      env: rawEnv,
      agentRuntimeOverride: runtime,
    });
  } catch (error) {
    if (
      runtime === undefined &&
      error instanceof ColonyConfigError &&
      error.code === "FILE_NOT_FOUND"
    ) {
      return undefined;
    }
    throw error;
  }
}

export function createConfigCredentialBroker(
  agents: readonly ResolvedAgentConfig[],
  env: Env,
  rawEnv: Readonly<Record<string, string | undefined>>,
): CredentialBroker {
  const entriesByProvider = new Map<
    string,
    {
      readonly agent: ResolvedAgentConfig;
      readonly piProviderId: string;
    }
  >();
  let oauthRepo: OAuthCredentialRepository | undefined;

  for (const agent of agents) {
    const piProviderId = piProviderIdForAgent(agent);
    entriesByProvider.set(agent.providerKey, { agent, piProviderId });
    entriesByProvider.set(piProviderId, { agent, piProviderId });
  }
  return {
    async resolve(
      request: CredentialResolveRequest,
    ): Promise<string | undefined> {
      const entry = entriesByProvider.get(request.provider);
      if (!entry) return undefined;
      if (entry.agent.auth.kind === "api_key") return entry.agent.auth.apiKey;

      const oauthProviderId = oauthProviderIdForAgent(entry.agent);
      if (!oauthProviderId) {
        throw new Error(
          `agent ${entry.agent.role} provider ${entry.agent.providerKey} uses oauth, but api ${entry.agent.api} is not wired for OAuth token refresh`,
        );
      }
      oauthRepo ??= new OAuthCredentialRepository(
        createPool({
          connectionString: env.DATABASE_URL,
          role: "colony_writer",
        }),
        SecretEncryption.fromString(secretEncryptionKey(env.NODE_ENV, rawEnv)),
      );
      return resolveOAuthApiKey({
        repo: oauthRepo,
        providerKey: entry.agent.auth.providerKey,
        providerId: oauthProviderId,
      });
    },
    authorizeTool(request: ToolAuthorizationRequest): ToolAuthorizationResult {
      if (isSubmissionTool(request.toolName)) {
        return { allow: true };
      }
      const granted = new Set([
        ...request.packet.capabilities,
        ...request.packet.tool_permissions,
      ]);
      const required = requiredPacketPermissions(request.toolName);
      if (required.some((permission) => granted.has(permission))) {
        return { allow: true };
      }
      return {
        allow: false,
        reason: `tool ${request.toolName} is not authorized by the run packet capabilities or tool permissions`,
      };
    },
  };
}

function isSubmissionTool(toolName: string): boolean {
  return (
    toolName === "submit_developer_completion" ||
    toolName === "submit_developer_plan" ||
    toolName === "submit_plan_review" ||
    toolName === "submit_reviewer_review" ||
    toolName === "submit_architect_decomposition"
  );
}

function requiredPacketPermissions(toolName: string): readonly string[] {
  switch (toolName) {
    case "bash":
      return ["bash", "tool.cli.execute", "tool.call", "git"];
    case "read":
    case "grep":
    case "find":
    case "ls":
      return [toolName, "provider.commits.read", "tool.call", "git"];
    case "write":
    case "edit":
      return [toolName, "provider.branches.push", "tool.call", "git"];
    case "post_progress_note":
      return ["post_progress_note", "provider.comment", "provider.mr.comment"];
    case "submit_developer_completion":
    case "submit_developer_plan":
    case "submit_plan_review":
    case "submit_reviewer_review":
    case "submit_architect_decomposition":
      return [toolName];
    default:
      return [toolName];
  }
}

async function resolveOAuthApiKey(input: {
  readonly repo: OAuthCredentialRepository;
  readonly providerKey: string;
  readonly providerId: OAuthProviderId;
}): Promise<string | undefined> {
  const provider = getOAuthProvider(input.providerId);
  if (!provider) {
    throw new Error(`unknown OAuth provider id ${input.providerId}`);
  }
  const conn = await input.repo.getActiveConnection<OAuthCredentials>(
    input.providerKey,
  );
  if (!conn) return undefined;
  if (Date.now() < conn.payload.expires) {
    return provider.getApiKey(conn.payload);
  }
  const refreshed = await provider.refreshToken(conn.payload);
  await input.repo.recordRefresh({
    id: conn.id,
    payload: refreshed,
    expiresAt: refreshed.expires ? new Date(refreshed.expires) : null,
  });
  return provider.getApiKey(refreshed);
}

function oauthProviderIdForAgent(
  agent: ResolvedAgentConfig,
): OAuthProviderId | undefined {
  if (agent.api === "openai-codex-responses") return "openai-codex";
  if (agent.api === "anthropic-messages") return "anthropic";
  return undefined;
}

function piProviderIdForAgent(agent: ResolvedAgentConfig): string {
  return oauthProviderIdForAgent(agent) ?? agent.providerKey;
}

function secretEncryptionKey(
  nodeEnv: string,
  rawEnv: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return (
    rawEnv.COLONY_SECRET_ENCRYPTION_KEY ??
    (nodeEnv === "development" ? "dev-only-not-for-production" : undefined)
  );
}

export function modelFromConfig(config: ResolvedAgentConfig): Model<Api> {
  const provider = piProviderIdForAgent(config);
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
