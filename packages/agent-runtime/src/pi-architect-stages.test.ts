import type { PiModelSpec } from "./pi-runner-common.js";
import type { PiRunResult } from "./pi-adapter.js";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  ARCHITECT_ROLE_PROFILE,
  PiBaseAgentRunner,
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

interface LogEntry {
  fields: Record<string, unknown>;
  message: string;
}

interface ChatRequest {
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
  tool_choice?: {
    type: string;
    function?: { name: string };
  };
}

function sseChunk(delta: unknown, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-stages",
    object: "chat.completion.chunk",
    created: 1,
    model: "primary",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function plan(summary: string) {
  return {
    kind: "architect_decomposition",
    summary,
    requirements: [
      { id: "R1", text: "GET /version returns the build sha", tasks: [0] },
    ],
    journey: [{ after_task: 0, working_state: "GET /version answers" }],
    acceptance: [{ description: "version route", command: "true" }],
    tasks: [
      {
        title: "Add /version",
        spec: `Land ${summary}.`,
        depends_on: [],
        files: ["src/http.ts"],
        evidence: ["bun test src/http.test.ts"],
      },
    ],
  };
}

function toolCallChunks(name: string, args: unknown): string[] {
  return [
    sseChunk(
      {
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
      null,
    ),
    sseChunk({}, "tool_calls"),
  ];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) =>
        block.type === "text" && typeof block.text === "string"
          ? block.text
          : "",
      )
      .join("\n");
  }
  return "";
}

function firstUserText(request: ChatRequest): string {
  return textOf(request.messages.find((m) => m.role === "user")?.content);
}

function systemText(request: ChatRequest): string {
  return textOf(request.messages.find((m) => m.role === "system")?.content);
}

interface Scenario {
  /** Decide the model's reply from the request; return tool call chunks. */
  reply: (request: ChatRequest, turn: number) => string[];
  packet?: Record<string, unknown>;
}

async function runScenario(scenario: Scenario): Promise<{
  result: PiRunResult;
  requests: ChatRequest[];
  logs: LogEntry[];
}> {
  const requests: ChatRequest[] = [];
  const logs: LogEntry[] = [];
  let turn = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as ChatRequest;
      requests.push(parsed);
      turn += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
        "cache-control": "no-cache",
      });
      for (const chunk of scenario.reply(parsed, turn)) response.write(chunk);
      response.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const scratchDir = mkdtempSync(join(tmpdir(), "colony-stages-test-"));
  scratchDirs.push(scratchDir);
  const runner = new PiBaseAgentRunner(
    {
      ...ARCHITECT_ROLE_PROFILE,
      workspaceMode: "scratch",
      requireRepositoryInspection: false,
    },
    {
      model: {
        id: "primary",
        name: "primary",
        api: "openai-completions",
        provider: "test-gateway",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      } satisfies PiModelSpec,
      scratchDir,
      broker: { resolve: () => "test-key" },
      runTimeoutMs: 60_000,
      maxTurns: 200,
      logger: {
        info: (fields: Record<string, unknown>, message: string) => {
          logs.push({ fields, message });
        },
        warn: (fields: Record<string, unknown>, message: string) => {
          logs.push({ fields, message });
        },
      },
    },
  );
  const result = await runner.run({
    runId: "stages-contract",
    packet: {
      kind: "architect_scope",
      goal: "Add GET /version returning the build sha",
      plan_directives: "Repair failed CI automatically.",
      head_sha: "a".repeat(40),
      ...scenario.packet,
    },
    environment: { role: "architect" },
  });
  return { result, requests, logs };
}

