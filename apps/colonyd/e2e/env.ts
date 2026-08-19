import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

export function writeColonyYaml(
  path: string,
  opts: { reviewMode?: "off" | "required" } = {},
): void {
  const lines = [
    "agent_runtime: fake",
    "allow_literal_keys: true",
    "hitl:",
    "  mode: yolo",
  ];
  if (opts.reviewMode === "required") {
    lines.push("review:", "  mode: required");
  }
  lines.push(
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
  );
  if (opts.reviewMode === "required") {
    lines.push(
      "  reviewer:",
      "    provider: fake_llm",
      "    model: fake-model",
    );
  }
  writeFileSync(path, lines.join("\n"), "utf8");
}

export async function prepareEnvWithPort(
  opts: {
    webhookSecret?: string;
    dbPath?: string;
    port?: number;
    reviewMode?: "off" | "required";
  } = {},
): Promise<PreparedEnv> {
  const e2eTmp = process.env.COLONY_E2E_TMP_DIR?.trim() || undefined;
  const e2eDbPath = process.env.COLONY_E2E_DB_PATH?.trim() || undefined;
  const rawE2ePort = process.env.COLONY_E2E_PORT?.trim();
  let e2ePort: number | undefined;
  if (rawE2ePort) {
    const n = Number(rawE2ePort);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`invalid COLONY_E2E_PORT: ${rawE2ePort}`);
    }
    e2ePort = n;
  }

  const rawDbPath = opts.dbPath?.trim() || undefined;
  const isExternalDb = Boolean(rawDbPath);
  if (isExternalDb) {
    // When an external DB path is supplied (restart e2e), place the temp
    // config dir under the same parent so a SIGKILLed fake-colonyd that
    // never runs prepared.cleanup() does not leak /tmp/colonyd-e2e-* —
    // the test's restartDir cleanup reclaims it.
    const parent = dirname(rawDbPath!);
    let dir: string;
    try {
      dir = mkdtempSync(join(parent, "colonyd-e2e-"));
    } catch {
      dir = mkdtempSync(join(tmpdir(), "colonyd-e2e-"));
    }
    const configPath = join(dir, "colony.yaml");
    writeColonyYaml(configPath, { reviewMode: opts.reviewMode });
    const dbPath = rawDbPath!;
    let port: number;
    if (opts.port !== undefined) {
      const n = opts.port;
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`invalid COLONY_E2E_PORT: ${String(opts.port)}`);
      }
      port = n;
    } else if (e2ePort !== undefined) {
      port = e2ePort;
    } else {
      port = await freePort();
    }
    const cleanup = (): void => {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
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

  const dir = e2eTmp ?? mkdtempSync(join(tmpdir(), "colonyd-e2e-"));
  const configPath = join(dir, "colony.yaml");
  writeColonyYaml(configPath, { reviewMode: opts.reviewMode });
  const dbPath = e2eDbPath ?? join(dir, "colonyd.db");
  let port: number;
  if (opts.port !== undefined) {
    const n = opts.port;
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`invalid COLONY_E2E_PORT: ${String(opts.port)}`);
    }
    port = n;
  } else if (e2ePort !== undefined) {
    port = e2ePort;
  } else {
    port = await freePort();
  }
  const ownsDir = !e2eTmp;
  const cleanup = (): void => {
    if (!ownsDir) return;
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
  const tickMs = input.tickMs !== undefined ? String(input.tickMs) : "250";
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
    COLONY_OIDC_ISSUER: input.oidcIssuer ?? "",
    COLONY_OIDC_CLIENT_ID: input.oidcClientId ?? "",
    COLONY_OIDC_REQUIRED_ROLE: input.oidcRequiredRole ?? "",
  };
}
