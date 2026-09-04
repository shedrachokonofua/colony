import {
  FakeAgentRuntimeAdapter,
  PiAgentRuntimeAdapter,
  type PiModelSpec,
  type AgentRuntimeAdapter,
  type CredentialBroker,
} from "@colony/agent-runtime";
import { env } from "@colony/config";
import type {
  ColonyConfig,
  ResolvedAgentConfig,
  SandboxEngine as SandboxEngineName,
} from "@colony/config";
import type { Store } from "@colony/core";
import type { TaskCostModelV1 } from "@colony/schemas";
import type { SandboxEngine } from "@colony/sandbox";
import type { RunAuditSink } from "@colony/agent-runtime";

/**
 * Per-session architect size gate source: colonyd rebuilds the offline cost
 * model from its runs table for each architect session and pairs it with the
 * developer budget. `undefined` disables the gate.
 */
export interface AgentTaskCostSource {
  readonly provider: () =>
    | { readonly model: TaskCostModelV1; readonly budget_ms: number }
    | undefined;
}

type WebToolsConfig = { searxngUrl?: string };

export interface AgentWiring {
  readonly runtime: "fake" | "pi";
  readonly architect: AgentRuntimeAdapter;
  readonly developer: AgentRuntimeAdapter;
  readonly reviewer?: AgentRuntimeAdapter;
  /** The reviewer chain pointed at plans; present whenever `reviewer` is. */
  readonly planReviewer?: AgentRuntimeAdapter;
}

export type RunEventSink = (
  runId: string,
  event: string,
  detail: Record<string, unknown>,
) => void;

/**
 * Build the run-event sink that appends every agent event to `run_events`
 * and, on a `pi_model_fallback` event, updates the run's `model_id` to the
 * fallback model. Never throws: the activity feed must not break a run.
 */
export function createRunEventSink(store: Store): RunEventSink {
  return (runId, event, detail) => {
    try {
      store.appendRunEvent(runId, event, detail);
      if (event === "pi_model_fallback" && typeof detail.to === "string") {
        store.setRunModel(runId, detail.to);
      }
      if (
        event === "pi_tool_start" &&
        typeof detail.tool === "string" &&
        typeof detail.startedAt === "string"
      ) {
        store.setRunActiveTool(
          runId,
          detail.tool,
          typeof detail.detail === "string" ? detail.detail : null,
          detail.startedAt,
        );
      } else if (event === "pi_tool_observation") {
        store.clearRunActiveTool(runId, new Date().toISOString());
      } else if (event === "pi_turn_usage") {
        store.touchRunProgress(runId, new Date().toISOString());
      }
    } catch {
      // The activity feed must never break a run.
    }
  };
}

/**
 * Maps a configured sandbox engine name to a dynamic factory producing the
 * `SandboxEngine`. Mirrors how the pi runners are imported via
 * `await import("@colony/agent-runtime/pi-architect-runner")` so the engine
 * choice is resolved at boot rather than statically linked.
 */
export const ENGINE_REGISTRY: Record<
  SandboxEngineName,
  (config: ColonyConfig) => Promise<() => SandboxEngine>
> = {
  "in-process": () =>
    import("@colony/sandbox-in-process").then((m) => m.createInProcessEngine),
  kubernetes: (config) =>
    import("@colony/sandbox-k8s").then(
      (m) => () =>
        m.createKubernetesEngine({
          namespace: config.sandbox.kubernetes.namespace,
          image: config.sandbox.kubernetes.image,
          apiVersionOverride: config.sandbox.kubernetes.api_version_override,
        }),
    ),
};

/** Resolve a configured engine name, throwing on unknown names. */
export async function createEngine(
  name: string,
  config: ColonyConfig,
): Promise<SandboxEngine> {
  const factory = ENGINE_REGISTRY[name as SandboxEngineName];
  if (!factory) {
    throw new Error(`unknown sandbox engine: ${name}`);
  }
  const engineFactory = await factory(config);
  return engineFactory();
}

