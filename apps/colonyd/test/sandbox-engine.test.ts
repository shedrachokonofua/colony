import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createInProcessEngine } from "@colony/sandbox-in-process";
import { createEngine, ENGINE_REGISTRY } from "../src/agent-runtime.js";
import { resetEnvCache } from "@colony/config";
import type { ColonyConfig } from "@colony/config";
import { DEFAULT_KUBERNETES_SANDBOX } from "@colony/config";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import { FakeProviderAdapter } from "@colony/provider";
import { boot, type ColonydHandle } from "../src/main.js";

function stubConfig(): ColonyConfig {
  return {
    agentRuntime: "pi",
    sandbox: {
      engine: "in-process",
      kubernetes: DEFAULT_KUBERNETES_SANDBOX,
    },
    hitlMode: "gated",
    reviewMode: "off",
    artifacts: { kind: "local", local: { dir: "data/artifacts" } },
    sessionsDir: "data/sessions",
    oauthProviderKeys: [],
    forAgent: () => {
      throw new Error("stub forAgent not used");
    },
    getProvider: () => null,
    modelParallelLimit: () => null,
  };
}

describe("colonyd sandbox engine registry", () => {
  it("maps the in-process engine name to createInProcessEngine", async () => {
    expect(ENGINE_REGISTRY["in-process"]).toBeTypeOf("function");

    const engineFromFactory = await ENGINE_REGISTRY["in-process"](stubConfig());
    // The registry resolves to the shared createInProcessEngine factory.
    expect(engineFromFactory).toBe(createInProcessEngine);

    const engine = await createEngine("in-process", stubConfig());
    expect(typeof engine.provision).toBe("function");
  });

  it("registers the kubernetes engine lazily", async () => {
    expect(ENGINE_REGISTRY["kubernetes"]).toBeTypeOf("function");

    // The factory is lazy per task 0: constructing it must not touch a
    // cluster, so we only assert the shape and never call provision().
    const engine = await createEngine("kubernetes", stubConfig());
    expect(typeof engine.provision).toBe("function");
  });

  it("throws on an unknown sandbox engine name", async () => {
    await expect(createEngine("nomad", stubConfig())).rejects.toThrow(
      /unknown sandbox engine: nomad/,
    );
  });
});

describe("colonyd boot validate-engine wiring", () => {
  let dir: string;
  let configPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "colonyd-validate-engine-"));
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

  it("provisions ctx.validateEngine from the configured engine at boot", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["AGENT_RUNTIME"] = "fake";
    process.env["GITLAB_TOKEN"] = "";
    process.env["COLONYD_DB_PATH"] = join(dir, "validate-engine.db");
    process.env["COLONY_CONFIG_PATH"] = configPath;
    resetEnvCache();

    const handle: ColonydHandle = await boot({
      provider: new FakeProviderAdapter(),
      agents: {
        runtime: "fake",
        architect: new FakeAgentRuntimeAdapter(),
        developer: new FakeAgentRuntimeAdapter(),
      },
      headless: true,
    });

    expect(handle.ctx.validateEngine).toBeDefined();
    expect(typeof handle.ctx.validateEngine?.provision).toBe("function");

    await handle.shutdown();
  });

  it("honors a BootOptions.validateEngine override", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["AGENT_RUNTIME"] = "fake";
    process.env["GITLAB_TOKEN"] = "";
    process.env["COLONYD_DB_PATH"] = join(dir, "validate-engine-override.db");
    process.env["COLONY_CONFIG_PATH"] = configPath;
    resetEnvCache();

    const override = createInProcessEngine();
    const handle: ColonydHandle = await boot({
      provider: new FakeProviderAdapter(),
      agents: {
        runtime: "fake",
        architect: new FakeAgentRuntimeAdapter(),
        developer: new FakeAgentRuntimeAdapter(),
      },
      validateEngine: override,
      headless: true,
    });

    expect(handle.ctx.validateEngine).toBe(override);

    await handle.shutdown();
  });
});
