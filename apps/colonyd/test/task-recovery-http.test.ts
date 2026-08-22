import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Store } from "@colony/core";
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";
import { trackRun } from "../src/runs/registry.js";

const dirs: string[] = [];
const stores: Store[] = [];

const plan: ArchitectDecompositionV2 = {
  kind: "architect_decomposition",
  summary: "one recovery task",
  acceptance: [{ description: "recovery plan goal", command: "true" }],
  tasks: [{ title: "Recover me", spec: "finish the work", depends_on: [] }],
};

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function recoveryApp() {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-recovery-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  let ticks = 0;
  const ctx: ColonydContext = {
    store,
    provider: {} as ColonydContext["provider"],
    config: {
      reviewMode: "required",
      hitlMode: "yolo",
    } as ColonydContext["config"],
    agents: {} as ColonydContext["agents"],
    logger: { info() {}, warn() {}, error() {} },
    env: {
      gitlabBaseUrl: "https://gitlab.test",
      gitlabToken: "",
      webhookSecret: "",
      singleToken: true,
      maxConcurrent: 1,
      maxAttempts: 3,
      oidcIssuer: "",
      oidcClientId: "colony",
      oidcRequiredRole: "",
    },
    requestTick() {
      ticks += 1;
    },
  };
  const scope = store.createScope({
    goal: "exercise task recovery",
    provider_repo_id: "49",
    provider_repo_path: "so/colony",
  });
  store.setScopeStatus(scope.id, "planning", "svc:colonyd");
  const [task] = store.materializePlan(scope.id, plan, "svc:colonyd");
  return {
    app: buildApp(ctx),
    store,
    scope,
    task: task!,
    tickCount: () => ticks,
  };
}

const actorHeaders = { "X-Actor-Id": "human:operator" };

describe("task recovery API", () => {
  it("stops the active run before requeueing without consuming an attempt", async () => {
    const { app, store, task, tickCount } = recoveryApp();
    const running = store.transitionTask(
      task.id,
      task.state_version,
      "running",
      "svc:colonyd",
      { attempt: 2 },
    );
    const run = store.startRun({
      scope_id: task.scope_id,
      task_id: task.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    let settle!: () => void;
    const execution = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let stateSeenByAbort = "";
    trackRun(run.id, execution, () => {
      stateSeenByAbort = store.getTask(task.id)!.state;
      store.finishRun(run.id, "canceled", { error: "aborted" });
      settle();
    });

    const response = await app.request(`/tasks/${task.id}/stop`, {
      method: "POST",
      headers: actorHeaders,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: task.id,
      state: "queued",
      attempt: running.attempt,
      next_retry_at: null,
      blocked_reason: null,
    });
    expect(stateSeenByAbort).toBe("running");
    expect(store.getRun(run.id)).toMatchObject({
      status: "canceled",
      error: "aborted",
    });
    expect(tickCount()).toBe(1);
    expect(
      store
        .listAudit({ scope_id: task.scope_id })
        .some(
          (row) =>
            row.actor === "human:operator" &&
            row.action === "task.stop_and_retry",
        ),
    ).toBe(true);
  });

  it("refuses to requeue a run owned by another process", async () => {
    const { app, store, task, tickCount } = recoveryApp();
    const running = store.transitionTask(
      task.id,
      task.state_version,
      "running",
      "svc:colonyd",
    );
    store.startRun({
      scope_id: task.scope_id,
      task_id: task.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });

    const response = await app.request(`/tasks/${task.id}/stop`, {
      method: "POST",
      headers: actorHeaders,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RUN_NOT_LOCAL" },
    });
    expect(store.getTask(task.id)).toMatchObject({
      state: "running",
      state_version: running.state_version,
    });
    expect(tickCount()).toBe(0);
  });

  it("restores a canceled task and reactivates its completed scope", async () => {
    const { app, store, scope, task, tickCount } = recoveryApp();
    const canceled = store.transitionTask(
      task.id,
      task.state_version,
      "canceled",
      "human:operator",
      {
        attempt: 2,
        next_retry_at: new Date(Date.now() + 60_000).toISOString(),
        blocked_reason: "stale failure",
      },
    );
    store.setScopeStatus(scope.id, "done", "svc:colonyd");

    const response = await app.request(`/tasks/${task.id}/restore`, {
      method: "POST",
      headers: actorHeaders,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: task.id,
      state: "queued",
      state_version: canceled.state_version + 1,
      attempt: 0,
      next_retry_at: null,
      blocked_reason: null,
    });
    expect(store.getScope(scope.id)).toMatchObject({
      status: "active",
      blocked_reason: null,
    });
    expect(store.readyTasks(scope.id).map((ready) => ready.id)).toEqual([
      task.id,
    ]);
    expect(tickCount()).toBe(1);
  });

  it("does not restore tasks inside an abandoned scope", async () => {
    const { app, store, scope, task, tickCount } = recoveryApp();
    store.transitionTask(
      task.id,
      task.state_version,
      "canceled",
      "human:operator",
    );
    store.setScopeStatus(scope.id, "abandoned", "human:operator");

    const response = await app.request(`/tasks/${task.id}/restore`, {
      method: "POST",
      headers: actorHeaders,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SCOPE_ABANDONED" },
    });
    expect(store.getTask(task.id)!.state).toBe("canceled");
    expect(tickCount()).toBe(0);
  });
});
