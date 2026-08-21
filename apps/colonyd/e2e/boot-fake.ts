import { resetEnvCache } from "@colony/config";
import type { ColonydHandle } from "../src/main.js";
import { buildEnvVars, installEnv, prepareEnvWithPort } from "./env.js";
import { createScriptedBoundary } from "./fakes.js";

export interface BootFakeHandle {
  handle: ColonydHandle;
  port: number;
  dir: string;
  boundary: ReturnType<typeof createScriptedBoundary>;
  repoId: string;
  cleanup: () => Promise<void>;
}

export async function bootFake(
  opts: {
    webhookSecret?: string;
    oidcIssuer?: string;
    oidcClientId?: string;
    oidcRequiredRole?: string;
    tickMs?: number | string;
    reviewMode?: "off" | "required";
  } = {},
): Promise<BootFakeHandle> {
  const prepared = await prepareEnvWithPort({
    webhookSecret: opts.webhookSecret ?? "",
    reviewMode: opts.reviewMode,
  });

  const envVars = buildEnvVars({
    dbPath: prepared.dbPath,
    port: prepared.port,
    configPath: prepared.configPath,
    webhookSecret: prepared.webhookSecret,
    oidcIssuer: opts.oidcIssuer,
    oidcClientId: opts.oidcClientId,
    oidcRequiredRole: opts.oidcRequiredRole,
    tickMs: opts.tickMs,
  });
  installEnv(envVars);
  resetEnvCache();

  const { boot } = await import("../src/main.js");

  const boundary = createScriptedBoundary();

  // Seed a repo so scopes can reference it
  const repo = await boundary.provider.repos.create({
    name: "console-e2e",
    path: "so/console-e2e",
  });
  const repoId = repo.id;
  boundary.script.repoId = repoId;

  const handle = await boot({
    provider: boundary.provider,
    agents: boundary.agents,
    gateExecutor: boundary.gateExecutor,
    validateExecutor: boundary.validateExecutor,
  });

  const cleanup = async (): Promise<void> => {
    await handle.shutdown();
    prepared.cleanup();
  };

  return {
    handle,
    port: prepared.port,
    dir: prepared.dir,
    boundary,
    repoId,
    cleanup,
  };
}
