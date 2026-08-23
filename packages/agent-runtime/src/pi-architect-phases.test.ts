import type { PiModelSpec } from "./pi-runner-common.js";
import { buildArchitectPhases } from "./architect-phases.js";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  ARCHITECT_ROLE_PROFILE,
  DEVELOPER_ROLE_PROFILE,
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
    id: "chatcmpl-phases",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

describe("Pi architect phases", () => {
  it("drives the architect through the four phases and submits on consolidate", async () => {
    const infoLogs: LogEntry[] = [];
    const finalUserMessages: string[] = [];

    const envelope = {
      kind: "architect_decomposition",
      summary: "Two-task plan covering the phase pipeline.",
      acceptance: [
        {
          description: "Pipeline runs",
          command: "true",
        },
      ],
      tasks: [
        {
          title: "Only task",
          spec: "Land the pipeline.",
          depends_on: [],
        },
      ],
    };

    const server = createServer((request, response) => {
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

        if (content.includes("## Phase: consolidate")) {
          writeSse([
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-phases",
                    type: "function",
                    function: {
                      name: "submit_architect_decomposition",
                      arguments: JSON.stringify(envelope),
                    },
                  },
                ],
              },
              finish: null,
            },
            { delta: {}, finish: "tool_calls" },
          ]);
          return;
        }
        writeSse([
          { delta: { role: "assistant", content: "Working." }, finish: null },
          { delta: {}, finish: "stop" },
        ]);
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
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-phases-test-"));
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
      },
    );

    const result = await runner.run({
      runId: "phases-contract",
      packet: { goal: "Plan the scope", head_sha: "b".repeat(40) },
      environment: { role: "architect" },
    });

    const phaseEvents = infoLogs.filter(
      (entry) => entry.message === "architect_phase",
    );
    expect(phaseEvents.map((entry) => entry.fields.phase)).toEqual([
      "survey",
      "decompose",
      "deep_dive",
      "consolidate",
    ]);
    for (const entry of phaseEvents) {
      expect(entry.fields.runId).toBe("phases-contract");
    }

    expect(finalUserMessages.length).toBe(4);
    expect(finalUserMessages[0]).toContain("## Phase: survey");
    expect(finalUserMessages[1]).toContain("## Phase: decompose");
    expect(finalUserMessages[2]).toContain("## Phase: deep_dive");
    expect(finalUserMessages[3]).toContain("## Phase: consolidate");

    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);
  });

  it("keeps developer and reviewer profiles single-prompt", () => {
    expect(DEVELOPER_ROLE_PROFILE.phases).toBeUndefined();
    expect(REVIEWER_ROLE_PROFILE.phases).toBeUndefined();
  });
});

describe("phase budgets", () => {
  it("every phase carries a budget and they sum under the architect run timeout", () => {
    const phases = buildArchitectPhases({ goal: "g", body: "b" } as never);
    let total = 0;
    for (const phase of phases) {
      expect(phase.budgetMs).toBeGreaterThan(0);
      expect(phase.prompt).toMatch(/minutes of wall clock/);
      total += phase.budgetMs;
    }
    // Architect timeout is 45 min in config; budgets must leave headroom.
    expect(total).toBeLessThanOrEqual(40 * 60_000);
  });
});
