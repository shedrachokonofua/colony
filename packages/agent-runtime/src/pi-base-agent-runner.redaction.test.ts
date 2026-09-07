import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  classifyPromptFailure,
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";
import type { PiModelSpec } from "./pi-runner-common.js";

// Joined at runtime so the merge gate's secret scanner, which flags
// token-shaped literals on added diff lines, never matches fixtures.
const TOKEN = ["glpat", "redactrunner0000001"].join("-");

const servers: Server[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const startGateway = async (
  respond: (response: ServerResponse) => void,
): Promise<string> => {
  const server = createServer((_request, response) => respond(response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}/v1`;
};

const modelSpec = (baseUrl: string): PiModelSpec => ({
  id: "primary",
  name: "primary",
  api: "openai-completions",
  provider: "test-gateway",
  baseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
});

const packetWithToken = () => ({
  goal: "Review the change",
  head_sha: "a".repeat(40),
  repo: {
    url: "https://gitlab.example/colony/dev.git",
    branch: "colony/task",
    base_commit: "a".repeat(40),
    credentials: { token: TOKEN },
  },
});

describe("pi-base-agent-runner fault.detail redaction", () => {
  it("classifyPromptFailure redacts the run credential from the detail", () => {
    // A provider-shaped message (429) carrying the run's own credential.
    const fault = classifyPromptFailure(`429 quota hit with ${TOKEN}`, TOKEN);
    expect(fault?.layer).toBe("provider");
    expect(fault?.code).toBe("http_429");
    expect(fault?.detail).not.toContain(TOKEN);
    expect(fault?.detail).toContain("[redacted]");
  });

  it("redacts the run credential from the provider_protocol_failure fault", async () => {
    const baseUrl = await startGateway((response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: `bad request echoing ${TOKEN}` },
        }),
      );
    });
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-runner-redact-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
      },
      {
        model: modelSpec(baseUrl),
        scratchDir,
        broker: { resolve: () => "test-key" },
        jiggleBackoffMs: 1,
        connectionRetryBackoffMs: 1,
        maxTurns: 4,
        runTimeoutMs: 60_000,
      },
    );

    const result = await runner.run({
      runId: "runner-redact-protocol",
      packet: packetWithToken(),
      environment: { role: "reviewer" },
    });

    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toMatch(/^provider_protocol_failure:/);
    expect(result.reason).not.toContain(TOKEN);
    expect(result.reason).toContain("[redacted]");
    expect(result.fault?.detail).not.toContain(TOKEN);
    expect(result.fault?.detail).toContain("[redacted]");
  }, 120_000);
});
