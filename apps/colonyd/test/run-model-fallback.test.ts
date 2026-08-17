import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Store } from "@colony/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
} from "@colony/agent-runtime/pi-base-agent-runner";
import { createRunEventSink } from "../src/agent-runtime.js";

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

describe("run event sink persists pi_model_fallback", () => {
  it("appends the fallback event and updates the run's model_id", async () => {
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
    const model = (id: string): Model<Api> => ({
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
      compat: { supportsStore: false },
    });

    const dbDir = mkdtempSync(join(tmpdir(), "colony-fallback-store-"));
    scratchDirs.push(dbDir);
    const store = new Store(join(dbDir, "test.db"));
    const scope = store.createScope({
      goal: "fallback sink",
      provider_project_id: "1",
      provider_project_path: "so/fake",
    });
    const run = store.startRun({
      scope_id: scope.id,
      kind: "review",
      lease_ttl_ms: 60_000,
      model_id: "primary",
    });

    const sink = createRunEventSink(store);
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
          info: (fields, message) => {
            if (typeof fields.runId === "string")
              sink(fields.runId, message, fields);
          },
          warn: (fields, message) => {
            if (typeof fields.runId === "string")
              sink(fields.runId, message, fields);
          },
          error: (fields, message) => {
            if (typeof fields.runId === "string")
              sink(fields.runId, message, fields);
          },
        },
      },
    );

    const result = await runner.run({
      runId: run.id,
      packet: { goal: "Review", head_sha: headSha },
      environment: { role: "reviewer" },
    });
    expect(result.envelope).toEqual(envelope);

    const events = store.listRunEvents(run.id);
    const fallback = events.find((e) => e.event === "pi_model_fallback");
    expect(fallback).toBeTruthy();
    const detail = JSON.parse(fallback!.detail_json) as {
      from?: unknown;
      to?: unknown;
    };
    expect(detail.from).toBe("primary");
    expect(detail.to).toBe("fallback");

    expect(store.getRun(run.id)!.model_id).toBe("fallback");
  });
});
