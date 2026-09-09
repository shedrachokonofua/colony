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
const pendingResponses: ServerResponse[] = [];
const releaseBarriers: Array<() => void> = [];

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  connection: "keep-alive",
  "cache-control": "no-cache",
};

type ParsedRequest = {
  model?: string;
  messages?: unknown[];
  tools?: Array<{ function?: { name?: string } }>;
};

type ChildRequest = {
  marker: string;
  label: string;
  model: string;
  toolNames: string[];
};

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

const respondFailure = (response: ServerResponse): void => {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: { message: "quota exhausted", type: "insufficient_quota" },
    }),
  );
};

const parseRequest = (body: string): ParsedRequest =>
  JSON.parse(body) as ParsedRequest;

const isChildRequest = (request: ParsedRequest): boolean =>
  JSON.stringify(request.messages ?? []).includes("You are a Colony subagent");

const requestToolNames = (request: ParsedRequest): string[] =>
  (request.tools ?? []).flatMap((tool) =>
    tool.function?.name ? [tool.function.name] : [],
  );

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
      jiggleBackoffMs: 0,
      maxTurns: 4,
      runTimeoutMs: 15_000,
    },
  );

const headSha = (letter: string): string => letter.repeat(40);

const reviewerEnvelope = (
  marker: string,
  sha: string,
  labels: readonly string[] = ["alpha", "beta", "gamma"],
) => ({
  kind: "reviewer_verdict",
  verdict: "approve",
  summary: `Approved after receiving the successful delegated reports for ${marker}: ${labels.map((label) => `${marker}-${label}`).join(", ")}.`,
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
      name: "defects",
      spec_blind: true,
      target_files: ["source.ts"],
      findings: 0,
    },
  ],
  challenged: { reviewed: 0, dropped: 0 },
});

const taskCalls = (marker: string) =>
  (["alpha", "beta", "gamma"] as const).map((label) => ({
    id: `call-${marker}-${label}`,
    name: "task",
    args: {
      description: `${marker} ${label}`,
      prompt: `For ${marker}, return exactly the useful delegated report ${marker}-${label}.`,
    },
  }));

const childReport = (marker: string, label: string): string =>
  `${marker}-${label}: delegated inspection completed successfully.`;

const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

