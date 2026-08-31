import { afterEach, describe, expect, it, jest } from "bun:test";

import {
  installWorkspaceProbe,
  type WorkspaceProbeHandle,
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

/** Fire one probe tick and drain the async probe body. */
async function tick(): Promise<void> {
  jest.advanceTimersByTime(10);
  // The interval body is fire-and-forget async; a few microtask turns let
  // the exec promise and the post-exec bookkeeping settle.
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
});

describe("workspace probe", () => {
  it("fires onLost exactly once after two consecutive completed misses", async () => {
    jest.useFakeTimers();
    const { handle } = probeWith([1, 1, 1]);
    let lost = 0;
    const cancel = installWorkspaceProbe(handle, {
      intervalMs: 10,
      runId: "r",
      sandboxId: "s",
      onLost: () => {
        lost += 1;
      },
    });
    try {
      await tick();
      expect(lost).toBe(0);
      await tick();
      expect(lost).toBe(1);
      await tick();
      expect(lost).toBe(1);
    } finally {
      cancel();
    }
  });

  it("never fires on thrown execs: transport failure is not evidence", async () => {
    jest.useFakeTimers();
    const { handle, calls } = probeWith(["throw"]);
    let lost = 0;
    const warns: string[] = [];
    const cancel = installWorkspaceProbe(handle, {
      intervalMs: 10,
      runId: "r",
      sandboxId: "s",
      logger: { warn: (_f, msg) => warns.push(msg) },
      onLost: () => {
        lost += 1;
      },
    });
    try {
      for (let i = 0; i < 5; i += 1) await tick();
      expect(calls()).toBeGreaterThanOrEqual(5);
      expect(lost).toBe(0);
      expect(warns).toContain("workspace_probe_error");
    } finally {
      cancel();
    }
  });

  it("a healthy probe resets the miss counter", async () => {
    jest.useFakeTimers();
    const { handle } = probeWith([1, 0, 1, 0, 1, 0]);
    let lost = 0;
    const cancel = installWorkspaceProbe(handle, {
      intervalMs: 10,
      runId: "r",
      sandboxId: "s",
      onLost: () => {
        lost += 1;
      },
    });
    try {
      for (let i = 0; i < 6; i += 1) await tick();
      expect(lost).toBe(0);
    } finally {
      cancel();
    }
  });

  it("timed-out execs (exitCode null) are not evidence", async () => {
    jest.useFakeTimers();
    const { handle } = probeWith([null, null, null, null]);
    let lost = 0;
    const cancel = installWorkspaceProbe(handle, {
      intervalMs: 10,
      runId: "r",
      sandboxId: "s",
      onLost: () => {
        lost += 1;
      },
    });
    try {
      for (let i = 0; i < 4; i += 1) await tick();
      expect(lost).toBe(0);
    } finally {
      cancel();
    }
  });

  it("cancel stops probing", async () => {
    jest.useFakeTimers();
    const { handle, calls } = probeWith([0]);
    const cancel = installWorkspaceProbe(handle, {
      intervalMs: 10,
      runId: "r",
      sandboxId: "s",
      onLost: () => {},
    });
    await tick();
    expect(calls()).toBe(1);
    cancel();
    await tick();
    await tick();
    expect(calls()).toBe(1);
  });
});
