import { describe, expect, it } from "bun:test";
import { describeEngineTests } from "@colony/sandbox-tests";
import { createInProcessEngine } from "./in-process-engine.js";

// The in-process engine is a compatibility engine, not a security boundary:
// it rejects escaping paths at the handle API but cannot confine what a
// spawned shell reads. Real exec isolation belongs to containerized engines.
describeEngineTests("in-process", () => createInProcessEngine(), {
  enforcesExecIsolation: false,
});

describe("in-process engine connect cross-instance and rejection", () => {
  it("connects to the identical live handle from a different engine instance", async () => {
    const engine1 = createInProcessEngine();
    const engine2 = createInProcessEngine();

    const handle = await engine1.provision(
      { envAllowlist: [] } as never,
      "/tmp",
    );
    expect(handle.sandboxId).toBeString();

    const connected = await engine2.connect(handle.sandboxId);
    expect(connected).toBe(handle);

    await handle.destroy();
  });

  it("rejects unknown sandbox ids with 'sandbox not found: <id>'", async () => {
    const engine = createInProcessEngine();
    await expect(engine.connect("unknown-id-123")).rejects.toThrow(
      "sandbox not found: unknown-id-123",
    );
  });
});
