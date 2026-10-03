import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Store, type Fault, type Task } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { retryOrFailTaskWithBudget } from "../src/fault-budget.js";

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ESC, assembled so the source carries no raw control character.
const ESC = String.fromCharCode(27);

const PLAN = {
  kind: "architect_decomposition" as const,
  summary: "test task",
  requirements: [{ id: "R1", text: "req", tasks: [0] }],
  journey: [{ after_task: 0, working_state: "state" }],
  acceptance: [{ description: "test", command: "true" }],
  tasks: [
    {
      title: "budget task",
      spec: "exercise the retry budget",
      depends_on: [],
      files: ["src/code.ts"],
      evidence: ["true"],
    },
  ],
};

const openStore = (): Store => {
  const dir = mkdtempSync(join(tmpdir(), "fault-budget-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  return store;
};

const ctxFor = (
  store: Store,
  maxAttempts: number,
): Pick<ColonydContext, "store" | "env"> => ({
  store,
  env: {
    gitlabBaseUrl: "",
    gitlabToken: "",
    webhookSecret: "",
    singleToken: true,
    maxConcurrent: 1,
    maxAttempts,
    resumeLeaseTtlMs: 60_000,
    oidcIssuer: "",
    oidcClientId: "",
    oidcRequiredRole: "",
    traceUiBaseUrl: "",
    consoleBaseUrl: "",
  },
});

const seedRunningTask = (store: Store): Task => {
  const scope = store.createScope({
    goal: "fault budget goal",
    title: "fault budget scope",
    provider_repo_id: "repo-1",
    provider_repo_path: "so/budget",
  });
  store.setScopeStatus(scope.id, "planning", "test");
  const [created] = store.materializePlan(scope.id, PLAN, "test");
  if (!created) throw new Error("task creation failed");
  store.transitionTask(created.id, created.state_version, "running", "test");
  return store.getTask(created.id)!;
};

const failImplement = (store: Store, task: Task, fault: Fault): void => {
  const run = store.startRun({
    scope_id: task.scope_id,
    task_id: task.id,
    kind: "implement",
    lease_ttl_ms: 60_000,
  });
  store.finishRun(run.id, "failed", { error: fault.detail ?? "failed", fault });
};

const cancelImplement = (store: Store, task: Task): void => {
  const run = store.startRun({
    scope_id: task.scope_id,
    task_id: task.id,
    kind: "implement",
    lease_ttl_ms: 60_000,
  });
  store.finishRun(run.id, "canceled", { error: "aborted" });
};

const unknown = (detail: string): Fault => ({
  layer: "unknown",
  code: "unknown",
  detail,
});

/** Simulate the tick dispatching the requeued task before the next failure. */
const redispatch = (store: Store, task: Task): void => {
  const current = store.getTask(task.id)!;
  store.transitionTask(current.id, current.state_version, "running", "test");
};

describe("retryOrFailTaskWithBudget blocking rules", () => {
  it("a provider_rejected fault blocks immediately with the sanitized provider reason", () => {
    const store = openStore();
    const task = seedRunningTask(store);
    const ctx = ctxFor(store, 3);
    const detail =
      'GitLab POST /projects/429/merge_requests returned 400: {"title":["is too long (maximum is 255 characters)"]}';
    failImplement(store, task, {
      layer: "provider",
      code: "provider_rejected",
      detail: `${ESC}[31m${detail}${ESC}[0m`,
    });

    retryOrFailTaskWithBudget(ctx, task.id, detail);

    const after = store.getTask(task.id)!;
    expect(after.state).toBe("blocked");
    expect(after.blocked_reason).toContain(
      "is too long (maximum is 255 characters)",
    );
    // The provider message is sanitized before it becomes operator-visible.
    expect(after.blocked_reason).not.toContain(ESC);
  });

  it("three consecutive identical unclassified failures block on the third", () => {
    const store = openStore();
    const task = seedRunningTask(store);
    const ctx = ctxFor(store, 3);

    for (let i = 1; i <= 3; i += 1) {
      failImplement(store, task, unknown("provider exploded"));
      retryOrFailTaskWithBudget(ctx, task.id, "provider exploded");
      const after = store.getTask(task.id)!;
      if (i < 3) {
        expect(after.state).toBe("queued");
        redispatch(store, task);
      } else {
        expect(after.state).toBe("blocked");
        expect(after.blocked_reason).toBe(
          "the same unclassified failure repeated 3 times: provider exploded",
        );
      }
    }
  });

  it("a divergent failure detail requeues where an identical streak blocks", () => {
    // Control: an identical streak reaching the budget blocks.
    const controlStore = openStore();
    const controlTask = seedRunningTask(controlStore);
    const controlCtx = ctxFor(controlStore, 2);
    failImplement(controlStore, controlTask, unknown("boom"));
    retryOrFailTaskWithBudget(controlCtx, controlTask.id, "boom");
    redispatch(controlStore, controlTask);
    failImplement(controlStore, controlTask, unknown("boom"));
    retryOrFailTaskWithBudget(controlCtx, controlTask.id, "boom");
    expect(controlStore.getTask(controlTask.id)!.state).toBe("blocked");

    // Variant: the third failure's divergent detail resets the streak.
    const store = openStore();
    const task = seedRunningTask(store);
    const ctx = ctxFor(store, 3);
    const details = ["boom", "boom", "other"];
    for (const [index, detail] of details.entries()) {
      failImplement(store, task, unknown(detail));
      retryOrFailTaskWithBudget(ctx, task.id, detail);
      if (index < details.length - 1) redispatch(store, task);
    }
    expect(store.getTask(task.id)!.state).toBe("queued");
  });

  it("a canceled run in between resets the streak where the uninterrupted streak blocks", () => {
    // Control: an uninterrupted identical streak reaching the budget blocks.
    const controlStore = openStore();
    const controlTask = seedRunningTask(controlStore);
    const controlCtx = ctxFor(controlStore, 3);
    for (let i = 0; i < 2; i += 1) {
      failImplement(controlStore, controlTask, unknown("boom"));
      retryOrFailTaskWithBudget(controlCtx, controlTask.id, "boom");
      redispatch(controlStore, controlTask);
    }
    failImplement(controlStore, controlTask, unknown("boom"));
    retryOrFailTaskWithBudget(controlCtx, controlTask.id, "boom");
    expect(controlStore.getTask(controlTask.id)!.state).toBe("blocked");

    // Variant: the canceled run breaks the streak; the two identical
    // failures after it only count 2 of 3.
    const store = openStore();
    const task = seedRunningTask(store);
    const ctx = ctxFor(store, 3);
    failImplement(store, task, unknown("boom"));
    retryOrFailTaskWithBudget(ctx, task.id, "boom");
    redispatch(store, task);
    cancelImplement(store, task);
    failImplement(store, task, unknown("boom"));
    retryOrFailTaskWithBudget(ctx, task.id, "boom");
    redispatch(store, task);
    failImplement(store, task, unknown("boom"));
    retryOrFailTaskWithBudget(ctx, task.id, "boom");
    expect(store.getTask(task.id)!.state).toBe("queued");
  });

  it("a provider quota fault requeues free and never retries before the provider's hint", () => {
    const store = openStore();
    const task = seedRunningTask(store);
    const ctx = ctxFor(store, 3);
    // A Moira tier_exhausted refusal: provider quota, not a model failure,
    // with the provider's own earliest reset.
    const notBefore = new Date(Date.now() + 3_600_000).toISOString();
    failImplement(store, task, {
      layer: "provider",
      code: "quota_exhausted",
      detail: "tier_exhausted: flash",
      retryNotBefore: notBefore,
    });

    retryOrFailTaskWithBudget(ctx, task.id, "tier exhausted");

    const after = store.getTask(task.id)!;
    expect(after.state).toBe("queued");
    expect(after.attempt).toBe(task.attempt);
    expect(Date.parse(after.next_retry_at!)).toBeGreaterThanOrEqual(
      Date.parse(notBefore),
    );
  });
});
