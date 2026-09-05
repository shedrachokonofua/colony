import type { PiModelSpec } from "./pi-runner-common.js";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  ARCHITECT_ROLE_PROFILE,
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";
import {
  createArchitectSubmitTool,
  createPlanDraftSubmitTool,
} from "./architect-stages.js";

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
const FAST_RECOVERY = {
  jiggleBackoffMs: 1,
  connectionRetryBackoffMs: 1,
} as const;

/** A gateway whose answer depends only on the requested model. */
const startGateway = async (
  respond: (
    model: string,
    response: ServerResponse,
    requestBody: unknown,
  ) => void,
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
      respond(model, response, parsed);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

// A clean empty `stop` is retried internally by pi-ai. `length` gives the
// runner a settled zero-token terminal response so this test isolates Colony's
// recovery state rather than the provider's own empty-completion policy.
const respondEmpty = (
  response: ServerResponse,
  model: string,
  reasoning = false,
): void => {
  response.writeHead(200, sseHeaders);
  sseChunk(response, model, [
    {
      index: 0,
      delta: {
        role: "assistant",
        ...(reasoning ? { reasoning_content: "Still thinking." } : {}),
      },
      finish_reason: null,
    },
  ]);
  sseChunk(response, model, [{ index: 0, delta: {}, finish_reason: "length" }]);
  response.end("data: [DONE]\n\n");
};

const respondMeaningfulText = (
  response: ServerResponse,
  model: string,
): void => {
  response.writeHead(200, sseHeaders);
  sseChunk(response, model, [
    {
      index: 0,
      delta: { role: "assistant", content: "I have enough evidence." },
      finish_reason: null,
    },
  ]);
  sseChunk(
    response,
    model,
    [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
    { completion_tokens: 3, prompt_tokens: 1 },
  );
  response.end("data: [DONE]\n\n");
};

/** A settled transport-class error; status 400 avoids testing pi-ai's own retry loop. */
const respondServiceUnavailable = (response: ServerResponse): void => {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: {
        message: "ECONNRESET: upstream connection reset",
        type: "server_error",
      },
    }),
  );
};

