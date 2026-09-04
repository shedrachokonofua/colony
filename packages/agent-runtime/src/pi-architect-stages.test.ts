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

const NOTES = {
  kind: "architect_survey_notes",
  requirements: [{ id: "R1", text: "GET /version returns the build sha" }],
  findings: [{ path: "src/http.ts", note: "router lives here" }],
  commands: { test: "bun test" },
  conventions: ["tests beside sources"],
  gaps: ["no version route yet"],
};

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
    },
    environment: { role: "architect" },
  });
  return { result, requests, logs };
}

/** Route on the stage: each stage's system prompt names its submit tool. */
function stageOf(request: ChatRequest): "survey" | "plan" | "verify" {
  const system = systemText(request);
  if (system.includes("submit_survey_notes")) return "survey";
  if (system.includes("submit_plan_draft")) return "plan";
  return "verify";
}

describe("staged architect", () => {
  it("runs survey, plan, verify as separate sessions with typed hand-offs", async () => {
    const { result, requests, logs } = await runScenario({
      reply: (request) => {
        switch (stageOf(request)) {
          case "survey":
            return toolCallChunks("submit_survey_notes", NOTES);
          case "plan":
            return toolCallChunks("submit_plan_draft", plan("draft"));
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

    // Three sessions, three system prompts, in order.
    const stages = requests.map(stageOf);
    expect(stages).toEqual(["survey", "plan", "verify"]);
    const started = logs
      .filter((l) => l.message === "architect_stage")
      .map((l) => l.fields.stage);
    expect(started).toEqual(["survey", "plan", "verify"]);

    // The plan stage saw the survey notes and nothing of the survey chat.
    const planPrompt = firstUserText(requests[1]!);
    expect(planPrompt).toContain("## Survey notes");
    expect(planPrompt).toContain("no version route yet");
    expect(planPrompt).toContain("Repair failed CI automatically.");
    expect(requests[1]!.messages.filter((m) => m.role === "user")).toHaveLength(
      1,
    );
    // The verify stage saw the draft.
    expect(firstUserText(requests[2]!)).toContain('"summary": "draft"');
    expect(firstUserText(requests[2]!)).toContain(
      "Repair failed CI automatically.",
    );

    // Tools per stage: survey and verify may inspect and delegate; plan may
    // only read and submit.
    const names = (r: ChatRequest) =>
      (r.tools ?? []).map((t) => t.function.name);
    expect(names(requests[0]!)).toContain("submit_survey_notes");
    expect(names(requests[0]!)).toContain("task");
    // The work tools are SDK builtins here (no engine); a survey that cannot
    // read is a survey by delegation only.
    expect(names(requests[0]!)).toEqual(
      expect.arrayContaining(["read", "grep", "glob", "bash"]),
    );
    expect(names(requests[1]!)).toEqual(
      expect.arrayContaining(["submit_plan_draft", "read"]),
    );
    expect(names(requests[1]!)).not.toContain("task");
    expect(names(requests[1]!)).not.toContain("grep");
    expect(names(requests[1]!)).not.toContain("bash");
    expect(names(requests[2]!)).toContain("submit_architect_decomposition");
    expect(names(requests[2]!)).toContain("task");
    expect(names(requests[2]!)).toContain("grep");

    // Every stage logged its close with the artifact it produced.
    const done = logs.filter((l) => l.message === "architect_stage_done");
    expect(done.map((l) => l.fields.stage)).toEqual([
      "survey",
      "plan",
      "verify",
    ]);
    expect(done[0]!.fields.landed).toBe(true);
    expect((done[0]!.fields.artifact as { kind: string }).kind).toBe(
      "architect_survey_notes",
    );
  }, 60_000);

  it("forces the submit tool when a stage needs a steer", async () => {
    let forcedSurveyRequest: ChatRequest | undefined;
    const { result, requests, logs } = await runScenario({
      reply: (request) => {
        switch (stageOf(request)) {
          case "survey":
            if (
              request.tool_choice?.type === "function" &&
              request.tool_choice.function?.name === "submit_survey_notes"
            ) {
              forcedSurveyRequest = request;
              return toolCallChunks("submit_survey_notes", NOTES);
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
          case "plan":
            return toolCallChunks("submit_plan_draft", plan("draft"));
          case "verify":
            return toolCallChunks(
              "submit_architect_decomposition",
              plan("verified"),
            );
        }
      },
    });

    expect(result.reason).toBeUndefined();
    expect(forcedSurveyRequest).toBeDefined();
    expect(forcedSurveyRequest?.tool_choice).toEqual({
      type: "function",
      function: { name: "submit_survey_notes" },
    });
    expect(
      logs.filter((l) => l.message === "architect_stage_submit_forced"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fields: expect.objectContaining({ stage: "survey", turn: 1 }),
        }),
      ]),
    );
    expect(
      requests.filter((request) => stageOf(request) === "survey"),
    ).toHaveLength(2);
  }, 60_000);

  it("a stage that keeps reading past its turn cap is left with only its submit tool", async () => {
    // The survey stage caps at 60 turns; the fake keeps calling `read`
    // until the request arrives with a single tool, then submits.
    let capSeen = false;
    const { result, requests, logs } = await runScenario({
      reply: (request) => {
        const tools = (request.tools ?? []).map((t) => t.function.name);
        switch (stageOf(request)) {
          case "survey":
            if (tools.length === 1 && tools[0] === "submit_survey_notes") {
              capSeen = true;
              return toolCallChunks("submit_survey_notes", NOTES);
            }
            return toolCallChunks("read", { path: "src/http.ts" });
          case "plan":
            return toolCallChunks("submit_plan_draft", plan("draft"));
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
    const cap = logs.find((l) => l.message === "architect_stage_turn_cap");
    expect(cap?.fields.stage).toBe("survey");
    expect(cap?.fields.turns).toBe(60);
    const surveyRequests = requests.filter((r) => stageOf(r) === "survey");
    expect(surveyRequests.length).toBeGreaterThan(60);
  }, 120_000);

  it("a stage the model never submits fails the run with the stage named", async () => {
    // The plan stage stops without calling submit_plan_draft, twice steered.
    const { result, logs } = await runScenario({
      reply: (request) => {
        switch (stageOf(request)) {
          case "survey":
            return toolCallChunks("submit_survey_notes", NOTES);
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
    // The runner's unfinished marker, never a plan.
    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toBe("architect_stage_plan_no_submission");
    expect(
      logs
        .filter((l) => l.message === "architect_stage")
        .map((l) => l.fields.stage),
    ).toEqual(["survey", "plan"]);
  }, 60_000);
});
