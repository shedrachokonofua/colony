import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ quiet: true });

const boolFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}, z.string().optional());

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Agent runtime
  AGENT_RUNTIME: z.enum(["fake", "pi"]).optional(),

  // Sandbox
  COLONY_SANDBOX_ENGINE: z.string().optional(),
  COLONY_CONFIG_PATH: optionalNonEmptyString,

  // GitLab (home-lab provider)
  GITLAB_BASE_URL: z.string().default("http://gitlab.local"),
  GITLAB_TOKEN: z.string().default(""),
  GITLAB_WEBHOOK_SECRET: z.string().default(""),

  // Host for cross-service calls (the laptop's LAN name/IP when GitLab needs to reach colonyd)
  PUBLIC_HOST: z.string().default("localhost"),

  // colonyd
  COLONYD_PORT: z.coerce.number().int().default(4400),
  COLONYD_DB_PATH: z.string().default("data/colonyd.db"),
  COLONYD_TICK_MS: z.coerce.number().int().default(15_000),
  COLONYD_MAX_CONCURRENT: z.coerce.number().int().default(1),
  COLONYD_MAX_ATTEMPTS: z.coerce.number().int().default(3),
  /** Single-token mode: use GITLAB_TOKEN directly in packet credentials. */
  COLONYD_SINGLE_TOKEN: boolFromEnv.default(false),

  // OIDC (Keycloak). When COLONY_OIDC_ISSUER is set, every operator API
  // call must carry a Bearer token from that realm; X-Actor-Id is ignored.
  COLONY_OIDC_ISSUER: z.string().default(""),
  COLONY_OIDC_CLIENT_ID: z.string().default("colony"),
  COLONY_OIDC_REQUIRED_ROLE: z.string().default(""),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}

export {
  AGENT_ROLES,
  ColonyConfigError,
  DEFAULT_CEILINGS,
  PI_API_KINDS,
  colonyConfigFileSchema,
  loadColonyConfig,
  type AgentRole,
  type ColonyConfig,
  type ColonyConfigFile,
  type HitlMode,
  type ReviewMode,
  type LoadColonyConfigOptions,
  type PiApiKind,
  type ResolvedAgentConfig,
  type ResolvedAuth,
  type SandboxEngine,
} from "./colony-config.js";
