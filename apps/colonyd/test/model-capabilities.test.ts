import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { loadColonyConfig } from "@colony/config";
import { createArchitectSubmitTool } from "@colony/agent-runtime";
import {
  ARCHITECT_ROLE_PROFILE,
  PiBaseAgentRunner,
} from "@colony/agent-runtime/pi-base-agent-runner";
import { modelFromConfig } from "../src/agent-runtime.js";

const servers: Server[] = [];
const scratchDirs: string[] = [];
const configDirs: string[] = [];

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
      id: "chatcmpl-model-capability-test",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices,
      ...(usage ? { usage } : {}),
    })}\n\n`,
  );
};
const isNamedArchitectToolChoice = (
  request: Record<string, unknown>,
): boolean => {
  const choice = request.tool_choice;
  if (!choice || typeof choice !== "object") return false;
  const functionChoice = (choice as Record<string, unknown>).function;
  return (
    typeof functionChoice === "object" &&
    functionChoice !== null &&
    (functionChoice as Record<string, unknown>).name ===
      "submit_architect_decomposition"
  );
};

const envelope = {
  kind: "architect_decomposition",
  summary: "A config-backed model capability regression.",
  requirements: [
    { id: "R1", text: "Preserve ordinary thinking requests.", tasks: [0] },
  ],
  journey: [
    { after_task: 0, working_state: "The capability path is verified." },
  ],
  acceptance: [
    {
      description: "The forced request omits reasoning fields.",
      command: "true",
    },
  ],
  tasks: [
    {
      title: "Verify model capability metadata",
      spec: "Load model metadata from the production-shaped config.",
      depends_on: [],
      files: ["packages/config/src/colony-config.ts"],
      evidence: ["true"],
    },
  ],
};

function tempConfig(baseUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-model-capabilities-config-"));
  configDirs.push(dir);
  const path = join(dir, "colony.yaml");
  writeFileSync(
    path,
    `agent_runtime: pi
providers:
  openai_compatible:
    api: openai-completions
    base_url: ${baseUrl}
    auth: { kind: api_key, value: MODEL_CAPABILITY_TEST_KEY }
    models:
      - id: kimi/k3
        name: kimi-k3
        reasoning: true
        context_window: 1048576
        max_tokens: 131072
        compat:
          disableReasoningOnForcedToolChoice: true
agents:
  architect:
    provider: openai_compatible
    model: kimi-k3
    thinking_level: high
    max_turns: 5
`,
    "utf8",
  );
  return path;
}

async function startGateway(
  requests: Record<string, unknown>[],
): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      const model = String(parsed.model);
      if (parsed.tool_choice === undefined) {
        response.writeHead(200, sseHeaders);
        sseChunk(response, model, [
          {
            index: 0,
            delta: {
              role: "assistant",
              reasoning_content: "Thinking before the submit directive.",
              content: "I have enough evidence to submit.",
            },
            finish_reason: null,
          },
        ]);
        sseChunk(
          response,
          model,
          [{ index: 0, delta: {}, finish_reason: "stop" }],
          { completion_tokens: 7, prompt_tokens: 1 },
        );
        response.end("data: [DONE]\n\n");
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
                id: "call-model-capability-test",
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
        { completion_tokens: 5, prompt_tokens: 1 },
      );
      response.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}/v1`;
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
  for (const dir of configDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("production model capability metadata", () => {
  it("loads kimi/k3 compat and disables reasoning only on forced submission", async () => {
    const requests: Record<string, unknown>[] = [];
    const baseUrl = await startGateway(requests);
    const config = loadColonyConfig({
      path: tempConfig(baseUrl),
      env: { MODEL_CAPABILITY_TEST_KEY: "test-key" },
    });
    const architect = config.forAgent("architect");
    expect(architect.model.id).toBe("kimi/k3");
    expect(architect.model.compat).toEqual({
      disableReasoningOnForcedToolChoice: true,
    });
    const thinkingLevel = architect.thinkingLevel;
    expect(thinkingLevel).toBe("high");

    const model = modelFromConfig(architect);
    expect(model.id).toBe("kimi/k3");
    expect(model.compat).toEqual({
      disableReasoningOnForcedToolChoice: true,
    });

    const scratchDir = mkdtempSync(
      join(tmpdir(), "colony-model-capabilities-scratch-"),
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
        model,
        scratchDir,
        broker: { resolve: () => "test-key" },
        thinkingLevel,
        maxTurns: 5,
        runTimeoutMs: 120_000,
        jiggleBackoffMs: 1,
        retryMaxRetries: 0,
      },
    );

    const result = await runner.run({
      runId: "production-model-capability-regression",
      packet: {
        goal: "Verify config-backed model capabilities",
        head_sha: "f".repeat(40),
      },
      environment: { role: "architect" },
    });

    expect(result.envelope).toEqual(envelope);
    const ordinary = requests.find(
      (request) => request.tool_choice === undefined,
    );
    const forced = requests.find(isNamedArchitectToolChoice);
    expect(ordinary?.model).toBe("kimi/k3");
    const ordinaryThinking = ordinary?.thinking;
    expect(
      typeof ordinary?.reasoning_effort === "string" ||
        (typeof ordinaryThinking === "object" &&
          ordinaryThinking !== null &&
          (ordinaryThinking as Record<string, unknown>).type === "enabled"),
    ).toBe(true);
    expect(forced?.model).toBe("kimi/k3");
    expect(forced?.tool_choice).toEqual({
      type: "function",
      function: { name: "submit_architect_decomposition" },
    });
    expect(forced?.reasoning_effort).toBeUndefined();
    expect(forced?.reasoning).toBeUndefined();
    expect(
      forced?.thinking === undefined ||
        (typeof forced.thinking === "object" &&
          forced.thinking !== null &&
          (forced.thinking as Record<string, unknown>).type === "disabled"),
    ).toBe(true);
    expect(forced?.enable_thinking).toBeUndefined();
  }, 120_000);
});
