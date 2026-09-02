import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Store, TASK_STATES, type TaskState } from "@colony/core";
import { createLocalArtifactStore } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeCtx(store: Store): ColonydContext {
  return {
    store,
    provider: {
      repos: {
        getByPath: async (path: string) =>
          path === "so/demo"
            ? { id: "1", path: "so/demo", default_branch: "main" }
            : null,
      },
    } as unknown as ColonydContext["provider"],
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
      gitlabBaseUrl: "https://gitlab.home.shdr.ch",
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
    requestTick() {},
  };
}

function appWithStore() {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-project-running-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  return { store, app: buildApp(fakeCtx(store)) };
}

const ACTOR = { headers: { "X-Actor-Id": "human:op-1" } };

interface RunningRow {
  scope_id: string;
  scope_title: string;
  task_id: string;
  task_title: string;
  task_state: string;
  attempt: number;
  run: {
    id: string;
    kind: string;
    status: string;
    model_id: string | null;
    started_at: string;
  } | null;
}

interface TestApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

async function getRunning(app: TestApp, project: string): Promise<Response> {
  return app.request(`/projects/${project}/running`, ACTOR);
}

/** Scope owned by `project` holding one independent task per title. */
function scopeWithTasks(
  store: Store,
  project: string,
  titles: readonly string[],
): { scope_id: string; task_ids: string[] } {
  const scope_id = store.createScope({
    goal: `${project} goal`,
    provider_repo_id: "1",
    provider_repo_path: "so/x",
    project,
  }).id;
  store.setScopeStatus(scope_id, "planning", "svc:test");
  const task_ids = store
    .materializePlan(
      scope_id,
      {
        kind: "architect_decomposition",
        summary: "test plan",
        acceptance: [{ description: "goal", command: "true" }],
        tasks: titles.map((title) => ({
          title,
          spec: `do ${title}`,
          depends_on: [],
        })),
      },
      "svc:test",
    )
    .map((task) => String(task.id));
  return { scope_id, task_ids };
}

/** queued -> running -> (mr_open); returns the task's new state_version. */
function advanceTask(
  store: Store,
  taskId: string,
  to: "running" | "mr_open",
): number {
  const running = store.transitionTask(taskId, 0, "running", "svc:test");
  if (to === "running") return running.state_version;
  return store.transitionTask(
    taskId,
    running.state_version,
    "mr_open",
    "svc:test",
  ).state_version;
}