/** Route on the stage: each stage's system prompt names its submit tool. */
function stageOf(request: ChatRequest): "plan" | "verify" {
  return systemText(request).includes("submit_plan_draft") ? "plan" : "verify";
}
describe("staged architect", () => {
  it("carries the exact rejected plan into a revision rather than fresh planning", async () => {
    let firstPlanPrompt = "";
    let planningTurns = 0;
    const rejected = plan("rejected");
    const feedback =
      "Plan review round 1: request_changes.\nFix the migration collision.\n\n1. [blocker] task 0: use the queue-safe state transition.";
    const { result, requests } = await runScenario({
      packet: {
        plan_feedback: feedback,
        revision_context: {
          rejected_plan: rejected,
          review_run_id: "review-1",
          review_base_sha: "base-before-review",
          plan_hash: "hash-rejected",
          planning_epoch: "scope.unblocked:7",
          feedback,
        },
      },
      reply: (request) => {
        switch (stageOf(request)) {
          case "plan":
            planningTurns += 1;
            if (planningTurns === 1) {
              firstPlanPrompt = firstUserText(request);
              return toolCallChunks("submit_plan_draft", plan("revised"));
            }
            throw new Error("planning should submit on the first turn");
          case "verify":
            return toolCallChunks(
              "submit_architect_decomposition",
              plan("verified revision"),
            );
        }
      },
    });

    expect(result.reason).toBeUndefined();
    expect(firstPlanPrompt).toContain('"summary": "rejected"');
    expect(firstPlanPrompt.split('"summary": "rejected"').length - 1).toBe(1);
    expect(firstPlanPrompt).toContain("review-1");
    expect(firstPlanPrompt).toContain("base-before-review");
    expect(firstPlanPrompt).toContain("hash-rejected");
    expect(firstPlanPrompt).toContain("scope.unblocked:7");
    expect(firstPlanPrompt).toContain("Fix the migration collision.");
    expect(firstPlanPrompt).toContain("Repair failed CI automatically.");
    expect(requests.map(stageOf)).toEqual(["plan", "verify"]);
  }, 60_000);

  it("discovers and plans in one session, then verifies independently", async () => {
    let planningTurns = 0;
    const { result, requests, logs } = await runScenario({
      reply: (request) => {
        switch (stageOf(request)) {
          case "plan":
            planningTurns += 1;
            return planningTurns === 1
              ? toolCallChunks("bash", { command: "pwd" })
              : toolCallChunks("submit_plan_draft", plan("draft"));
          case "verify":
            return toolCallChunks(
              "submit_architect_decomposition",
              plan("verified"),
            );
        }
      },
    });
    expect(result.reason).toBeUndefined();
    expect((result.envelope as { summary: string }).summary).toBe("verified");

    expect(requests.map(stageOf)).toEqual(["plan", "plan", "verify"]);
    const started = logs
      .filter((entry) => entry.message === "architect_stage")
      .map((entry) => entry.fields.stage);
    expect(started).toEqual(["plan", "verify"]);

    const planPrompt = firstUserText(requests[0]!);
    expect(planPrompt).toContain("Add GET /version");
    expect(planPrompt).toContain("Repair failed CI automatically.");
    const verifyPrompt = firstUserText(requests[2]!);
    expect(verifyPrompt).toContain('"summary": "draft"');
    expect(verifyPrompt).toContain("## Mechanical inspection manifest");
    expect(verifyPrompt).toContain('"pwd"');
    expect(verifyPrompt).toContain("Repair failed CI automatically.");
    const closingNudge = requests[1]!.messages
      .map((message) => textOf(message.content))
      .join("\n");
    expect(closingNudge).toContain("The submission window is closing");
    expect(closingNudge).not.toMatch(/\b\d+\s*(?:minutes?|mins?)\b/i);

    const names = (request: ChatRequest) =>
      (request.tools ?? []).map((tool) => tool.function.name);
    expect(names(requests[0]!)).toEqual(
      expect.arrayContaining([
        "submit_plan_draft",
        "read",
        "grep",
        "glob",
        "bash",
        "task",
      ]),
    );
    expect(names(requests[2]!)).toEqual(
      expect.arrayContaining([
        "submit_architect_decomposition",
        "read",
        "grep",
        "task",
      ]),
    );
    expect(
      names(requests[0]!).some((name) => name === "submit_survey_notes"),
    ).toBe(false);

    const done = logs.filter(
      (entry) => entry.message === "architect_stage_done",
    );
    expect(done.map((entry) => entry.fields.stage)).toEqual(["plan", "verify"]);
    expect((done[0]!.fields.artifact as { kind: string }).kind).toBe(
      "architect_decomposition",
    );

    for (const request of requests) {
      expect(`${systemText(request)}\n${firstUserText(request)}`).not.toMatch(
        /\b\d+\s*(?:minutes?|mins?)\b/i,
      );
    }
  }, 60_000);

  it("forces the plan submit tool when discovery needs a steer", async () => {
    let forcedPlanRequest: ChatRequest | undefined;
    const { result, requests, logs } = await runScenario({
      reply: (request) => {
        switch (stageOf(request)) {
          case "plan":
            if (
              request.tool_choice?.type === "function" &&
              request.tool_choice.function?.name === "submit_plan_draft"
            ) {
              forcedPlanRequest = request;
              return toolCallChunks("submit_plan_draft", plan("draft"));
            }
            return [
              sseChunk(
                {
                  role: "assistant",
                  content: "I am still inspecting the repository.",
                },
                null,
              ),
              sseChunk({}, "stop"),
            ];
          case "verify":
            return toolCallChunks(
              "submit_architect_decomposition",
              plan("verified"),
            );
        }
      },
    });

    expect(result.reason).toBeUndefined();
    expect(forcedPlanRequest?.tool_choice).toEqual({
      type: "function",
      function: { name: "submit_plan_draft" },
    });
    expect(
      logs.filter((entry) => entry.message === "architect_stage_submit_forced"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fields: expect.objectContaining({ stage: "plan", turn: 1 }),
        }),
      ]),
    );
    expect(
      requests.filter((request) => stageOf(request) === "plan"),
    ).toHaveLength(2);
  }, 60_000);

  it("a planning stage that keeps reading is left with only its submit tool", async () => {
    let capSeen = false;
    const { result, requests, logs } = await runScenario({
      reply: (request) => {
        const tools = (request.tools ?? []).map((tool) => tool.function.name);
        switch (stageOf(request)) {
          case "plan":
            if (tools.length === 1 && tools[0] === "submit_plan_draft") {
              capSeen = true;
              return toolCallChunks("submit_plan_draft", plan("draft"));
            }
            return toolCallChunks("bash", { command: "pwd" });
          case "verify":
            return toolCallChunks(
              "submit_architect_decomposition",
              plan("verified"),
            );
        }
      },
    });
    expect(capSeen).toBe(true);
    expect(result.reason).toBeUndefined();
    const cap = logs.find(
      (entry) => entry.message === "architect_stage_turn_cap",
    );
    expect(cap?.fields.stage).toBe("plan");
    expect(cap?.fields.turns).toBe(40);
    const planRequests = requests.filter(
      (request) => stageOf(request) === "plan",
    );
    expect(planRequests.length).toBeGreaterThan(40);
  }, 120_000);

  it("a planning stage the model never submits fails before verification", async () => {
    const { result, logs } = await runScenario({
      reply: (request) => {
        switch (stageOf(request)) {
          case "plan":
            return [
              sseChunk(
                { role: "assistant", content: "I would plan it like so." },
                null,
              ),
              sseChunk({}, "stop"),
            ];
          case "verify":
            throw new Error("verify must not run after a failed plan stage");
        }
      },
    });
    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toBe("architect_stage_plan_no_submission");
    expect(
      logs
        .filter((entry) => entry.message === "architect_stage")
        .map((entry) => entry.fields.stage),
    ).toEqual(["plan"]);
  }, 60_000);
});
