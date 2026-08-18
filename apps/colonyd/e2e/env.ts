import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

export interface PreparedEnv {
  dir: string;
  dbPath: string;
  configPath: string;
  port: number;
  webhookSecret: string;
  cleanup: () => void;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

export function writeColonyYaml(path: string): void {
  writeFileSync(
    path,
    [
      "agent_runtime: fake",
      "allow_literal_keys: true",
      "hitl:",
      "  mode: yolo",
      "providers:",
      "  fake_llm:",
      "    api: openai-completions",
      "    base_url: http://localhost:9/v1",
      "    auth:",
      "      kind: api_key",
      "      value: fake-key",
      "    models:",
      "      - id: fake-model",
      "        name: fake-model",
      "agents:",
      "  architect:",
      "    provider: fake_llm",
      "    model: fake-model",
      "  developer:",
      "    provider: fake_llm",
      "    model: fake-model",
    ].join("\n"),
    "utf8",
  );
}

export async function prepareEnvWithPort(
  opts: {
    webhookSecret?: string;
  } = {},
): Promise<PreparedEnv> {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-e2e-"));
  const configPath = join(dir, "colony.yaml");
  writeColonyYaml(configPath);
  const e2eDbPath = process.env["COLONY_E2E_DB_PATH"];
  const e2ePort = process.env["COLONY_E2E_PORT"];
  const dbPath =
    e2eDbPath && e2eDbPath.trim() ? e2eDbPath : join(dir, "colonyd.db");
  const port = e2ePort && e2ePort.trim() ? Number(e2ePort) : await freePort();
  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    dir,
    dbPath,
    configPath,
    port,
    webhookSecret: opts.webhookSecret ?? "",
    cleanup,
  };
}

export function installEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    process.env[k] = v;
  }
}

export function buildEnvVars(input: {
  dbPath: string;
  port: number;
  configPath: string;
  webhookSecret?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcRequiredRole?: string;
  tickMs?: string | number;
}): Record<string, string> {
  const tickMs =
    input.tickMs !== undefined
      ? String(input.tickMs)
      : (process.env["COLONYD_TICK_MS"] ?? "250");
  return {
    NODE_ENV: "test",
    AGENT_RUNTIME: "fake",
    GITLAB_TOKEN: "",
    GITLAB_WEBHOOK_SECRET: input.webhookSecret ?? "",
    COLONYD_DB_PATH: input.dbPath,
    COLONYD_PORT: String(input.port),
    COLONYD_TICK_MS: tickMs,
    COLONYD_MAX_CONCURRENT: "1",
    COLONYD_MAX_ATTEMPTS: "3",
    COLONYD_SINGLE_TOKEN: "0",
    COLONY_CONFIG_PATH: input.configPath,
    PUBLIC_HOST: "localhost",
    COLONY_OIDC_ISSUER:
      input.oidcIssuer ?? process.env["COLONY_OIDC_ISSUER"] ?? "",
    COLONY_OIDC_CLIENT_ID:
      input.oidcClientId ?? process.env["COLONY_OIDC_CLIENT_ID"] ?? "",
    COLONY_OIDC_REQUIRED_ROLE:
      input.oidcRequiredRole ?? process.env["COLONY_OIDC_REQUIRED_ROLE"] ?? "",
  };
}
