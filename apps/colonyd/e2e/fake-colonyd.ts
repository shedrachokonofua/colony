#!/usr/bin/env -S tsx
import { createServer } from "node:http";
import { resetEnvCache } from "@colony/config";
import { buildEnvVars, installEnv, prepareEnvWithPort } from "./env.js";
import {
  createScriptedBoundary,
  patchScript,
  serializeScript,
} from "./fakes.js";
import type { ScriptedAgentRuntimeAdapter } from "./fakes.js";

const CONTROL_PORT = Number(process.env.COLONY_E2E_CONTROL_PORT || "4478");

async function main(): Promise<void> {
  const rawE2eDbPath = process.env["COLONY_E2E_DB_PATH"]?.trim() || undefined;
  const rawE2ePort = process.env["COLONY_E2E_PORT"]?.trim();
  let e2ePort: number | undefined;
  if (rawE2ePort) {
    const n = Number(rawE2ePort);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`invalid COLONY_E2E_PORT: ${rawE2ePort}`);
    }
    e2ePort = n;
  }
  const prepared = await prepareEnvWithPort({
    webhookSecret: process.env.GITLAB_WEBHOOK_SECRET ?? "",
    dbPath: rawE2eDbPath,
    port: e2ePort,
  });

  const envVars = buildEnvVars({
    dbPath: prepared.dbPath,
    port: prepared.port,
    configPath: prepared.configPath,
    webhookSecret: prepared.webhookSecret,
    tickMs: process.env["COLONYD_TICK_MS"],
    oidcIssuer: process.env["COLONY_OIDC_ISSUER"],
    oidcClientId: process.env["COLONY_OIDC_CLIENT_ID"],
    oidcRequiredRole: process.env["COLONY_OIDC_REQUIRED_ROLE"],
  });
  installEnv(envVars);
  resetEnvCache();

  const { boot } = await import("../src/main.js");
  const boundary = createScriptedBoundary();
  if (process.env["COLONY_E2E_MODE"] === "stall-implementer") {
    boundary.script.implementerStall = true;
  }
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
      `[fake-colonyd] api :${prepared.port} control :${CONTROL_PORT} db ${prepared.dbPath}`,
    );
  });

  const shutdown = async (): Promise<void> => {
    console.log("[fake-colonyd] shutting down");
    control.close();
    await handle.shutdown();
    prepared.cleanup();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
