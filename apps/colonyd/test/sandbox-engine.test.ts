import { describe, expect, it } from "vitest";
import { createInProcessEngine } from "@colony/sandbox-in-process";
import { createEngine, ENGINE_REGISTRY } from "../src/agent-runtime.js";

describe("colonyd sandbox engine registry", () => {
  it("maps the in-process engine name to createInProcessEngine", async () => {
    expect(ENGINE_REGISTRY["in-process"]).toBeTypeOf("function");

    const engineFromFactory = await ENGINE_REGISTRY["in-process"]();
    // The registry resolves to the shared createInProcessEngine factory.
    expect(engineFromFactory).toBe(createInProcessEngine);

    const engine = await createEngine("in-process");
    expect(typeof engine.provision).toBe("function");
  });

  it("throws on an unknown sandbox engine name", async () => {
    await expect(createEngine("kubernetes")).rejects.toThrow(
      /unknown sandbox engine: kubernetes/,
    );
  });
});
