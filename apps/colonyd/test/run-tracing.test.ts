import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetEnvCache } from "@colony/config";
import { PiAgentRuntimeAdapter, type PiModelSpec } from "@colony/agent-runtime";
import {
  ARCHITECT_ROLE_PROFILE,
  PiBaseAgentRunner,
} from "@colony/agent-runtime/pi-base-agent-runner";
import { FakeProviderAdapter } from "@colony/provider";
import { registerInMemorySpanExporter } from "@colony/observability";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { boot, type ColonydHandle } from "../src/main.js";
import { buildApp } from "../src/http.js";
import { runArchitect } from "../src/runs/architect.js";

const ACTOR = "human:t";

const servers: Server[] = [];
const stubServers: Server[] = [];

interface ModelStubHandle {
  baseUrl: string;
}

/**
 * Stub the OpenAI-compatible completions endpoint the way
 * pi-architect-phases.test.ts does: intermediate architect phases get a
 * plain content reply, the consolidate phase submits the decomposition
 * envelope via the submit tool (which is what produces the execute_tool
 * span).
 */
async function startModelStub(envelope: unknown): Promise<ModelStubHandle> {
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

      const chunks = content.includes("## Phase: consolidate")
        ? [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-tracing-submit",
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
          ]
        : [
            { delta: { role: "assistant", content: "Working." }, finish: null },
            { delta: {}, finish: "stop" },
          ];

      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
        "cache-control": "no-cache",
      });
      for (const { delta, finish } of chunks) {
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-tracing",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  stubServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function testModel(baseUrl: string, id: string): PiModelSpec {
  return {
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
  };
}

function writeConfig(dir: string): string {
  const configPath = join(dir, "colony.yaml");
  writeFileSync(
    configPath,
    [
      "agent_runtime: pi",
      "allow_literal_keys: true",
      "hitl:",
      "  mode: yolo",
      "providers:",
      "  test_llm:",
      "    api: openai-completions",
      "    base_url: http://localhost:9/v1",
      "    auth:",
      "      kind: api_key",
      "      value: test-key",
      "    models:",
      "      - id: test-model",
      "        name: test-model",
      "agents:",
      "  architect:",
      "    provider: test_llm",
      "    model: test-model",
      "  developer:",
      "    provider: test_llm",
      "    model: test-model",
    ].join("\n"),
    "utf8",
  );
  return configPath;
}

