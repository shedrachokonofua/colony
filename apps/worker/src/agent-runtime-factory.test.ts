import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Env } from "@colony/config";
import { createAgentRuntimeWiring } from "./agent-runtime-factory.js";

describe("createAgentRuntimeWiring", () => {
  it("uses fake runtime in test mode without requiring a config file", async () => {
    const wiring = await createAgentRuntimeWiring({
      ...baseEnv(),
      NODE_ENV: "test",
      COLONY_CONFIG_PATH: "/no/such/config.yaml",
    });

    await expect(wiring.developer.getRunStatus("missing")).resolves.toBeNull();
    expect(wiring.developer).toBe(wiring.reviewer);
  });

  it("builds pi adapters from an OpenAI-compatible provider config", async () => {
    const path = tempConfig(`
agent_runtime: pi
providers:
  openai_compatible:
    api: openai-completions
    base_url: https://litellm.home.shdr.ch/v1
    auth: { kind: api_key, value: COLONY_OPENAI_COMPATIBLE_API_KEY }
    models:
      - id: openai/gpt-5.4
        name: gpt-5.4
      - id: anthropic/claude-sonnet-4.6
        name: sonnet-4.6
agents:
  developer:
    provider: openai_compatible
    model: gpt-5.4
  reviewer:
    provider: openai_compatible
    model: sonnet-4.6
`);

    const env = {
      ...baseEnv(),
      AGENT_RUNTIME: "pi" as const,
      COLONY_CONFIG_PATH: path,
    };
    const wiring = await createAgentRuntimeWiring(env, {
      COLONY_OPENAI_COMPATIBLE_API_KEY: "sk-litellm-virtual",
    });

    expect(wiring.developer).not.toBe(wiring.reviewer);
  });

  it("fails fast in pi mode when the OpenAI-compatible key is missing", async () => {
    const path = tempConfig(`
agent_runtime: pi
providers:
  openai_compatible:
    api: openai-completions
    base_url: https://litellm.home.shdr.ch/v1
    auth: { kind: api_key, value: COLONY_OPENAI_COMPATIBLE_API_KEY }
    models:
      - id: openai/gpt-5.4
        name: gpt-5.4
agents:
  developer:
    provider: openai_compatible
    model: gpt-5.4
  reviewer:
    provider: openai_compatible
    model: gpt-5.4
`);

    await expect(
      createAgentRuntimeWiring(
        {
          ...baseEnv(),
          AGENT_RUNTIME: "pi",
          COLONY_CONFIG_PATH: path,
        },
        {},
      ),
    ).rejects.toThrow(/COLONY_OPENAI_COMPATIBLE_API_KEY/);
  });

  it("builds pi adapters from an OAuth Codex provider config", async () => {
    const path = tempConfig(`
agent_runtime: pi
providers:
  openai_codex:
    api: openai-codex-responses
    auth:
      kind: oauth
      subscription: chatgpt_plus
    models:
      - id: gpt-5.5
        name: gpt-5.5
        reasoning: true
agents:
  developer:
    provider: openai_codex
    model: gpt-5.5
    thinking_level: high
  reviewer:
    provider: openai_codex
    model: gpt-5.5
    thinking_level: high
`);

    const wiring = await createAgentRuntimeWiring(
      {
        ...baseEnv(),
        AGENT_RUNTIME: "pi",
        COLONY_CONFIG_PATH: path,
      },
      {},
    );

    expect(wiring.developer).not.toBe(wiring.reviewer);
  });
});

function tempConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-worker-runtime-"));
  const path = join(dir, "colony.yaml");
  writeFileSync(path, yaml, "utf8");
  return path;
}

function baseEnv(): Env {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgres://colony:colony@localhost:5432/colony",
    TEMPORAL_ADDRESS: "localhost:7233",
    TEMPORAL_TLS: false,
    TEMPORAL_NAMESPACE: "default",
    TEMPORAL_TASK_QUEUE: "colony-supervisor",
    GITLAB_BASE_URL: "https://gitlab.home.shdr.ch",
    GITLAB_TOKEN: "",
    GITLAB_WEBHOOK_SECRET: "",
    GITLAB_DEV_PROJECT_ID: "",
    API_PORT: 4000,
    WEBHOOK_DISPATCHER_PORT: 4100,
    TOOL_GATEWAY_PORT: 4200,
    WEB_PORT: 3000,
    PUBLIC_HOST: "localhost",
  };
}