/**
 * Build the agent runtime wiring once at boot.
 *
 * `fake` -> shared FakeAgentRuntimeAdapter (tests).
 * `pi`   -> PiAgentRuntimeAdapter with PiArchitectRunner / PiCodingAgentRunner,
 *           model/thinking/limits from colony config, credential broker that
 *           resolves provider auth (env var / !cmd / literal already resolved
 *           by loadColonyConfig; oauth is unsupported).
 */
export async function createAgentWiring(
  config: ColonyConfig,
  onRunEvent?: RunEventSink,
  taskCost?: AgentTaskCostSource,
  auditSink?: RunAuditSink,
  store?: Store,
): Promise<AgentWiring> {
  if (config.agentRuntime === "fake") {
    const fake = new FakeAgentRuntimeAdapter();
    return {
      runtime: "fake",
      architect: fake,
      developer: fake,
      reviewer: fake,
      planReviewer: fake,
    };
  }

  const architectConfig = config.forAgent("architect");
  const developerConfig = config.forAgent("developer");
  const reviewerConfig =
    config.reviewMode === "required" ? config.forAgent("reviewer") : undefined;
  const planReviewerConfig =
    config.reviewMode === "required"
      ? config.forAgent("plan_reviewer")
      : undefined;
  const agentsToCheck = reviewerConfig
    ? [architectConfig, developerConfig, reviewerConfig]
    : [architectConfig, developerConfig];
  for (const agent of agentsToCheck) {
    if (agent.auth.kind === "oauth") {
      throw new Error(
        `agent ${agent.role} uses oauth auth; oauth is unsupported — use an api_key provider`,
      );
    }
  }

  const broker = createConfigCredentialBroker(agentsToCheck);
  const engine = await createEngine(config.sandbox.engine, config);
  const webTools = resolveWebToolsConfig(env().COLONY_SEARXNG_URL);
  const { PiArchitectRunner } =
    await import("@colony/agent-runtime/pi-architect-runner");
  const { PiCodingAgentRunner } =
    await import("@colony/agent-runtime/pi-coding-agent-runner");

  // Shared Pi runner persistence options: durable session JSONL root and the
  // runs-table sandbox write-back. The store is reached only through this
  // injected callback — the agent-runtime package never imports @colony/core.
  const persistOptions = {
    sessionsDir: config.sessionsDir,
    onSandboxId: (runId: string, sandboxId: string) =>
      store?.setRunSandboxId(runId, sandboxId),
    // Runtime failover reads the same cap + live count the dispatcher's
    // slot picker does (tick.ts pickDispatchSlot); one definition of "free".
    modelHasCapacity: (modelId: string) => {
      const limit = config.modelParallelLimit(modelId);
      return (
        limit === null ||
        store === undefined ||
        store.activeRunCountByModel(modelId) < limit
      );
    },
  } as const;

  const architectLogger = roleLogger("architect", onRunEvent);
  const developerLogger = roleLogger("developer", onRunEvent);

  let reviewer: AgentRuntimeAdapter | undefined;
  let planReviewer: AgentRuntimeAdapter | undefined;
  if (reviewerConfig) {
    const { PiReviewerRunner } =
      await import("@colony/agent-runtime/pi-reviewer-runner");
    const { PiPlanReviewerRunner } =
      await import("@colony/agent-runtime/pi-plan-reviewer-runner");
    const reviewerLogger = roleLogger("reviewer", onRunEvent);
    const planReviewerLogger = roleLogger("plan_reviewer", onRunEvent);
    planReviewer = new PiAgentRuntimeAdapter(
      new PiPlanReviewerRunner({
        broker,
        model: modelFromConfig(planReviewerConfig!),
        fallbackModels: fallbackModelsFromConfig(planReviewerConfig!),
        maxTurns: planReviewerConfig!.ceilings.maxTurns,
        runTimeoutMs: planReviewerConfig!.ceilings.timeoutMs,
        thinkingLevel: planReviewerConfig!.thinkingLevel,
        logger: planReviewerLogger,
        ...(auditSink ? { auditSink } : {}),
        engine,
        ...persistOptions,
        ...(webTools ? { webTools } : {}),
      }),
      {
        provider: planReviewerConfig!.providerKey,
        model: planReviewerConfig!.model.id,
      },
    );
    reviewer = new PiAgentRuntimeAdapter(
      new PiReviewerRunner({
        broker,
        model: modelFromConfig(reviewerConfig),
        fallbackModels: fallbackModelsFromConfig(reviewerConfig),
        maxTurns: reviewerConfig.ceilings.maxTurns,
        runTimeoutMs: reviewerConfig.ceilings.timeoutMs,
        thinkingLevel: reviewerConfig.thinkingLevel,
        logger: reviewerLogger,
        ...(auditSink ? { auditSink } : {}),
        engine,
        ...persistOptions,
        ...(webTools ? { webTools } : {}),
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
        fallbackModels: fallbackModelsFromConfig(architectConfig),
        maxTurns: architectConfig.ceilings.maxTurns,
        runTimeoutMs: architectConfig.ceilings.timeoutMs,
        thinkingLevel: architectConfig.thinkingLevel,
        logger: architectLogger,
        ...(auditSink ? { auditSink } : {}),
        engine,
        ...(taskCost ? { architectSizeGate: taskCost.provider } : {}),
        ...persistOptions,
        ...(webTools ? { webTools } : {}),
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
        fallbackModels: fallbackModelsFromConfig(developerConfig),
        maxTurns: developerConfig.ceilings.maxTurns,
        runTimeoutMs: developerConfig.ceilings.timeoutMs,
        thinkingLevel: developerConfig.thinkingLevel,
        logger: developerLogger,
        ...(auditSink ? { auditSink } : {}),
        engine,
        ...persistOptions,
        ...(webTools ? { webTools } : {}),
      }),
      {
        provider: developerConfig.providerKey,
        model: developerConfig.model.id,
      },
    ),
    reviewer,
    planReviewer,
  };
}

