import type { PiModelSpec } from "./pi-runner-common.js";
import { createServer, type Server } from "node:http";
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

function sseToolCall(model: string, name: string, args: unknown): string {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  return (
    chunk({
      id: "chatcmpl-x",
      object: "chat.completion.chunk",
      created: 1,
      model,
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
      id: "chatcmpl-x",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }) +
    "data: [DONE]\n\n"
  );
}

describe("repository inspection gate", () => {
  it("blocks a premature submit, then credits glob and accepts the verdict", async () => {
    const headSha = "d".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary: "Inspected via glob before submitting.",
      findings: [],
      head_sha: headSha,
    };
    let requests = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests += 1;
        const headers = {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "cache-control": "no-cache",
        };
        response.writeHead(200, headers);
        // Turn 1: submit IMMEDIATELY (the grok move) - must be blocked.
        // Turn 2 (after the block feedback): inspect with glob.
        // Turn 3 (after the glob result): submit again - must be accepted.
        if (requests === 1) {
          response.end(sseToolCall("m", "submit_reviewer_verdict", envelope));
        } else if (requests === 2) {
          response.end(sseToolCall("m", "glob", { pattern: "*" }));
        } else {
          response.end(sseToolCall("m", "submit_reviewer_verdict", envelope));
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
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-inspection-test-"));
    scratchDirs.push(scratchDir);
    writeFileSync(join(scratchDir, "source.ts"), "export const x = 1;\n");

    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: true,
        defaultTools: ["glob"],
      },
      {
        model,
        fallbackModels: [],
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 6,
        runTimeoutMs: 30_000,
      },
    );

    const result = await runner.run({
      runId: "inspection-gate-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    // The first submit was blocked (three requests happened, not one), and
    // the post-glob submit produced the envelope.
    expect(requests).toBeGreaterThanOrEqual(3);
    expect(result.envelope).toEqual(envelope);
    expect(result.reason).toBeUndefined();
  }, 60_000);
});
