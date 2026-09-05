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

const respondProseStop = (
  response: ServerResponse,
  model: string,
  text = "Reviewing the diff now.",
): void => {
  response.writeHead(200, sseHeaders);
  sseChunk(response, model, [
    {
      index: 0,
      delta: { role: "assistant", content: text },
      finish_reason: null,
    },
  ]);
  sseChunk(response, model, [{ index: 0, delta: {}, finish_reason: "stop" }], {
    completion_tokens: 3,
    prompt_tokens: 1,
  });
  response.end("data: [DONE]\n\n");
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
            id: `call-${model}-${name}-${Math.random().toString(36).slice(2, 6)}`,
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

const startGateway = async (
  respond: (
    model: string,
    response: ServerResponse,
    requestBody: Record<string, unknown>,
  ) => void,
): Promise<{
  baseUrl: string;
  requestedModels: string[];
  requestBodies: Record<string, unknown>[];
}> => {
  const requestedModels: string[] = [];
  const requestBodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const model = typeof parsed.model === "string" ? parsed.model : "";
      requestedModels.push(model);
      requestBodies.push(parsed);
      respond(model, response, parsed);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestedModels,
    requestBodies,
  };
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

describe("pi reviewer per-leg finalizer", () => {
  it("T1: primary prose stops, forces submit, falls back to second model which submits with restored tools", async () => {
    const headSha = "1".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
      findings: [],
      inspected: [{ file: "source.ts", note: "checked against spec" }],
      head_sha: headSha,
    };
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const infos: { fields: Record<string, unknown>; message: string }[] = [];

    let primaryTurns = 0;
    const { baseUrl, requestedModels, requestBodies } = await startGateway(
      (model, response) => {
        if (model === "primary") {
          primaryTurns += 1;
          if (primaryTurns === 1) {
            respondToolCall(response, model, "glob", { pattern: "*" });
            return;
          }
          respondProseStop(response, model);
          return;
        }
        respondToolCall(response, model, "submit_reviewer_verdict", envelope);
      },
    );

    const scratchDir = mkdtempSync(join(tmpdir(), "colony-finalizer-t1-"));
    scratchDirs.push(scratchDir);
    writeFileSync(join(scratchDir, "source.ts"), "export const a = 1;\n");

    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        defaultTools: ["glob"],
        requireRepositoryInspection: true,
      },
      {
        model: modelSpec(baseUrl, "primary"),
        fallbackModels: [modelSpec(baseUrl, "fallback")],
        scratchDir,
        broker: { resolve: () => "test-key" },
        jiggleBackoffMs: 1,
        retryMaxRetries: 0,
        maxTurns: 16,
        runTimeoutMs: 120_000,
        logger: {
          info: (fields, message) => {
            infos.push({ fields, message });
          },
          warn: (fields, message) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "finalizer-t1-contract",
      packet: { goal: "Review change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(result.envelope).toEqual(envelope);
    expect(result.reason).toBeUndefined();
    expect(requestedModels.at(-1)).toBe("fallback");

    const forcedInfos = infos.filter(
      (entry) =>
        entry.message === "pi_finalizer_forced" &&
        entry.fields.model === "primary",
    );
    expect(forcedInfos.length).toBeGreaterThanOrEqual(1);

    const fallbackWarns = warnings.filter(
      (entry) => entry.message === "pi_model_fallback",
    );
    expect(fallbackWarns).toHaveLength(1);
    expect(fallbackWarns[0].fields).toMatchObject({
      from: "primary",
      to: "fallback",
      error: "finalize_no_submission",
    });

    const primaryForcedBodies = requestBodies.filter(
      (b) =>
        b.model === "primary" &&
        Array.isArray(b.tools) &&
        b.tools.length === 1 &&
        (b.tools[0] as { function: { name: string } }).function.name ===
          "submit_reviewer_verdict",
    );
    expect(primaryForcedBodies.length).toBeGreaterThanOrEqual(1);
    expect(primaryForcedBodies[0].tool_choice).toEqual({
      type: "function",
      function: { name: "submit_reviewer_verdict" },
    });

    const fallbackBodies = requestBodies.filter(
      (b) =>
        b.model === "fallback" &&
        Array.isArray(b.tools) &&
        b.tools.length > 1 &&
        (b.tools as { function: { name: string } }[]).some(
          (t) => t.function.name === "glob",
        ),
    );
    expect(fallbackBodies.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("T2: single-model configuration exhausts finalizer and ends with finalize_no_submission", async () => {
    const headSha = "2".repeat(40);
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const infos: { fields: Record<string, unknown>; message: string }[] = [];

    const { baseUrl, requestBodies } = await startGateway((model, response) => {
      respondProseStop(response, model);
    });

    const scratchDir = mkdtempSync(join(tmpdir(), "colony-finalizer-t2-"));
    scratchDirs.push(scratchDir);

    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        defaultTools: ["glob"],
        requireRepositoryInspection: false,
      },
      {
        model: modelSpec(baseUrl, "primary"),
        fallbackModels: [],
        scratchDir,
        broker: { resolve: () => "test-key" },
        jiggleBackoffMs: 1,
        retryMaxRetries: 0,
        maxTurns: 16,
        runTimeoutMs: 120_000,
        logger: {
          info: (fields, message) => {
            infos.push({ fields, message });
          },
          warn: (fields, message) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "finalizer-t2-contract",
      packet: { goal: "Review change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(result.reason).toBe("finalize_no_submission");

    const forcedInfos = infos.filter(
      (entry) =>
        entry.message === "pi_finalizer_forced" &&
        entry.fields.model === "primary",
    );
    expect(forcedInfos).toHaveLength(2);
    expect(forcedInfos.map((i) => i.fields.attempt)).toEqual([1, 2]);

    const exhaustedWarns = warnings.filter(
      (entry) => entry.message === "pi_finalizer_exhausted",
    );
    expect(exhaustedWarns).toHaveLength(1);
    expect(exhaustedWarns[0].fields.models).toEqual(["primary"]);

    const fallbackWarns = warnings.filter(
      (entry) => entry.message === "pi_model_fallback",
    );
    expect(fallbackWarns).toHaveLength(0);

    const lastPrimaryBody = requestBodies.at(-1)!;
    expect(Array.isArray(lastPrimaryBody.tools)).toBe(true);
    const tools = lastPrimaryBody.tools as { function: { name: string } }[];
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("submit_reviewer_verdict");
    expect(lastPrimaryBody.tool_choice).toEqual({
      type: "function",
      function: { name: "submit_reviewer_verdict" },
    });
  }, 120_000);

  it("T3: multiple candidates each get finalizer and exhaust in order without returning", async () => {
    const headSha = "3".repeat(40);
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const infos: { fields: Record<string, unknown>; message: string }[] = [];

    const { baseUrl, requestedModels } = await startGateway(
      (model, response) => {
        respondProseStop(response, model);
      },
    );

    const scratchDir = mkdtempSync(join(tmpdir(), "colony-finalizer-t3-"));
    scratchDirs.push(scratchDir);

    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        defaultTools: ["glob"],
        requireRepositoryInspection: false,
      },
      {
        model: modelSpec(baseUrl, "primary"),
        fallbackModels: [
          modelSpec(baseUrl, "second"),
          modelSpec(baseUrl, "third"),
        ],
        scratchDir,
        broker: { resolve: () => "test-key" },
        jiggleBackoffMs: 1,
        retryMaxRetries: 0,
        maxTurns: 30,
        runTimeoutMs: 120_000,
        logger: {
          info: (fields, message) => {
            infos.push({ fields, message });
          },
          warn: (fields, message) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "finalizer-t3-contract",
      packet: { goal: "Review change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(result.reason).toBe("finalize_no_submission");

    const fallbackWarns = warnings.filter(
      (entry) => entry.message === "pi_model_fallback",
    );
    expect(fallbackWarns).toHaveLength(2);
    expect(fallbackWarns[0].fields).toMatchObject({
      from: "primary",
      to: "second",
      error: "finalize_no_submission",
    });
    expect(fallbackWarns[1].fields).toMatchObject({
      from: "second",
      to: "third",
      error: "finalize_no_submission",
    });

    for (const modelId of ["primary", "second", "third"]) {
      const modelForced = infos.filter(
        (entry) =>
          entry.message === "pi_finalizer_forced" &&
          entry.fields.model === modelId,
      );
      expect(modelForced).toHaveLength(2);
    }

    const firstSecondIndex = requestedModels.indexOf("second");
    const lastPrimaryIndex = requestedModels.lastIndexOf("primary");
    const firstThirdIndex = requestedModels.indexOf("third");
    const lastSecondIndex = requestedModels.lastIndexOf("second");

    expect(lastPrimaryIndex).toBeLessThan(firstSecondIndex);
    expect(lastSecondIndex).toBeLessThan(firstThirdIndex);

    const exhaustedWarns = warnings.filter(
      (entry) => entry.message === "pi_finalizer_exhausted",
    );
    expect(exhaustedWarns).toHaveLength(1);
    expect(exhaustedWarns[0].fields.models).toEqual([
      "primary",
      "second",
      "third",
    ]);
  }, 120_000);

  it("T4: schema-rejected submission inside the finalizer is corrected on the second attempt", async () => {
    const headSha = "4".repeat(40);
    const validEnvelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
      findings: [],
      inspected: [{ file: "source.ts", note: "checked against spec" }],
      head_sha: headSha,
    };
    const invalidEnvelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
      findings: [],
      inspected: [],
      head_sha: headSha,
    };

    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const infos: { fields: Record<string, unknown>; message: string }[] = [];

    let primaryTurn = 0;
    let forcedTurnCount = 0;
    const { baseUrl } = await startGateway((model, response, body) => {
      primaryTurn += 1;
      if (primaryTurn === 1) {
        respondToolCall(response, model, "glob", { pattern: "*" });
        return;
      }
      const isForcedChoice =
        body.tool_choice !== undefined &&
        typeof body.tool_choice === "object" &&
        (body.tool_choice as { function?: { name?: string } }).function?.name ===
          "submit_reviewer_verdict";

      if (!isForcedChoice) {
        respondProseStop(response, model);
        return;
      }

      forcedTurnCount += 1;
      if (forcedTurnCount === 1) {
        respondToolCall(
          response,
          model,
          "submit_reviewer_verdict",
          invalidEnvelope,
        );
      } else {
        respondToolCall(
          response,
          model,
          "submit_reviewer_verdict",
          validEnvelope,
        );
      }
    });

    const scratchDir = mkdtempSync(join(tmpdir(), "colony-finalizer-t4-"));
    scratchDirs.push(scratchDir);
    writeFileSync(join(scratchDir, "source.ts"), "export const val = 42;\n");

    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        defaultTools: ["glob"],
        requireRepositoryInspection: true,
      },
      {
        model: modelSpec(baseUrl, "primary"),
        fallbackModels: [modelSpec(baseUrl, "fallback")],
        scratchDir,
        broker: { resolve: () => "test-key" },
        jiggleBackoffMs: 1,
        retryMaxRetries: 0,
        maxTurns: 16,
        runTimeoutMs: 120_000,
        logger: {
          info: (fields, message) => {
            infos.push({ fields, message });
          },
          warn: (fields, message) => {
            warnings.push({ fields, message });
          },
        },
      },
    );

    const result = await runner.run({
      runId: "finalizer-t4-contract",
      packet: { goal: "Review change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(result.envelope).toEqual(validEnvelope);
    expect(result.reason).toBeUndefined();

    const fallbackWarns = warnings.filter(
      (entry) => entry.message === "pi_model_fallback",
    );
    expect(fallbackWarns).toHaveLength(0);
  }, 120_000);
});
