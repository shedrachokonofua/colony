import type { PiModelSpec } from "./pi-runner-common.js";
import {
  createServer,
  type Server,
  type ServerResponse,
} from "node:http";
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

const countOf = (values: string[], target: string): number =>
  values.filter((value) => value === target).length;

/** A gateway whose answer depends only on the requested model. */
const startGateway = async (
  respond: (model: string, response: ServerResponse) => void,
): Promise<{ baseUrl: string; requestedModels: string[] }> => {
  const requestedModels: string[] = [];
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
      respond(model, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requestedModels };
};

const sseHeaders = {
  "content-type": "text/event-stream",
  connection: "keep-alive",
  "cache-control": "no-cache",
};

const sseChunk = (
  response: ServerResponse,
  model: string,
  choices: unknown[],
): void => {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices,
    })}\n\n`,
  );
};

/** Every connection-failure fixture in these tests: a dead upstream leg. */
const respondServiceUnavailable = (response: ServerResponse): void => {
  response.writeHead(503, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: { message: "503 Service Unavailable", type: "server_error" },
    }),
  );
};

const respondVerdictToolCall = (
  response: ServerResponse,
  model: string,
  envelope: unknown,
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
            id: `call-${model}`,
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
  ]);
  sseChunk(response, model, [
    { index: 0, delta: {}, finish_reason: "tool_calls" },
  ]);
  response.end("data: [DONE]\n\n");
};

/** A healthy turn that deliberately does NOT submit. */
const respondHealthyText = (
  response: ServerResponse,
  model: string,
): void => {
  response.writeHead(200, sseHeaders);
  sseChunk(response, model, [
    {
      index: 0,
      delta: { role: "assistant", content: "Reviewing the change now." },
      finish_reason: null,
    },
  ]);
  sseChunk(response, model, [{ index: 0, delta: {}, finish_reason: "stop" }]);
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
        // The wall must be long enough for three empty turns + the first
        // 15s jiggle even on a slow CI box (9s starved the stall entirely
        // there), yet shorter than jiggle 1 + jiggle 2 completing - so
        // "third" is reachable ONLY via the stale-quota shortcut, the bug.
        runTimeoutMs: 30_000,
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
  }, 90_000);

  it("fails over to the next configured model after five consecutive connection errors", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const headSha = "c".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary: "Survived the dead primary leg.",
      findings: [],
      head_sha: headSha,
    };
    const { baseUrl, requestedModels } = await startGateway(
      (model, response) => {
        if (model === "primary") return respondServiceUnavailable(response);
        respondVerdictToolCall(response, model, envelope);
      },
    );
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-dead-leg-test-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
      },
      {
        model: modelSpec(baseUrl, "primary"),
        fallbackModels: [modelSpec(baseUrl, "fallback")],
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 8,
        runTimeoutMs: 120_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "dead-leg-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(requestedModels).toContain("fallback");
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);

    const fallbackWarnings = warnings.filter(
      (warning) => warning.message === "pi_model_fallback",
    );
    expect(fallbackWarnings).toHaveLength(1);
    expect(fallbackWarnings[0].fields.error).toMatch(
      /^provider_connection_exhausted:/,
    );
    expect(fallbackWarnings[0].fields.from).toBe("primary");
    expect(fallbackWarnings[0].fields.to).toBe("fallback");
  }, 240_000);

  it("connection errors interleaved with successful turns never trigger model fallback", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    let primaryRequests = 0;
    const { baseUrl, requestedModels } = await startGateway(
      (model, response) => {
        if (model !== "primary") return respondServiceUnavailable(response);
        primaryRequests += 1;
        // Odd requests (the first one included) are a dead upstream; every
        // other request is a healthy, non-submitting turn, so the leg keeps
        // proving it is alive and never spends its error budget.
        if (primaryRequests % 2 === 1) {
          return respondServiceUnavailable(response);
        }
        respondHealthyText(response, model);
      },
    );
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-blip-leg-test-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
      },
      {
        model: modelSpec(baseUrl, "primary"),
        fallbackModels: [modelSpec(baseUrl, "fallback")],
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 8,
        runTimeoutMs: 20_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "blip-leg-contract",
      packet: { goal: "Review the change", head_sha: "d".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(requestedModels.length).toBeGreaterThan(0);
    for (const requested of requestedModels) expect(requested).toBe("primary");
    expect(
      warnings.some((warning) => warning.message === "pi_model_fallback"),
    ).toBe(false);
    expect(result.reason).toBeDefined();
  }, 60_000);

  it("a prior model's connection errors never count against the current model", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const headSha = "e".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary: "Third leg carried the review.",
      findings: [],
      head_sha: headSha,
    };
    const { baseUrl, requestedModels } = await startGateway(
      (model, response) => {
        if (model === "third") {
          return respondVerdictToolCall(response, model, envelope);
        }
        respondServiceUnavailable(response);
      },
    );
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-per-leg-test-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
      },
      {
        model: modelSpec(baseUrl, "primary"),
        fallbackModels: [modelSpec(baseUrl, "second"), modelSpec(baseUrl, "third")],
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 8,
        runTimeoutMs: 120_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "per-leg-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(requestedModels).toContain("third");
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);

    const primaryToSecond = warnings.filter(
      (warning) =>
        warning.message === "pi_model_fallback" &&
        warning.fields.from === "primary" &&
        warning.fields.to === "second",
    );
    const secondToThird = warnings.filter(
      (warning) =>
        warning.message === "pi_model_fallback" &&
        warning.fields.from === "second" &&
        warning.fields.to === "third",
    );
    expect(primaryToSecond).toHaveLength(1);
    expect(secondToThird).toHaveLength(1);
    expect(primaryToSecond[0].fields.error).toMatch(
      /^provider_connection_exhausted:/,
    );
    expect(secondToThird[0].fields.error).toMatch(
      /^provider_connection_exhausted:/,
    );
    // The second leg got its own full budget: a counter shared across legs
    // would have failed it over with fewer requests than the primary spent.
    expect(countOf(requestedModels, "second")).toBe(
      countOf(requestedModels, "primary"),
    );
  }, 240_000);

  it("a single-model configuration never logs a model fallback on repeated connection errors", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const { baseUrl } = await startGateway((_model, response) =>
      respondServiceUnavailable(response),
    );
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-solo-leg-test-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
      },
      {
        model: modelSpec(baseUrl, "primary"),
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 8,
        runTimeoutMs: 60_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "solo-leg-contract",
      packet: { goal: "Review the change", head_sha: "f".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(
      warnings.some((warning) => warning.message === "pi_model_fallback"),
    ).toBe(false);
    expect(result.reason).toBeDefined();
    if (result.reason?.startsWith("provider_connection_failure:")) {
      expect(result.reason).toMatch(
        /provider_connection_failure:.*(503|fetch failed|ECONNRESET|service unavailable)/i,
      );
    }
  }, 120_000);
});