afterEach(async () => {
  for (const release of releaseBarriers.splice(0)) release();
  for (const response of pendingResponses.splice(0)) response.destroy();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map(closeServer));
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Pi subagent sessions", () => {
  it("completes three simultaneous child calls for overlapping parent runs", async () => {
    const markers = ["overlap-alpha-run", "overlap-beta-run"] as const;
    const shas = [headSha("a"), headSha("b")] as const;
    const childRequests: ChildRequest[] = [];
    const parentBodies = new Map<string, string[]>();
    const parentTurns = new Map<string, number>();
    const allChildren = Promise.withResolvers<void>();
    releaseBarriers.push(allChildren.resolve);

    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", async () => {
        const parsed = parseRequest(body);
        const marker = markers.find((candidate) => body.includes(candidate));
        if (!marker) {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end("missing run marker");
          return;
        }
        if (isChildRequest(parsed)) {
          const label = (["alpha", "beta", "gamma"] as const).find(
            (candidate) => body.includes(`${marker}-${candidate}`),
          );
          if (!label) {
            response.writeHead(500, { "content-type": "text/plain" });
            response.end("missing child label");
            return;
          }
          childRequests.push({
            marker,
            label,
            model: parsed.model ?? "",
            toolNames: requestToolNames(parsed),
          });
          if (childRequests.length === 6) allChildren.resolve();
          pendingResponses.push(response);
          await allChildren.promise;
          respondText(response, parsed.model ?? "", childReport(marker, label));
          return;
        }

        const bodies = parentBodies.get(marker) ?? [];
        bodies.push(body);
        parentBodies.set(marker, bodies);
        const turn = (parentTurns.get(marker) ?? 0) + 1;
        parentTurns.set(marker, turn);
        if (turn === 1) {
          respondToolCalls(response, parsed.model ?? "", taskCalls(marker));
          return;
        }

        const reports = (["alpha", "beta", "gamma"] as const).map((label) =>
          childReport(marker, label),
        );
        if (!reports.every((report) => body.includes(report))) {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end("parent did not receive every delegated report");
          return;
        }
        respondToolCalls(response, parsed.model ?? "", [
          {
            id: `submit-${marker}`,
            name: "submit_reviewer_verdict",
            args: reviewerEnvelope(marker, shas[markers.indexOf(marker)]!),
          },
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
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-subagent-overlap-"));
    scratchDirs.push(scratchDir);
    const runner = makeRunner(scratchDir, modelSpec(baseUrl, "overlap"));

    const results = await Promise.all(
      markers.map((marker, index) =>
        runner.run({
          runId: marker,
          packet: {
            goal: `Review ${marker} and use delegated reports before submitting.`,
            head_sha: shas[index],
          },
          environment: { role: "reviewer" },
        }),
      ),
    );

    expect(childRequests).toHaveLength(6);
    expect(
      childRequests.map(({ marker, label }) => `${marker}-${label}`).sort(),
    ).toEqual(
      markers
        .flatMap((marker) =>
          (["alpha", "beta", "gamma"] as const).map(
            (label) => `${marker}-${label}`,
          ),
        )
        .sort(),
    );
    expect(
      childRequests.every(({ toolNames }) =>
        ["submit_reviewer_verdict", "goal", "task"].every(
          (forbidden) => !toolNames.includes(forbidden),
        ),
      ),
    ).toBe(true);
    for (const [index, result] of results.entries()) {
      expect(result.reason).toBeUndefined();
      expect(result.envelope).toEqual(
        reviewerEnvelope(markers[index]!, shas[index]!),
      );
    }
    expect(
      parentBodies
        .get(markers[0]!)
        ?.some((body) => body.includes(childReport(markers[0]!, "alpha"))),
    ).toBe(true);
    expect(
      parentBodies
        .get(markers[1]!)
        ?.some((body) => body.includes(childReport(markers[1]!, "gamma"))),
    ).toBe(true);
  }, 30_000);

  it("runs a delegated child on the active fallback model after primary failure", async () => {
    const marker = "fallback-delegation-run";
    const sha = headSha("c");
    const childModels: string[] = [];
    const childToolNames: string[][] = [];
    const parentModels: string[] = [];
    const parentBodies: string[] = [];
    let fallbackTurns = 0;

    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = parseRequest(body);
        if (!body.includes(marker)) {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end("missing run marker");
          return;
        }
        if (isChildRequest(parsed)) {
          childModels.push(parsed.model ?? "");
          childToolNames.push(requestToolNames(parsed));
          respondText(
            response,
            parsed.model ?? "",
            childReport(marker, "only"),
          );
          return;
        }

        parentModels.push(parsed.model ?? "");
        parentBodies.push(body);
        if (parsed.model === "primary") {
          respondFailure(response);
          return;
        }
        fallbackTurns += 1;
        if (fallbackTurns === 1) {
          respondToolCalls(response, parsed.model ?? "", [
            {
              id: "call-fallback-child",
              name: "task",
              args: {
                description: "fallback delegated inspection",
                prompt: `For ${marker}, return exactly the useful delegated report ${marker}-only.`,
              },
            },
          ]);
          return;
        }
        if (!body.includes(childReport(marker, "only"))) {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end("fallback parent did not receive delegated report");
          return;
        }
        respondToolCalls(response, parsed.model ?? "", [
          {
            id: "submit-fallback",
            name: "submit_reviewer_verdict",
            args: reviewerEnvelope(marker, sha, ["only"]),
          },
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
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-subagent-fallback-"));
    scratchDirs.push(scratchDir);
    const runner = makeRunner(scratchDir, modelSpec(baseUrl, "primary"), [
      modelSpec(baseUrl, "fallback"),
    ]);

    const result = await runner.run({
      runId: marker,
      packet: {
        goal: `Review ${marker} and delegate the inspection before submitting.`,
        head_sha: sha,
      },
      environment: { role: "reviewer" },
    });

    expect(parentModels[0]).toBe("primary");
    expect(childModels).toEqual(["fallback"]);
    expect(
      childToolNames.every((names) =>
        ["submit_reviewer_verdict", "goal", "task"].every(
          (forbidden) => !names.includes(forbidden),
        ),
      ),
    ).toBe(true);
    expect(
      parentBodies.some((body) => body.includes(childReport(marker, "only"))),
    ).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(reviewerEnvelope(marker, sha, ["only"]));
  }, 30_000);
});
