import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ColonyConfigError, loadColonyConfig } from "../src/colony-config.js";
import { env, resetEnvCache } from "../src/index.js";

function tempConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-config-"));
  const path = join(dir, "colony.yaml");
  writeFileSync(path, yaml, "utf8");
  return path;
}

const VALID_YAML = `
agent_runtime: pi
providers:
  anthropic:
    api: anthropic-messages
    auth:
      kind: api_key
      value: ANTHROPIC_API_KEY
    models:
      - id: claude-sonnet-4-20250514
        name: sonnet-4
        cost: { input: 3, output: 15 }
  openai_codex:
    api: openai-codex-responses
    auth:
      kind: oauth
      subscription: chatgpt_plus
    models:
      - id: gpt-5-codex
        name: gpt-5-codex
agents:
  developer:
    provider: openai_codex
    model: gpt-5-codex
    thinking_level: high
    timeout_ms: 60000
    max_turns: 5
  reviewer:
    provider: anthropic
    model: sonnet-4
`;

describe("loadColonyConfig", () => {
  it("resolves an api_key auth via env var", () => {
    const path = tempConfig(VALID_YAML);
    const cfg = loadColonyConfig({
      path,
      env: { ANTHROPIC_API_KEY: "sk-test-anthropic" },
    });
    const reviewer = cfg.forAgent("reviewer");
    expect(reviewer.providerKey).toBe("anthropic");
    expect(reviewer.api).toBe("anthropic-messages");
    expect(reviewer.model.id).toBe("claude-sonnet-4-20250514");
    expect(reviewer.model.name).toBe("sonnet-4");
    expect(reviewer.auth.kind).toBe("api_key");
    if (reviewer.auth.kind === "api_key") {
      expect(reviewer.auth.apiKey).toBe("sk-test-anthropic");
    }
    // ceilings fall back to per-role defaults when not specified
    expect(reviewer.ceilings.maxTurns).toBe(20);
  });

  it("defaults hitl mode to gated and parses yolo", () => {
    const gated = loadColonyConfig({
      path: tempConfig(VALID_YAML),
      env: { ANTHROPIC_API_KEY: "x" },
    });
    expect(gated.hitlMode).toBe("gated");

    const yolo = loadColonyConfig({
      path: tempConfig(`hitl: { mode: yolo }
${VALID_YAML}`),
      env: { ANTHROPIC_API_KEY: "x" },
    });
    expect(yolo.hitlMode).toBe("yolo");
  });

  it("defaults review mode to off and parses required", () => {
    const off = loadColonyConfig({
      path: tempConfig(VALID_YAML),
      env: { ANTHROPIC_API_KEY: "x" },
    });
    expect(off.reviewMode).toBe("off");

    const required = loadColonyConfig({
      path: tempConfig(`review: { mode: required }
${VALID_YAML}`),
      env: { ANTHROPIC_API_KEY: "x" },
    });
    expect(required.reviewMode).toBe("required");
  });

  it("preserves OpenAI-compatible base_url and arbitrary env var auth names", () => {
    const path = tempConfig(`
agent_runtime: pi
providers:
  openai_compatible:
    api: openai-completions
    base_url: https://litellm.home.shdr.ch/v1
    auth: { kind: api_key, value: COLONY_OPENAI_COMPATIBLE_API_KEY }
    models:
      - id: anthropic/claude-sonnet-4.6
        name: sonnet-4.6
agents:
  reviewer:
    provider: openai_compatible
    model: sonnet-4.6
`);
    const cfg = loadColonyConfig({
      path,
      env: { COLONY_OPENAI_COMPATIBLE_API_KEY: "sk-litellm-virtual" },
    });
    const reviewer = cfg.forAgent("reviewer");
    expect(reviewer.providerKey).toBe("openai_compatible");
    expect(reviewer.api).toBe("openai-completions");
    expect(reviewer.baseUrl).toBe("https://litellm.home.shdr.ch/v1");
    expect(reviewer.auth.kind).toBe("api_key");
  });

  it("returns oauth auth with the provider key as the lookup handle", () => {
    const path = tempConfig(VALID_YAML);
    const cfg = loadColonyConfig({
      path,
      env: { ANTHROPIC_API_KEY: "sk-anthropic" },
    });
    const dev = cfg.forAgent("developer");
    expect(dev.api).toBe("openai-codex-responses");
    expect(dev.thinkingLevel).toBe("high");
    expect(dev.auth.kind).toBe("oauth");
    if (dev.auth.kind === "oauth") {
      expect(dev.auth.providerKey).toBe("openai_codex");
      expect(dev.auth.subscription).toBe("chatgpt_plus");
    }
    // explicit ceilings on the agent override defaults
    expect(dev.ceilings.timeoutMs).toBe(60_000);
    expect(dev.ceilings.maxTurns).toBe(5);
  });

  it("surfaces oauthProviderKeys for the admin UI", () => {
    const path = tempConfig(VALID_YAML);
    const cfg = loadColonyConfig({
      path,
      env: { ANTHROPIC_API_KEY: "x" },
    });
    expect(cfg.oauthProviderKeys).toEqual(["openai_codex"]);
  });

  it("rejects literal api_key values when allow_literal_keys is false", () => {
    const path = tempConfig(`
providers:
  anthropic:
    api: anthropic-messages
    auth:
      kind: api_key
      value: "sk-actual-literal-key"
    models:
      - id: claude-sonnet-4-20250514
        name: sonnet-4
agents:
  reviewer:
    provider: anthropic
    model: sonnet-4
`);
    const cfg = loadColonyConfig({ path, env: {} });
    expect(() => cfg.forAgent("reviewer")).toThrow(ColonyConfigError);
    try {
      cfg.forAgent("reviewer");
    } catch (e) {
      expect((e as ColonyConfigError).code).toBe("LITERAL_KEY_NOT_ALLOWED");
    }
  });

  it("accepts literal keys when allow_literal_keys is true", () => {
    const path = tempConfig(`
allow_literal_keys: true
providers:
  anthropic:
    api: anthropic-messages
    auth:
      kind: api_key
      value: "sk-literal-allowed"
    models:
      - id: claude-sonnet-4-20250514
        name: sonnet-4
agents:
  reviewer:
    provider: anthropic
    model: sonnet-4
`);
    const cfg = loadColonyConfig({ path, env: {} });
    const r = cfg.forAgent("reviewer");
    if (r.auth.kind === "api_key") {
      expect(r.auth.apiKey).toBe("sk-literal-allowed");
    } else {
      throw new Error("expected api_key");
    }
  });

  it("rejects api_key when env var is missing", () => {
    const path = tempConfig(VALID_YAML);
    const cfg = loadColonyConfig({ path, env: {} });
    expect(() => cfg.forAgent("reviewer")).toThrow(ColonyConfigError);
    try {
      cfg.forAgent("reviewer");
    } catch (e) {
      expect((e as ColonyConfigError).code).toBe("UNRESOLVED_API_KEY");
    }
  });

  it("rejects unknown provider in agent entry at boot when not lazy", () => {
    const path = tempConfig(`
agent_runtime: pi
providers:
  anthropic:
    api: anthropic-messages
    auth: { kind: api_key, value: ANTHROPIC_API_KEY }
    models:
      - id: claude-sonnet-4-20250514
        name: sonnet-4
agents:
  developer:
    provider: openai_codex
    model: gpt-5-codex
`);
    expect(() =>
      loadColonyConfig({
        path,
        env: { ANTHROPIC_API_KEY: "x" },
      }),
    ).toThrow(/UNRESOLVED_AGENT_PROVIDER|unknown provider/);
  });

  it("resolves ordered same-provider fallback models", () => {
    const path = tempConfig(`
agent_runtime: pi
providers:
  gateway:
    api: openai-completions
    base_url: https://llm.example/v1
    auth: { kind: api_key, value: GATEWAY_KEY }
    models:
      - { id: kimi/k3, name: kimi }
      - { id: router/deepseek-v4-pro, name: deepseek }
      - { id: router/glm-5.2, name: glm }
agents:
  reviewer:
    provider: gateway
    model: kimi
    fallback_models: [deepseek, glm]
`);
    const reviewer = loadColonyConfig({
      path,
      env: { GATEWAY_KEY: "x" },
    }).forAgent("reviewer");

    expect(reviewer.model.id).toBe("kimi/k3");
    expect(reviewer.fallbackModels.map((model) => model.id)).toEqual([
      "router/deepseek-v4-pro",
      "router/glm-5.2",
    ]);
  });

  it("rejects an unknown fallback model at boot", () => {
    const path = tempConfig(
      VALID_YAML.replace(
        "    model: sonnet-4",
        "    model: sonnet-4\n    fallback_models: [missing]",
      ),
    );
    expect(() =>
      loadColonyConfig({
        path,
        env: { ANTHROPIC_API_KEY: "x" },
      }),
    ).toThrow(/unknown model missing/);
  });

  it("tolerates missing cross-refs in fake mode (lazy)", () => {
    const path = tempConfig(`
agent_runtime: fake
providers: {}
agents: {}
`);
    const cfg = loadColonyConfig({ path });
    expect(cfg.agentRuntime).toBe("fake");
    expect(() => cfg.forAgent("developer")).toThrow(ColonyConfigError);
  });

  it("agent-level auth override wins over provider auth", () => {
    const path = tempConfig(`
agent_runtime: pi
providers:
  anthropic:
    api: anthropic-messages
    auth: { kind: api_key, value: ANTHROPIC_PRIMARY }
    models:
      - id: claude-sonnet-4-20250514
        name: sonnet-4
agents:
  reviewer:
    provider: anthropic
    model: sonnet-4
    auth: { kind: api_key, value: ANTHROPIC_REVIEWER }
`);
    const cfg = loadColonyConfig({
      path,
      env: { ANTHROPIC_PRIMARY: "primary", ANTHROPIC_REVIEWER: "reviewer" },
    });
    const r = cfg.forAgent("reviewer");
    if (r.auth.kind === "api_key") {
      expect(r.auth.apiKey).toBe("reviewer");
    } else {
      throw new Error("expected api_key");
    }
  });

  it("getProvider returns shape suitable for the admin UI", () => {
    const path = tempConfig(VALID_YAML);
    const cfg = loadColonyConfig({
      path,
      env: { ANTHROPIC_API_KEY: "x" },
    });
    expect(cfg.getProvider("openai_codex")).toEqual({
      api: "openai-codex-responses",
      auth: { kind: "oauth", subscription: "chatgpt_plus" },
      models: [{ id: "gpt-5-codex", name: "gpt-5-codex" }],
    });
    expect(cfg.getProvider("nope")).toBeNull();
  });

  it("agentRuntimeOverride wins over the file value", () => {
    const path = tempConfig(VALID_YAML);
    const cfg = loadColonyConfig({
      path,
      env: { ANTHROPIC_API_KEY: "x" },
      agentRuntimeOverride: "fake",
    });
    expect(cfg.agentRuntime).toBe("fake");
  });

  it("throws FILE_NOT_FOUND for a missing file", () => {
    expect(() =>
      loadColonyConfig({ path: "/no/such/path/colony.yaml" }),
    ).toThrow(ColonyConfigError);
  });

  it("defaults sandbox engine to in-process when no sandbox block", () => {
    const cfg = loadColonyConfig({ path: tempConfig(VALID_YAML) });
    expect(cfg.sandbox.engine).toBe("in-process");
  });

  it("round-trips an explicit sandbox engine value", () => {
    const cfg = loadColonyConfig({
      path: tempConfig(`sandbox: { engine: "in-process" }
${VALID_YAML}`),
    });
    expect(cfg.sandbox.engine).toBe("in-process");
  });

  it("honors the sandboxEngineOverride", () => {
    const cfg = loadColonyConfig({
      path: tempConfig(VALID_YAML),
      sandboxEngineOverride: "in-process",
    });
    expect(cfg.sandbox.engine).toBe("in-process");
  });

  it("rejects an unknown sandbox engine", () => {
    expect(() =>
      loadColonyConfig({
        path: tempConfig(`sandbox: { engine: "nomad" }
${VALID_YAML}`),
      }),
    ).toThrow(/validation failed/);
  });

  it("rejects an unknown sandboxEngineOverride", () => {
    try {
      loadColonyConfig({
        path: tempConfig(VALID_YAML),
        sandboxEngineOverride: "nomad" as never,
      });
      throw new Error("expected override validation to fail");
    } catch (e) {
      const err = e as ColonyConfigError;
      expect(err).toBeInstanceOf(ColonyConfigError);
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toMatch(/sandbox engine override/);
    }
  });

  it("accepts the kubernetes sandbox engine", () => {
    const cfg = loadColonyConfig({
      path: tempConfig(`sandbox: { engine: "kubernetes" }
${VALID_YAML}`),
    });
    expect(cfg.sandbox.engine).toBe("kubernetes");
  });

  it("round-trips the kubernetes sandbox config block", () => {
    const cfg = loadColonyConfig({
      path: tempConfig(`sandbox:
  engine: kubernetes
  kubernetes:
    namespace: custom-ns
    image: img:tag
    api_version_override: v1beta1
${VALID_YAML}`),
    });
    expect(cfg.sandbox.engine).toBe("kubernetes");
    expect(cfg.sandbox.kubernetes.namespace).toBe("custom-ns");
    expect(cfg.sandbox.kubernetes.image).toBe("img:tag");
    expect(cfg.sandbox.kubernetes.api_version_override).toBe("v1beta1");
  });

  it("defaults sandbox.kubernetes when the block is absent", () => {
    const cfg = loadColonyConfig({ path: tempConfig(VALID_YAML) });
    expect(cfg.sandbox.engine).toBe("in-process");
    expect(cfg.sandbox.kubernetes.namespace).toBe("colony-sandboxes");
    expect(cfg.sandbox.kubernetes.image).toBe(
      "registry.gitlab.home.shdr.ch/so/colony/sandbox:latest",
    );
    expect(cfg.sandbox.kubernetes.api_version_override).toBeUndefined();
  });

  it("rejects an unknown key inside sandbox.kubernetes", () => {
    expect(() =>
      loadColonyConfig({
        path: tempConfig(`sandbox:
  engine: kubernetes
  kubernetes: { foo: bar }
${VALID_YAML}`),
      }),
    ).toThrow(/validation failed/);
  });

  it("parses COLONY_SEARXNG_URL as optional non-empty (unset → undefined)", () => {
    const prev = process.env["COLONY_SEARXNG_URL"];
    try {
      delete process.env["COLONY_SEARXNG_URL"];
      resetEnvCache();
      expect(env().COLONY_SEARXNG_URL).toBeUndefined();
      process.env["COLONY_SEARXNG_URL"] = "";
      resetEnvCache();
      expect(env().COLONY_SEARXNG_URL).toBeUndefined();
      process.env["COLONY_SEARXNG_URL"] = "   ";
      resetEnvCache();
      expect(env().COLONY_SEARXNG_URL).toBeUndefined();
      process.env["COLONY_SEARXNG_URL"] = "https://searxng.home.shdr.ch";
      resetEnvCache();
      expect(env().COLONY_SEARXNG_URL).toBe("https://searxng.home.shdr.ch");
    } finally {
      if (prev === undefined) delete process.env["COLONY_SEARXNG_URL"];
      else process.env["COLONY_SEARXNG_URL"] = prev;
      resetEnvCache();
    }
  });
});
