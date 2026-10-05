import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { PiModelSpec } from "./pi-runner-common.js";
import {
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";

const servers: Server[] = [];
const sockets: Socket[] = [];
const scratchDirs: string[] = [];

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  connection: "keep-alive",
  "cache-control": "no-cache",
};

/** What actually crossed the wire, as Colony's seam sees it. */
type WireRequest = {
  model: string;
  promptCacheKey: unknown;
  delegated: boolean;
};

type ParsedBody = {
  model?: string;
  messages?: unknown[];
  prompt_cache_key?: unknown;
};

const parseRequest = (body: string): ParsedBody =>
  JSON.parse(body) as ParsedBody;

const sseChunk = (model: string, choices: unknown[]): string =>
  `data: ${JSON.stringify({
    id: `chatcmpl-${model}`,
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices,
  })}\n\n`;

const respondToolCalls = (
  response: ServerResponse,
  model: string,
  calls: Array<{ id: string; name: string; args: unknown }>,
): void => {
  response.writeHead(200, SSE_HEADERS);
  response.end(
    sseChunk(model, [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args),
            },
          })),
        },
        finish_reason: null,
      },
    ]) +
      sseChunk(model, [{ index: 0, delta: {}, finish_reason: "tool_calls" }]) +
      "data: [DONE]\n\n",
  );
};

const respondText = (
  response: ServerResponse,
  model: string,
  text: string,
): void => {
  response.writeHead(200, SSE_HEADERS);
  response.end(
    sseChunk(model, [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ]) +
      sseChunk(model, [{ index: 0, delta: {}, finish_reason: "stop" }]) +
      "data: [DONE]\n\n",
  );
};

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

const recordWireRequest = (body: string, wire: WireRequest[]): WireRequest => {
  const parsed = parseRequest(body);
  const entry: WireRequest = {
    model: parsed.model ?? "",
    promptCacheKey: parsed.prompt_cache_key,
    delegated: JSON.stringify(parsed.messages ?? []).includes(
      "You are a Colony subagent",
    ),
  };
  wire.push(entry);
  return entry;
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

const makeRunner = (
  scratchDir: string,
  primary: PiModelSpec,
  fallbackModels: PiModelSpec[] = [],
): PiBaseAgentRunner =>
  new PiBaseAgentRunner(
    {
      ...REVIEWER_ROLE_PROFILE,
      workspaceMode: "scratch",
      requireRepositoryInspection: false,
      defaultTools: [],
    },
    {
      model: primary,
      fallbackModels,
      scratchDir,
      broker: { resolve: () => "test-key" },
      jiggleBackoffMs: 1,
      connectionRetryBackoffMs: 1,
      maxTurns: 4,
      runTimeoutMs: 15_000,
    },
  );

const headSha = (letter: string): string => letter.repeat(40);

const childReport = (marker: string): string =>
  `${marker}-only: delegated inspection completed successfully.`;

const reviewerEnvelope = (
  marker: string,
  sha: string,
  summary: string = `Approved after receiving the successful delegated reports for ${marker}: ${marker}-only.`,
) => ({
  kind: "reviewer_verdict",
  verdict: "approve",
  summary,
  findings: [],
  inspected: [{ file: "source.ts", note: `checked while reviewing ${marker}` }],
  head_sha: sha,
  dimensions: [
    {
      name: "spec",
      spec_blind: false,
      target_files: ["source.ts"],
      findings: 0,
    },
    {
      name: "security",
      spec_blind: true,
      target_files: ["source.ts"],
      findings: 0,
    },
  ],
  challenged: { reviewed: 0, dropped: 0 },
});

const taskCall = (marker: string) => ({
  id: `call-${marker}-only`,
  name: "task",
  args: {
    description: `${marker} only`,
    prompt: `For ${marker}, return exactly the useful delegated report ${marker}-only.`,
  },
});

const submitCall = (marker: string, sha: string, summary?: string) => ({
  id: `submit-${marker}`,
  name: "submit_reviewer_verdict",
  args: reviewerEnvelope(marker, sha, summary),
});

const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map(closeServer));
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("prompt_cache_key on the wire", () => {
  it("sends the run id as prompt_cache_key on main-session and delegated subagent requests", async () => {
    const runId = "prompt-cache-key-delegation";
    const sha = headSha("b");
    const wire: WireRequest[] = [];
    let parentTurns = 0;

    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const entry = recordWireRequest(body, wire);
        if (entry.delegated) {
          respondText(response, entry.model, childReport(runId));
          return;
        }
        parentTurns += 1;
        if (parentTurns === 1) {
          respondToolCalls(response, entry.model, [taskCall(runId)]);
          return;
        }
        respondToolCalls(response, entry.model, [submitCall(runId, sha)]);
      });
    });
    server.on("connection", (socket) => sockets.push(socket));
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-pck-delegation-"));
    scratchDirs.push(scratchDir);
    const runner = makeRunner(scratchDir, modelSpec(baseUrl, "pck-main"));

    const result = await runner.run({
      runId,
      packet: {
        goal: `Review ${runId} and delegate the inspection before submitting.`,
        head_sha: sha,
      },
      environment: { role: "reviewer" },
    });

    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(reviewerEnvelope(runId, sha));
    expect(wire.length).toBeGreaterThanOrEqual(3);
    expect(wire.some((entry) => entry.delegated)).toBe(true);
    expect(wire.some((entry) => !entry.delegated)).toBe(true);
    expect(wire.every((entry) => entry.promptCacheKey === runId)).toBe(true);
  }, 30_000);

  it("keeps the run id as prompt_cache_key on every request after a model fallback", async () => {
    const runId = "prompt-cache-key-fallback";
    const sha = headSha("f");
    const wire: WireRequest[] = [];

    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const entry = recordWireRequest(body, wire);
        if (entry.model === "primary") {
          respondQuotaRateLimit(response);
          return;
        }
        respondToolCalls(response, entry.model, [
          submitCall(
            runId,
            sha,
            "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
          ),
        ]);
      });
    });
    server.on("connection", (socket) => sockets.push(socket));
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-pck-fallback-"));
    scratchDirs.push(scratchDir);
    const runner = makeRunner(scratchDir, modelSpec(baseUrl, "primary"), [
      modelSpec(baseUrl, "fallback"),
    ]);

    const result = await runner.run({
      runId,
      packet: { goal: "Review the change", head_sha: sha },
      environment: { role: "reviewer" },
    });

    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(
      reviewerEnvelope(
        runId,
        sha,
        "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
      ),
    );
    expect(wire.some((entry) => entry.model === "primary")).toBe(true);
    expect(wire.some((entry) => entry.model === "fallback")).toBe(true);
    expect(wire.every((entry) => entry.promptCacheKey === runId)).toBe(true);
  }, 30_000);
});
