import { execSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Colony agent runtime config.
 *
 * Single YAML file (default `config/colony.yaml`) with three sections:
 *   - providers: provider key -> { api, auth, models[] }
 *   - agents:    agent role -> { provider, model, ceilings, optional auth override }
 *   - agent_runtime: "fake" | "pi" — top-level switch
 *
 * Field names mirror Pi's models.json schema where they overlap, so a
 * resolved provider entry can be handed to Pi's ModelRegistry without
 * re-translating (`api`, `models[].id`, `models[].cost`, etc.).
 *
 * Auth is a discriminated union:
 *   - api_key: Pi's three-form value resolver (env var name | "!shell cmd"
 *              | literal). Literal is rejected unless `allow_literal_keys`
 *              is set, which is itself only safe when the file is
 *              SOPS-encrypted.
 *   - oauth:   Resolution happens at run time via a connection_loader the
 *              caller injects (see resolveAgentConfig below). The YAML
 *              carries no token material.
 */

// ---------------------------------------------------------------------------
// Provider api kinds — verbatim from Pi (`@earendil-works/pi-ai` README).
// ---------------------------------------------------------------------------

export const PI_API_KINDS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "mistral-conversations",
  "bedrock-converse-stream",
] as const;

export type PiApiKind = (typeof PI_API_KINDS)[number];

// ---------------------------------------------------------------------------
// Zod schemas (file shape).
// ---------------------------------------------------------------------------

const apiKeyAuthSchema = z
  .object({
    kind: z.literal("api_key"),
    /**
     * Pi's three-form resolver:
     *   - leading "!" => execute the rest as a shell command, stdout = key
     *   - matches /^[A-Z_][A-Z0-9_]*$/ => env var lookup
     *   - otherwise => literal (rejected unless config.allow_literal_keys)
     */
    value: z.string().min(1),
  })
  .strict();

const oauthAuthSchema = z
  .object({
    kind: z.literal("oauth"),
    /**
     * Documentation tag for the human (e.g. "chatgpt_plus", "claude_pro").
     * Not enforced; the actual subscription lives upstream.
     */
    subscription: z.string().min(1).optional(),
  })
  .strict();

const authSchema = z.discriminatedUnion("kind", [
  apiKeyAuthSchema,
  oauthAuthSchema,
]);

const modelCostSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cache_read: z.number().nonnegative().optional(),
    cache_write: z.number().nonnegative().optional(),
  })
  .strict();

const modelSchema = z
  .object({
    id: z.string().min(1),
    /** Lookup name agents reference (defaults to `id`). */
    name: z.string().min(1).optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.enum(["text", "image"])).optional(),
    context_window: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    cost: modelCostSchema.optional(),
  })
  .strict();

const providerSchema = z
  .object({
    api: z.enum(PI_API_KINDS),
    auth: authSchema,
    base_url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    models: z.array(modelSchema).min(1),
  })
  .strict();

const agentSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    /** Ordered same-provider models tried when the primary run fails. */
    fallback_models: z.array(z.string().min(1)).default([]),
    thinking_level: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
    /** Optional: override the provider's auth for this agent only. */
    auth: authSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
    max_turns: z.number().int().positive().optional(),
  })
  .strict();