/** A quota error with a server-directed delay the outer runner must ignore. */
const respondQuotaRateLimit = (response: ServerResponse): void => {
  response.writeHead(429, {
    "content-type": "application/json",
    "retry-after": "300",
  });
  response.end(
    JSON.stringify({
      error: { message: "quota exhausted", type: "insufficient_quota" },
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
  sseChunk(
    response,
    model,
    [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    { completion_tokens: 4, prompt_tokens: 1 },
  );
  response.end("data: [DONE]\n\n");
};

const respondToolCall = (
  response: ServerResponse,
  model: string,
  name: string,
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
            id: `call-${model}-${name}`,
            type: "function",
            function: { name, arguments: JSON.stringify(envelope) },
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

const stageEnvelope = () => ({
  kind: "architect_decomposition",
  summary: "A minimal verified implementation plan.",
  requirements: [
    { id: "R1", text: "Deliver the requested change.", tasks: [0] },
  ],
  journey: [{ after_task: 0, working_state: "The change is delivered." }],
  acceptance: [
    { description: "The focused scenario passes.", command: "true" },
  ],
  tasks: [
    {
      title: "Implement the change",
      spec: "Implement the requested behavior.",
      depends_on: [],
      files: ["src/main.ts"],
      evidence: ["true"],
    },
  ],
});

/** A healthy turn that deliberately does NOT submit. */
const respondHealthyText = (response: ServerResponse, model: string): void => {
  response.writeHead(200, sseHeaders);
  sseChunk(response, model, [
    {
      index: 0,
      delta: { role: "assistant", content: "Reviewing the change now." },
      finish_reason: null,
    },
  ]);
  sseChunk(response, model, [{ index: 0, delta: {}, finish_reason: "stop" }], {
    completion_tokens: 3,
    prompt_tokens: 1,
  });
  response.end("data: [DONE]\n\n");
};

const modelSpec = (
  baseUrl: string,
  id: string,
  extra: Partial<
    Pick<PiModelSpec, "reasoning" | "thinking" | "supportsTools" | "compat">
  > = {},
): PiModelSpec => ({
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
  ...extra,
});

describe("Pi model fallback", () => {
  it("keeps the working fallback after a write instead of returning to a quota-limited primary", async () => {
    const requestedModels: string[] = [];
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    let fallbackTurns = 0;
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
        requestedModels.push(model);
        if (model === "primary") {
          respondQuotaRateLimit(response);
          return;
        }
        if (fallbackTurns++ === 0) {
          response.writeHead(200, sseHeaders);
          sseChunk(response, model, [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "write-recovery",
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({
                        path: join(scratchDir, "recovered.txt"),
                        content: "work continued on the fallback",
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ]);
          sseChunk(response, model, [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ]);
          response.end("data: [DONE]\n\n");
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
        defaultTools: ["write"],
      },
      {
        model: model("primary"),
        fallbackModels: [model("fallback")],
        scratchDir,
        broker: { resolve: () => "test-key" },
        ...FAST_RECOVERY,
        maxTurns: 6,
        runTimeoutMs: 10_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const startedAt = performance.now();
    const result = await runner.run({
      runId: "fallback-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });
    expect(performance.now() - startedAt).toBeLessThan(5_000);

    expect(requestedModels).toEqual(["primary", "fallback", "fallback"]);
    expect(readFileSync(join(scratchDir, "recovered.txt"), "utf8")).toBe(
      "work continued on the fallback",
    );
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);

    const fallbackWarnings = warnings.filter(
      (warning) => warning.message === "pi_model_fallback",
    );
    expect(fallbackWarnings).toHaveLength(1);
    expect(fallbackWarnings[0].fields.from).toBe("primary");
    expect(fallbackWarnings[0].fields.to).toBe("fallback");
  });

  it("does not retry a quota 429 when no alternate model exists", async () => {
    const { baseUrl, requestedModels } = await startGateway(
      (_model, response) => respondQuotaRateLimit(response),
    );
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-quota-solo-test-"));
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
        ...FAST_RECOVERY,
        maxTurns: 4,
        runTimeoutMs: 10_000,
      },
    );

    const startedAt = performance.now();
    const result = await runner.run({
      runId: "quota-solo-contract",
      packet: { goal: "Review the change", head_sha: "1".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(requestedModels).toEqual(["primary"]);
    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toMatch(/^provider_protocol_failure:/);
  });

  it("stops after every configured model rejects the quota request", async () => {
    const { baseUrl, requestedModels } = await startGateway(
      (_model, response) => respondQuotaRateLimit(response),
    );
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-quota-exhausted-test-"),
    );
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
        fallbackModels: [modelSpec(baseUrl, "alternate")],
        scratchDir,
        broker: { resolve: () => "test-key" },
        ...FAST_RECOVERY,
        maxTurns: 4,
        runTimeoutMs: 10_000,
      },
    );

    const startedAt = performance.now();
    const result = await runner.run({
      runId: "quota-exhausted-contract",
      packet: { goal: "Review the change", head_sha: "2".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(requestedModels).toEqual(["primary", "alternate"]);
    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toMatch(/^provider_protocol_failure:/);
  });

  it("keeps recovering a mute primary across exhausted continuations before fallback", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const headSha = "7".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
      findings: [],
      inspected: [{ file: "src/main.ts", note: "checked" }],
      head_sha: headSha,
    };
    const { baseUrl, requestedModels } = await startGateway(
      (model, response) => {
        if (model === "primary") return respondEmpty(response, model);
        respondVerdictToolCall(response, model, envelope);
      },
    );
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-empty-recovery-test-"),
    );
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
        ...FAST_RECOVERY,
        jiggleBackoffMs: 0,
        maxTurns: 12,
        runTimeoutMs: 120_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "empty-recovery-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(requestedModels).toEqual([
      "primary",
      "primary",
      "primary",
      "primary",
      "primary",
      "fallback",
    ]);
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);
    expect(
      warnings.filter((warning) => warning.message === "pi_zero_output_jiggle"),
    ).toHaveLength(2);
  }, 90_000);

  it("treats reasoning-only stops as empty through fallback recovery", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const headSha = "8".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
      findings: [],
      inspected: [{ file: "src/main.ts", note: "checked" }],
      head_sha: headSha,
    };
    const { baseUrl, requestedModels } = await startGateway(
      (model, response) => {
        if (model === "primary") return respondEmpty(response, model, true);
        respondVerdictToolCall(response, model, envelope);
      },
    );
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-reasoning-recovery-test-"),
    );
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
        ...FAST_RECOVERY,
        jiggleBackoffMs: 0,
        maxTurns: 12,
        runTimeoutMs: 120_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "reasoning-recovery-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(requestedModels).toEqual([
      "primary",
      "primary",
      "primary",
      "primary",
      "primary",
      "fallback",
    ]);
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);
    expect(
      warnings.filter((warning) => warning.message === "pi_zero_output_jiggle"),
    ).toHaveLength(2);
  }, 90_000);

  it("bounds a persistent empty-output primary without a fallback", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const { baseUrl, requestedModels } = await startGateway((model, response) =>
      respondEmpty(response, model),
    );
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-empty-solo-test-"));
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
        ...FAST_RECOVERY,
        jiggleBackoffMs: 0,
        maxTurns: 12,
        runTimeoutMs: 120_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "empty-solo-contract",
      packet: { goal: "Review the change", head_sha: "9".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(requestedModels).toEqual([
      "primary",
      "primary",
      "primary",
      "primary",
      "primary",
    ]);
    expect(result.reason).toBe("zero_output_stall");
    expect(
      warnings.filter((warning) => warning.message === "pi_zero_output_jiggle"),
    ).toHaveLength(2);
  }, 90_000);

  it("disarms recovery when the same model makes meaningful progress", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const headSha = "a".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
      findings: [],
      inspected: [{ file: "src/main.ts", note: "checked" }],
      head_sha: headSha,
    };
    let primaryRequests = 0;
    const { baseUrl, requestedModels } = await startGateway(
      (model, response) => {
        primaryRequests += 1;
        if (primaryRequests <= 3) return respondEmpty(response, model);
        if (primaryRequests === 4)
          return respondMeaningfulText(response, model);
        respondVerdictToolCall(response, model, envelope);
      },
    );
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-progress-recovery-test-"),
    );
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
        ...FAST_RECOVERY,
        jiggleBackoffMs: 0,
        maxTurns: 12,
        runTimeoutMs: 120_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "progress-recovery-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(requestedModels).toEqual([
      "primary",
      "primary",
      "primary",
      "primary",
      "primary",
    ]);
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);
    expect(
      warnings.filter((warning) => warning.message === "pi_zero_output_jiggle"),
    ).toHaveLength(1);
    expect(
      warnings.filter((warning) => warning.message === "pi_run_continuation"),
    ).toHaveLength(3);
  }, 90_000);

  it("falls back after exhausted continuations while retaining tool context", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const requestBodies: { model: string; body: unknown }[] = [];
    const headSha = "b".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
      findings: [],
      inspected: [{ file: "src/main.ts", note: "checked" }],
      head_sha: headSha,
    };
    let fallbackRequests = 0;
    const { baseUrl, requestedModels } = await startGateway(
      (model, response, body) => {
        requestBodies.push({ model, body });
        if (model === "primary") {
          // Useful tool activity interleaved with clean non-submitting stops
          // must not reset the stop-steer allowance forever or hide fallback.
          if (requestedModels.filter((value) => value === "primary").length % 2)
            return respondToolCall(response, model, "web_fetch", {
              url: "https://example.com/evidence",
            });
          return respondHealthyText(response, model);
        }
        fallbackRequests += 1;
        if (fallbackRequests === 1) return respondHealthyText(response, model);
        respondVerdictToolCall(response, model, envelope);
      },
    );
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-continuation-fallback-test-"),
    );
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
        fallbackModels: [
          modelSpec(baseUrl, "capped"),
          modelSpec(baseUrl, "fallback"),
        ],
        modelHasCapacity: (modelId) => modelId !== "capped",
        scratchDir,
        broker: { resolve: () => "test-key" },
        webTools: {
          searxngUrl: "https://searx.example.test",
          transport: async () => ({
            status: 200,
            headers: { "content-type": "text/plain" },
            body: "repository evidence",
            truncated: false,
          }),
        } as never,
        ...FAST_RECOVERY,
        maxTurns: 20,
        runTimeoutMs: 120_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "continuation-fallback-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(requestedModels).not.toContain("capped");
    expect(requestedModels).toContain("fallback");
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);
    const fallback = warnings.filter(
      (warning) =>
        warning.message === "pi_model_fallback" &&
        warning.fields.from === "primary",
    );
    expect(fallback).toHaveLength(1);
    expect(fallback[0].fields.to).toBe("fallback");
    expect(fallback[0].fields.error).toBe("finalize_no_submission");
    expect(
      warnings.filter((warning) => warning.message === "pi_run_continuation"),
    ).toHaveLength(4);
    const fallbackBody = requestBodies.find(
      (request) => request.model === "fallback",
    )?.body;
    expect(JSON.stringify(fallbackBody)).toContain("repository evidence");
  }, 120_000);
  it("keeps a genuinely exhausted final candidate as no submission", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const { baseUrl, requestedModels } = await startGateway((model, response) =>
      respondHealthyText(response, model),
    );
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-final-continuation-exhaustion-test-"),
    );
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
        ...FAST_RECOVERY,
        maxTurns: 20,
        runTimeoutMs: 120_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "final-continuation-exhaustion-contract",
      packet: { goal: "Review the change", head_sha: "c".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(requestedModels).toEqual([
      "primary",
      "primary",
      "primary",
      "primary",
      "primary",
      "primary",
      "fallback",
      "fallback",
      "fallback",
      "fallback",
      "fallback",
      "fallback",
    ]);
    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toBe("finalize_no_submission");
    const fallback = warnings.filter(
      (warning) =>
        warning.message === "pi_model_fallback" &&
        warning.fields.from === "primary",
    );
    expect(fallback).toHaveLength(1);
    expect(fallback[0].fields.error).toBe("finalize_no_submission");
  }, 120_000);

  it("lets the next model recover from empty replies without inheriting prior quota exhaustion", async () => {
    const headSha = "b".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "The implementation satisfies the complete specification; acceptance checks pass without regressions.",
      findings: [],
      inspected: [
        { file: "src/main.ts", note: "checked against the specification" },
      ],
      head_sha: headSha,
    };
    let secondTurns = 0;
    const { baseUrl, requestedModels } = await startGateway(
      (model, response) => {
        if (model === "primary") return respondQuotaRateLimit(response);
        if (model === "second" && ++secondTurns <= 3) {
          respondEmpty(response, model);
          return;
        }
        respondVerdictToolCall(response, model, envelope);
      },
    );
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
        model: modelSpec(baseUrl, "primary"),
        fallbackModels: [
          modelSpec(baseUrl, "second"),
          modelSpec(baseUrl, "third"),
        ],
        scratchDir,
        broker: { resolve: () => "test-key" },
        ...FAST_RECOVERY,
        maxTurns: 40,
        runTimeoutMs: 90_000,
      },
    );
    const result = await runner.run({
      runId: "stale-quota-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });
    expect(result.envelope).toEqual(envelope);
    expect(result.reason).toBeUndefined();
    expect(requestedModels).toEqual([
      "primary",
      "second",
      "second",
      "second",
      "second",
    ]);
  }, 90_000);

  it("lets a brief transport outage recover before exhausting healthy model choices", async () => {
    const headSha = "f".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "The diff implements the complete specification; acceptance checks passed and no regressions were found.",
      findings: [],
      inspected: [
        { file: "src/main.ts", note: "checked against the specification" },
      ],
      head_sha: headSha,
    };
    let recoveryAt: number | undefined;
    const { baseUrl, requestedModels } = await startGateway(
      (model, response) => {
        recoveryAt ??= performance.now() + 120;
        if (model === "primary" && performance.now() < recoveryAt) {
          respondServiceUnavailable(response);
          return;
        }
        respondVerdictToolCall(response, model, envelope);
      },
    );
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-brief-outage-"));
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
        ...FAST_RECOVERY,
        connectionRetryBackoffMs: 100,
        maxTurns: 20,
        runTimeoutMs: 10_000,
      },
    );
    const result = await runner.run({
      runId: "brief-transport-outage",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });
    expect(result.envelope).toEqual(envelope);
    expect(result.reason).toBeUndefined();
    expect(requestedModels).not.toContain("fallback");
  });

  it("fails over to the next configured model after five consecutive connection errors", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const headSha = "c".repeat(40);
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
        ...FAST_RECOVERY,
        maxTurns: 60,
        runTimeoutMs: 300_000,
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
  }, 350_000);

  it("runtime failover skips a fallback model with no free dispatch slot", async () => {
    // 2026-09-01: grok died, five concurrent reviews all fell over onto
    // qwen (max_parallel_runs: 1) and every one walled at 45 minutes.
    // Dispatch honored the cap; runtime failover never asked.
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const headSha = "d".repeat(40);
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
    const { baseUrl, requestedModels } = await startGateway(
      (model, response) => {
        if (model === "primary") return respondServiceUnavailable(response);
        respondVerdictToolCall(response, model, envelope);
      },
    );
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-capped-leg-test-"));
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
        fallbackModels: [
          modelSpec(baseUrl, "capped"),
          modelSpec(baseUrl, "open"),
        ],
        modelHasCapacity: (modelId) => modelId !== "capped",
        scratchDir,
        broker: { resolve: () => "test-key" },
        ...FAST_RECOVERY,
        maxTurns: 60,
        runTimeoutMs: 300_000,
        logger: {
          warn: (fields: Record<string, unknown>, message: string) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "capped-leg-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(requestedModels).not.toContain("capped");
    expect(requestedModels).toContain("open");
    expect(result.envelope).toEqual(envelope);
    const fallback = warnings.filter((w) => w.message === "pi_model_fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0].fields.from).toBe("primary");
    expect(fallback[0].fields.to).toBe("open");
  }, 350_000);

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
        ...FAST_RECOVERY,
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
      summary:
        "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
      findings: [],
      inspected: [
        { file: "src/main.ts", note: "checked against the task spec" },
      ],
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
        fallbackModels: [
          modelSpec(baseUrl, "second"),
          modelSpec(baseUrl, "third"),
        ],
        scratchDir,
        broker: { resolve: () => "test-key" },
        ...FAST_RECOVERY,
        // Both dead legs must settle five errors each before "third" is
        // reached: six settled turns per leg. SDK retries are disabled so
        // each provider response reaches Colony's outer connection budget
        // promptly. maxTurns must exceed the turns a leg needs or the turn
        // guard ends the run first.
        maxTurns: 60,
        runTimeoutMs: 600_000,
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
  }, 700_000);
  it("preserves a guard-classified failure when the last model aborts", async () => {
    const { baseUrl } = await startGateway((_model, response) =>
      respondHealthyText(response, "primary"),
    );
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-guard-cause-test-"));
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
        ...FAST_RECOVERY,
        maxTurns: 1,
        runTimeoutMs: 120_000,
      },
    );

    const result = await runner.run({
      runId: "guard-cause-contract",
      packet: { goal: "Review the change", head_sha: "f".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toBe("max_turns_exhausted_without_envelope");
  });

  it("does not carry a plan rejection into a later verify no-submission", async () => {
    let requests = 0;
    const rejectedDraft = {
      ...stageEnvelope(),
      tasks: [{ ...stageEnvelope().tasks[0], depends_on: [3] }],
    };
    const { baseUrl } = await startGateway((_model, response) => {
      requests += 1;
      if (requests === 1) {
        respondToolCall(
          response,
          "primary",
          "submit_plan_draft",
          rejectedDraft,
        );
      } else if (requests === 2) {
        respondToolCall(
          response,
          "primary",
          "submit_plan_draft",
          stageEnvelope(),
        );
      } else {
        respondHealthyText(response, "primary");
      }
    });
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-stage-rejection-reset-test-"),
    );
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...ARCHITECT_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
        stages: () => [
          {
            name: "plan" as const,
            systemPrompt: "Plan the change.",
            prompt: () => "PLAN_STAGE_KEY",
            tools: "read_only" as const,
            subagents: false,
            turnCap: 2,
            submitTool: (capture: (value: unknown) => void) =>
              createPlanDraftSubmitTool(capture),
          },
          {
            name: "verify" as const,
            systemPrompt: "Verify the change.",
            prompt: () => "VERIFY_STAGE_KEY",
            tools: "read_only" as const,
            subagents: false,
            turnCap: 1,
            submitTool: (capture: (value: unknown) => void) =>
              createArchitectSubmitTool(capture),
          },
        ],
      },
      {
        model: modelSpec(baseUrl, "primary"),
        scratchDir,
        broker: { resolve: () => "test-key" },
        ...FAST_RECOVERY,
        runTimeoutMs: 120_000,
      },
    );

    const result = await runner.run({
      runId: "stage-rejection-reset-contract",
      packet: { goal: "Plan the change", head_sha: "f".repeat(40) },
      environment: { role: "architect" },
    });

    expect(requests).toBeGreaterThanOrEqual(3);
    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toBe("architect_stage_verify_no_submission");
  });

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
        ...FAST_RECOVERY,
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
      runId: "solo-leg-contract",
      packet: { goal: "Review the change", head_sha: "f".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(
      warnings.some((warning) => warning.message === "pi_model_fallback"),
    ).toBe(false);
    expect(result.reason).toBeDefined();
    // The settled leg, not the run wall, must spend the budget: the sole
    // candidate is classified with the raw provider text embedded.
    expect(result.reason).toMatch(
      /^provider_connection_failure:.*(503|fetch failed|ECONNRESET|service unavailable)/i,
    );
  }, 120_000);
  it("reports a rejected terminal submission instead of no submission", async () => {
    let requests = 0;
    const { baseUrl } = await startGateway((_model, response) => {
      requests += 1;
      if (requests === 1) {
        respondVerdictToolCall(response, "primary", {
          kind: "reviewer_verdict",
          verdict: "approve",
          summary: "too short",
          findings: [],
          inspected: [],
          head_sha: "f".repeat(40),
        });
        return;
      }
      respondHealthyText(response, "primary");
    });
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-rejection-cause-test-"),
    );
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
        ...FAST_RECOVERY,
        maxTurns: 8,
        runTimeoutMs: 120_000,
      },
    );

    const result = await runner.run({
      runId: "rejection-cause-contract",
      packet: { goal: "Review the change", head_sha: "f".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toMatch(/^submission_rejected:/);
    expect(result.reason).not.toBe("finalize_no_submission");
  }, 120_000);
  it("preserves the full next-stage prompt after a prior stage falls back", async () => {
    const requestBodies: unknown[] = [];
    const { baseUrl, requestedModels } = await startGateway(
      (model, response, requestBody) => {
        requestBodies.push(requestBody);
        if (model === "primary") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { message: "primary stage protocol failure" },
            }),
          );
          return;
        }
        if (requestBodies.length === 2) {
          respondToolCall(
            response,
            model,
            "submit_plan_draft",
            stageEnvelope(),
          );
          return;
        }
        respondToolCall(
          response,
          model,
          "submit_architect_decomposition",
          stageEnvelope(),
        );
      },
    );
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-stage-prompt-fallback-test-"),
    );
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...ARCHITECT_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
        stages: () => [
          {
            name: "plan" as const,
            systemPrompt: "Plan stage system prompt.",
            prompt: () => "PLAN_STAGE_PROMPT_KEY",
            tools: "read_only" as const,
            subagents: false,
            turnCap: 1,
            submitTool: (capture: (value: unknown) => void) =>
              createPlanDraftSubmitTool(capture),
          },
          {
            name: "verify" as const,
            systemPrompt: "Verify stage system prompt.",
            prompt: () => "VERIFY_STAGE_PROMPT_KEY",
            tools: "read_only" as const,
            subagents: false,
            turnCap: 1,
            submitTool: (capture: (value: unknown) => void) =>
              createArchitectSubmitTool(capture),
          },
        ],
      },
      {
        model: modelSpec(baseUrl, "primary"),
        fallbackModels: [modelSpec(baseUrl, "fallback")],
        scratchDir,
        broker: { resolve: () => "test-key" },
        ...FAST_RECOVERY,
        runTimeoutMs: 120_000,
      },
    );

    const result = await runner.run({
      runId: "stage-prompt-fallback-contract",
      packet: { goal: "Plan the change", head_sha: "f".repeat(40) },
      environment: { role: "architect" },
    });

    expect(requestedModels).toEqual(["primary", "fallback", "fallback"]);
    expect(JSON.stringify(requestBodies[2])).toContain(
      "VERIFY_STAGE_PROMPT_KEY",
    );
    expect(JSON.stringify(requestBodies[2])).toContain(
      "Verify stage system prompt.",
    );
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(stageEnvelope());
  }, 120_000);
  it("reports a terminal provider protocol failure distinctly from no submission", async () => {
    const { baseUrl } = await startGateway((_model, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "invalid forced tool protocol" },
        }),
      );
    });
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-provider-cause-test-"),
    );
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
        ...FAST_RECOVERY,
        maxTurns: 4,
        runTimeoutMs: 120_000,
      },
    );

    const result = await runner.run({
      runId: "provider-cause-contract",
      packet: { goal: "Review the change", head_sha: "f".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toMatch(/^provider_protocol_failure:/);
    expect(result.reason).not.toBe("finalize_no_submission");
  }, 120_000);
  it("reports a clean terminal with no submit as genuine no submission", async () => {
    const { baseUrl } = await startGateway((_model, response) =>
      respondHealthyText(response, "primary"),
    );
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-no-submit-cause-test-"),
    );
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
        ...FAST_RECOVERY,
        maxTurns: 20,
        runTimeoutMs: 120_000,
      },
    );

    const result = await runner.run({
      runId: "no-submit-cause-contract",
      packet: { goal: "Review the change", head_sha: "f".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toBe("finalize_no_submission");
  }, 120_000);
  it("switches the staged finalizer to the active fallback and honors its tool-choice capability", async () => {
    const requestedModels: string[] = [];
    const forcedBodies: Record<string, unknown>[] = [];
    const envelope = {
      kind: "architect_decomposition",
      summary: "A minimal verified implementation plan.",
      requirements: [
        { id: "R1", text: "Deliver the requested change.", tasks: [0] },
      ],
      journey: [{ after_task: 0, working_state: "The change is delivered." }],
      acceptance: [
        { description: "The focused scenario passes.", command: "true" },
      ],
      tasks: [
        {
          title: "Implement the change",
          spec: "Implement the requested behavior.",
          depends_on: [],
          files: ["src/main.ts"],
          evidence: ["true"],
        },
      ],
    };
    const { baseUrl, requestedModels: observedModels } = await startGateway(
      (model, response, requestBody) => {
        requestedModels.push(model);
        const body =
          requestBody && typeof requestBody === "object"
            ? (requestBody as Record<string, unknown>)
            : {};
        if (body.tool_choice !== undefined) forcedBodies.push(body);
        if (model === "primary" && body.tool_choice !== undefined) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message:
                  "tool_choice specified is incompatible with thinking enabled",
              },
            }),
          );
          return;
        }
        if (model === "primary") {
          respondHealthyText(response, model);
          return;
        }
        response.writeHead(200, sseHeaders);
        sseChunk(response, model, [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-architect-fallback",
                  type: "function",
                  function: {
                    name: "submit_architect_decomposition",
                    arguments: JSON.stringify(envelope),
                  },
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
      },
    );
    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-staged-finalizer-fallback-test-"),
    );
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...ARCHITECT_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
        stages: () => [
          {
            name: "verify" as const,
            systemPrompt: "Submit the verified architect decomposition.",
            prompt: ({ packet }) => JSON.stringify(packet),
            tools: "read_only" as const,
            subagents: false,
            turnCap: 1,
            submitTool: (capture: (value: unknown) => void) =>
              createArchitectSubmitTool(capture),
          },
        ],
      },
      {
        model: modelSpec(baseUrl, "primary", { reasoning: true }),
        fallbackModels: [
          modelSpec(baseUrl, "fallback", {
            reasoning: true,
            compat: {
              disableReasoningOnForcedToolChoice: true,
              supportsForcedToolChoice: true,
            },
          }),
        ],
        scratchDir,
        broker: { resolve: () => "test-key" },
        ...FAST_RECOVERY,
        runTimeoutMs: 120_000,
      },
    );

    const result = await runner.run({
      runId: "staged-finalizer-fallback-contract",
      packet: { goal: "Plan the change", head_sha: "f".repeat(40) },
      environment: { role: "architect" },
    });

    expect(requestedModels).toEqual(["primary", "primary", "fallback"]);
    expect(observedModels).toEqual(requestedModels);
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);
    const fallbackForced = forcedBodies.find(
      (body) => body.model === "fallback",
    );
    expect(fallbackForced?.tool_choice).toBeDefined();
    expect(fallbackForced?.reasoning_effort).toBeUndefined();
    expect(fallbackForced?.reasoning).toBeUndefined();
  }, 120_000);
});
