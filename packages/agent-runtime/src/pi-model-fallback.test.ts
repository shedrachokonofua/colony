import type { PiModelSpec } from "./pi-runner-common.js";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
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

describe("Pi model fallback", () => {
  it("continues the same session on the next configured model after a provider failure", async () => {
    const requestedModels: string[] = [];
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const headSha = "a".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary: "Fallback model completed the review.",
      findings: [],
      head_sha: headSha,
    };
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const model = (JSON.parse(body) as { model: string }).model;
        requestedModels.push(model);
        if (model === "primary") {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { message: "quota exhausted", type: "insufficient_quota" },
            }),
          );
          return;
        }

        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "cache-control": "no-cache",
        });
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-fallback",
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
                      id: "call-fallback",
                      type: "function",
                      function: {
                        name: "submit_reviewer_verdict",
                        arguments: JSON.stringify(envelope),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-fallback",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
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
    const model = (id: string): PiModelSpec => ({
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
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-fallback-test-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
      },
      {
        model: model("primary"),
        fallbackModels: [model("fallback")],
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 3,
        runTimeoutMs: 10_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "fallback-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(requestedModels).toEqual(["primary", "fallback"]);
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);

    const fallbackWarnings = warnings.filter(
      (warning) => warning.message === "pi_model_fallback",
    );
    expect(fallbackWarnings).toHaveLength(1);
    expect(fallbackWarnings[0].fields.from).toBe("primary");
    expect(fallbackWarnings[0].fields.to).toBe("fallback");
  });

  it("a prior model's quota error never short-circuits the current model's stall handling", async () => {
    const requestedModels: string[] = [];
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        const model =
          parsed && typeof parsed === "object" && "model" in parsed
            ? String(parsed.model)
            : "";
        requestedModels.push(model);
        if (model === "primary") {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { message: "quota exhausted", type: "insufficient_quota" },
            }),
          );
          return;
        }
        // "second" and "third" both stream an EMPTY completion: role delta,
        // no content, clean stop - the mute-model shape.
        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "cache-control": "no-cache",
        });
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-empty",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [
              { index: 0, delta: { role: "assistant" }, finish_reason: null },
            ],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-empty",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
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
    const model = (id: string): PiModelSpec => ({
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
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-stale-quota-test-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
      },
      {
        model: model("primary"),
        fallbackModels: [model("second"), model("third")],
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 8,
        // Short wall: the CORRECT path (jiggle, 15s first backoff) cannot
        // finish inside it, so reaching "third" at all means the stale
        // primary quota error short-circuited the jiggles - the bug.
        runTimeoutMs: 9_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "stale-quota-contract",
      packet: { goal: "Review the change", head_sha: "b".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(requestedModels).toContain("second");
    expect(requestedModels).not.toContain("third");
    expect(result.reason).toBeDefined();
    // The stall took the jiggle path on the CURRENT model instead of
    // inheriting primary's quota verdict.
    expect(
      warnings.some((warning) => warning.message === "pi_zero_output_jiggle"),
    ).toBe(true);
  }, 40_000);
});
