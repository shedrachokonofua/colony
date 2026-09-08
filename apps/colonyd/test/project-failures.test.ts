import { describe, expect, it } from "bun:test";
import {
  appWithStore,
  scopeWithTasks,
  advanceTask,
} from "./project-running.test.js";
import type { Run } from "@colony/core";

describe("run.fault serialization", () => {
  it("includes parsed fault or null in GET /tasks/:id, /scopes/:id, /runs/:id, /projects/:name/running", async () => {
    const { store, app } = appWithStore();
    const { scope_id, task_ids } = scopeWithTasks(store, "p-fault", ["Task-1"]);
    const task_id = task_ids[0]!;

    const run = store.startRun({
      scope_id,
      task_id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });

    store.finishRun(run.id, "failed", {
      error: "rate limited",
      fault: {
        layer: "provider",
        code: "rate_limit",
        detail: "429 too many requests",
      },
    });

    // Check GET /tasks/:id
    const taskRes = await app.request(`/tasks/${task_id}`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(taskRes.status).toBe(200);
    const taskBody = (await taskRes.json()) as {
      runs: Array<{ fault: unknown }>;
    };
    expect(taskBody.runs[0]!.fault).toEqual({
      layer: "provider",
      code: "rate_limit",
      detail: "429 too many requests",
    });

    // Check GET /scopes/:id
    const scopeRes = await app.request(`/scopes/${scope_id}`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(scopeRes.status).toBe(200);
    const scopeBody = (await scopeRes.json()) as {
      runs: Array<{ fault: unknown }>;
    };
    expect(scopeBody.runs[0]!.fault).toEqual({
      layer: "provider",
      code: "rate_limit",
      detail: "429 too many requests",
    });

    // Check GET /runs/:id
    const runRes = await app.request(`/runs/${run.id}`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { fault: unknown };
    expect(runBody.fault).toEqual({
      layer: "provider",
      code: "rate_limit",
      detail: "429 too many requests",
    });

    // Check GET /projects/:name/running with an in-flight task
    advanceTask(store, task_id, "running");
    const activeRun = store.startRun({
      scope_id,
      task_id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    const runningRes = await app.request(`/projects/p-fault/running`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(runningRes.status).toBe(200);
    const runningBody = (await runningRes.json()) as Array<{
      run: { fault: unknown };
    }>;
    expect(runningBody[0]!.run.fault).toBeNull();
  });
});
