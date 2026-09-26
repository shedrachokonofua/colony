/**
 * Live-run steering through the Pi runtime: an operator message queued via
 * `steer(runId, …)` must reach the model's conversation — folded into the
 * next tool result ahead of every generated nudge — exactly once. This is
 * the delivery half of the spec-amendment loop (colonyd aborts the run when
 * this channel is unavailable).
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { PiModelSpec } from "./pi-runner-common.js";
import {
  DEVELOPER_ROLE_PROFILE,
  PiBaseAgentRunner,
} from "./pi-base-agent-runner.js";

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

const sseHeaders = {
  "content-type": "text/event-stream",
  connection: "keep-alive",
  "cache-control": "no-cache",
};

const sseChunk = (
  response: ServerResponse,
  model: string,
  choices: unknown[],
  usage?: { completion_tokens: number; prompt_tokens?: number },
): void => {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices,
      ...(usage ? { usage } : {}),
    })}\n\n`,
  );
};

const respondToolCall = (
  response: ServerResponse,
  model: string,
  name: string,
  args: unknown,
): void => {
  response.writeHead(200, sseHeaders);
  sseChunk(response, model, [
    {
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${model}-${name}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: null,
    },
  ]);
  sseChunk(
    response,
    model,
    [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    { completion_tokens: 4, prompt_tokens: 1 },
  );
  response.end("data: [DONE]\n\n");
};

const modelSpec = (baseUrl: string, id: string): PiModelSpec => ({
  id,
  name: id,
  api: "openai-completions",
  provider: "test-gateway",
  baseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
});

const ENVELOPE = {
  kind: "implementer_completion",
  status: "complete",
  summary: "implemented the intake",
  branch: "colony/c-1.1",
  head_sha: "a".repeat(40),
  commands: [{ cmd: "bun test", exit_code: 0 }],
};

const OPERATOR_MESSAGE =
  "The operator amended this task's spec while you were running. It supersedes every conflicting requirement and must be satisfied before you submit.";

describe("PiBaseAgentRunner.steer", () => {
  it("folds a queued operator message into the next tool result exactly once", async () => {
    const requestBodies: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requestBodies.push(JSON.parse(body));
        if (requestBodies.length === 1) {
          respondToolCall(response, "primary", "web_fetch", {
            url: "https://example.com/evidence",
          });
          return;
        }
        respondToolCall(
          response,
          "primary",
          "submit_implementer_completion",
          ENVELOPE,
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
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;

    // The tool blocks until the steer is queued, so the message is in the
    // channel before the fold runs — no timing guesswork.
    const toolStarted = Promise.withResolvers<void>();
    const toolGate = Promise.withResolvers<void>();
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-runner-steer-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...DEVELOPER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        verifyPushedHead: false,
        defaultTools: [],
        // The run's work happens through web_fetch in this test; the
        // developer profile's no-work-tools shortcut would skip the loop.
        skipPromptWithoutWorkTools: false,
      },
      {
        model: modelSpec(baseUrl, "primary"),
        fallbackModels: [],
        scratchDir,
        broker: { resolve: () => "test-key" },
        webTools: {
          searxngUrl: "https://searx.example.test",
          transport: async () => {
            toolStarted.resolve();
            await toolGate.promise;
            return {
              status: 200,
              headers: { "content-type": "text/plain" },
              body: "repository evidence",
              truncated: false,
            };
          },
        } as never,
        jiggleBackoffMs: 1,
        connectionRetryBackoffMs: 1,
        maxTurns: 10,
        runTimeoutMs: 60_000,
      },
    );

    const running = runner.run({
      runId: "steer-delivery-1",
      packet: { goal: "Implement the intake", task_id: "c-1.1" },
      environment: { role: "developer" },
    });
    await toolStarted.promise;

    expect(runner.steer("steer-delivery-1", OPERATOR_MESSAGE)).toBe(true);
    expect(runner.steer("steer-delivery-1-ghost", OPERATOR_MESSAGE)).toBe(
      false,
    );
    toolGate.resolve();

    const result = await running;
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(ENVELOPE);

    // The message rode the web_fetch tool result into the next prompt, once.
    expect(requestBodies).toHaveLength(2);
    const second = JSON.stringify(requestBodies[1]);
    expect(second).toContain(OPERATOR_MESSAGE);
    expect(second.split(OPERATOR_MESSAGE)).toHaveLength(2);
  }, 30_000);
});
