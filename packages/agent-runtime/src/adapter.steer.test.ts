/**
 * The steerRun adapter contract: deliver an operator message to a live run
 * when the runtime has a steering channel, and report — never throw — when
 * it cannot, so colonyd can abort and requeue instead. Covers the Pi
 * adapter's runner delegation and the fake runtime's no-op default.
 */
import { describe, expect, it } from "bun:test";
import {
  FakeAgentRuntimeAdapter,
  type AgentRunMetadata,
  type AgentRuntimePacket,
} from "./adapter.js";
import {
  PiAgentRuntimeAdapter,
  type PiRunResult,
  type PiRunner,
} from "./pi-adapter.js";

const PACKET: AgentRuntimePacket = {
  goal: "ship the change",
  task_id: "c-1.1",
};

function completedRun(sandboxId: string): PiRunResult {
  return {
    sandboxId,
    envelope: {
      kind: "implementer_completion",
      status: "complete",
      summary: "done",
      branch: "colony/c-1.1",
      head_sha: "a".repeat(40),
      commands: [{ cmd: "true", exit_code: 0 }],
    },
  };
}

describe("PiAgentRuntimeAdapter.steerRun", () => {
  it("reports unsupported when the runner has no steering channel", async () => {
    const stalled = Promise.withResolvers<PiRunResult>();
    const inner: PiRunner = {
      kind: "pi-coding-agent",
      run: () => stalled.promise,
    };
    const adapter = new PiAgentRuntimeAdapter(inner);
    const running: Promise<AgentRunMetadata> = adapter.startRun(PACKET, {
      role: "developer",
      runId: "run-1",
    });
    expect(await adapter.steerRun("run-1", "amendment")).toEqual({
      delivered: false,
      reason: "unsupported",
    });
    stalled.resolve(completedRun("sandbox-1"));
    await running;
  });

  it("reports not_running when no live run owns the id", async () => {
    const inner: PiRunner = {
      kind: "pi-coding-agent",
      run: () => Promise.resolve(completedRun("sandbox-1")),
      steer: () => true,
    };
    const adapter = new PiAgentRuntimeAdapter(inner);
    expect(await adapter.steerRun("ghost", "amendment")).toEqual({
      delivered: false,
      reason: "not_running",
    });
    // A finished run is as dead as a missing one.
    await adapter.startRun(PACKET, { role: "developer", runId: "run-1" });
    expect(await adapter.steerRun("run-1", "amendment")).toEqual({
      delivered: false,
      reason: "not_running",
    });
  });

  it("delivers the message to a live run through the runner's steer", async () => {
    const stalled = Promise.withResolvers<PiRunResult>();
    const steered: [string, string][] = [];
    const inner: PiRunner = {
      kind: "pi-coding-agent",
      run: () => stalled.promise,
      steer: (runId, message) => {
        steered.push([runId, message]);
        return true;
      },
    };
    const adapter = new PiAgentRuntimeAdapter(inner);
    const running: Promise<AgentRunMetadata> = adapter.startRun(PACKET, {
      role: "developer",
      runId: "run-1",
    });
    expect(
      await adapter.steerRun("run-1", "operator amended the spec"),
    ).toEqual({ delivered: true });
    expect(steered).toEqual([["run-1", "operator amended the spec"]]);
    stalled.resolve(completedRun("sandbox-1"));
    await running;
  });

  it("reports failed when the runner's steer throws", async () => {
    const stalled = Promise.withResolvers<PiRunResult>();
    const inner: PiRunner = {
      kind: "pi-coding-agent",
      run: () => stalled.promise,
      steer: () => {
        throw new Error("steer channel broken");
      },
    };
    const adapter = new PiAgentRuntimeAdapter(inner);
    const running: Promise<AgentRunMetadata> = adapter.startRun(PACKET, {
      role: "developer",
      runId: "run-1",
    });
    expect(await adapter.steerRun("run-1", "amendment")).toEqual({
      delivered: false,
      reason: "failed",
    });
    stalled.resolve(completedRun("sandbox-1"));
    await running;
  });
});

describe("FakeAgentRuntimeAdapter.steerRun", () => {
  it("is the unsupported no-op without a steerForRun seam", async () => {
    const adapter = new FakeAgentRuntimeAdapter();
    expect(await adapter.steerRun("run-1", "amendment")).toEqual({
      delivered: false,
      reason: "unsupported",
    });
  });

  it("delivers through steerForRun when a test wires one", async () => {
    const seen: [string, string][] = [];
    const adapter = new FakeAgentRuntimeAdapter({
      steerForRun: (runId, message) => {
        seen.push([runId, message]);
      },
    });
    expect(await adapter.steerRun("run-1", "amendment")).toEqual({
      delivered: true,
    });
    expect(seen).toEqual([["run-1", "amendment"]]);
  });

  it("reports failed when the seam throws, keeping the never-throws contract", async () => {
    const adapter = new FakeAgentRuntimeAdapter({
      steerForRun: () => {
        throw new Error("seam broken");
      },
    });
    expect(await adapter.steerRun("run-1", "amendment")).toEqual({
      delivered: false,
      reason: "failed",
    });
  });
});
