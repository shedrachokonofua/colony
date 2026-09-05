import type { PiModelSpec } from "@colony/agent-runtime";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@colony/core";
import { afterEach, describe, expect, it } from "bun:test";
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
      summary:
        "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
      findings: [],
      inspected: [
        { file: "src/main.ts", note: "checked against the task spec" },
      ],
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
            usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
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

    const dbDir = mkdtempSync(join(tmpdir(), "colony-fallback-store-"));
    scratchDirs.push(dbDir);
    const store = new Store(join(dbDir, "test.db"));
    const scope = store.createScope({
      goal: "fallback sink",
      title: "fallback sink",
      provider_repo_id: "1",
      provider_repo_path: "so/fake",
    });
    const run = store.startRun({
      scope_id: scope.id,
      kind: "review",
      lease_ttl_ms: 60_000,
      model_id: "primary",
    });

    const sink = createRunEventSink(store);
    const baseline = "2020-01-01T00:00:00.000Z";
    store.touchRunProgress(run.id, baseline);
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
      packet: { goal: "Review", title: "Review", head_sha: headSha },
      environment: { role: "reviewer" },
    });
    expect(result.envelope).toEqual(envelope);

    const events = store.listRunEvents(run.id).events;
    const fallback = events.find((e) => e.event === "pi_model_fallback");
    expect(fallback).toBeTruthy();
    const detail = JSON.parse(fallback!.detail_json) as {
      from?: unknown;
      to?: unknown;
    };
    expect(detail.from).toBe("primary");
    expect(detail.to).toBe("fallback");

    const usage = events.find(
      (e) =>
        e.event === "pi_turn_usage" &&
        JSON.parse(e.detail_json).stop_reason === "toolUse",
    );
    expect(usage).toBeTruthy();
    expect(JSON.parse(usage!.detail_json)).toMatchObject({
      outputTokens: 4,
      stop_reason: "toolUse",
    });
    expect(store.getRun(run.id)!.last_progress_at).not.toBe(baseline);
    expect(store.getRun(run.id)!.model_id).toBe("fallback");
  });

  it("maps tool lifecycle events onto the active run operation", () => {
    const dbDir = mkdtempSync(join(tmpdir(), "colony-progress-store-"));
    scratchDirs.push(dbDir);
    const store = new Store(join(dbDir, "test.db"));
    const scope = store.createScope({
      goal: "active tool sink",
      title: "active tool sink",
      provider_repo_id: "1",
      provider_repo_path: "so/fake",
    });
    const run = store.startRun({
      scope_id: scope.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    const sink = createRunEventSink(store);

    sink(run.id, "pi_tool_start", {
      tool: "bash",
      detail: "bun run test:unit",
      startedAt: "2026-09-04T18:00:00.000Z",
    });
    expect(store.getRun(run.id)).toMatchObject({
      active_tool: "bash",
      active_tool_detail: "bun run test:unit",
      active_tool_started_at: "2026-09-04T18:00:00.000Z",
    });
    sink(run.id, "pi_tool_end", { tool: "bash", isError: false });
    expect(store.getRun(run.id)).toMatchObject({
      active_tool: null,
      active_tool_detail: null,
      active_tool_started_at: null,
    });
  });
  it("records usage failures without progress and counts successful output", () => {
    const dbDir = mkdtempSync(join(tmpdir(), "colony-progress-signals-"));
    scratchDirs.push(dbDir);
    const store = new Store(join(dbDir, "test.db"));
    const scope = store.createScope({
      goal: "progress signals",
      title: "progress signals",
      provider_repo_id: "1",
      provider_repo_path: "so/fake",
    });
    const run = store.startRun({
      scope_id: scope.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    const sink = createRunEventSink(store);
    const baseline = "2020-01-01T00:00:00.000Z";
    store.touchRunProgress(run.id, baseline);

    sink(run.id, "pi_turn_usage", {
      outputTokens: 0,
      stop_reason: "error",
      error_message: "429 rate limited",
    });
    sink(run.id, "pi_turn_usage", {
      outputTokens: 0,
      stop_reason: "aborted",
      error_message: "request aborted",
    });
    sink(run.id, "pi_usage", {
      outputTokens: 0,
      stop_reason: "stop",
    });
    expect(store.getRun(run.id)!.last_progress_at).toBe(baseline);

    store.heartbeatRun(run.id, 60_000);
    sink(run.id, "pi_model_fallback", { from: "primary", to: "fallback" });
    expect(store.getRun(run.id)).toMatchObject({
      last_progress_at: baseline,
      model_id: "fallback",
    });

    sink(run.id, "pi_turn_usage", {
      outputTokens: 12,
      stop_reason: "stop",
      error_message: "",
    });
    expect(store.getRun(run.id)!.last_progress_at).not.toBe(baseline);

    store.touchRunProgress(run.id, baseline);
    sink(run.id, "pi_usage", {
      outputTokens: 8,
      stop_reason: "toolUse",
    });
    expect(store.getRun(run.id)!.last_progress_at).not.toBe(baseline);

    store.touchRunProgress(run.id, baseline);
    const startedAt = "2026-09-04T18:00:00.000Z";
    sink(run.id, "pi_tool_start", {
      tool: "bash",
      detail: "bun run test:unit",
      startedAt,
    });
    expect(store.getRun(run.id)!.last_progress_at).toBe(startedAt);
    sink(run.id, "pi_tool_end", { tool: "bash", isError: false });
    expect(store.getRun(run.id)!.last_progress_at).not.toBe(startedAt);

    expect(() => {
      sink(run.id, "unknown_event", null as unknown as Record<string, unknown>);
      sink(run.id, "pi_usage", null as unknown as Record<string, unknown>);
    }).not.toThrow();

    const events = store.listRunEvents(run.id).events;
    expect(
      events.filter(
        (event) =>
          event.event === "pi_turn_usage" || event.event === "pi_usage",
      ),
    ).toHaveLength(6);
    expect(events.some((event) => event.event === "unknown_event")).toBe(true);
  });
});