export function resolveWebToolsConfig(
  url: string | undefined,
): WebToolsConfig | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      "COLONY_SEARXNG_URL must be an https:// URL without embedded credentials",
    );
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(
      "COLONY_SEARXNG_URL must be an https:// URL without embedded credentials",
    );
  }
  return { searxngUrl: trimmed };
}

function fallbackModelsFromConfig(
  config: ResolvedAgentConfig,
): readonly PiModelSpec[] {
  return config.fallbackModels.map((model) =>
    modelFromConfig({ ...config, model, fallbackModels: [] }),
  );
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
          `agent ${agent.role} provider ${agent.providerKey} resolved oauth auth; oauth is unsupported`,
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

export function modelFromConfig(config: ResolvedAgentConfig): PiModelSpec {
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

/** Console logging plus an optional per-run event feed keyed on fields.runId. */
function roleLogger(role: string, sink?: RunEventSink): RuntimeLogger {
  const base = consoleLogger(role);
  if (!sink) return base;
  const forward = (
    level: string,
    fields: Record<string, unknown>,
    message: string,
  ): void => {
    const runId = fields["runId"];
    if (typeof runId !== "string" || !runId) return;
    try {
      sink(runId, message, { role, level, ...fields });
    } catch {
      // The activity feed must never break a run.
    }
  };
  return {
    info: (fields, message) => {
      base.info(fields, message);
      forward("info", fields, message);
    },
    warn: (fields, message) => {
      base.warn(fields, message);
      forward("warn", fields, message);
    },
    error: (fields, message) => {
      base.error(fields, message);
      forward("error", fields, message);
    },
  };
}
