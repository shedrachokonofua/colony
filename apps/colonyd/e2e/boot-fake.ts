import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetEnvCache } from "@colony/config";
import type { ColonydHandle } from "../src/main.js";
import { buildEnvVars, freePort, writeColonyYaml } from "./env.js";
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
  } = {},
): Promise<BootFakeHandle> {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-e2e-"));
  const configPath = join(dir, "colony.yaml");
  writeColonyYaml(configPath);
  const dbPath = join(dir, "colonyd.db");
  const port = await freePort();

  const envVars = buildEnvVars({
    dbPath,
    port,
    configPath,
    webhookSecret: opts.webhookSecret ?? "",
  });
  for (const [k, v] of Object.entries(envVars)) process.env[k] = v;
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

  // Create a seeded branch commit root optional
  // provider starts with empty commits; branches.create uses headSha mapping

  const handle = await boot({
    provider: boundary.provider,
    agents: boundary.agents,
    gateExecutor: boundary.gateExecutor,
    validateExecutor: boundary.validateExecutor,
  });

  const cleanup = async (): Promise<void> => {
    await handle.shutdown();
    rmSync(dir, { recursive: true, force: true });
  };

  return { handle, port, dir, boundary, projectId, cleanup };
}
