import { describe, expect, it } from "vitest";
import { createInProcessEngine } from "@colony/sandbox-in-process";
import { createEngine, ENGINE_REGISTRY } from "../src/agent-runtime.js";
import { DEFAULT_KUBERNETES_SANDBOX, type ColonyConfig } from "@colony/config";

function stubConfig(): ColonyConfig {
  return {
    agentRuntime: "pi",
    sandbox: {
      engine: "in-process",
      kubernetes: DEFAULT_KUBERNETES_SANDBOX,
    },
    hitlMode: "gated",
    reviewMode: "off",
    oauthProviderKeys: [],
    forAgent: () => {
      throw new Error("stub forAgent not used");
    },
    getProvider: () => null,
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
