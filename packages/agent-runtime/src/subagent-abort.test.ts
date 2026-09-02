import type { PiModelSpec } from "./pi-runner-common.js";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";

const servers: Server[] = [];
const scratchDirs: string[] = [];
const hanging: ServerResponse[] = [];

afterEach(async () => {
  for (const response of hanging.splice(0)) response.destroy();
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

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  connection: "keep-alive",
  "cache-control": "no-cache",
};

function sseToolCall(name: string, args: unknown): string {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const base = {
    id: "chatcmpl-x",
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

/** Parent turns carry the reviewer prompt; child turns the subagent one. */
function isChildTurn(body: string): boolean {
  return body.includes("You are a Colony subagent");
}

async function harness(
  handle: (body: string, response: ServerResponse) => void,
  runTimeoutMs: number,
) {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => handle(body, response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
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
  const scratchDir = mkdtempSync(join(tmpdir(), "colony-subagent-abort-"));
  scratchDirs.push(scratchDir);
  writeFileSync(join(scratchDir, "source.ts"), "export const x = 1;\n");
  return new PiBaseAgentRunner(
    {
      ...REVIEWER_ROLE_PROFILE,
      workspaceMode: "scratch",
      defaultTools: ["glob"],
    },
    {
      model,
      fallbackModels: [],
      scratchDir,
      broker: { resolve: () => "test-key" },
      maxTurns: 60,
      runTimeoutMs,
    },
  );
}

describe("subagent abort propagation", () => {
  // 2026-09-01: a reviewer delegated to a `task` subagent, the child hit
  // its turn guard mid-work, and the task tool never returned. The wall
  // and the wedge watchdog then aborted the PARENT session only; the run
  // outlived its 45-minute wall by half an hour, heartbeating its lease.

  it("the run wall aborts a child whose upstream never answers, and the run finalizes", async () => {
    let childTurns = 0;
    const runner = await harness((body, response) => {
      response.writeHead(200, SSE_HEADERS);
      if (!isChildTurn(body)) {
        response.end(
          sseToolCall("task", { description: "inspect", prompt: "inspect" }),
        );
        return;
      }
      // The child's turn: headers, then silence forever.
      childTurns += 1;
      response.write(": open\n\n");
      hanging.push(response);
    }, 3_000);

    const started = Date.now();
    const result = await runner.run({
      runId: "subagent-abort-hung-upstream",
      packet: { goal: "Review the change", head_sha: "e".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(childTurns).toBe(1);
    expect(result.reason).toBe("timeout_without_envelope");
    // Finalized on the wall's schedule, not the child's (which is never).
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it("a child that exhausts its own turn guard returns to the parent, which finishes the run", async () => {
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "Child exhausted; parent inspected the diff itself against the spec and submitted the verdict once the turn guard returned.",
      findings: [],
      inspected: [
        { file: "src/main.ts", note: "checked against the task spec" },
      ],
      head_sha: "f".repeat(40),
    };
    let parentTurns = 0;
    let childTurns = 0;
    const runner = await harness((body, response) => {
      response.writeHead(200, SSE_HEADERS);
      if (isChildTurn(body)) {
        // The child globs forever: its 24-turn guard aborts it mid-loop.
        childTurns += 1;
        response.end(sseToolCall("glob", { pattern: "*" }));
        return;
      }
      parentTurns += 1;
      if (parentTurns === 1) {
        response.end(
          sseToolCall("task", { description: "inspect", prompt: "inspect" }),
        );
      } else if (parentTurns === 2) {
        response.end(sseToolCall("glob", { pattern: "*" }));
      } else {
        response.end(sseToolCall("submit_reviewer_verdict", envelope));
      }
    }, 60_000);

    const result = await runner.run({
      runId: "subagent-abort-child-guard",
      packet: { goal: "Review the change", head_sha: "f".repeat(40) },
      environment: { role: "reviewer" },
    });

    // The child ran into its guard, the task tool came back, and the parent
    // went on to inspect and submit instead of waiting forever.
    expect(childTurns).toBeGreaterThanOrEqual(24);
    expect(parentTurns).toBeGreaterThanOrEqual(3);
    expect(result.envelope).toEqual(envelope);
    expect(result.reason).toBeUndefined();
  }, 60_000);
});
