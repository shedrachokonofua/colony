import type { PiModelSpec } from "./pi-runner-common.js";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createInProcessEngine } from "@colony/sandbox-in-process";
import {
  PiBaseAgentRunner,
  DEVELOPER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function sseToolCall(name: string, args: unknown): string {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const base = {
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
  };
  return (
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
                id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
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
    }) +
    "data: [DONE]\n\n"
  );
}

describe("implementer submit gate: pushed head", () => {
  it("blocks an envelope whose head_sha is not on origin/<branch>, accepts it once pushed", async () => {
    // Local origin with one commit on main; the work branch does not exist
    // on the remote until the model pushes it.
    const root = mkdtempSync(join(tmpdir(), "colony-push-gate-"));
    dirs.push(root);
    const origin = join(root, "origin");
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    execFileSync(
      "git",
      ["-C", origin, "commit", "-q", "--allow-empty", "-m", "init"],
      { env: GIT_ENV },
    );
    // Bare-ish: allow pushes into the checked-out repo's other branches.
    execFileSync("git", [
      "-C",
      origin,
      "config",
      "receive.denyCurrentBranch",
      "updateInstead",
    ]);
    const baseSha = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const branch = "colony/push-gate";
    const envelope = {
      kind: "implementer_completion",
      status: "complete",
      summary: "Landed.",
      branch,
      head_sha: baseSha,
      commands: [{ cmd: "bun test", exit_code: 0 }],
    };

    let turns = 0;
    const seen: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        turns += 1;
        // Record the newest tool result the model sees, so the test can
        // assert the gate's message reached it.
        const parsed = JSON.parse(body) as {
          messages: { role: string; content?: unknown }[];
        };
        const lastTool = [...parsed.messages]
          .reverse()
          .find((m) => m.role === "tool");
        if (lastTool) seen.push(String(lastTool.content));
        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "cache-control": "no-cache",
        });
        if (turns === 1) {
          // Submit before pushing - the 2026-09-01 move.
          response.end(sseToolCall("submit_implementer_completion", envelope));
        } else if (turns === 2) {
          response.end(
            sseToolCall("bash", { command: `git push -q origin ${branch}` }),
          );
        } else {
          response.end(sseToolCall("submit_implementer_completion", envelope));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const model: PiModelSpec = {
      id: "m",
      name: "m",
      api: "openai-completions",
      provider: "test-gateway",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
    const runner = new PiBaseAgentRunner(DEVELOPER_ROLE_PROFILE, {
      model,
      fallbackModels: [],
      engine: createInProcessEngine(),
      broker: { resolve: () => "test-key" },
      maxTurns: 8,
      runTimeoutMs: 60_000,
    });

    const result = await runner.run({
      runId: `push-gate-${Date.now()}`,
      packet: {
        goal: "Land the change",
        body: "b",
        head_sha: baseSha,
        // Local path remotes ignore the token; the profile only insists one exists.
        repo: {
          url: origin,
          branch,
          base_commit: baseSha,
          credentials: { token: "local-noop" },
        },
      } as never,
      environment: { role: "developer" },
    });

    expect(turns).toBeGreaterThanOrEqual(3);
    expect(
      seen.some((text) => text.includes("does not exist on the remote")),
    ).toBe(true);
    expect(result.envelope).toEqual(envelope);
    expect(result.reason).toBeUndefined();
    // And the branch really is on the remote at that SHA.
    const remote = execFileSync("git", ["-C", origin, "rev-parse", branch], {
      encoding: "utf8",
    }).trim();
    expect(remote).toBe(baseSha);
  }, 60_000);

  it("rejects the reviewed head, then falls back and accepts a changed head", async () => {
    const rejectedHead = "a".repeat(40);
    const changedHead = "b".repeat(40);
    const branch = "colony/repair-gate";
    const submitted = (head_sha: string) => ({
      kind: "implementer_completion",
      status: "complete",
      summary: "Repair complete.",
      branch,
      head_sha,
      commands: [{ cmd: "bun test", exit_code: 0 }],
    });
    let turns = 0;
    const requestedModels: string[] = [];
    const seen: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        turns += 1;
        const parsed = JSON.parse(body) as {
          model: string;
          messages: { role: string; content?: unknown }[];
        };
        requestedModels.push(parsed.model);
        const lastTool = [...parsed.messages]
          .reverse()
          .find((m) => m.role === "tool");
        if (lastTool) seen.push(JSON.stringify(lastTool.content));
        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "cache-control": "no-cache",
        });
        response.end(
          sseToolCall(
            "submit_implementer_completion",
            submitted(turns < 3 ? rejectedHead : changedHead),
          ),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const model = (id: string): PiModelSpec => ({
      id,
      name: id,
      api: "openai-completions",
      provider: "test-gateway",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-repair-gate-"));
    dirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...DEVELOPER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        verifyPushedHead: false,
        defaultTools: [],
        skipPromptWithoutWorkTools: false,
      },
      {
        model: model("primary"),
        fallbackModels: [model("fallback")],
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 6,
        runTimeoutMs: 10_000,
      },
    );

    const result = await runner.run({
      runId: `repair-gate-${Date.now()}`,
      packet: {
        goal: "Repair the rejected change",
        body: "Fix the review finding.",
        repair: { rejected_head_sha: rejectedHead },
      },
      environment: { role: "developer" },
    });

    expect(requestedModels).toEqual(["primary", "primary", "fallback"]);
    expect(result.envelope).toEqual(submitted(changedHead));
    expect(result.reason).toBeUndefined();
  }, 20_000);

  it("fails with repair_no_change when every model candidate is exhausted", async () => {
    const rejectedHead = "c".repeat(40);
    const envelope = {
      kind: "implementer_completion",
      status: "complete",
      summary: "No change.",
      branch: "colony/repair-exhausted",
      head_sha: rejectedHead,
      commands: [{ cmd: "bun test", exit_code: 0 }],
    };
    let turns = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        turns += 1;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "cache-control": "no-cache",
        });
        response.end(sseToolCall("submit_implementer_completion", envelope));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-repair-exhausted-"));
    dirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...DEVELOPER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        verifyPushedHead: false,
        defaultTools: [],
        skipPromptWithoutWorkTools: false,
      },
      {
        model: {
          id: "only",
          name: "only",
          api: "openai-completions",
          provider: "test-gateway",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 4,
        runTimeoutMs: 10_000,
      },
    );

    const result = await runner.run({
      runId: `repair-exhausted-${Date.now()}`,
      packet: {
        goal: "Repair the rejected change",
        body: "Fix the review finding.",
        repair: { rejected_head_sha: rejectedHead },
      },
      environment: { role: "developer" },
    });

    expect(turns).toBe(2);
    expect(result.reason).toBe("repair_no_change");
  }, 20_000);
});
