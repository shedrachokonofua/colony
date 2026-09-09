import { describe, expect, it } from "bun:test";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createSubagentTool, type SubagentRequest } from "./subagent-tool.js";

const taskParams = {
  description: "exercise child budget",
  prompt: "Complete the delegated test task.",
};

function executeTask(tool: ToolDefinition, id: string, signal?: AbortSignal) {
  return tool.execute(id, taskParams, signal, undefined, undefined as never);
}

describe("subagent delegation budgets", () => {
  it("cancels queued work and never starts it after the parent aborts", async () => {
    const running = Array.from({ length: 3 }, () =>
      Promise.withResolvers<string>(),
    );
    let spawnCount = 0;
    const tool = createSubagentTool(
      async (_request: SubagentRequest) => {
        const slot = spawnCount++;
        return running[slot]!.promise;
      },
      { deadline: Date.now() + 1_000, timeoutMs: 1_000 },
    );

    const firstThree = [0, 1, 2].map((index) =>
      executeTask(tool, `running-${index}`),
    );
    const queuedController = new AbortController();
    const queued = executeTask(tool, "queued", queuedController.signal);
    queuedController.abort();
    await expect(queued).rejects.toThrow(Error);

    await Promise.resolve();
    await Promise.resolve();
    expect(spawnCount).toBe(3);

    for (const child of running) child.resolve("finished");
    await Promise.all(firstThree);
    expect(spawnCount).toBe(3);
  });

  it("releases timed-out active work even when the spawner ignores cancellation", async () => {
    // This uses the platform timer intentionally: it exercises the actual
    // deadline cancellation path while the spawner ignores the signal.
    const childSignals: AbortSignal[] = [];
    let spawnCount = 0;
    const tool = createSubagentTool(
      async ({ signal }: SubagentRequest) => {
        childSignals.push(signal);
        if (spawnCount++ < 3) return Promise.withResolvers<string>().promise;
        return "success";
      },
      { deadline: Date.now() + 1_000, timeoutMs: 40 },
    );

    const active = [0, 1, 2].map((index) =>
      executeTask(tool, `hanging-${index}`),
    );
    const successor = executeTask(tool, "successor");
    const results = await Promise.allSettled([...active, successor]);

    expect(results.slice(0, 3).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(results[3]!.status).toBe("fulfilled");
    expect(spawnCount).toBe(4);
    expect(childSignals).toHaveLength(4);
    expect(childSignals.slice(0, 3).every((signal) => signal.aborted)).toBe(
      true,
    );
  });

  it("rejects queued and new work when the shared delegation window closes", async () => {
    let spawned = 0;
    const tool = createSubagentTool(
      () => {
        spawned += 1;
        return Promise.withResolvers<string>().promise;
      },
      { deadline: Date.now() + 40, timeoutMs: 1_000 },
    );
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) => executeTask(tool, `cutoff-${i}`)),
    );
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    await expect(executeTask(tool, "after-cutoff")).rejects.toThrow(Error);
    expect(spawned).toBe(3);
  });

  it("does not start a child canceled immediately after admission", async () => {
    let spawned = false;
    const tool = createSubagentTool(
      async () => {
        spawned = true;
        return "must not execute";
      },
      { deadline: Date.now() + 1_000, timeoutMs: 1_000 },
    );
    const parent = new AbortController();
    const result = executeTask(tool, "admission-race", parent.signal);
    parent.abort();
    await expect(result).rejects.toThrow(Error);
    expect(spawned).toBe(false);
  });
});
