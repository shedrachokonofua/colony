import { describe, expect, it } from "bun:test";
import { appWithStore, scopeWithTasks, advanceTask } from "./project-running.test.js";
import type { Run } from "@colony/core";

describe("GET /projects/:name/failures and run.fault serialization", () => {
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
      fault: { layer: "provider", code: "rate_limit", detail: "429 too many requests" },
    });

    // Check GET /tasks/:id
    const taskRes = await app.request(`/tasks/${task_id}`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(taskRes.status).toBe(200);
    const taskBody = await taskRes.json();
    expect(taskBody.runs[0].fault).toEqual({
      layer: "provider",
      code: "rate_limit",
      detail: "429 too many requests",
    });

    // Check GET /scopes/:id
    const scopeRes = await app.request(`/scopes/${scope_id}`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(scopeRes.status).toBe(200);
    const scopeBody = await scopeRes.json();
    expect(scopeBody.runs[0].fault).toEqual({
      layer: "provider",
      code: "rate_limit",
      detail: "429 too many requests",
    });

    // Check GET /runs/:id
    const runRes = await app.request(`/runs/${run.id}`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(runRes.status).toBe(200);
    const runBody = await runRes.json();
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
    const runningBody = await runningRes.json();
    expect(runningBody[0].run.fault).toBeNull();
  });

  it("GET /projects/:name/failures returns paginated failures and census counts", async () => {
    const { store, app } = appWithStore();
    const { scope_id, task_ids } = scopeWithTasks(store, "census-proj", ["T1", "T2"]);

    // Run 1: provider failure
    const r1 = store.startRun({ scope_id, task_id: task_ids[0]!, kind: "implement", lease_ttl_ms: 60_000 });
    store.finishRun(r1.id, "failed", {
      fault: { layer: "provider", code: "rate_limit" },
    });

    // Run 2: model failure
    const r2 = store.startRun({ scope_id, task_id: task_ids[1]!, kind: "implement", lease_ttl_ms: 60_000 });
    store.finishRun(r2.id, "failed", {
      fault: { layer: "model", code: "syntax_error" },
    });

    // Run 3: colonyd failure
    const r3 = store.startRun({ scope_id, kind: "architect", lease_ttl_ms: 60_000 });
    store.finishRun(r3.id, "failed", {
      fault: { layer: "colonyd", code: "process_restart" },
    });

    // Run 4: succeeded run (should not be counted in failures)
    const r4 = store.startRun({ scope_id, kind: "architect", lease_ttl_ms: 60_000 });
    store.finishRun(r4.id, "succeeded");

    const res = await app.request(`/projects/census-proj/failures?limit=2&offset=0`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.items).toHaveLength(2);
    expect(body.counts).toEqual({
      model: 1,
      harness: 0,
      sandbox: 0,
      provider: 1,
      colonyd: 1,
      unknown: 0,
    });
    expect(body.items[0]).toHaveProperty("runId");
    expect(body.items[0]).toHaveProperty("layer");
    expect(body.items[0]).toHaveProperty("code");
    expect(body.items[0]).toHaveProperty("at");
  });
});