const ENVELOPE = {
  kind: "architect_decomposition",
  summary: "Two-task plan covering the tracing pipeline.",
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

describe("run tracing with the pi runtime and an in-memory exporter", () => {
  let dir: string;
  let provider: FakeProviderAdapter;
  let handle: ColonydHandle | undefined;
  let seam: {
    exporter: { getFinishedSpans(): readonly ReadableSpan[] };
    shutdown: () => Promise<void>;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "colonyd-run-tracing-"));
    prepareEnv(dir, writeConfig(dir));

    provider = new FakeProviderAdapter();
    const stub = await startModelStub(ENVELOPE);
    // One shared runner backs both wired roles; only the architect path is
    // exercised below.
    const adapter = new PiAgentRuntimeAdapter(
      new PiBaseAgentRunner(
        {
          ...ARCHITECT_ROLE_PROFILE,
          workspaceMode: "scratch",
          requireRepositoryInspection: false,
          defaultTools: [],
        },
        {
          model: testModel(stub.baseUrl, "test-model"),
          scratchDir: dir,
          broker: { resolve: () => "test-key" },
          runTimeoutMs: 60_000,
          logger: { info: () => undefined },
        },
      ),
      { provider: "test-gateway", model: "test-model" },
    );
    handle = await boot({
      provider,
      agents: { runtime: "pi", architect: adapter, developer: adapter },
      headless: true,
    });
    // Registered after boot: boot's configureTracing is a no-op without an
    // OTLP endpoint, leaving the global tracer slot free for the test seam.
    seam = registerInMemorySpanExporter();
  }, 90_000);

  afterAll(async () => {
    // The booted daemon owns a tick interval; the seam owns the global
    // tracer provider. Both leak into every test file sharing this process.
    await handle?.shutdown();
    // The model stub backs every run in this file; tear it down only here.
    await closeAll(stubServers.splice(0));
    await seam?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a colony.run span tree with nested GenAI child spans for a pi run", async () => {
    if (!handle) throw new Error("boot failed");
    const repo = await provider.repos.create({
      name: "run-tracing-tree",
      path: "so/run-tracing-tree",
    });
    const scope = handle.ctx.store.createScope({
      goal: "span tree harness",
      title: "span tree harness",
      provider_repo_id: repo.id,
      provider_repo_path: repo.path,
    });

    await runArchitect(handle.ctx, scope);

    // The FakeAgentRuntimeAdapter never calls createAgentSession, so it can
    // never emit invoke_agent/chat/execute_tool spans; this test drives the
    // real pi runner against the stubbed model precisely so those spans
    // appear under the run root.
    const root = findRunSpan(seam.exporter.getFinishedSpans(), scope.id);
    expect(root).toBeTruthy();
    expect(root!.attributes["colony.task_id"]).toBe("");
    // The span is started before the run row exists, so its colony.run_id
    // must be the id later minted into the runs row, not a throwaway uuid.
    const runRow = handle.ctx.store
      .runsForScope(scope.id)
      .find((entry) => entry.kind === "architect");
    expect(runRow).toBeTruthy();
    expect(root!.attributes["colony.run_id"]).toBe(runRow!.id);
    expect(root!.attributes["colony.run.kind"]).toBe("architect");
    expect(root!.attributes["colony.model.id"]).toBe("test-model");
    expect(root!.attributes["colony.run.status"]).toBe("succeeded");

    const children = seam.exporter
      .getFinishedSpans()
      .filter(
        (span) =>
          span.spanContext().traceId === root!.spanContext().traceId &&
          span !== root,
      );
    expect(children.some((span) => span.name.startsWith("invoke_agent"))).toBe(
      true,
    );
    expect(children.some((span) => span.name.startsWith("chat"))).toBe(true);
    expect(children.some((span) => span.name.startsWith("execute_tool"))).toBe(
      true,
    );
  });

  it("trace_id persists on the runs row and surfaces via GET /scopes/:id", async () => {
    if (!handle) throw new Error("boot failed");
    const repo = await provider.repos.create({
      name: "run-tracing-persist",
      path: "so/run-tracing-persist",
    });
    const scope = handle.ctx.store.createScope({
      goal: "trace persistence harness",
      title: "trace persistence harness",
      provider_repo_id: repo.id,
      provider_repo_path: repo.path,
    });

    await runArchitect(handle.ctx, scope);

    const runSpan = findRunSpan(seam.exporter.getFinishedSpans(), scope.id);
    expect(runSpan).toBeTruthy();

    const app = buildApp(handle.ctx);
    const res = await app.request(`/scopes/${scope.id}`, {
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: { kind: string; trace_id: string | null }[];
    };
    expect(body.runs.length).toBeGreaterThan(0);
    const persisted = body.runs[0]!.trace_id;
    expect(persisted).toMatch(/^[0-9a-f]{32}$/);
    expect(persisted).toBe(runSpan!.spanContext().traceId);
  });
});

function findRunSpan(
  spans: readonly ReadableSpan[],
  scopeId: string,
): ReadableSpan | undefined {
  return spans.find(
    (span) =>
      span.name === "colony.run" &&
      span.attributes["colony.scope_id"] === scopeId,
  );
}

function closeAll(list: readonly Server[]): Promise<void> {
  return Promise.all(
    list.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  ).then(() => undefined);
}

function prepareEnv(dir: string, configPath: string): void {
  process.env["NODE_ENV"] = "test";
  process.env["AGENT_RUNTIME"] = "pi";
  process.env["GITLAB_TOKEN"] = "";
  delete process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
  process.env["COLONYD_DB_PATH"] = join(dir, "run-tracing.db");
  process.env["COLONY_CONFIG_PATH"] = configPath;
  resetEnvCache();
}
