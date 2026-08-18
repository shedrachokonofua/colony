import { resetEnvCache } from "@colony/config";
import type { ColonydHandle } from "../src/main.js";
import { buildEnvVars, installEnv, prepareEnvWithPort } from "./env.js";
import { createScriptedBoundary } from "./fakes.js";

export interface BootFakeHandle {
  handle: ColonydHandle;
  port: number;
  dir: string;
  boundary: ReturnType<typeof createScriptedBoundary>;
  projectId: string;
  cleanup: () => Promise<void>;
}

export async function bootFake(
  opts: {
    webhookSecret?: string;
    oidcIssuer?: string;
    oidcClientId?: string;
    oidcRequiredRole?: string;
    tickMs?: number | string;
  } = {},
): Promise<BootFakeHandle> {
  const prepared = await prepareEnvWithPort({
    webhookSecret: opts.webhookSecret ?? "",
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

  // Seed project so scopes can reference it
  const project = await boundary.provider.projects.create({
    name: "console-e2e",
    path: "so/console-e2e",
  });
  const projectId = project.id;
  boundary.script.projectId = projectId;

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
    projectId,
    cleanup,
  };
}