export const AGENT_ROLES = [
  "developer",
  "reviewer",
  "architect",
  "memory_consolidator",
  "integrator",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

const hitlSchema = z
  .object({
    mode: z.enum(["gated", "yolo"]).default("gated"),
  })
  .strict()
  .default({ mode: "gated" });

export type HitlMode = "gated" | "yolo";

const sandboxEngineSchema = z.enum(["in-process"]);

export type SandboxEngine = z.infer<typeof sandboxEngineSchema>;

const reviewSchema = z
  .object({
    mode: z.enum(["off", "required"]).default("off"),
  })
  .strict()
  .default({ mode: "off" });

export type ReviewMode = "off" | "required";

export const colonyConfigFileSchema = z
  .object({
    agent_runtime: z.enum(["fake", "pi"]).default("fake"),
    sandbox: z
      .object({ engine: sandboxEngineSchema.default("in-process") })
      .strict()
      .default({ engine: "in-process" }),
    /**
     * Allow literal `api_key.value` strings. Requires the file to be
     * SOPS-encrypted at rest; the loader does NOT verify SOPS itself —
     * caller is responsible for encryption. Default false.
     */
    allow_literal_keys: z.boolean().default(false),
    hitl: hitlSchema,
    review: reviewSchema,
    providers: z.record(z.string().min(1), providerSchema).default({}),
    agents: z
      .object({
        developer: agentSchema.optional(),
        reviewer: agentSchema.optional(),
        architect: agentSchema.optional(),
        memory_consolidator: agentSchema.optional(),
        integrator: agentSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type ColonyConfigFile = z.infer<typeof colonyConfigFileSchema>;

// ---------------------------------------------------------------------------
// Resolved (post-load) shape exposed to runners.
// ---------------------------------------------------------------------------

export type ResolvedAuth =
  | { readonly kind: "api_key"; readonly apiKey: string }
  | {
      readonly kind: "oauth";
      readonly subscription?: string;
      /**
       * Loader supplied by the caller (typically a Postgres-backed
       * AuthStorage adapter). Returns an opaque AuthStorage Pi will read
       * and refresh through. The config layer never touches the token
       * payload itself — it only knows the *provider key* the runner
       * should look up at run time.
       */
      readonly providerKey: string;
    };

export interface ResolvedModelConfig {
  readonly id: string;
  readonly name: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
}

export interface ResolvedAgentConfig {
  readonly role: AgentRole;
  readonly providerKey: string;
  readonly api: PiApiKind;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly model: ResolvedModelConfig;
  readonly fallbackModels: readonly ResolvedModelConfig[];
  readonly auth: ResolvedAuth;
  readonly thinkingLevel?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";
  readonly ceilings: {
    readonly timeoutMs: number;
    readonly maxTurns: number;
  };
}

export interface ColonyConfig {
  readonly agentRuntime: "fake" | "pi";
  readonly sandbox: { readonly engine: SandboxEngine };
  readonly hitlMode: HitlMode;
  readonly reviewMode: ReviewMode;
  /** Provider keys whose auth.kind === "oauth" — surface for the admin UI. */
  readonly oauthProviderKeys: readonly string[];
  forAgent(role: AgentRole): ResolvedAgentConfig;
  /** Lookup-by-key for the admin API; returns null when not present. */
  getProvider(key: string): {
    readonly api: PiApiKind;
    readonly auth: { kind: "api_key" | "oauth"; subscription?: string };
    readonly models: readonly { readonly id: string; readonly name: string }[];
  } | null;
}

// ---------------------------------------------------------------------------
// Loader.
// ---------------------------------------------------------------------------

export interface LoadColonyConfigOptions {
  /** Path to the YAML file. Default: `config/colony.yaml` from cwd. */
  readonly path?: string;
  /** Process env override map; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Override `agent_runtime` (e.g. tests force `fake`). */
  readonly agentRuntimeOverride?: "fake" | "pi";
  /** Override the sandbox engine (e.g. from COLONY_SANDBOX_ENGINE). */
  readonly sandboxEngineOverride?: SandboxEngine;
  /**
   * When true, missing providers/agents/models are tolerated and
   * `forAgent()` throws lazily on first access. Useful in fake mode.
   * Default: derived from `agent_runtime` (fake => true, pi => false).
   */
  readonly lazyValidation?: boolean;
}

export class ColonyConfigError extends Error {
  constructor(
    readonly code:
      | "FILE_NOT_FOUND"
      | "PARSE"
      | "VALIDATION"
      | "UNRESOLVED_AGENT_PROVIDER"
      | "UNRESOLVED_AGENT_MODEL"
      | "UNRESOLVED_API_KEY"
      | "LITERAL_KEY_NOT_ALLOWED",
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ColonyConfigError";
  }
}

export const DEFAULT_CEILINGS = {
  developer: { timeoutMs: 900_000, maxTurns: 60 },
  reviewer: { timeoutMs: 600_000, maxTurns: 20 },
  architect: { timeoutMs: 1_800_000, maxTurns: 80 },
  memory_consolidator: {
    timeoutMs: 300_000,
    maxTurns: 10,
  },
  integrator: { timeoutMs: 300_000, maxTurns: 10 },
} as const satisfies Record<AgentRole, ResolvedAgentConfig["ceilings"]>;

export function loadColonyConfig(
  opts: LoadColonyConfigOptions = {},
): ColonyConfig {
  const env = opts.env ?? process.env;
  const path = resolveConfigPath(opts.path);
  const raw = readYamlFile(path);
  const parsed = colonyConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ColonyConfigError(
      "VALIDATION",
      `colony config validation failed: ${parsed.error.message}`,
      { path, issues: parsed.error.issues },
    );
  }
  const file = parsed.data;
  const agentRuntime = opts.agentRuntimeOverride ?? file.agent_runtime;
  const sandboxEngine = resolveSandboxEngine(
    opts.sandboxEngineOverride,
    file.sandbox.engine,
  );
  const lazy = opts.lazyValidation ?? agentRuntime === "fake";

  // Validate cross-refs eagerly when not lazy. This catches misconfig at
  // boot rather than at first agent run.
  if (!lazy) {
    for (const [role, agentEntry] of Object.entries(file.agents)) {
      const provider = file.providers[agentEntry.provider];
      if (!provider) {
        throw new ColonyConfigError(
          "UNRESOLVED_AGENT_PROVIDER",
          `agent ${role} references unknown provider ${agentEntry.provider}`,
          { role, provider: agentEntry.provider },
        );
      }
      for (const modelRef of [
        agentEntry.model,
        ...agentEntry.fallback_models,
      ]) {
        if (findModel(provider.models, modelRef)) continue;
        throw new ColonyConfigError(
          "UNRESOLVED_AGENT_MODEL",
          `agent ${role} references unknown model ${modelRef} on provider ${agentEntry.provider}`,
          { role, provider: agentEntry.provider, model: modelRef },
        );
      }
    }
  }

  const oauthProviderKeys = Object.entries(file.providers)
    .filter(([, p]) => p.auth.kind === "oauth")
    .map(([k]) => k);

  return {
    agentRuntime,
    sandbox: { engine: sandboxEngine },
    hitlMode: file.hitl.mode,
    reviewMode: file.review.mode,
    oauthProviderKeys,
    forAgent(role) {
      const agentEntry = file.agents[role];
      if (!agentEntry) {
        throw new ColonyConfigError(
          "UNRESOLVED_AGENT_PROVIDER",
          `no config entry for agent ${role}`,
          { role },
        );
      }
      const provider = file.providers[agentEntry.provider];
      if (!provider) {
        throw new ColonyConfigError(
          "UNRESOLVED_AGENT_PROVIDER",
          `agent ${role} references unknown provider ${agentEntry.provider}`,
          { role, provider: agentEntry.provider },
        );
      }
      const model = findModel(provider.models, agentEntry.model);
      if (!model) {
        throw new ColonyConfigError(
          "UNRESOLVED_AGENT_MODEL",
          `agent ${role} references unknown model ${agentEntry.model}`,
          { role, model: agentEntry.model },
        );
      }
      const fallbackModels = agentEntry.fallback_models.map((modelRef) => {
        const fallback = findModel(provider.models, modelRef);
        if (!fallback) {
          throw new ColonyConfigError(
            "UNRESOLVED_AGENT_MODEL",
            `agent ${role} references unknown fallback model ${modelRef}`,
            { role, model: modelRef },
          );
        }
        return toResolvedModel(fallback);
      });
      const auth = resolveAuth(
        agentEntry.auth ?? provider.auth,
        agentEntry.provider,
        env,
        file.allow_literal_keys,
      );
      const defaults = DEFAULT_CEILINGS[role];
      return {
        role,
        providerKey: agentEntry.provider,
        api: provider.api,
        baseUrl: provider.base_url,
        headers: provider.headers,
        model: toResolvedModel(model),
        fallbackModels,
        auth,
        thinkingLevel: agentEntry.thinking_level,
        ceilings: {
          timeoutMs: agentEntry.timeout_ms ?? defaults.timeoutMs,
          maxTurns: agentEntry.max_turns ?? defaults.maxTurns,
        },
      };
    },
    getProvider(key) {
      const provider = file.providers[key];
      if (!provider) return null;
      return {
        api: provider.api,
        auth: {
          kind: provider.auth.kind,
          subscription:
            provider.auth.kind === "oauth"
              ? provider.auth.subscription
              : undefined,
        },
        models: provider.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function resolveConfigPath(path: string | undefined): string {
  const p = path ?? "config/colony.yaml";
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function resolveSandboxEngine(
  override: SandboxEngine | undefined,
  fileEngine: SandboxEngine,
): SandboxEngine {
  if (override === undefined) return fileEngine;
  const parsed = sandboxEngineSchema.safeParse(override);
  if (!parsed.success) {
    throw new ColonyConfigError(
      "VALIDATION",
      `invalid sandbox engine override: ${parsed.error.message}`,
      { engine: override },
    );
  }
  return parsed.data;
}

function readYamlFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new ColonyConfigError(
      "FILE_NOT_FOUND",
      `colony config not found at ${path}`,
      { path },
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ColonyConfigError(
      "PARSE",
      `failed to read colony config at ${path}: ${e instanceof Error ? e.message : String(e)}`,
      { path },
    );
  }
  try {
    return parseYaml(text);
  } catch (e) {
    throw new ColonyConfigError(
      "PARSE",
      `failed to parse colony config YAML at ${path}: ${e instanceof Error ? e.message : String(e)}`,
      { path },
    );
  }
}

function findModel(
  models: ReadonlyArray<z.infer<typeof modelSchema>>,
  ref: string,
): z.infer<typeof modelSchema> | undefined {
  return models.find((m) => (m.name ?? m.id) === ref || m.id === ref);
}

function toResolvedModel(
  model: z.infer<typeof modelSchema>,
): ResolvedModelConfig {
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: model.reasoning,
    contextWindow: model.context_window,
    maxTokens: model.max_tokens,
    cost: model.cost
      ? {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cache_read,
          cacheWrite: model.cost.cache_write,
        }
      : undefined,
  };
}

const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;

function resolveAuth(
  auth: z.infer<typeof authSchema>,
  providerKey: string,
  env: Readonly<Record<string, string | undefined>>,
  allowLiteral: boolean,
): ResolvedAuth {
  if (auth.kind === "oauth") {
    return {
      kind: "oauth",
      subscription: auth.subscription,
      providerKey,
    };
  }
  return {
    kind: "api_key",
    apiKey: resolveApiKeyValue(auth.value, env, allowLiteral, providerKey),
  };
}

function resolveApiKeyValue(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  allowLiteral: boolean,
  providerKey: string,
): string {
  if (value.startsWith("!")) {
    const cmd = value.slice(1).trim();
    try {
      const out = execSync(cmd, { encoding: "utf8" }).trim();
      if (!out) {
        throw new ColonyConfigError(
          "UNRESOLVED_API_KEY",
          `provider ${providerKey} api_key shell command returned empty output`,
          { providerKey },
        );
      }
      return out;
    } catch (e) {
      if (e instanceof ColonyConfigError) throw e;
      throw new ColonyConfigError(
        "UNRESOLVED_API_KEY",
        `provider ${providerKey} api_key shell command failed: ${e instanceof Error ? e.message : String(e)}`,
        { providerKey },
      );
    }
  }
  if (ENV_VAR_RE.test(value)) {
    const v = env[value];
    if (!v) {
      throw new ColonyConfigError(
        "UNRESOLVED_API_KEY",
        `provider ${providerKey} api_key env var ${value} is unset`,
        { providerKey, envVar: value },
      );
    }
    return v;
  }
  if (!allowLiteral) {
    throw new ColonyConfigError(
      "LITERAL_KEY_NOT_ALLOWED",
      `provider ${providerKey} api_key is a literal but allow_literal_keys is false`,
      { providerKey },
    );
  }
  return value;
}
