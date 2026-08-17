import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@colony/config";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import { FakeProviderAdapter } from "@colony/provider";
import { boot, type ColonydHandle } from "../src/main.js";
import { awaitPendingRuns } from "../src/runs/registry.js";
import { buildApp } from "../src/http.js";

const ACTOR = "human:t";

let dir: string;
let provider: FakeProviderAdapter;
let projectId: string;
let handle: ColonydHandle;
let configPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "colonyd-model-id-"));
  configPath = join(dir, "colony.yaml");
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
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("records the configured primary model_id on architect runs and exposes it via HTTP", async () => {
  process.env["NODE_ENV"] = "test";
  process.env["AGENT_RUNTIME"] = "fake";
  process.env["GITLAB_TOKEN"] = "";
  process.env["COLONYD_DB_PATH"] = join(dir, "model-id.db");
  process.env["COLONY_CONFIG_PATH"] = configPath;
  resetEnvCache();

  provider = new FakeProviderAdapter();
  const project = await provider.projects.create({
    name: "fake-model-id",
    path: "so/fake-model-id",
  });
  projectId = project.id;

  handle = await boot({
    provider,
    agents: {
      runtime: "fake",
      architect: new FakeAgentRuntimeAdapter(),
      developer: new FakeAgentRuntimeAdapter(),
    },
    headless: true,
  });

  const scope = handle.ctx.store.createScope({
    goal: "model id harness",
    provider_project_id: projectId,
    provider_project_path: project.path,
  });
  handle.ctx.store.audit(ACTOR, "scope.created", { scope_id: scope.id });

  await handle.tick();
  // Drain until the architect run exists.
  for (let i = 0; i < 10; i += 1) {
    await awaitPendingRuns();
    const runs = handle.ctx.store.runsForScope(scope.id);
    if (runs.some((r) => r.kind === "architect")) break;
  }

  const architectRun = handle.ctx.store
    .runsForScope(scope.id)
    .find((r) => r.kind === "architect");
  expect(architectRun).toBeTruthy();
  expect(architectRun!.model_id).toBe("fake-model");

  const app = buildApp(handle.ctx);
  const scopeRes = await app.request(`/scopes/${scope.id}`, {
    headers: { "X-Actor-Id": ACTOR },
  });
  expect(scopeRes.status).toBe(200);
  const scopeBody = (await scopeRes.json()) as {
    runs: { kind: string; model_id: string | null }[];
  };
  const scopeRun = scopeBody.runs.find((r) => r.kind === "architect");
  expect(scopeRun).toBeTruthy();
  expect(scopeRun!.model_id).toBe("fake-model");

  const runRes = await app.request(`/runs/${architectRun!.id}`, {
    headers: { "X-Actor-Id": ACTOR },
  });
  expect(runRes.status).toBe(200);
  const runBody = (await runRes.json()) as { model_id: string | null };
  expect(runBody.model_id).toBe("fake-model");
});
