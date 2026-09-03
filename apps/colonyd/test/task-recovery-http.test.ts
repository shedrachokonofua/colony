import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Store } from "@colony/core";
import { createLocalArtifactStore } from "@colony/core";
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";
import { trackRun } from "../src/runs/registry.js";

const dirs: string[] = [];
const stores: Store[] = [];

const plan: ArchitectDecompositionV2 = {
  kind: "architect_decomposition",
  summary: "one recovery task",
  requirements: [{ id: "R1", text: "recovery plan goal", tasks: [0] }],
  journey: [{ after_task: 0, working_state: "recovery plan goal" }],
  acceptance: [{ description: "recovery plan goal", command: "true" }],
  tasks: [
    {
      title: "Recover me",
      spec: "finish the work",
      depends_on: [],
      files: ["src/recovery.ts"],
      evidence: ["true"],
    },
  ],
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
    artifacts: createLocalArtifactStore(
      mkdtempSync(join(tmpdir(), "colonyd-artifacts-")),
    ),
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
      traceUiBaseUrl: "",
      consoleBaseUrl: "",
    },
    draining: { isDraining: () => false },
    requestTick() {
      ticks += 1;
    },
  };
  const scope = store.createScope({
    goal: "exercise task recovery",
    title: "exercise task recovery",
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
        .events.some(
          (row) =>
            row.actor === "human:operator" &&
            row.action === "task.stop_and_retry",
        ),
    ).toBe(true);
  });

  it("request-changes stops a review in flight before requeueing the implementer", async () => {
    // col-e3021988.10, 2026-09-01: request-changes requeued the task while
    // grok was reviewing it, so the implementer and the reviewer ran side
    // by side on a head the implementer was rewriting.
    const { app, store, task, tickCount } = recoveryApp();
    let current = store.transitionTask(
      task.id,
      task.state_version,
      "running",
      "svc:colonyd",
      { attempt: 1 },
    );
    current = store.transitionTask(
      current.id,
      current.state_version,
      "mr_open",
      "svc:colonyd",
      { mr_iid: 9, branch: "colony/t" },
    );
    const review = store.startRun({
      scope_id: task.scope_id,
      task_id: task.id,
      kind: "review",
      lease_ttl_ms: 60_000,
    });
    let settle!: () => void;
    const execution = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let aborted = false;
    trackRun(review.id, execution, () => {
      aborted = true;
      store.finishRun(review.id, "canceled", { error: "aborted" });
      settle();
    });

    const response = await app.request(`/tasks/${task.id}/request-changes`, {
      method: "POST",
      headers: { ...actorHeaders, "content-type": "application/json" },
      body: JSON.stringify({ feedback: "revert the backend edits" }),
    });
    expect(response.status).toBe(200);
    expect(aborted).toBe(true);
    expect(store.getRun(review.id)!.status).toBe("canceled");
    const requeued = store.getTask(task.id)!;
    expect(requeued.state).toBe("queued");
    expect(requeued.attempt).toBe(2);
    expect(requeued.human_feedback).toBe("revert the backend edits");
    expect(tickCount()).toBe(1);
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

  it("unblock refuses a task that is not blocked (stale operator snapshot)", async () => {
    const { app, store, task, tickCount } = recoveryApp();
    // The task healed itself (queued) before the operator's unblock arrived.
    expect(store.getTask(task.id)!.state).toBe("queued");

    const response = await app.request(`/tasks/${task.id}/unblock`, {
      method: "POST",
      headers: actorHeaders,
    });

    expect(response.status).toBe(409);
    expect(store.getTask(task.id)!.state_version).toBe(task.state_version);
    expect(tickCount()).toBe(0);

    // A genuinely blocked task still unblocks.
    const blocked = store.transitionTask(
      task.id,
      task.state_version,
      "running",
      "svc:colonyd",
    );
    store.transitionTask(
      task.id,
      blocked.state_version,
      "blocked",
      "svc:colonyd",
      {
        blocked_reason: "retries exhausted",
      },
    );
    const ok = await app.request(`/tasks/${task.id}/unblock`, {
      method: "POST",
      headers: actorHeaders,
    });
    expect(ok.status).toBe(200);
    expect(store.getTask(task.id)!.state).toBe("queued");
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
