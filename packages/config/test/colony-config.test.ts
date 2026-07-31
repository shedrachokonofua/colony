import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ColonyConfigError, loadColonyConfig } from "../src/colony-config.js";

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
    max_usd_per_run: 1
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
    expect(dev.ceilings.maxUsdPerRun).toBe(1);
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
});
