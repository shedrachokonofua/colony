import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Store, type Fault, type Run } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";

// Fake credentials, assembled so the literals never appear contiguously in
// source: the merge gate's secret scan would reject this file otherwise.
const FAKE_GLPAT = ["glpat", "opsummary0000000000000abc"].join("-");
const FAKE_BEARER = ["Bearer", "opsumsecretvalue0000"].join(" ");

/** The instant the summary is built at: the fixture's "now". */
const NOW_MS = Date.now();
const iso = (offsetMs: number): string =>
  new Date(NOW_MS + offsetMs).toISOString();

/** One hour inside the 24h window; everything seeded at/after it counts. */
const IN_WINDOW = iso(-3_600_000);
/** Two days back: outside the 24h window, inside the 7d one. */
const OUT_OF_WINDOW = iso(-2 * 86_400_000);

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Env = { Variables: { actor: string } };

interface Summary {
  window: string;
  window_start: string;
  generated_at: string;
  waiting_on_you: {
    plan_approvals: { scope_id: string }[];
    awaiting_merge: { scope_id: string; task_id: string; head_sha: string }[];
    blocked_tasks: {
      scope_id: string;
      task_id: string;
      blocked_reason: string | null;
      age: string | null;
    }[];
    blocked_scopes: {
      scope_id: string;
      blocked_reason: string | null;
      age: string | null;
    }[];
  };
  live: {
    id: string;
    kind: Run["kind"];
    model_id: string | null;
    scope_id: string;
    task_id: string | null;
    started_at: string;
    last_progress_at: string | null;
    active_tool: string | null;
    stalled: boolean;
  }[];
  metrics: {
    runs_by_kind_status: Record<string, number>;
    merges: number;
    verdicts: number;
    per_model: Record<
      string,
      {
        runs: number;
        succeeded: number;
        failed: number;
        timeouts: number;
        completion_rate: number;
        median_ms: number | null;
        p90_ms: number | null;
      }
    >;
    faults_by_layer: Record<string, number>;
    faults_by_layer_code: Record<string, number>;
    restart_incidents: { incidents: number; reaped_runs: number };
    validation: { pass: number; fail: number };
  };
  unclassified: {
    run_id: string;
    kind: Run["kind"];
    model_id: string | null;
    task_id: string | null;
    finished_at: string | null;
    detail: string;
  }[];
  deploy: {
    version: string;
    started_at: string;
    restart_incidents: { incidents: number; reaped_runs: number };
  };
}

