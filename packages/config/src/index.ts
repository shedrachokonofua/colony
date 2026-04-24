import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Postgres
  DATABASE_URL: z
    .string()
    .default("postgres://colony:colony@localhost:5432/colony"),

  // Temporal
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("colony-supervisor"),

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