describe("GET /projects/:name/running", () => {
  it("returns a bare array of the project's in-flight tasks and runs", async () => {
    const { store, app } = appWithStore();
    const { scope_id, task_ids } = scopeWithTasks(store, "wave", [
      "Implement",
      "InReview",
    ]);
    advanceTask(store, task_ids[0]!, "running");
    advanceTask(store, task_ids[1]!, "mr_open");
    const implementRun = store.startRun({
      scope_id,
      task_id: task_ids[0],
      kind: "implement",
      lease_ttl_ms: 60_000,
      model_id: "model-a",
    });
    const reviewRun = store.startRun({
      scope_id,
      task_id: task_ids[1],
      kind: "review",
      lease_ttl_ms: 60_000,
    });

    const res = await getRunning(app, "wave");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunningRow[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    for (const row of body) {
      expect(Object.keys(row).sort()).toEqual([
        "attempt",
        "run",
        "scope_id",
        "scope_title",
        "task_id",
        "task_state",
        "task_title",
      ]);
      expect(row.scope_id).toBe(scope_id);
      expect(row.scope_title).toBe("wave goal");
      expect(row.attempt).toBe(0);
    }

    const states = Object.fromEntries(
      body.map((row) => [row.task_title, row.task_state]),
    );
    expect(states).toEqual({ Implement: "running", InReview: "mr_open" });

    const runs = Object.fromEntries(
      body.map((row) => [row.task_title, row.run]),
    );
    expect(runs.Implement).toEqual({
      id: implementRun.id,
      kind: "implement",
      status: "running",
      model_id: "model-a",
      started_at: implementRun.started_at,
    });
    expect(runs.InReview).toMatchObject({
      id: reviewRun.id,
      kind: "review",
      status: "running",
      model_id: null,
    });
  });

  it("returns [] for a project whose scopes are all terminal", async () => {
    const { store, app } = appWithStore();
    const { scope_id, task_ids } = scopeWithTasks(store, "settled", [
      "WasRunning",
    ]);
    advanceTask(store, task_ids[0]!, "running");
    store.startRun({
      scope_id,
      task_id: task_ids[0],
      kind: "implement",
      lease_ttl_ms: 60_000,
    });

    store.setScopeStatus(scope_id, "validating", "svc:test");
    store.setScopeStatus(scope_id, "done", "svc:test");

    const res = await getRunning(app, "settled");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);

    // A project with no scopes at all is empty too.
    store.createProject({ name: "idle", context_doc: null });
    const idle = await getRunning(app, "idle");
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual([]);
  });

  it("404s an unknown project", async () => {
    const { app } = appWithStore();
    const res = await getRunning(app, "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "project not found" },
    });
  });

  it("orders rows newest-activity-first across scopes", async () => {
    const { store, app } = appWithStore();
    const first = scopeWithTasks(store, "wave", ["First"]);
    const second = scopeWithTasks(store, "wave", ["Second", "NoRun"]);
    advanceTask(store, first.task_ids[0]!, "mr_open");
    advanceTask(store, second.task_ids[0]!, "running");
    advanceTask(store, second.task_ids[1]!, "running");

    const older = store.startRun({
      scope_id: first.scope_id,
      task_id: first.task_ids[0],
      kind: "merge_gate",
      lease_ttl_ms: 60_000,
    });
    const newer = store.startRun({
      scope_id: second.scope_id,
      task_id: second.task_ids[0],
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    for (const [run, at] of [
      [older, "2026-01-01T00:00:00.000Z"],
      [newer, "2026-01-02T00:00:00.000Z"],
    ] as const) {
      store.db
        .prepare(`UPDATE runs SET started_at = ? WHERE id = ?`)
        .run(at, run.id);
    }

    const res = await getRunning(app, "wave");
    const body = (await res.json()) as RunningRow[];
    expect(body.map((row) => row.task_title)).toEqual([
      "Second",
      "First",
      "NoRun",
    ]);
    expect(body[0]!.run!.started_at).toBe("2026-01-02T00:00:00.000Z");
    // The task with no run sorts last and carries null.
    expect(body[2]!.run).toBeNull();
  });

  it("serves task_state_counts zero-filled from GET /projects/:name", async () => {
    const { store, app } = appWithStore();
    const { task_ids } = scopeWithTasks(store, "wave", [
      "Queued",
      "Blocked",
      "Running",
    ]);
    advanceTask(store, task_ids[2]!, "running");
    const running = store.transitionTask(
      task_ids[1]!,
      0,
      "running",
      "svc:test",
    );
    store.transitionTask(
      task_ids[1]!,
      running.state_version,
      "blocked",
      "svc:test",
    );

    const res = await app.request("/projects/wave", ACTOR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: { task_state_counts: Record<TaskState, number> };
    };
    const zeroCounts = () =>
      Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as Record<
        TaskState,
        number
      >;
    expect(body.project.task_state_counts).toEqual({
      ...zeroCounts(),
      queued: 1,
      blocked: 1,
      running: 1,
    });
    expect(Object.keys(body.project.task_state_counts).sort()).toEqual(
      [...TASK_STATES].sort(),
    );

    // A project with no tasks is still fully zero-filled.
    store.createProject({ name: "empty", context_doc: null });
    const empty = await app.request("/projects/empty", ACTOR);
    const emptyBody = (await empty.json()) as {
      project: { task_state_counts: Record<TaskState, number> };
    };
    expect(emptyBody.project.task_state_counts).toEqual(zeroCounts());
  });
});