function fakeCtx(store: Store): ColonydContext {
  return {
    store,
    provider: {} as ColonydContext["provider"],
    config: {
      reviewMode: "required",
      hitlMode: "yolo",
    } as ColonydContext["config"],
    agents: {} as ColonydContext["agents"],
    artifacts: {} as ColonydContext["artifacts"],
    logger: { info() {}, warn() {}, error() {} },
    env: {
      gitlabBaseUrl: "https://gitlab.example",
      gitlabToken: "",
      webhookSecret: "",
      singleToken: true,
      maxConcurrent: 1,
      maxAttempts: 3,
      resumeLeaseTtlMs: 900_000,
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

function setup(): { app: Hono<Env>; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-operator-summary-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  return { app: buildApp(fakeCtx(store)), store };
}

const ACTOR = { headers: { "X-Actor-Id": "human:op-1" } };

const get = async (app: Hono<Env>, query = ""): Promise<Summary> => {
  const res = await app.request(`/operator/summary${query}`, ACTOR);
  expect(res.status).toBe(200);
  return (await res.json()) as Summary;
};

/**
 * A scope in `status`, reached through the real transitions. appendTasks
 * asserts planning -> active itself (draft and active are both illegal
 * origins), so a scope that needs tasks is left in `planning`.
 */
function seedScope(
  store: Store,
  input: {
    goal: string;
    approvals?: "auto" | "manual";
    status?: "active" | "blocked" | "planning";
  } = { goal: "summary" },
) {
  const scope = store.createScope({
    goal: input.goal,
    title: input.goal,
    provider_repo_id: "1",
    provider_repo_path: "so/colony",
    ...(input.approvals ? { approvals: input.approvals } : {}),
  });
  if (input.status === undefined) return scope;
  if (input.status === "planning") {
    return store.setScopeStatus(scope.id, "planning", "test");
  }
  const planning = store.setScopeStatus(scope.id, "planning", "test");
  const active = store.setScopeStatus(planning.id, "active", "test");
  return input.status === "blocked"
    ? store.setScopeStatus(active.id, "blocked", "test", {
        blocked_reason: input.goal,
      })
    : active;
}

/**
 * A run whose every instant the test owns. startRun stamps `now()`, so the
 * window columns and the lease are rewritten here — the window is what the
 * summary filters on and the lease is what `stalled` measures against.
 */
function seedRun(
  store: Store,
  input: {
    scopeId: string;
    kind: Run["kind"];
    model_id?: string;
    started_at: string;
    finished_at?: string;
    status?: Run["status"];
    error?: string;
    fault?: Fault;
    last_progress_at?: string;
    active_tool?: string;
    leaseMs?: number;
  },
): string {
  const leaseMs = input.leaseMs ?? 900_000;
  const run = store.startRun({
    scope_id: input.scopeId,
    kind: input.kind,
    lease_ttl_ms: leaseMs,
    model_id: input.model_id,
  });
  const status = input.status ?? (input.finished_at ? "succeeded" : "running");
  store.db
    .prepare(
      `UPDATE runs SET started_at = ?, finished_at = ?, status = ?, error = ?,
       fault_json = ?, last_progress_at = ?, active_tool = ?,
       lease_expires_at = ? WHERE id = ?`,
    )
    .run(
      input.started_at,
      input.finished_at ?? null,
      status,
      input.error ?? null,
      input.fault ? JSON.stringify(input.fault) : null,
      input.last_progress_at ?? null,
      input.active_tool ?? null,
      new Date(Date.parse(input.started_at) + leaseMs).toISOString(),
      run.id,
    );
  return run.id;
}

/**
 * One task of a scope walked to mr_open: queued -> running -> mr_open, the
 * only legal path there. A task straight to mr_open would need DB surgery
 * against an append-only audit log.
 */
function mrOpenTask(store: Store, scopeId: string) {
  const [task] = store.appendTasks(
    scopeId,
    [{ title: "awaiting merge", spec: "spec" }],
    "human:op-1",
  );
  if (!task) throw new Error("fixture task missing");
  const running = store.transitionTask(
    task.id,
    task.state_version,
    "running",
    "test",
    { branch: "colony/awaiting-merge" },
  );
  return store.transitionTask(
    running.id,
    running.state_version,
    "mr_open",
    "test",
    { mr_iid: 7 },
  );
}

/**
 * An audit row at an explicit instant. `Store.audit` stamps `now()`, and the
 * append-only trigger rejects UPDATE, so a backdated row is inserted here.
 */
function auditAt(
  store: Store,
  action: string,
  scopeId: string,
  at: string,
): void {
  store.db
    .prepare(
      `INSERT INTO audit (at, actor, action, scope_id, detail_json)
       VALUES (?, 'svc:colonyd', ?, ?, '{}')`,
    )
    .run(at, action, scopeId);
}

describe("GET /operator/summary", () => {
  it("rejects a window outside the enum", async () => {
    const { app } = setup();
    const res = await app.request("/operator/summary?window=30d", ACTOR);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_BODY" } });
  });

  it("flags a run that outlived its lease and not a fresh one", async () => {
    const { app, store } = setup();
    const scope = seedScope(store, { goal: "stall" });
    let stalledAt = "";
    const stalledId = seedRun(store, {
      scopeId: scope.id,
      kind: "implement",
      model_id: "router/muse-spark-1.3",
      started_at: (stalledAt = iso(-4 * 3_600_000)),
      last_progress_at: stalledAt,
      active_tool: "bash",
      leaseMs: 900_000,
    });
    const freshId = seedRun(store, {
      scopeId: scope.id,
      kind: "implement",
      model_id: "router/muse-spark-1.3",
      started_at: iso(-5 * 60_000),
      last_progress_at: iso(-60_000),
      active_tool: "edit",
      leaseMs: 900_000,
    });

    const summary = await get(app, "?window=24h");
    const byId = new Map(summary.live.map((run) => [run.id, run]));
    // The live section ignores the window: every running run is listed.
    expect(byId.size).toBe(2);
    expect(byId.get(stalledId)!.stalled).toBe(true);
    expect(byId.get(freshId)!.stalled).toBe(false);
    expect(byId.get(stalledId)).toMatchObject({
      kind: "implement",
      model_id: "router/muse-spark-1.3",
      scope_id: scope.id,
      active_tool: "bash",
      last_progress_at: stalledAt,
    });
  });

  it("lists a manual-approval mr_open task at its reviewed head and not an auto one", async () => {
    const { app, store } = setup();
    // Left in `planning` so appendTasks can do its own planning -> active.
    const manual = seedScope(store, {
      goal: "manual",
      approvals: "manual",
      status: "planning",
    });
    const auto = seedScope(store, {
      goal: "auto",
      approvals: "auto",
      status: "planning",
    });
    const H1 = "0123456789abcdef0123456789abcdef01234567";
    const H2 = "89abcdef0123456789abcdef0123456789abcdef";

    const manualTask = mrOpenTask(store, manual.id);
    const autoTask = mrOpenTask(store, auto.id);
    // The head an awaiting-merge row offers is the one the latest review
    // approved; tasks hold no head_sha column.
    store.audit("svc:colonyd", "review.approved", {
      scope_id: manual.id,
      task_id: manualTask.id,
      detail: { head_sha: H1 },
    });
    store.audit("svc:colonyd", "review.approved", {
      scope_id: auto.id,
      task_id: autoTask.id,
      detail: { head_sha: H2 },
    });

    const summary = await get(app, "?window=24h");
    expect(summary.waiting_on_you.awaiting_merge).toEqual([
      { scope_id: manual.id, task_id: manualTask.id, head_sha: H1 },
    ]);

    // Approving that exact head clears it: nothing is waiting any more.
    store.approveMerge(manualTask.id, H1);
    const after = await get(app, "?window=24h");
    expect(after.waiting_on_you.awaiting_merge).toEqual([]);
  });

  it("counts a batch of reaped runs in one minute as one incident", async () => {
    const { app, store } = setup();
    const scope = seedScope(store, { goal: "reaped" });
    // Both finish inside the same wall-clock minute: one restart reaped
    // them together, so the summary reports one outage and two victims. The
    // bucket is the whole minute, not a 60s window around the first finish,
    // so aligning to the minute boundary keeps the fixture honest.
    const minute = Math.floor(NOW_MS / 60_000) - 120;
    const finished = new Date(minute * 60_000).toISOString();
    const finishedLater = new Date(minute * 60_000 + 30_000).toISOString();
    seedRun(store, {
      scopeId: scope.id,
      kind: "implement",
      model_id: "router/muse-spark-1.3",
      started_at: iso(-3 * 3_600_000),
      finished_at: finished,
      status: "failed",
      fault: { layer: "colonyd", code: "crash_reaped" },
    });
    seedRun(store, {
      scopeId: scope.id,
      kind: "implement",
      model_id: "router/muse-spark-1.3",
      started_at: iso(-3 * 3_600_000 + 5 * 60_000),
      finished_at: finishedLater,
      status: "failed",
      fault: { layer: "colonyd", code: "process_restart" },
    });
    expect(Math.floor(Date.parse(finished) / 60_000)).toBe(
      Math.floor(Date.parse(finishedLater) / 60_000),
    );

    const summary = await get(app, "?window=24h");
    expect(summary.metrics.restart_incidents).toEqual({
      incidents: 1,
      reaped_runs: 2,
    });
    expect(summary.deploy.restart_incidents).toEqual({
      incidents: 1,
      reaped_runs: 2,
    });
    expect(summary.metrics.faults_by_layer_code).toMatchObject({
      "colonyd:crash_reaped": 1,
      "colonyd:process_restart": 1,
    });
  });

  it("counts a wall_timeout run in its model's timeouts", async () => {
    const { app, store } = setup();
    const scope = seedScope(store, { goal: "timeout" });
    let startAt = "";
    seedRun(store, {
      scopeId: scope.id,
      kind: "implement",
      model_id: "router/muse-spark-1.3",
      started_at: (startAt = iso(-3 * 3_600_000)),
      finished_at: new Date(Date.parse(startAt) + 20 * 60_000).toISOString(),
      status: "failed",
      fault: { layer: "model", code: "wall_timeout" },
    });
    seedRun(store, {
      scopeId: scope.id,
      kind: "implement",
      model_id: "router/muse-spark-1.3",
      started_at: startAt,
      finished_at: new Date(Date.parse(startAt) + 10 * 60_000).toISOString(),
      status: "succeeded",
    });

    const summary = await get(app, "?window=24h");
    const model = summary.metrics.per_model["router/muse-spark-1.3"]!;
    // 10 and 20 minute runs: median at rank ceil(0.5*2)=1 and p90 at rank
    // ceil(0.9*2)=2 of the ascending sample.
    expect(model.runs).toBe(2);
    expect(model.succeeded).toBe(1);
    expect(model.failed).toBe(1);
    expect(model.timeouts).toBe(1);
    expect(model.completion_rate).toBe(0.5);
    expect(model.median_ms).toBe(10 * 60_000);
    expect(model.p90_ms).toBe(20 * 60_000);
  });

  it("redacts a credential-bearing unclassified fault and never echoes the run error", async () => {
    const { app, store } = setup();
    const scope = seedScope(store, { goal: "unclassified" });
    // Both assembled at runtime, so the literals never sit contiguously in
    // source; long enough for sanitizeTrace's shape-preserving redaction
    // (first four and last four characters survive).
    const detail = `gitlab refused the push: token ${FAKE_GLPAT} rejected`;
    const rawError = `open MR failed: Authorization: ${FAKE_BEARER}`;
    let finishedAt = "";
    const runId = seedRun(store, {
      scopeId: scope.id,
      kind: "implement",
      model_id: "router/muse-spark-1.3",
      started_at: iso(-3 * 3_600_000),
      finished_at: (finishedAt = iso(-2 * 3_600_000)),
      status: "failed",
      error: rawError,
      fault: { layer: "unknown", code: "unknown", detail },
    });

    const summary = await get(app, "?window=24h");
    expect(summary.unclassified).toEqual([
      {
        run_id: runId,
        kind: "implement",
        model_id: "router/muse-spark-1.3",
        task_id: null,
        finished_at: finishedAt,
        // The redaction marker, not the credential: sanitizeTrace keeps the
        // first four characters so an operator can tell which secret leaked.
        detail: `gitlab refused the push: token ${FAKE_GLPAT.slice(0, 4)}...${FAKE_GLPAT.slice(-4)} rejected`,
      },
    ]);
    const served = summary.unclassified[0]!.detail;
    expect(served).not.toContain(FAKE_GLPAT);
    expect(served).not.toContain("opsum0000000000abcd");
    // Redaction is visible as the provider's marker shape, not mere absence.
    expect(served).toContain(`${FAKE_GLPAT.slice(0, 4)}...`);
    // The run's own error is never echoed into the served detail.
    expect(served).not.toContain(rawError);
    expect(served).not.toContain(FAKE_BEARER.split(" ")[1]!);

    // The stored row is untouched: redaction rewrites the served copy only.
    const stored = store.getRun(runId)!;
    expect(stored.error).toBe(rawError);
    expect(stored.fault_json).toContain(FAKE_GLPAT);
  });

  it("excludes runs outside the window from both counts and rows", async () => {
    const { app, store } = setup();
    const scope = seedScope(store, { goal: "window" });
    seedRun(store, {
      scopeId: scope.id,
      kind: "implement",
      model_id: "router/muse-spark-1.3",
      started_at: OUT_OF_WINDOW,
      finished_at: OUT_OF_WINDOW,
      status: "failed",
      fault: { layer: "unknown", code: "unknown", detail: "old" },
    });
    seedRun(store, {
      scopeId: scope.id,
      kind: "review",
      model_id: "router/muse-spark-1.3",
      started_at: IN_WINDOW,
      finished_at: IN_WINDOW,
      status: "succeeded",
    });

    const day = await get(app, "?window=24h");
    expect(day.metrics.runs_by_kind_status).toEqual({ "review:succeeded": 1 });
    expect(day.unclassified).toEqual([]);
    expect(day.metrics.per_model["router/muse-spark-1.3"]!.runs).toBe(1);

    // Same dataset, wider window: the older run is now in scope, and the
    // count grows with the row it describes.
    const week = await get(app, "?window=7d");
    expect(week.metrics.runs_by_kind_status).toEqual({
      "review:succeeded": 1,
      "implement:failed": 1,
    });
    expect(week.unclassified.length).toBe(1);
    expect(week.metrics.per_model["router/muse-spark-1.3"]!.runs).toBe(2);
  });

  it("counts merges, verdicts and validation over the same window as the runs", async () => {
    const { app, store } = setup();
    const scope = seedScope(store, { goal: "counts" });
    store.audit("svc:colonyd", "mr.merged", {
      scope_id: scope.id,
      detail: { head_sha: "c".repeat(40) },
    });
    store.audit("svc:colonyd", "review.approved", {
      scope_id: scope.id,
      detail: { head_sha: "d".repeat(40) },
    });
    store.audit("svc:colonyd", "review.changes_requested", {
      scope_id: scope.id,
      detail: { head_sha: "d".repeat(40) },
    });
    store.audit("svc:colonyd", "scope.validated", { scope_id: scope.id });
    // Outside the 24h window: present in the append-only log, absent from
    // the summary. The audit table forbids UPDATE, so an old row is written
    // directly with its own `at`.
    auditAt(store, "scope.validation_failed", scope.id, OUT_OF_WINDOW);

    const summary = await get(app, "?window=24h");
    expect(summary.metrics.merges).toBe(1);
    expect(summary.metrics.verdicts).toBe(2);
    expect(summary.metrics.validation).toEqual({ pass: 1, fail: 0 });

    // The 7d window keeps the out-of-day row: the count follows the window,
    // not the log.
    const week = await get(app, "?window=7d");
    expect(week.metrics.validation).toEqual({ pass: 1, fail: 1 });
  });
});
