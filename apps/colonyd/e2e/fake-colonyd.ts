#!/usr/bin/env -S tsx
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetEnvCache } from "@colony/config";
import { buildEnvVars, freePort, writeColonyYaml } from "./env.js";
import {
  createScriptedBoundary,
  patchScript,
  serializeScript,
} from "./fakes.js";
import type { ScriptedAgentRuntimeAdapter } from "./fakes.js";

const CONTROL_PORT = Number(process.env.COLONY_E2E_CONTROL_PORT || "4478");

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-e2e-"));
  const configPath = join(dir, "colony.yaml");
  writeColonyYaml(configPath);
  const dbPath = join(dir, "colonyd.db");
  const port = process.env.COLONYD_PORT
    ? Number(process.env.COLONYD_PORT)
    : await freePort();
  const webhookSecret = process.env.GITLAB_WEBHOOK_SECRET ?? "";

  const envVars = buildEnvVars({
    dbPath,
    port,
    configPath,
    webhookSecret,
  });
  // Preserve COLONY_E2E_CONTROL_PORT for diagnostic
  for (const [k, v] of Object.entries(envVars)) process.env[k] = v;
  if (!process.env.COLONYD_PORT) process.env.COLONYD_PORT = String(port);
  resetEnvCache();

  const { boot } = await import("../src/main.js");
  const boundary = createScriptedBoundary();
  const project = await boundary.provider.projects.create({
    name: "console-e2e",
    path: "so/console-e2e",
  });
  boundary.script.projectId = project.id;

  const handle = await boot({
    provider: boundary.provider,
    agents: boundary.agents,
    gateExecutor: boundary.gateExecutor,
    validateExecutor: boundary.validateExecutor,
  });

  const adapter = boundary.agents.architect as ScriptedAgentRuntimeAdapter;

  const control = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/control/script") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(serializeScript(boundary.script)));
      return;
    }
    if (req.method === "POST" && req.url === "/control/script") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const patch = body
            ? (JSON.parse(body) as Record<string, unknown>)
            : {};
          patchScript(boundary.script, patch, adapter);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  control.listen(CONTROL_PORT, "127.0.0.1", () => {
    console.log(
      `[fake-colonyd] api :${port} control :${CONTROL_PORT} db ${dbPath}`,
    );
  });

  const shutdown = async (): Promise<void> => {
    console.log("[fake-colonyd] shutting down");
    control.close();
    await handle.shutdown();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
