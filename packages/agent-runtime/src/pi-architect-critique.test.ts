import type { PiModelSpec } from "./pi-runner-common.js";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { ARCHITECT_CRITIQUE, parseCritiqueReport } from "./architect-phases.js";
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

function sseChunk(
  model: string,
  delta: unknown,
  finish: string | null,
): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-critique",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** A schema-valid decomposition envelope. */
function envelope(summary: string) {
  return {
    kind: "architect_decomposition",
    summary,
    acceptance: [
      {
        description: "Pipeline runs",
        command: "true",
      },
    ],
    tasks: [
      {
        title: "Only task",
        spec: `Land ${summary}.`,
        depends_on: [],
      },
    ],
  };
}

interface Harness {
  result: Awaited<ReturnType<PiBaseAgentRunner["run"]>>;
  finalUserMessages: string[];
  infoLogs: LogEntry[];
}

/**
 * SSE fake provider routing on each request's FINAL user message:
 * phase markers get phase turns (consolidate submits E1), `## Critique` gets
 * the critic's JSON report, `## Revision` gets a fresh submit carrying E2.
 */
async function runCritiqueScenario(
  critiqueResponse: string,
): Promise<Harness> {
  const infoLogs: LogEntry[] = [];
  const finalUserMessages: string[] = [];

  const e1 = envelope("Draft plan from consolidate.");
  const e2 = envelope("Revised plan after critique.");

  const server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as {
        model: string;
        messages?: { role: string; content: unknown }[];
      };
      const model = parsed.model;
      const lastUser = [...(parsed.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user");
      const content = Array.isArray(lastUser?.content)
        ? lastUser.content
            .map((block) =>
              typeof block === "object" && block !== null && "text" in block
                ? String((block as { text: unknown }).text)
                : "",
            )
            .join("\n")
        : String(lastUser?.content ?? "");
      finalUserMessages.push(content);

      const writeSse = (
        deltas: { delta: unknown; finish: string | null }[],
      ) => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "cache-control": "no-cache",
        });
        for (const { delta, finish } of deltas) {
          response.write(sseChunk(model, delta, finish));
        }
        response.end("data: [DONE]\n\n");
      };

      const submitToolCall = (envelopeJson: string) => [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${Math.random().toString(36).slice(2)}`,
                type: "function",
                function: {
                  name: "submit_architect_decomposition",
                  arguments: envelopeJson,
                },
              },
            ],
          },
          finish: null,
        },
        { delta: {}, finish: "tool_calls" },
      ];

      if (content.includes("## Critique")) {
        writeSse([
          {
            delta: { role: "assistant", content: critiqueResponse },
            finish: null,
          },
          { delta: {}, finish: "stop" },
        ]);
        return;
      }
      if (content.includes("## Revision")) {
        writeSse(submitToolCall(JSON.stringify(e2)));
        return;
      }
      if (content.includes("## Phase: consolidate")) {
        writeSse(submitToolCall(JSON.stringify(e1)));
        return;
      }
      writeSse([
        { delta: { role: "assistant", content: "Working." }, finish: null },
        { delta: {}, finish: "stop" },
      ]);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  const scratchDir = mkdtempSync(join(tmpdir(), "colony-critique-test-"));
  scratchDirs.push(scratchDir);
  const runner = new PiBaseAgentRunner(
    {
      ...ARCHITECT_ROLE_PROFILE,
      workspaceMode: "scratch",
      requireRepositoryInspection: false,
      defaultTools: [],
    },
    {
      model: model("primary"),
      scratchDir,
      broker: { resolve: () => "test-key" },
      runTimeoutMs: 60_000,
      logger: {
        info: (fields: Record<string, unknown>, message: string) => {
          infoLogs.push({ fields, message });
        },
      },
      critique: ARCHITECT_CRITIQUE,
    },
  );

  const result = await runner.run({
    runId: "critique-contract",
    packet: { goal: "Plan the scope", head_sha: "b".repeat(40) },
    environment: { role: "architect" },
  });
  return { result, finalUserMessages, infoLogs };
}

describe("Pi architect critique", () => {
  it("sends request_changes findings back for exactly one revision and accepts E2", async () => {
    const { result, finalUserMessages, infoLogs } = await runCritiqueScenario(
      '{"verdict":"request_changes","findings":["coverage walk: requirement X has no task"]}',
    );

    expect(finalUserMessages.length).toBe(6);
    expect(finalUserMessages[0]).toContain("## Phase: survey");
    expect(finalUserMessages[1]).toContain("## Phase: decompose");
    expect(finalUserMessages[2]).toContain("## Phase: deep_dive");
    expect(finalUserMessages[3]).toContain("## Phase: consolidate");
    expect(finalUserMessages[4]).toContain("## Critique");
    expect(finalUserMessages[5]).toContain("## Revision");
    expect(finalUserMessages[5]).toContain(
      "1. coverage walk: requirement X has no task",
    );
    // The critic sees only goal + project context + draft envelope.
    expect(finalUserMessages[4]).toContain("Scope goal:");
    expect(finalUserMessages[4]).toContain("Plan the scope");
    expect(finalUserMessages[4]).toContain("(none)");
    expect(finalUserMessages[4]).toContain('"summary": "Draft plan');

    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope("Revised plan after critique."));
    expect(result.envelope).not.toEqual(envelope("Draft plan from consolidate."));

    const critiqueEvents = infoLogs.filter(
      (entry) => entry.message === "architect_critique",
    );
    expect(critiqueEvents.length).toBe(1);
    expect(critiqueEvents[0]?.fields.verdict).toBe("request_changes");
    expect(critiqueEvents[0]?.fields.findings).toBe(1);
    expect(critiqueEvents[0]?.fields.runId).toBe("critique-contract");

    // Bounded: exactly one critique prompt, exactly one revision prompt.
    expect(
      finalUserMessages.filter((message) => message.includes("## Critique"))
        .length,
    ).toBe(1);
    expect(
      finalUserMessages.filter((message) => message.includes("## Revision"))
        .length,
    ).toBe(1);
  });

  it("accepts E1 without any revision turn when the critique approves", async () => {
    const { result, finalUserMessages, infoLogs } = await runCritiqueScenario(
      '{"verdict":"approve","findings":[]}',
    );

    expect(finalUserMessages.length).toBe(5);
    expect(finalUserMessages[4]).toContain("## Critique");
    expect(
      finalUserMessages.some((message) => message.includes("## Revision")),
    ).toBe(false);

    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope("Draft plan from consolidate."));

    const critiqueEvents = infoLogs.filter(
      (entry) => entry.message === "architect_critique",
    );
    expect(critiqueEvents.length).toBe(1);
    expect(critiqueEvents[0]?.fields.verdict).toBe("approve");
    expect(critiqueEvents[0]?.fields.findings).toBe(0);
  });

  it("ignores the critique option on profiles without phases", async () => {
    const infoLogs: LogEntry[] = [];
    const finalUserMessages: string[] = [];
    const envelopeValue = envelope("Single-prompt submission.");
    const server = createServer((_request, response) => {
      let body = "";
      _request.setEncoding("utf8");
      _request.on("data", (chunk) => {
        body += chunk;
      });
      _request.on("end", () => {
        const parsed = JSON.parse(body) as {
          messages?: { role: string; content: unknown }[];
        };
        const lastUser = [...(parsed.messages ?? [])]
          .reverse()
          .find((message) => message.role === "user");
        finalUserMessages.push(String(lastUser?.content ?? ""));
        const chunks = [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-single",
                  type: "function",
                  function: {
                    name: "submit_architect_decomposition",
                    arguments: JSON.stringify(envelopeValue),
                  },
                },
              ],
            },
            finish: null,
          },
          { delta: {}, finish: "tool_calls" },
        ];
        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "cache-control": "no-cache",
        });
        for (const { delta, finish } of chunks) {
          response.write(sseChunk("primary", delta, finish));
        }
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
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-nophase-test-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...ARCHITECT_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
        // No phases: critique must be ignored even though the option is set.
        phases: undefined,
      },
      {
        model: {
          id: "primary",
          name: "primary",
          api: "openai-completions",
          provider: "test-gateway",
          baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        } satisfies PiModelSpec,
        scratchDir,
        broker: { resolve: () => "test-key" },
        runTimeoutMs: 60_000,
        logger: {},
        critique: ARCHITECT_CRITIQUE,
      },
    );

    const result = await runner.run({
      runId: "nophase-contract",
      packet: { goal: "Plan the scope", head_sha: "b".repeat(40) },
      environment: { role: "architect" },
    });
    expect(finalUserMessages.length).toBe(1);
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelopeValue);
  });
});

describe("parseCritiqueReport", () => {
  it("parses fenced JSON reports", () => {
    const report = parseCritiqueReport(
      '```json\n{"verdict":"approve","findings":["a"]}\n```',
    );
    expect(report).toEqual({ verdict: "approve", findings: ["a"] });
  });

  it("falls back to request_changes with the raw text when unparseable", () => {
    const raw = "I could not produce JSON, sorry.";
    const report = parseCritiqueReport(raw);
    expect(report).toEqual({ verdict: "request_changes", findings: [raw] });
  });

  it("normalizes request_changes with no findings to approve", () => {
    const report = parseCritiqueReport('{"verdict":"request_changes"}');
    expect(report).toEqual({ verdict: "approve", findings: [] });
  });
});
