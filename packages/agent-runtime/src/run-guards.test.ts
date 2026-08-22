import { describe, expect, it } from "bun:test";

import {
  installRunGuards,
  LIVENESS_FAILURE_REASON,
} from "./pi-runner-common.js";

type AgentEvent = { type: string; [key: string]: unknown };

/** Minimal Agent seam: subscribe + abort, driven manually by the test. */
function fakeAgent() {
  const listeners = new Set<(e: AgentEvent) => void>();
  let aborted = 0;
  return {
    subscribe(fn: (e: AgentEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    abort() {
      aborted += 1;
    },
    emit(event: AgentEvent) {
      for (const fn of listeners) fn(event);
    },
    get aborted() {
      return aborted;
    },
  };
}

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

describe("liveness watchdog", () => {
  it("aborts a silent run with no tool in flight", async () => {
    const agent = fakeAgent();
    const failures: string[] = [];
    const unsubscribe = installRunGuards(agent as never, "run-1", {
      livenessTimeoutMs: 30,
      onFailure: (reason) => failures.push(reason),
    });
    await sleep(60);
    unsubscribe();
    expect(failures).toEqual([LIVENESS_FAILURE_REASON]);
    expect(agent.aborted).toBe(1);
  });

  it("treats every agent event as a heartbeat", async () => {
    const agent = fakeAgent();
    const failures: string[] = [];
    const unsubscribe = installRunGuards(agent as never, "run-2", {
      livenessTimeoutMs: 40,
      onFailure: (reason) => failures.push(reason),
    });
    for (let i = 0; i < 4; i += 1) {
      await sleep(20);
      agent.emit({ type: "message_update" });
    }
    expect(failures).toEqual([]);
    expect(agent.aborted).toBe(0);
    unsubscribe();
  });

  it("spares silence while a tool call is in flight, then re-polices", async () => {
    const agent = fakeAgent();
    const failures: string[] = [];
    const unsubscribe = installRunGuards(agent as never, "run-3", {
      livenessTimeoutMs: 30,
      onFailure: (reason) => failures.push(reason),
    });
    agent.emit({ type: "tool_execution_start", toolCallId: "t1" });
    // Quiet tool run longer than the liveness budget: engine deadlines own
    // this window, so the watchdog must not kill the run.
    await sleep(70);
    expect(failures).toEqual([]);
    agent.emit({ type: "tool_execution_end", toolCallId: "t1" });
    // After the tool completes, silence is the agent's own again.
    await sleep(60);
    unsubscribe();
    expect(failures).toEqual([LIVENESS_FAILURE_REASON]);
    expect(agent.aborted).toBe(1);
  });

  it("stops policing once unsubscribed", async () => {
    const agent = fakeAgent();
    const failures: string[] = [];
    const unsubscribe = installRunGuards(agent as never, "run-4", {
      livenessTimeoutMs: 20,
      onFailure: (reason) => failures.push(reason),
    });
    unsubscribe();
    await sleep(50);
    expect(failures).toEqual([]);
    expect(agent.aborted).toBe(0);
  });
});

describe("zero-output stall", () => {
  const msg = (agent: ReturnType<typeof fakeAgent>, output: number) =>
    agent.emit({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { output, input: 10, cost: { total: 0 } },
      },
    } as never);

  it("fires after N consecutive empty assistant messages without aborting", () => {
    const agent = fakeAgent();
    let stalled = 0;
    installRunGuards(agent as never, "run-zo", {
      zeroOutputStallTurns: 3,
      livenessTimeoutMs: 0,
      onZeroOutputStall: () => {
        stalled += 1;
      },
    });
    msg(agent, 0);
    msg(agent, 0);
    expect(stalled).toBe(0);
    msg(agent, 0);
    expect(stalled).toBe(1);
    // Flag-only: aborting a live session poisons the replayed conversation.
    expect(agent.aborted).toBe(0);
  });

  it("tool activity and real output reset the stall counter", () => {
    const agent = fakeAgent();
    let stalled = 0;
    installRunGuards(agent as never, "run-zo2", {
      zeroOutputStallTurns: 3,
      livenessTimeoutMs: 0,
      onZeroOutputStall: () => {
        stalled += 1;
      },
    });
    msg(agent, 0);
    msg(agent, 0);
    agent.emit({ type: "tool_execution_start" } as never);
    agent.emit({ type: "tool_execution_end" } as never);
    msg(agent, 0);
    msg(agent, 0);
    expect(stalled).toBe(0);
    msg(agent, 50);
    msg(agent, 0);
    msg(agent, 0);
    expect(stalled).toBe(0);
    expect(agent.aborted).toBe(0);
  });
});
