import { createServer, type Server, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { SandboxEngine } from "@colony/sandbox";
import { createInProcessEngine } from "@colony/sandbox-in-process";
import type { PiModelSpec } from "./pi-runner-common.js";
import {
  DEVELOPER_ROLE_PROFILE,
  PiBaseAgentRunner,
} from "./pi-base-agent-runner.js";

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    }),
  );
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A model that only ever asks for more work: any request is a leak. */
async function startBusyGateway(): Promise<{
  baseUrl: string;
  requests: () => number;
}> {
  let requests = 0;
  const server = createServer((request, response: ServerResponse) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      const chunk = (payload: unknown) =>
        `data: ${JSON.stringify(payload)}\n\n`;
      const base = {
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chunk({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests}`,
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({ command: "true" }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }) +
          chunk({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 10,
              total_tokens: 20,
            },
          }) +
          "data: [DONE]\n\n",
      );
    });
  });
  servers.push(server);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests: () => requests,
  };
}

const modelSpec = (baseUrl: string): PiModelSpec => ({
  id: "m",
  name: "m",
  api: "openai-completions",
  provider: "test-gateway",
  baseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
});

function seedPacket(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(root);
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  execFileSync(
    "git",
    ["-C", origin, "commit", "-q", "--allow-empty", "-m", "init"],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    },
  );
  const baseSha = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const branch = "colony/cancel";
  execFileSync("git", ["-C", origin, "branch", branch]);
  return {
    goal: "Land the change",
    body: "b",
    head_sha: baseSha,
    repo: {
      url: origin,
      branch,
      base_commit: baseSha,
      credentials: { token: "local-noop" },
    },
  } as never;
}

// col-db8759e3.2 (2026-10-15): an operator pause landed seconds after
// dispatch, while the run was still setting up. The cancel found no live run,
// the adapter recorded the run as canceled, and the run then worked for 15
// minutes while pause, stop, and amend each waited on it forever.
describe("operator cancel before the first prompt", () => {
  it("is honored when it arrives before the run registers", async () => {
    const gateway = await startBusyGateway();
    const runner = new PiBaseAgentRunner(DEVELOPER_ROLE_PROFILE, {
      model: modelSpec(gateway.baseUrl),
      fallbackModels: [],
      engine: createInProcessEngine(),
      broker: { resolve: () => "test-key" },
      maxTurns: 40,
      runTimeoutMs: 600_000,
    });
    const runId = `cancel-early-${Date.now()}`;
    const running = runner.run({
      runId,
      packet: seedPacket("colony-cancel-early-"),
      environment: { role: "developer" },
    });
    await runner.cancel(runId);

    await running.catch(() => undefined);
    expect(gateway.requests()).toBe(0);
  }, 60_000);

  it("is honored when it arrives while the sandbox is provisioning", async () => {
    const gateway = await startBusyGateway();
    const inner = createInProcessEngine();
    const provisioning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const engine: SandboxEngine = {
      ...inner,
      provision: async (...args: Parameters<SandboxEngine["provision"]>) => {
        provisioning.resolve();
        await release.promise;
        return inner.provision(...args);
      },
    };
    const runner = new PiBaseAgentRunner(DEVELOPER_ROLE_PROFILE, {
      model: modelSpec(gateway.baseUrl),
      fallbackModels: [],
      engine,
      broker: { resolve: () => "test-key" },
      maxTurns: 40,
      runTimeoutMs: 600_000,
    });
    const runId = `cancel-provisioning-${Date.now()}`;
    const running = runner.run({
      runId,
      packet: seedPacket("colony-cancel-provisioning-"),
      environment: { role: "developer" },
    });
    await provisioning.promise;
    await runner.cancel(runId);
    release.resolve();

    await running.catch(() => undefined);
    expect(gateway.requests()).toBe(0);
  }, 60_000);
});
