import { describe, expect, it } from "bun:test";

import {
  workspaceProbeStep,
  type WorkspaceProbeHandle,
  type WorkspaceProbeOptions,
  type WorkspaceProbeState,
} from "./pi-runner-common.js";

function probeWith(exitCodes: Array<number | null | "throw">): {
  handle: WorkspaceProbeHandle;
  calls: () => number;
} {
  let i = 0;
  return {
    handle: {
      async exec() {
        const step = exitCodes[Math.min(i, exitCodes.length - 1)]!;
        i += 1;
        if (step === "throw") throw new Error("transport down");
        return { exitCode: step };
      },
    },
    calls: () => i,
  };
}

function harness(): {
  state: WorkspaceProbeState;
  options: WorkspaceProbeOptions;
  lost: () => number;
  warns: string[];
} {
  let lost = 0;
  const warns: string[] = [];
  return {
    state: { misses: 0, fired: false },
    options: {
      runId: "r",
      sandboxId: "s",
      logger: { warn: (_f, msg) => warns.push(msg) },
      onLost: () => {
        lost += 1;
      },
    },
    lost: () => lost,
    warns,
  };
}

describe("workspace probe", () => {
  it("fires onLost exactly once after two consecutive completed misses", async () => {
    const { handle } = probeWith([1, 1, 1]);
    const h = harness();
    expect(await workspaceProbeStep(handle, h.state, h.options)).toBe(false);
    expect(h.lost()).toBe(0);
    expect(await workspaceProbeStep(handle, h.state, h.options)).toBe(true);
    expect(h.lost()).toBe(1);
    // A fired probe is inert: no further exec, no second onLost.
    expect(await workspaceProbeStep(handle, h.state, h.options)).toBe(false);
    expect(h.lost()).toBe(1);
  });

  it("a streak of thrown execs is a dead pod: fires on the third consecutive throw", async () => {
    // A reaped pod makes exec THROW, not exit non-zero. Treating throws as
    // nothing let runs generate against gone sandboxes for 26+ minutes
    // (2026-09-01, 13 consecutive probe errors each).
    const { handle } = probeWith(["throw", "throw", "throw", "throw"]);
    const h = harness();
    expect(await workspaceProbeStep(handle, h.state, h.options)).toBe(false);
    expect(await workspaceProbeStep(handle, h.state, h.options)).toBe(false);
    expect(h.lost()).toBe(0);
    expect(await workspaceProbeStep(handle, h.state, h.options)).toBe(true);
    expect(h.lost()).toBe(1);
    expect(await workspaceProbeStep(handle, h.state, h.options)).toBe(false);
    expect(h.lost()).toBe(1);
    expect(h.warns).toContain("workspace_probe_error");
  });

  it("a single thrown exec between healthy probes is a blip, not evidence", async () => {
    const { handle } = probeWith(["throw", 0, "throw", 0, "throw", 0]);
    const h = harness();
    for (let i = 0; i < 6; i += 1) {
      await workspaceProbeStep(handle, h.state, h.options);
    }
    expect(h.lost()).toBe(0);
    expect(h.state.misses).toBe(0);
  });

  it("a healthy probe resets the miss counter", async () => {
    const { handle } = probeWith([1, 0, 1, 0, 1, 0]);
    const h = harness();
    for (let i = 0; i < 6; i += 1) {
      await workspaceProbeStep(handle, h.state, h.options);
    }
    expect(h.lost()).toBe(0);
    expect(h.state.misses).toBe(0);
  });

  it("timed-out execs (exitCode null) are not evidence", async () => {
    const { handle } = probeWith([null, null, null, null]);
    const h = harness();
    for (let i = 0; i < 4; i += 1) {
      await workspaceProbeStep(handle, h.state, h.options);
    }
    expect(h.lost()).toBe(0);
    expect(h.state.misses).toBe(0);
  });

  it("a transport error between misses does not bridge them into a loss", async () => {
    const { handle } = probeWith([1, "throw", 1, "throw"]);
    const h = harness();
    for (let i = 0; i < 4; i += 1) {
      await workspaceProbeStep(handle, h.state, h.options);
    }
    // Errors count as misses too now; two completed misses with one error
    // between them is a loss either way.
    expect(h.lost()).toBe(1);
  });

  it("fired state stops probing entirely", async () => {
    const { handle, calls } = probeWith([1, 1, 0]);
    const h = harness();
    await workspaceProbeStep(handle, h.state, h.options);
    await workspaceProbeStep(handle, h.state, h.options);
    expect(h.state.fired).toBe(true);
    const after = calls();
    await workspaceProbeStep(handle, h.state, h.options);
    expect(calls()).toBe(after);
  });
});
