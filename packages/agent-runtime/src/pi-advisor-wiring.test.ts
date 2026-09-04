import { createServer, type Server, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
  shouldEnableColonyAdvisor,
} from "./pi-base-agent-runner.js";
import type { PiModelSpec } from "./pi-runner-common.js";

const servers: Server[] = [];
const scratchDirs: string[] = [];

const sseHeaders = {
  "content-type": "text/event-stream",
  connection: "keep-alive",
  "cache-control": "no-cache",
};

function writeChunk(
  response: ServerResponse,
  model: string,
  choices: unknown[],
): void {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-advisor-test",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices,
    })}\n\n`,
  );
}

function respondText(response: ServerResponse, model: string): void {
  response.writeHead(200, sseHeaders);
  writeChunk(response, model, [
    {
      index: 0,
      delta: { role: "assistant", content: "No blocking issue found." },
      finish_reason: null,
    },
  ]);
  writeChunk(response, model, [{ index: 0, delta: {}, finish_reason: "stop" }]);
  response.end("data: [DONE]\n\n");
}

function respondVerdict(
  response: ServerResponse,
  model: string,
  envelope: unknown,
): void {
  response.writeHead(200, sseHeaders);
  writeChunk(response, model, [
    {
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call-submit",
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
  writeChunk(response, model, [
    { index: 0, delta: {}, finish_reason: "tool_calls" },
  ]);
  response.end("data: [DONE]\n\n");
}

function modelSpec(
  baseUrl: string,
  id: string,
  provider = "openai_compatible",
): PiModelSpec {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function privateAdvisorDirs(): string[] {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith("colony-advisor-"),
    )
    .map((entry) => join(tmpdir(), entry.name));
}

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

describe("Pi advisor wiring", () => {
  it("limits advisors to non-architect run journals", () => {
    expect(shouldEnableColonyAdvisor("reviewer", "run", true)).toBe(true);
    expect(shouldEnableColonyAdvisor("reviewer", "transient", true)).toBe(
      false,
    );
    expect(shouldEnableColonyAdvisor("architect", "run", true)).toBe(false);
    expect(shouldEnableColonyAdvisor("developer", "run", false)).toBe(false);
  });

  it("keeps a Contributor-only advisor failure outside the primary fallback chain", async () => {
    const requests: Array<{ model: string; tools: string[] }> = [];
    const advisorDirsBefore = new Set(privateAdvisorDirs());
    const advisorDirsSeen = new Set<string>();
    const headSha = "a".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "Approved: the requested behavior is complete and the inspected implementation has no blocking defect.",
      findings: [],
      inspected: [
        { file: "src/main.ts", note: "checked against the requested behavior" },
      ],
      head_sha: headSha,
    };
    let primaryTurns = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as {
          model: string;
          tools?: Array<{ function?: { name?: string } }>;
        };
        requests.push({
          model: parsed.model,
          tools: (parsed.tools ?? []).flatMap((tool) =>
            tool.function?.name ? [tool.function.name] : [],
          ),
        });
        for (const dir of privateAdvisorDirs()) {
          if (advisorDirsBefore.has(dir)) continue;
          advisorDirsSeen.add(dir);
          expect(existsSync(join(dir, "WATCHDOG.yml"))).toBe(true);
        }
        if (parsed.model === "router/muse-spark-1.3-contributor") {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "advisor quota exhausted",
                type: "insufficient_quota",
              },
            }),
          );
          return;
        }
        primaryTurns += 1;
        respondVerdict(
          response,
          parsed.model,
          primaryTurns === 1 ? {} : envelope,
        );
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
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-advisor-test-"));
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
        fallbackModels: [modelSpec(baseUrl, "primary-fallback")],
        advisorModel: modelSpec(baseUrl, "router/muse-spark-1.3-contributor"),
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 5,
        runTimeoutMs: 10_000,
      },
    );

    const result = await runner.run({
      runId: "advisor-contract",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);
    expect(advisorDirsSeen.size).toBe(1);
    for (const dir of advisorDirsSeen) {
      expect(existsSync(join(dir, "WATCHDOG.yml"))).toBe(false);
      expect(existsSync(dir)).toBe(false);
    }
    const advisorRequests = requests.filter(
      (request) => request.model === "router/muse-spark-1.3-contributor",
    );
    expect(advisorRequests).toHaveLength(1);
    expect([...advisorRequests[0]!.tools].sort()).toEqual(
      ["advise", "glob", "grep", "read"].sort(),
    );
    expect(
      requests.some((request) => request.model === "primary-fallback"),
    ).toBe(false);
  }, 30_000);
  it("runs the primary without an advisor when its provider is unavailable", async () => {
    const requests: string[] = [];
    const headSha = "b".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "Approved: the primary completed after the optional advisor provider was unavailable.",
      findings: [],
      inspected: [
        { file: "src/main.ts", note: "checked by the primary reviewer" },
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
        const parsed = JSON.parse(body) as { model: string };
        requests.push(parsed.model);
        respondVerdict(response, parsed.model, envelope);
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
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-advisor-test-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
      },
      {
        model: modelSpec(baseUrl, "primary", "primary_provider"),
        fallbackModels: [],
        advisorModel: modelSpec(
          baseUrl,
          "router/muse-spark-1.3-contributor",
        ),
        scratchDir,
        broker: {
          resolve: ({ provider }) =>
            provider === "primary_provider" ? "test-key" : undefined,
        },
        maxTurns: 5,
        runTimeoutMs: 10_000,
      },
    );

    const result = await runner.run({
      runId: "advisor-provider-unavailable",
      packet: { goal: "Review the change", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);
    expect(requests).toEqual(["primary"]);
  }, 30_000);
});
