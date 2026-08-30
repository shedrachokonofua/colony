import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetEnvCache } from "@colony/config";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import { FakeProviderAdapter } from "@colony/provider";
import { isTracingEnabled, startColonyRunSpan } from "@colony/observability";
import { boot, type ColonydHandle } from "../src/main.js";
import { buildApp } from "../src/http.js";
import { runArchitect } from "../src/runs/architect.js";

const ACTOR = "human:t";

describe("run tracing disabled", () => {
  let dir: string;
  let provider: FakeProviderAdapter;
  let handle: ColonydHandle | undefined;

  beforeAll(async () => {
    // Deliberately NO registerInMemorySpanExporter and NO
    // OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: the run must complete with zero
    // tracing code paths activated.
    dir = mkdtempSync(join(tmpdir(), "colonyd-run-notracing-"));
    prepareEnv(dir, writeConfig(dir));

    provider = new FakeProviderAdapter();
    handle = await boot({
      provider,
      agents: {
        runtime: "fake",
        architect: new FakeAgentRuntimeAdapter(),
        developer: new FakeAgentRuntimeAdapter(),
      },
      headless: true,
    });
  }, 90_000);

  afterAll(async () => {
    // The booted daemon owns a tick interval; leaving it running leaks it
    // into every test file sharing this process.
    await handle?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes trace_id null and completes normally with tracing disabled", async () => {
    if (!handle) throw new Error("boot failed");
    expect(isTracingEnabled()).toBe(false);
    expect(
      startColonyRunSpan({
        scope_id: "scope-x",
        task_id: null,
        run_id: "run-x",
        kind: "architect",
        model_id: null,
      }),
    ).toBeUndefined();

    const repo = await provider.repos.create({
      name: "run-tracing-off",
      path: "so/run-tracing-off",
    });
    const scope = handle.ctx.store.createScope({
      goal: "tracing disabled harness",
      provider_repo_id: repo.id,
      provider_repo_path: repo.path,
    });

    await runArchitect(handle.ctx, scope);

    const run = handle.ctx.store
      .runsForScope(scope.id)
      .find((entry) => entry.kind === "architect");
    expect(run).toBeTruthy();
    expect(run!.status).toBe("succeeded");
    expect(run!.trace_id).toBeNull();
    // The run-scoped audit rows (run.start, run.finished) must reference the
    // runs row id, so the trail stays joinable to runs by run_id.
    const startRows = handle.ctx.store
      .listAudit({ run_id: run!.id })
      .events.filter((row) => row.action === "run.start");
    expect(startRows).toHaveLength(1);

    const app = buildApp(handle.ctx);
    const res = await app.request(`/scopes/${scope.id}`, {
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: { kind: string; trace_id: string | null }[];
    };
    expect(body.runs[0]!.trace_id).toBeNull();
  });
});

function writeConfig(dir: string): string {
  const configPath = join(dir, "colony.yaml");
  writeFileSync(
    configPath,
    [
      "agent_runtime: fake",
      "allow_literal_keys: true",
      "hitl:",
      "  mode: yolo",
      "providers:",
      "  fake_llm:",
      "    api: openai-completions",
      "    base_url: http://localhost:9/v1",
      "    auth:",
      "      kind: api_key",
      "      value: fake-key",
      "    models:",
      "      - id: fake-model",
      "        name: fake-model",
      "agents:",
      "  architect:",
      "    provider: fake_llm",
      "    model: fake-model",
      "  developer:",
      "    provider: fake_llm",
      "    model: fake-model",
    ].join("\n"),
    "utf8",
  );
  return configPath;
}

function prepareEnv(dir: string, configPath: string): void {
  process.env["NODE_ENV"] = "test";
  process.env["AGENT_RUNTIME"] = "fake";
  process.env["GITLAB_TOKEN"] = "";
  delete process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
  process.env["COLONYD_DB_PATH"] = join(dir, "run-tracing.db");
  process.env["COLONY_CONFIG_PATH"] = configPath;
  resetEnvCache();
}
