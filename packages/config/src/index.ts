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

  // Postgres
  DATABASE_URL: z
    .string()
    .default("postgres://colony:colony@localhost:5432/colony"),

  // Temporal
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_TLS: boolFromEnv.default(false),
  TEMPORAL_TLS_SERVER_NAME: optionalNonEmptyString,
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("colony-supervisor"),

  // Agent runtime
  AGENT_RUNTIME: z.enum(["fake", "pi"]).optional(),
  COLONY_CONFIG_PATH: optionalNonEmptyString,

  // GitLab (home-lab provider)
  GITLAB_BASE_URL: z.string().default("http://gitlab.local"),
  GITLAB_TOKEN: z.string().default(""),
  GITLAB_WEBHOOK_SECRET: z.string().default(""),
  GITLAB_DEV_PROJECT_ID: z.string().default(""),

  // Service ports
  API_PORT: z.coerce.number().int().default(4000),
  WEBHOOK_DISPATCHER_PORT: z.coerce.number().int().default(4100),
  TOOL_GATEWAY_PORT: z.coerce.number().int().default(4200),
  WEB_PORT: z.coerce.number().int().default(3000),

  // Host for cross-service calls (the laptop's LAN name/IP when GitLab needs to reach the dispatcher)
  PUBLIC_HOST: z.string().default("localhost"),
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
  type LoadColonyConfigOptions,
  type PiApiKind,
  type ResolvedAgentConfig,
  type ResolvedAuth,
} from "./colony-config.js";
