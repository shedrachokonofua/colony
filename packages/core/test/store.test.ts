import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { DomainStateError, taskId } from "@colony/domain";
import { LATEST_SCHEMA_VERSION } from "../src/migrations.js";
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import {
  SCOPE_STATUSES,
  Store,
  TASK_STATES,
  assertScopeTransition,
  assertTaskTransition,
  retryBackoffMs,
  type ScopeStatus,
  type Task,
  type TaskState,
} from "../src/index.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "colony-core-"));
  store = new Store(join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("state machine", () => {
  it("permits every legal task transition", () => {
    const legal: Array<[string, string]> = [
      ["queued", "running"],
      ["queued", "merged"],
      ["running", "mr_open"],
      ["running", "queued"],
      ["running", "blocked"],
      ["mr_open", "merged"],
      ["mr_open", "queued"],
      ["mr_open", "blocked"],
      ["blocked", "queued"],
      ["blocked", "merged"],
      ["queued", "canceled"],
      ["running", "canceled"],
      ["mr_open", "canceled"],
      ["blocked", "canceled"],
      ["canceled", "queued"],
    ];
    for (const [from, to] of legal) {
      expect(() =>
        assertTaskTransition(from as never, to as never),
      ).not.toThrow();
    }
  });

  it("rejects every illegal task transition", () => {
    const illegal: Array<[string, string]> = [
      ["queued", "mr_open"],
      ["queued", "blocked"],
      ["queued", "queued"],
      ["running", "merged"],
      ["mr_open", "running"],
      ["merged", "queued"],
      ["merged", "blocked"],
      ["merged", "canceled"],
      ["blocked", "running"],
      ["blocked", "blocked"],
    ];
    for (const [from, to] of illegal) {
      expect(() => assertTaskTransition(from as never, to as never)).toThrow(
        DomainStateError,
      );
    }
  });

  it("permits every legal scope transition", () => {
    const legal: Array<[string, string]> = [
      ["draft", "planning"],
      ["planning", "active"],
      ["planning", "blocked"],
      ["active", "done"],
      ["active", "blocked"],
      ["active", "validating"],
      ["validating", "done"],
      ["validating", "active"],
      ["validating", "planning"],
      ["validating", "abandoned"],
      ["blocked", "planning"],
      ["blocked", "active"],
      ["draft", "abandoned"],
      ["planning", "abandoned"],
      ["active", "abandoned"],
      ["blocked", "abandoned"],
      ["done", "active"],
    ];
    for (const [from, to] of legal) {
      expect(() =>
        assertScopeTransition(from as never, to as never),
      ).not.toThrow();
    }
  });

  it("rejects illegal scope transitions", () => {
    const illegal: Array<[string, string]> = [
      ["draft", "active"],
      ["draft", "done"],
      ["planning", "done"],
      ["planning", "validating"],
      ["active", "planning"],
      ["validating", "blocked"],
      ["draft", "validating"],
      ["abandoned", "active"],
      ["done", "abandoned"],
      ["done", "done"],
    ];
    for (const [from, to] of illegal) {
      expect(() => assertScopeTransition(from as never, to as never)).toThrow(
        DomainStateError,
      );
    }
  });

  it("computes exponential backoff capped at 5 minutes", () => {
    expect(retryBackoffMs(1)).toBe(10_000);
    expect(retryBackoffMs(2)).toBe(20_000);
    expect(retryBackoffMs(3)).toBe(40_000);
    expect(retryBackoffMs(6)).toBe(300_000);
    expect(retryBackoffMs(7)).toBe(300_000);
    expect(retryBackoffMs(100)).toBe(300_000);
  });
});

function plan(
  overrides: Partial<ArchitectDecompositionV2> = {},
): ArchitectDecompositionV2 {
  return {
    kind: "architect_decomposition",
    summary: "test plan",
    acceptance: [{ description: "core plan goal", command: "true" }],
    tasks: [
      { title: "A", spec: "do A", depends_on: [] },
      { title: "B", spec: "do B", depends_on: [0] },
    ],
    ...overrides,
  };
}

function seededScope(): string {
  const scope = store.createScope({
    goal: "test goal",
    provider_repo_id: "42",
    provider_repo_path: "so/test",
  });
  return scope.id;
}

describe("Store", () => {
  it("creates scopes and materializes a plan into tasks + deps", () => {
    const scopeId = seededScope();
    store.setScopeStatus(scopeId, "planning", "svc:colonyd");
    const tasks = store.materializePlan(scopeId, plan(), "svc:colonyd");
    expect(tasks).toHaveLength(2);
    expect(String(tasks[0]!.id)).toBe(`${scopeId}.1`);
    expect(String(tasks[1]!.id)).toBe(`${scopeId}.2`);
    expect(store.getScope(scopeId)!.status).toBe("active");
    expect(store.taskDeps(tasks[1]!.id)).toEqual([tasks[0]!.id]);
  });

  it("appends extension tasks while preserving existing ids and wiring deps", () => {
    const scopeId = seededScope();
    store.setScopeStatus(scopeId, "planning", "svc:colonyd");
    const [first] = store.materializePlan(scopeId, plan(), "svc:colonyd");
    store.setScopeStatus(scopeId, "validating", "svc:colonyd");
    const appended = store.appendTasks(
      scopeId,
      [
        {
          title: "Repair",
          spec: "repair the implementation",
          depends_on: [first!.id],
        },
        {
          title: "Verify repair",
          spec: "verify the repair",
          depends_on: [0],
        },
      ],
      "svc:colonyd",
    );
    expect(appended.map((task) => task.id)).toEqual([
      taskId(`${scopeId}.3`),
      taskId(`${scopeId}.4`),
    ]);
    expect(store.listTasks(scopeId)).toHaveLength(4);
    expect(store.taskDeps(appended[0]!.id)).toEqual([first!.id]);
    expect(store.taskDeps(appended[1]!.id)).toEqual([appended[0]!.id]);
    expect(store.getScope(scopeId)!.status).toBe("active");
  });

  it("rejects cycles in appended tasks before inserting any rows", () => {
    const scopeId = seededScope();
    store.setScopeStatus(scopeId, "planning", "svc:colonyd");
    store.materializePlan(scopeId, plan(), "svc:colonyd");
    store.setScopeStatus(scopeId, "validating", "svc:colonyd");
    expect(() =>
      store.appendTasks(
        scopeId,
        [
          { title: "Cycle A", spec: "a", depends_on: [1] },
          { title: "Cycle B", spec: "b", depends_on: [0] },
        ],
        "svc:colonyd",
      ),
    ).toThrow(/cyclic/);
    expect(store.listTasks(scopeId)).toHaveLength(2);
  });

  it("persists acceptance_json on materializePlan", () => {
    const scopeId = seededScope();
    store.setScopeStatus(scopeId, "planning", "svc:colonyd");
    const p = plan();
    store.materializePlan(scopeId, p, "svc:colonyd");
    expect(store.getScope(scopeId)!.acceptance_json).toBe(
      JSON.stringify(p.acceptance),
    );
  });

  it("writes a non-null cost_prediction_json for every materialized task", () => {
    const scopeId = seededScope();
    store.setScopeStatus(scopeId, "planning", "svc:colonyd");
    const p = plan({
      tasks: [
        {
          title: "A",
          spec: "touch packages/core/src/store.ts and apps/x/y.ts",
          depends_on: [],
        },
        { title: "B", spec: "no paths here", depends_on: [0] },
      ],
    });
    const tasks = store.materializePlan(scopeId, p, "svc:colonyd");
    expect(tasks).toHaveLength(2);
    // Zero-history database: nothing is predicted or flagged, but the
    // spec-derived file list still rides along.
    expect(JSON.parse(tasks[0]!.cost_prediction_json!)).toMatchObject({
      predicted_ms: 0,
      budget_ms: 900_000,
      files_touched: 2,
      model_version: "v1",
      flagged: false,
      sample_size: 0,
      inputs: { files: ["packages/core/src/store.ts", "apps/x/y.ts"] },
    });
    expect(JSON.parse(tasks[1]!.cost_prediction_json!)).toMatchObject({
      predicted_ms: 0,
      files_touched: 0,
      flagged: false,
      inputs: { files: [] },
    });
    // GET /tasks/:id reads through SELECT *: the blob round-trips.
    const reloaded = store.listTasks(scopeId);
    expect(reloaded[0]!.cost_prediction_json).toBe(
      tasks[0]!.cost_prediction_json,
    );
  });

  it("rejects a cyclic plan", () => {
    const scopeId = seededScope();
    store.setScopeStatus(scopeId, "planning", "svc:colonyd");
    const cyclic = plan({
      tasks: [
        { title: "A", spec: "a", depends_on: [1] },
        { title: "B", spec: "b", depends_on: [0] },
      ],
    });
    expect(() => store.materializePlan(scopeId, cyclic, "svc:colonyd")).toThrow(
      /cyclic/,
    );
  });

  it("gates readyTasks on merged dependencies", () => {
    const scopeId = seededScope();
    store.setScopeStatus(scopeId, "planning", "svc:colonyd");
    const [a, b] = store.materializePlan(scopeId, plan(), "svc:colonyd");

    // Only A is ready: B depends on A which is not merged.
    expect(store.readyTasks(scopeId).map((t) => t.id)).toEqual([a!.id]);

    // Advance A through to merged; then B becomes ready.
    let taskA = store.transitionTask(a!.id, 0, "running", "svc:colonyd");
    taskA = store.transitionTask(
      a!.id,
      taskA.state_version,
      "mr_open",
      "svc:colonyd",
    );
    store.transitionTask(a!.id, taskA.state_version, "merged", "svc:colonyd");
    expect(store.readyTasks(scopeId).map((t) => t.id)).toEqual([b!.id]);
  });

  it("honors next_retry_at for queued tasks", () => {
    const scopeId = seededScope();
    store.setScopeStatus(scopeId, "planning", "svc:colonyd");
    const [a] = store.materializePlan(scopeId, plan(), "svc:colonyd");
    let t = store.transitionTask(a!.id, 0, "running", "svc:colonyd");
    const future = new Date(Date.now() + 60_000).toISOString();
    store.transitionTask(a!.id, t.state_version, "queued", "svc:colonyd", {
      next_retry_at: future,
      attempt: 1,
    });
    expect(store.readyTasks(scopeId)).toEqual([]);
    // Backdate the retry -> ready.
    store.db
      .prepare(`UPDATE tasks SET next_retry_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), a!.id);
    expect(store.readyTasks(scopeId).map((x) => x.id)).toEqual([a!.id]);
  });

  it("rejects a stale state_version (optimistic concurrency)", () => {
    const scopeId = seededScope();
    store.setScopeStatus(scopeId, "planning", "svc:colonyd");
    const [a] = store.materializePlan(scopeId, plan(), "svc:colonyd");
    store.transitionTask(a!.id, 0, "running", "svc:colonyd");
    // Stale version 0 now conflicts with the bumped version.
    expect(() =>
      store.transitionTask(a!.id, 0, "mr_open", "svc:colonyd"),
    ).toThrow(DomainStateError);
  });

  it("rejects illegal transitions through transitionTask", () => {
    const scopeId = seededScope();
    store.setScopeStatus(scopeId, "planning", "svc:colonyd");
    const [a] = store.materializePlan(scopeId, plan(), "svc:colonyd");
    expect(() =>
      store.transitionTask(a!.id, 0, "blocked", "svc:colonyd"),
    ).toThrow(DomainStateError);
  });

  it("expires dead leases and reports them", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 50,
    });
    expect(store.activeRunCount()).toBe(1);
    const expired = store.expireDeadLeases(new Date(Date.now() + 1000));
    expect(expired).toHaveLength(1);
    expect(expired[0]!.id).toBe(run.id);
    expect(store.getRun(run.id)!.status).toBe("failed");
    expect(store.getRun(run.id)!.error).toBe("lease_expired");
    expect(store.activeRunCount()).toBe(0);
  });

  it("expires orphaned in-flight runs regardless of lease TTL", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 30 * 60_000,
    });
    const expired = store.expireOrphanedRuns();
    expect(expired).toHaveLength(1);
    expect(expired[0]!.id).toBe(run.id);
    expect(store.getRun(run.id)!.status).toBe("failed");
    expect(store.getRun(run.id)!.error).toBe("process_restart");
    expect(store.activeRunCount()).toBe(0);
  });

  it("preserves token_id across orphan expiry so crash-reap can revoke", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 30 * 60_000,
    });
    store.setRunToken(run.id, "glpat-token-99");
    const expired = store.expireOrphanedRuns();
    expect(expired[0]!.token_id).toBe("glpat-token-99");
    expect(store.getRun(run.id)!.token_id).toBe("glpat-token-99");
  });

  it("extends a lease via heartbeat", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 50,
    });
    store.heartbeatRun(run.id, 60_000);
    const expired = store.expireDeadLeases(new Date(Date.now() + 1000));
    expect(expired).toEqual([]);
  });

  it("enforces append-only audit on UPDATE and DELETE", () => {
    store.audit("svc:colonyd", "test.action", {});
    expect(() =>
      store.db.prepare(`UPDATE audit SET action = 'x'`).run(),
    ).toThrow(/append-only/);
    expect(() => store.db.prepare(`DELETE FROM audit`).run()).toThrow(
      /append-only/,
    );
    expect(store.listAudit().events).toHaveLength(1);
  });

  it("pages run events newest-first by default with has_more and cursor walkback", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    for (let i = 1; i <= 250; i++) {
      store.appendRunEvent(run.id, "tool_call", { seq: i });
    }

    const page = store.listRunEvents(run.id);
    expect(page.events).toHaveLength(200);
    expect(page.has_more).toBe(true);
    expect(page.events[0]!.detail_json).toBe(JSON.stringify({ seq: 51 }));
    expect(page.newest_id).toBe(page.events.at(-1)!.id);
    expect(page.oldest_id).toBe(page.events[0]!.id);
    const ids = page.events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    // Exclusive cursor: everything strictly older than the page's oldest_id.
    const older = store.listRunEvents(run.id, {
      before_id: page.oldest_id!,
    });
    expect(older.events).toHaveLength(50);
    expect(older.has_more).toBe(false);
    expect(older.oldest_id).toBe(older.events[0]!.id);
    expect(older.events[0]!.detail_json).toBe(JSON.stringify({ seq: 1 }));
  });

  it("listRunEventsByName returns every row of one event name, ascending, unpaginated", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    // The fallback row is the oldest event of the run: beyond the feed's
    // 200-row window, so only a by-name query can see it.
    store.appendRunEvent(run.id, "pi_model_fallback", { from: "m1", to: "m2" });
    for (let i = 1; i <= 250; i++) {
      store.appendRunEvent(run.id, "tool_call", { seq: i });
    }

    const fallbacks = store.listRunEventsByName(run.id, "pi_model_fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.event).toBe("pi_model_fallback");
    expect(fallbacks[0]!.detail_json).toBe(
      JSON.stringify({ from: "m1", to: "m2" }),
    );

    const toolCalls = store.listRunEventsByName(run.id, "tool_call");
    expect(toolCalls).toHaveLength(250);
    const ids = toolCalls.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("clamps run-event page limits to 1..1000", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    // One transaction: 1200 individual inserts each fsync and can blow the
    // test timeout on slow disks.
    store.db.transaction(() => {
      for (let i = 0; i < 1200; i++) {
        store.appendRunEvent(run.id, "tick", { seq: i });
      }
    })();
    expect(store.listRunEvents(run.id, { limit: 5000 }).events).toHaveLength(
      1000,
    );
    expect(store.listRunEvents(run.id, { limit: 0 }).events).toHaveLength(1);
    expect(store.listRunEvents(run.id, { limit: -50 }).events).toHaveLength(1);
    expect(store.listRunEvents(run.id).events).toHaveLength(200);
  });

  it("returns an empty run-event page with null cursor bounds", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    const page = store.listRunEvents(run.id);
    expect(page.events).toEqual([]);
    expect(page.has_more).toBe(false);
    expect(page.oldest_id).toBeNull();
    expect(page.newest_id).toBeNull();
  });

  it("writes a run.finished audit row on every run completion", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    store.finishRun(run.id, "failed", { error: "agent_failed" });

    const rows = store
      .listAudit({ run_id: run.id })
      .events.filter((row) => row.action === "run.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("svc:colonyd");
    expect(rows[0]!.run_id).toBe(run.id);
    expect(rows[0]!.scope_id).toBe(scopeId);
    expect(rows[0]!.task_id).toBeNull();
    expect(JSON.parse(rows[0]!.detail_json)).toEqual({
      run_id: run.id,
      status: "failed",
      error: "agent_failed",
    });
  });

  it("does not write a second run.finished row when already terminal", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    store.finishRun(run.id, "succeeded");
    // A second finish is a no-op on the runs row; the audit trail must not
    // grow a contradicting run.finished row for the skipped transition.
    store.finishRun(run.id, "failed", { error: "late_failure" });

    const row = store.getRun(run.id);
    expect(row!.status).toBe("succeeded");
    const rows = store
      .listAudit({ run_id: run.id })
      .events.filter((entry) => entry.action === "run.finished");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.detail_json).status).toBe("succeeded");
  });

  it("writes run.finished audit rows for lease expiry and orphan sweeps", () => {
    const scopeId = seededScope();
    const leased = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 1,
    });
    store.expireDeadLeases(new Date(Date.now() + 1000));
    const orphaned = store.startRun({
      scope_id: scopeId,
      kind: "validate",
      lease_ttl_ms: 60_000,
    });
    store.expireOrphanedRuns();

    for (const id of [leased.id, orphaned.id]) {
      const rows = store
        .listAudit({ run_id: id })
        .events.filter((row) => row.action === "run.finished");
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.detail_json).status).toBe("failed");
    }
  });

  it("pages audit with before_id and honors run_id filtering", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    store.audit("svc:colonyd", "first", { run_id: run.id });
    store.finishRun(run.id, "succeeded");
    store.audit("svc:colonyd", "last", { run_id: run.id });

    const page = store.listAudit({ run_id: run.id });
    expect(page.events.map((row) => row.action)).toEqual([
      "first",
      "run.finished",
      "last",
    ]);
    expect(page.has_more).toBe(false);

    const first = store.listAudit({ run_id: run.id, limit: 2 });
    expect(first.events.map((row) => row.action)).toEqual([
      "run.finished",
      "last",
    ]);
    expect(first.has_more).toBe(true);
    const older = store.listAudit({
      run_id: run.id,
      before_id: first.oldest_id!,
    });
    expect(older.events.map((row) => row.action)).toEqual(["first"]);
  });

  it("startRun honors a pre-minted id and still mints uuids without one", () => {
    const scopeId = seededScope();
    const preMinted = crypto.randomUUID();
    const run = store.startRun({
      id: preMinted,
      scope_id: scopeId,
      kind: "architect",
      lease_ttl_ms: 60_000,
    });
    expect(run.id).toBe(preMinted);
    expect(store.getRun(preMinted)!.id).toBe(preMinted);

    const minted = store.startRun({
      scope_id: scopeId,
      kind: "architect",
      lease_ttl_ms: 60_000,
    });
    expect(minted.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(minted.id).not.toBe(preMinted);
  });

  it("dedupes observations by dedup_key", () => {
    expect(
      store.recordObservation("webhook", "k1", JSON.stringify({ a: 1 })),
    ).toBe(true);
    expect(
      store.recordObservation("webhook", "k1", JSON.stringify({ a: 2 })),
    ).toBe(false);
    expect(
      store.recordObservation("webhook", "k2", JSON.stringify({ a: 3 })),
    ).toBe(true);
  });

  it("starts and counts validate runs", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "validate",
      lease_ttl_ms: 1000,
    });
    expect(run.kind).toBe("validate");
    expect(store.getRun(run.id)!.kind).toBe("validate");
    expect(store.activeRunCount()).toBe(1);
    expect(store.activeRunCount("validate")).toBe(1);
  });

  it("persists model_id at run creation and defaults to null when omitted", () => {
    const scopeId = seededScope();
    const withModel = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 1000,
      model_id: "m1",
    });
    expect(store.getRun(withModel.id)!.model_id).toBe("m1");

    const withoutModel = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 1000,
    });
    expect(store.getRun(withoutModel.id)!.model_id).toBeNull();
  });

  it("setRunModel updates model_id, including on a finished run", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 1000,
      model_id: "m1",
    });
    store.setRunModel(run.id, "m2");
    expect(store.getRun(run.id)!.model_id).toBe("m2");

    const finished = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 1000,
    });
    store.finishRun(finished.id, "succeeded", {});
    expect(store.getRun(finished.id)!.status).toBe("succeeded");
    store.setRunModel(finished.id, "m2");
    expect(store.getRun(finished.id)!.model_id).toBe("m2");
  });

  it("counts active runs by model", () => {
    const scopeId = seededScope();
    const start = (modelId?: string) =>
      store.startRun({
        scope_id: scopeId,
        kind: "implement",
        lease_ttl_ms: 1000,
        ...(modelId === undefined ? {} : { model_id: modelId }),
      });

    start("m1");
    start("m1");
    start("m2");
    start();

    expect(store.activeRunCountByModel("m1")).toBe(2);
    expect(store.activeRunCountByModel("m2")).toBe(1);
    expect(store.activeRunCountByModel("m3")).toBe(0);

    const [m1First] = store
      .activeRuns("implement")
      .filter((r) => r.model_id === "m1");
    store.finishRun(m1First!.id, "succeeded", {});
    expect(store.activeRunCountByModel("m1")).toBe(1);
  });

  it("activeRunCountByModel follows setRunModel fallback rewrites", () => {
    const scopeId = seededScope();
    const run = store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 1000,
      model_id: "m1",
    });

    expect(store.activeRunCountByModel("m1")).toBe(1);
    store.setRunModel(run.id, "m2");
    expect(store.activeRunCountByModel("m1")).toBe(0);
    expect(store.activeRunCountByModel("m2")).toBe(1);
  });

  it("counts active runs by kind", () => {
    const scopeId = seededScope();
    store.startRun({
      scope_id: scopeId,
      kind: "implement",
      lease_ttl_ms: 1000,
    });
    store.startRun({
      scope_id: scopeId,
      kind: "merge_gate",
      lease_ttl_ms: 1000,
    });
    expect(store.activeRunCount()).toBe(2);
    expect(store.activeRunCount("implement")).toBe(1);
    expect(store.activeRunCount("merge_gate")).toBe(1);
  });

  it("reports whole-table scope tallies on project reads", () => {
    store.ensureProject("Solo");
    for (const status of [
      "active",
      "active",
      "done",
      "blocked",
      "draft",
    ] as const) {
      const id = store.createScope({
        goal: `scope ${status}`,
        provider_repo_id: "1",
        provider_repo_path: "so/x",
        project: "Wave one",
      }).id;
      if (status === "done") {
        store.setScopeStatus(id, "planning", "svc:colonyd");
        store.setScopeStatus(id, "active", "svc:colonyd");
        store.setScopeStatus(id, status, "svc:colonyd");
      } else if (status !== "draft") {
        store.setScopeStatus(id, "planning", "svc:colonyd");
        store.setScopeStatus(id, status, "svc:colonyd");
      }
    }

    const zeroCounts = () =>
      Object.fromEntries(SCOPE_STATUSES.map((s) => [s, 0])) as Record<
        ScopeStatus,
        number
      >;
    const expected = {
      ...zeroCounts(),
      draft: 1,
      active: 2,
      done: 1,
      blocked: 1,
    };
    expect(store.getProject("Wave one")!.status_counts).toEqual(expected);
    expect(store.getProject("Wave one")!.scope_count).toBe(5);
    expect(store.getProject("Solo")!.scope_count).toBe(0);
    expect(store.getProject("Solo")!.status_counts).toEqual(zeroCounts());

    // Pagination stays honest: total counts the whole table, not the page.
    const all = store.pageProjects(100, 0);
    expect(all.total).toBe(2);
    expect(all.projects.map((p) => p.name).sort()).toEqual([
      "Solo",
      "Wave one",
    ]);
    const wave = all.projects.find((p) => p.name === "Wave one")!;
    expect(wave.scope_count).toBe(5);
    expect(wave.status_counts).toEqual(expected);
    const solo = all.projects.find((p) => p.name === "Solo")!;
    expect(solo.scope_count).toBe(0);
    expect(solo.status_counts).toEqual(zeroCounts());

    // Narrow windows return one row while total still counts both projects.
    const firstPage = store.pageProjects(1, 0);
    const secondPage = store.pageProjects(1, 1);
    expect(firstPage.total).toBe(2);
    expect(secondPage.total).toBe(2);
    expect(firstPage.projects).toHaveLength(1);
    expect(secondPage.projects).toHaveLength(1);
  });

  it("orders projects stably by updated_at DESC then name", () => {
    // All three share an identical updated_at: only the name tiebreaker
    // can order them, so pages never shuffle between calls.
    const sameUpdated = "2026-01-01T00:00:00.000Z";
    for (const name of ["beta", "alpha", "gamma"]) {
      store.ensureProject(name);
      store.db
        .prepare(`UPDATE projects SET updated_at = ? WHERE name = ?`)
        .run(sameUpdated, name);
    }

    // Windowed by one: deterministic name-ascending slices.
    expect(store.pageProjects(1, 0).projects.map((p) => p.name)).toEqual([
      "alpha",
    ]);
    expect(store.pageProjects(1, 1).projects.map((p) => p.name)).toEqual([
      "beta",
    ]);
    expect(store.pageProjects(1, 2).projects.map((p) => p.name)).toEqual([
      "gamma",
    ]);

    // Both page windows are stable across repeated calls.
    expect(store.pageProjects(2, 0).projects.map((p) => p.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(store.pageProjects(2, 0).projects.map((p) => p.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(store.pageProjects(2, 1).projects.map((p) => p.name)).toEqual([
      "beta",
      "gamma",
    ]);
    expect(store.pageProjects(2, 1).projects.map((p) => p.name)).toEqual([
      "beta",
      "gamma",
    ]);
  });

  it("surfaces last_activity_at from the newest scope", () => {
    // A project with no scopes reports null.
    store.ensureProject("empty");
    store.db
      .prepare(`UPDATE projects SET updated_at = ? WHERE name = ?`)
      .run("2026-01-01T00:00:00.000Z", "empty");

    store.ensureProject("active-proj");
    store.db
      .prepare(`UPDATE projects SET updated_at = ? WHERE name = ?`)
      .run("2026-01-02T00:00:00.000Z", "active-proj");
    const older = store.createScope({
      goal: "older",
      provider_repo_id: "1",
      provider_repo_path: "so/x",
      project: "active-proj",
    }).id;
    const newer = store.createScope({
      goal: "newer",
      provider_repo_id: "1",
      provider_repo_path: "so/x",
      project: "active-proj",
    }).id;
    store.db
      .prepare(`UPDATE scopes SET updated_at = ? WHERE id = ?`)
      .run("2026-01-02T01:00:00.000Z", older);
    store.db
      .prepare(`UPDATE scopes SET updated_at = ? WHERE id = ?`)
      .run("2026-01-02T02:00:00.000Z", newer);

    const page = store.pageProjects(10, 0);
    expect(
      page.projects.find((p) => p.name === "active-proj")!.last_activity_at,
    ).toBe("2026-01-02T02:00:00.000Z");
    expect(
      page.projects.find((p) => p.name === "empty")!.last_activity_at,
    ).toBeNull();

    // Activity never drives order: a project whose scopes are newer than its
    // own updated_at still sorts by its own (older) updated_at.
    store.ensureProject("busy-scopes");
    store.db
      .prepare(`UPDATE projects SET updated_at = ? WHERE name = ?`)
      .run("2026-01-01T12:00:00.000Z", "busy-scopes");
    const busyScope = store.createScope({
      goal: "new scope",
      provider_repo_id: "1",
      provider_repo_path: "so/x",
      project: "busy-scopes",
    }).id;
    store.db
      .prepare(`UPDATE scopes SET updated_at = ? WHERE id = ?`)
      .run("2026-01-03T00:00:00.000Z", busyScope);

    // Sorted by projects.updated_at DESC: active-proj (01-02) before
    // busy-scopes (01-01T12) despite busy-scopes holding the newest scope.
    const ordered = store.pageProjects(10, 0).projects.map((p) => p.name);
    expect(ordered.indexOf("active-proj")).toBeLessThan(
      ordered.indexOf("busy-scopes"),
    );
  });

  it("returns an empty page with the true total beyond the end", () => {
    store.ensureProject("P1");
    store.ensureProject("P2");
    store.createScope({
      goal: "g1",
      provider_repo_id: "1",
      provider_repo_path: "so/x",
      project: "P1",
    });
    store.createScope({
      goal: "g2",
      provider_repo_id: "1",
      provider_repo_path: "so/x",
      project: "P1",
    });
    store.createScope({
      goal: "g3",
      provider_repo_id: "1",
      provider_repo_path: "so/x",
      project: "P2",
    });

    const beyondProjects = store.pageProjects(10, 2);
    expect(beyondProjects.projects).toEqual([]);
    expect(beyondProjects.total).toBe(2);
    const wayBeyond = store.pageProjects(10, 100);
    expect(wayBeyond.projects).toEqual([]);
    expect(wayBeyond.total).toBe(2);

    const beyondScopes = store.pageScopes(10, 3);
    expect(beyondScopes.scopes).toEqual([]);
    expect(beyondScopes.total).toBe(3);
    const beyondScopesP1 = store.pageScopes(10, 2, "P1");
    expect(beyondScopesP1.scopes).toEqual([]);
    expect(beyondScopesP1.total).toBe(2);
  });

  it("filters scopes to a project newest-first without leaking others", () => {
    const ids = {
      p1a: store.createScope({
        goal: "p1-a",
        provider_repo_id: "1",
        provider_repo_path: "so/x",
        project: "projA",
      }).id,
      p1b: store.createScope({
        goal: "p1-b",
        provider_repo_id: "1",
        provider_repo_path: "so/x",
        project: "projA",
      }).id,
      p2: store.createScope({
        goal: "p2",
        provider_repo_id: "1",
        provider_repo_path: "so/x",
        project: "projB",
      }).id,
    };
    store.db
      .prepare(`UPDATE scopes SET updated_at = ? WHERE id = ?`)
      .run("2026-01-01T00:00:00.000Z", ids.p1a);
    store.db
      .prepare(`UPDATE scopes SET updated_at = ? WHERE id = ?`)
      .run("2026-01-02T00:00:00.000Z", ids.p1b);
    store.db
      .prepare(`UPDATE scopes SET updated_at = ? WHERE id = ?`)
      .run("2026-01-03T00:00:00.000Z", ids.p2);

    const page = store.pageScopes(10, 0, "projA");
    // Newest-first (updated_at DESC), scoped to projA only.
    expect(page.scopes.map((s) => s.id)).toEqual([ids.p1b, ids.p1a]);
    expect(page.total).toBe(2);
    for (const scope of page.scopes) expect(scope.project_name).toBe("projA");
    expect(page.scopes.some((s) => s.id === ids.p2)).toBe(false);
  });
});

describe("legacy CHECK constraint migrations", () => {
  it("rebuilds pre-validating scopes and runs tables so new enum values are accepted", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "colony-legacy-"));
    const dbPath = join(legacyDir, "legacy.db");
    try {
      // Recreate the shape of a database from before 'validating' existed:
      // same tables, but the scopes CHECK lacks the new status.
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE scopes (
          id TEXT PRIMARY KEY,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','planning','active','blocked','done','abandoned')),
          provider_project_id TEXT NOT NULL,
          provider_project_path TEXT NOT NULL,
          default_branch TEXT NOT NULL DEFAULT 'main',
          plan_json TEXT,
          blocked_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL REFERENCES scopes(id),
          title TEXT NOT NULL,
          spec TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'queued',
          state_version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL REFERENCES scopes(id),
          task_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('architect','implement','merge_gate','review')),
          status TEXT NOT NULL DEFAULT 'running'
            CHECK (status IN ('running','succeeded','failed','canceled')),
          lease_expires_at TEXT NOT NULL,
          base_sha TEXT,
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO scopes (id, goal, status, provider_project_id, provider_project_path)
          VALUES ('col-legacy1', 'g', 'active', '1', 'so/x');
        INSERT INTO tasks (id, scope_id, title, spec, state)
          VALUES ('col-legacy1.1', 'col-legacy1', 't', 's', 'merged');
        INSERT INTO runs (id, scope_id, kind, lease_expires_at)
          VALUES ('run-legacy1', 'col-legacy1', 'implement', '2026-01-01T00:00:00Z');
      `);
      legacy.close();

      const migrated = new Store(dbPath);
      try {
        // The migration preserved rows and the FK relationship...
        const scope = migrated.getScope("col-legacy1");
        expect(scope?.status).toBe("active");
        expect(scope?.provider_repo_id).toBe("1");
        expect(scope?.provider_repo_path).toBe("so/x");
        expect(String(migrated.getTask("col-legacy1.1")?.scope_id)).toBe(
          "col-legacy1",
        );
        // ...and the rebuilt table accepts the new status.
        migrated.setScopeStatus("col-legacy1", "validating", "svc:test");
        expect(migrated.getScope("col-legacy1")?.status).toBe("validating");
        // The runs table accepts the new kind and kept legacy rows.
        expect(migrated.getRun("run-legacy1")?.kind).toBe("implement");
        const vrun = migrated.startRun({
          scope_id: "col-legacy1",
          kind: "validate",
          lease_ttl_ms: 1000,
        });
        expect(migrated.getRun(vrun.id)?.kind).toBe("validate");
        // Idempotent: reopening does not rebuild again or lose data.
        migrated.close();
        const reopened = new Store(dbPath);
        expect(reopened.getScope("col-legacy1")?.status).toBe("validating");
        reopened.close();
      } finally {
        // handled above
      }
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe("versioned migrations", () => {
  const tableColumns = (db: Store["db"], table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((c) => c.name)
      .sort();
  const userVersion = (db: Store["db"]) =>
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;

  it("stamps fresh databases at the latest version without replaying migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "colony-mig-"));
    try {
      const store = new Store(join(dir, "fresh.db"));
      expect(userVersion(store.db)).toBe(LATEST_SCHEMA_VERSION);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrated legacy databases match fresh schema per table and get stamped", () => {
    const dir = mkdtempSync(join(tmpdir(), "colony-mig-"));
    try {
      // Legacy: pre-versioning DB built from the old base DDL, no extras.
      const legacyPath = join(dir, "legacy.db");
      const legacy = new Database(legacyPath);
      legacy.exec(`
        CREATE TABLE scopes (
          id TEXT PRIMARY KEY,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','planning','active','blocked','done','abandoned')),
          provider_project_id TEXT NOT NULL,
          provider_project_path TEXT NOT NULL,
          default_branch TEXT NOT NULL DEFAULT 'main',
          plan_json TEXT,
          blocked_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL REFERENCES scopes(id),
          title TEXT NOT NULL,
          spec TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'queued',
          state_version INTEGER NOT NULL DEFAULT 0,
          branch TEXT,
          mr_iid INTEGER,
          attempt INTEGER NOT NULL DEFAULT 0,
          next_retry_at TEXT,
          blocked_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL REFERENCES scopes(id),
          task_id TEXT REFERENCES tasks(id),
          kind TEXT NOT NULL CHECK (kind IN ('architect','implement','merge_gate','review')),
          status TEXT NOT NULL DEFAULT 'running'
            CHECK (status IN ('running','succeeded','failed','canceled')),
          lease_expires_at TEXT NOT NULL,
          base_sha TEXT,
          head_sha TEXT,
          workspace_path TEXT,
          envelope_json TEXT,
          evidence_json TEXT,
          error TEXT,
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          finished_at TEXT
        );
      `);
      legacy.close();

      const migrated = new Store(legacyPath);
      const fresh = new Store(join(dir, "fresh.db"));
      try {
        expect(userVersion(migrated.db)).toBe(LATEST_SCHEMA_VERSION);
        expect(LATEST_SCHEMA_VERSION).toBe(7);
        for (const table of ["scopes", "tasks", "runs", "projects"]) {
          expect(tableColumns(migrated.db, table)).toEqual(
            tableColumns(fresh.db, table),
          );
        }
        // The run root span's trace_id persists on every generation of the
        // runs table: fresh DDL and migration 3's ALTER TABLE agree.
        expect(tableColumns(store.db, "runs")).toContain("trace_id");
        expect(tableColumns(migrated.db, "runs")).toContain("trace_id");
        expect(tableColumns(fresh.db, "runs")).toContain("trace_id");
        // The task cost-prediction blob column exists on every generation:
        // fresh DDL and migration 4's ALTER TABLE agree.
        expect(tableColumns(store.db, "tasks")).toContain(
          "cost_prediction_json",
        );
        expect(tableColumns(migrated.db, "tasks")).toContain(
          "cost_prediction_json",
        );
        expect(tableColumns(fresh.db, "tasks")).toContain(
          "cost_prediction_json",
        );
        // A short-lived `initiative` column is renamed, not duplicated.
        const renamed = new Database(join(dir, "renamed.db"));
        renamed.exec(
          `CREATE TABLE scopes (id TEXT PRIMARY KEY, goal TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','planning','active','validating','blocked','done','abandoned')),
            provider_project_id TEXT NOT NULL, provider_project_path TEXT NOT NULL,
            default_branch TEXT NOT NULL DEFAULT 'main', plan_json TEXT, blocked_reason TEXT,
            initiative TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
           CREATE TABLE tasks (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
            title TEXT NOT NULL, spec TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
            state_version INTEGER NOT NULL DEFAULT 0);
           CREATE TABLE runs (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
            task_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('architect','implement','merge_gate','review','validate')),
            status TEXT NOT NULL DEFAULT 'running', lease_expires_at TEXT NOT NULL);`,
        );
        renamed.close();
        const renamedStore = new Store(join(dir, "renamed.db"));
        const cols = tableColumns(renamedStore.db, "scopes");
        expect(cols).toContain("project_name");
        expect(cols).not.toContain("initiative");
        expect(cols).not.toContain("group");
        renamedStore.close();

        // A pre-versioning DB from the "group"-era (user_version=0, real
        // "group" column with operator data, never had `initiative`):
        // legacyReconcile must rename "group" rather than strand its values.
        const groupEra = new Database(join(dir, "group-era.db"));
        groupEra.exec(
          `CREATE TABLE scopes (id TEXT PRIMARY KEY, goal TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','planning','active','blocked','done','abandoned')),
            provider_project_id TEXT NOT NULL, provider_project_path TEXT NOT NULL,
            default_branch TEXT NOT NULL DEFAULT 'main', plan_json TEXT, blocked_reason TEXT,
            "group" TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
           CREATE TABLE tasks (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
            title TEXT NOT NULL, spec TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
            state_version INTEGER NOT NULL DEFAULT 0);
           CREATE TABLE runs (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
            task_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('architect','implement','merge_gate','review')),
            status TEXT NOT NULL DEFAULT 'running', lease_expires_at TEXT NOT NULL);
           INSERT INTO scopes (id, goal, "group", provider_project_id, provider_project_path)
             VALUES ('col-grpa', 'g1', 'Wave one', '9', 'so/grp');
           INSERT INTO scopes (id, goal, provider_project_id, provider_project_path)
             VALUES ('col-grpb', 'g2', '10', 'so/grp');`,
        );
        groupEra.close();
        const groupEraStore = new Store(join(dir, "group-era.db"));
        const grpCols = tableColumns(groupEraStore.db, "scopes");
        expect(grpCols).toContain("project_name");
        expect(grpCols).not.toContain("group");
        expect(groupEraStore.getScope("col-grpa")?.project_name).toBe(
          "Wave one",
        );
        expect(groupEraStore.getScope("col-grpb")?.project_name).toBeNull();
        expect(groupEraStore.getProject("Wave one")).toMatchObject({
          name: "Wave one",
          context_doc: null,
        });
        expect(groupEraStore.listProjects().map((p) => p.name)).toEqual([
          "Wave one",
        ]);
        groupEraStore.close();

        // A version-1 DB (post legacy-reconcile, pre migration 2) converges:
        // "group" values become projects rows and the scope points at one.
        const v1 = new Database(join(dir, "v1.db"));
        v1.exec(
          `CREATE TABLE scopes (id TEXT PRIMARY KEY, goal TEXT NOT NULL,
            title TEXT, "group" TEXT, approvals TEXT NOT NULL DEFAULT 'auto',
            status TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','planning','active','validating','blocked','done','abandoned')),
            provider_project_id TEXT NOT NULL, provider_project_path TEXT NOT NULL,
            default_branch TEXT NOT NULL DEFAULT 'main', plan_json TEXT, plan_feedback TEXT,
            acceptance_json TEXT, blocked_reason TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
           INSERT INTO scopes (id, goal, "group", provider_project_id, provider_project_path)
             VALUES ('col-v1a', 'g1', 'Wave one', '7', 'so/v1');
           INSERT INTO scopes (id, goal, provider_project_id, provider_project_path)
             VALUES ('col-v1b', 'g2', '8', 'so/v1');`,
        );
        v1.exec(`PRAGMA user_version = 1`);
        v1.close();
        const v1Store = new Store(join(dir, "v1.db"));
        const v1Scope = v1Store.getScope("col-v1a");
        expect(v1Scope?.project_name).toBe("Wave one");
        expect(v1Scope?.provider_repo_id).toBe("7");
        expect(v1Scope?.provider_repo_path).toBe("so/v1");
        expect(v1Store.getScope("col-v1b")?.project_name).toBeNull();
        expect(v1Store.getProject("Wave one")).toMatchObject({
          name: "Wave one",
          context_doc: null,
        });
        expect(v1Store.getProject("Wave one")?.created_at).toBe(
          v1Store.getProject("Wave one")?.updated_at,
        );
        expect(v1Store.listProjects().map((p) => p.name)).toEqual(["Wave one"]);
        v1Store.close();
      } finally {
        migrated.close();
        fresh.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migration 6 creates the append-only run_artifacts table on legacy databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "colony-mig6-"));
    try {
      // A version-5 database: created fresh, then downgraded by dropping the
      // migration-6 table and stamping user_version=5.
      const v5Path = join(dir, "v5.db");
      const v5 = new Store(v5Path);
      v5.close();
      const downgrade = new Database(v5Path);
      downgrade.exec(
        `DROP TABLE run_artifacts;
         PRAGMA user_version = 5;`,
      );
      downgrade.close();

      const migrated = new Store(v5Path);
      try {
        expect(userVersion(migrated.db)).toBe(LATEST_SCHEMA_VERSION);
        expect(tableColumns(migrated.db, "run_artifacts")).toEqual([
          "bytes",
          "content_type",
          "created_at",
          "id",
          "key",
          "kind",
          "ref",
          "run_id",
          "sha256",
        ]);
        expect(
          migrated.db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='run_artifacts' ORDER BY name`,
            )
            .all()
            .map((r) => (r as { name: string }).name),
        ).toEqual(["run_artifacts_no_delete", "run_artifacts_no_update"]);
        const fresh = new Store(join(dir, "fresh.db"));
        expect(tableColumns(fresh.db, "run_artifacts")).toEqual(
          tableColumns(migrated.db, "run_artifacts"),
        );
        fresh.close();
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("project files", () => {
  it("createProject rejects a duplicate name with DomainStateError", () => {
    store.createProject({ name: "alpha", context_doc: null });
    expect(() =>
      store.createProject({ name: "alpha", context_doc: "doc" }),
    ).toThrow(DomainStateError);
  });

  it("createProjectFile enforces (project_name, filename) uniqueness", () => {
    store.createProject({ name: "p", context_doc: null });
    store.createProjectFile({
      project_name: "p",
      filename: "notes.md",
      media_type: "text/markdown",
      content: "hello",
    });
    expect(() =>
      store.createProjectFile({
        project_name: "p",
        filename: "notes.md",
        media_type: "text/markdown",
        content: "again",
      }),
    ).toThrow(/file exists: notes\.md/);
    // Same filename under a different project is allowed.
    store.createProject({ name: "q", context_doc: null });
    expect(() =>
      store.createProjectFile({
        project_name: "q",
        filename: "notes.md",
        media_type: "text/markdown",
        content: "other",
      }),
    ).not.toThrow();
  });

  it("createProjectFile on an unknown project throws DomainStateError", () => {
    expect(() =>
      store.createProjectFile({
        project_name: "nope",
        filename: "a.txt",
        media_type: "text/plain",
        content: "x",
      }),
    ).toThrow(DomainStateError);
  });

  it("deleting a project cascades to its files", () => {
    store.createProject({ name: "p", context_doc: null });
    store.createProjectFile({
      project_name: "p",
      filename: "a.txt",
      media_type: "text/plain",
      content: "x",
    });
    store.createProjectFile({
      project_name: "p",
      filename: "b.md",
      media_type: "text/markdown",
      content: "y",
    });
    expect(store.listProjectFiles("p")).toHaveLength(2);
    store.db.prepare(`DELETE FROM projects WHERE name = ?`).run("p");
    expect(store.listProjectFiles("p")).toEqual([]);
    const { n } = store.db
      .prepare(`SELECT COUNT(*) AS n FROM project_files`)
      .get() as { n: number };
    expect(n).toBe(0);
  });

  it("listProjectFiles returns [] for an unknown project and orders by filename", () => {
    expect(store.listProjectFiles("missing")).toEqual([]);
    store.createProject({ name: "p", context_doc: null });
    store.createProjectFile({
      project_name: "p",
      filename: "b.md",
      media_type: "text/markdown",
      content: "b",
    });
    store.createProjectFile({
      project_name: "p",
      filename: "a.txt",
      media_type: "text/plain",
      content: "a",
    });
    expect(store.listProjectFiles("p").map((f) => f.filename)).toEqual([
      "a.txt",
      "b.md",
    ]);
  });

  it("pageProjectFiles returns metadata without content and honest totals", () => {
    store.createProject({ name: "p", context_doc: null });
    for (let i = 0; i < 5; i += 1) {
      store.createProjectFile({
        project_name: "p",
        filename: `f${i}.txt`,
        media_type: "text/plain",
        content: `content ${i}`,
      });
    }
    const page = store.pageProjectFiles("p", 2, 1);
    expect(page.total).toBe(5);
    expect(page.files).toHaveLength(2);
    expect(page.files.map((f) => f.filename)).toEqual(["f1.txt", "f2.txt"]);
    expect(page.files[0]).not.toHaveProperty("content");
    expect(page.files[0]).not.toHaveProperty("project_name");
    expect(page.files[0]).toHaveProperty("sha256");
    expect(page.files[0]).toHaveProperty("byte_size");
  });

  it("replaceProjectFile updates content and metadata; unknown returns undefined", () => {
    store.createProject({ name: "p", context_doc: null });
    const created = store.createProjectFile({
      project_name: "p",
      filename: "a.txt",
      media_type: "text/plain",
      content: "old",
    });
    const replaced = store.replaceProjectFile("p", created.id, {
      media_type: "text/markdown",
      content: "new content",
    })!;
    expect(replaced.content).toBe("new content");
    expect(replaced.media_type).toBe("text/markdown");
    expect(replaced.byte_size).toBe(Buffer.byteLength("new content"));
    expect(replaced.sha256).not.toBe(created.sha256);
    expect(
      store.replaceProjectFile("p", "pf-000000000000", {
        media_type: "text/plain",
        content: "x",
      }),
    ).toBeUndefined();
  });

  it("deleteProjectFile removes a row and reports not-found", () => {
    store.createProject({ name: "p", context_doc: null });
    const created = store.createProjectFile({
      project_name: "p",
      filename: "a.txt",
      media_type: "text/plain",
      content: "x",
    });
    expect(store.deleteProjectFile("p", created.id)).toBe(true);
    expect(store.deleteProjectFile("p", created.id)).toBe(false);
    expect(store.listProjectFiles("p")).toEqual([]);
  });

  it("projectRepositories returns distinct repos ordered by path", () => {
    store.createProject({ name: "p", context_doc: null });
    store.createScope({
      goal: "g1",
      provider_repo_id: "1",
      provider_repo_path: "so/z",
      project: "p",
    });
    store.createScope({
      goal: "g2",
      provider_repo_id: "2",
      provider_repo_path: "so/a",
      project: "p",
    });
    // Identical (id, path) pair from a second scope collapses to one row.
    store.createScope({
      goal: "g3",
      provider_repo_id: "2",
      provider_repo_path: "so/a",
      project: "p",
    });
    expect(store.projectRepositories("p")).toEqual([
      { repo_id: "2", repo_path: "so/a" },
      { repo_id: "1", repo_path: "so/z" },
    ]);
    expect(store.projectRepositories("missing")).toEqual([]);
  });

  it("getProject and pageProjects expose file_count, file_bytes, repositories", () => {
    store.createProject({ name: "p", context_doc: null });
    store.createProjectFile({
      project_name: "p",
      filename: "a.txt",
      media_type: "text/plain",
      content: "hello",
    });
    store.createProjectFile({
      project_name: "p",
      filename: "b.md",
      media_type: "text/markdown",
      content: "world",
    });
    store.createScope({
      goal: "g",
      provider_repo_id: "1",
      provider_repo_path: "so/p",
      project: "p",
    });
    const detail = store.getProject("p")!;
    expect(detail.file_count).toBe(2);
    expect(detail.file_bytes).toBe(
      Buffer.byteLength("hello") + Buffer.byteLength("world"),
    );
    expect(detail.repositories).toEqual([{ repo_id: "1", repo_path: "so/p" }]);
    const page = store.pageProjects(10, 0);
    const row = page.projects.find((x) => x.name === "p")!;
    expect(row.file_count).toBe(2);
    expect(row.file_bytes).toBe(detail.file_bytes);
    expect(row.repositories).toEqual([{ repo_id: "1", repo_path: "so/p" }]);
    // A project with no files reports zeros and empty repos.
    store.createProject({ name: "empty", context_doc: null });
    const empty = store.getProject("empty")!;
    expect(empty.file_count).toBe(0);
    expect(empty.file_bytes).toBe(0);
    expect(empty.repositories).toEqual([]);
  });
});

describe("project running", () => {
  /** Scope in `status`, owned by `project`, holding one task per title. */
  function scopeWithTasks(
    project: string,
    titles: readonly string[],
    status: ScopeStatus = "active",
    goal = "goal",
  ): { scope_id: string; task_ids: string[] } {
    const scope_id = store.createScope({
      goal,
      title: null,
      provider_repo_id: "1",
      provider_repo_path: "so/x",
      project,
    }).id;
    store.setScopeStatus(scope_id, "planning", "svc:colonyd");
    const task_ids = store
      .materializePlan(
        scope_id,
        plan({
          tasks: titles.map((title) => ({
            title,
            spec: `do ${title}`,
            depends_on: [],
          })),
        }),
        "svc:colonyd",
      )
      .map((task) => String(task.id));
    if (status !== "active") {
      store.setScopeStatus(scope_id, status, "svc:colonyd");
    }
    return { scope_id, task_ids };
  }

  /** Walk a task queued -> running -> (mr_open), returning the new version. */
  function advanceTask(taskId: string, to: "running" | "mr_open"): number {
    const running = store.transitionTask(taskId, 0, "running", "svc:colonyd");
    if (to === "running") return running.state_version;
    return store.transitionTask(
      taskId,
      running.state_version,
      "mr_open",
      "svc:colonyd",
    ).state_version;
  }

  function terminateTask(taskId: string, to: "merged" | "canceled"): void {
    const mrOpen = store.transitionTask(taskId, 0, "running", "svc:colonyd");
    const open = store.transitionTask(
      taskId,
      mrOpen.state_version,
      "mr_open",
      "svc:colonyd",
    );
    store.transitionTask(taskId, open.state_version, to, "svc:colonyd");
  }

  it("joins each in-flight task with its newest run of any kind", () => {
    const { scope_id, task_ids } = scopeWithTasks(
      "wave",
      ["Running", "NoRuns", "MultiKind"],
      "active",
      "a goal long enough to be the label",
    );
    advanceTask(task_ids[0]!, "running");
    advanceTask(task_ids[1]!, "running");
    advanceTask(task_ids[2]!, "mr_open");

    const running = store.startRun({
      scope_id,
      task_id: task_ids[0],
      kind: "implement",
      lease_ttl_ms: 60_000,
      model_id: "model-a",
    });
    // The newest run wins even though an older run of another kind exists.
    const older = store.startRun({
      scope_id,
      task_id: task_ids[2],
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    store.db
      .prepare(`UPDATE runs SET started_at = ? WHERE id = ?`)
      .run("2026-01-01T00:00:00.000Z", older.id);
    const newest = store.startRun({
      scope_id,
      task_id: task_ids[2],
      kind: "review",
      lease_ttl_ms: 60_000,
      model_id: "model-b",
    });
    store.db
      .prepare(`UPDATE runs SET started_at = ? WHERE id = ?`)
      .run("2026-01-03T00:00:00.000Z", newest.id);

    const rows = store.listProjectRunning("wave");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
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
      // The scope has no title, so the goal carries the label.
      expect(row.scope_title).toBe("a goal long enough to be the label");
    }

    const byTask = new Map(rows.map((row) => [row.task_id, row]));
    expect(byTask.get(task_ids[1]!)!.run).toBeNull();

    const single = byTask.get(task_ids[0]!)!.run!;
    expect(single).toEqual({
      id: running.id,
      kind: "implement",
      status: "running",
      model_id: "model-a",
      started_at: running.started_at,
    });

    const multi = byTask.get(task_ids[2]!)!.run!;
    expect(multi.id).toBe(newest.id);
    expect(multi.kind).toBe("review");
    expect(multi.model_id).toBe("model-b");
    expect(multi.started_at).toBe("2026-01-03T00:00:00.000Z");
  });

  it("orders rows newest-activity-first with tasks lacking a run last", () => {
    const first = scopeWithTasks("wave", ["A"]);
    const second = scopeWithTasks("wave", ["B", "C"]);
    advanceTask(first.task_ids[0]!, "mr_open");
    advanceTask(second.task_ids[0]!, "running");
    advanceTask(second.task_ids[1]!, "running");

    const oldest = store.startRun({
      scope_id: first.scope_id,
      task_id: first.task_ids[0],
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    const middle = store.startRun({
      scope_id: second.scope_id,
      task_id: second.task_ids[0],
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    for (const [run, at] of [
      [oldest, "2026-01-01T00:00:00.000Z"],
      [middle, "2026-01-02T00:00:00.000Z"],
    ] as const) {
      store.db
        .prepare(`UPDATE runs SET started_at = ? WHERE id = ?`)
        .run(at, run.id);
    }

    const rows = store.listProjectRunning("wave");
    expect(rows.map((row) => row.task_id)).toEqual([
      second.task_ids[0]!,
      first.task_ids[0]!,
      second.task_ids[1]!,
    ]);
    // Tasks with no run sort last, and the ordering is stable across calls.
    expect(rows[2]!.run).toBeNull();
    expect(store.listProjectRunning("wave").map((row) => row.task_id)).toEqual(
      rows.map((row) => row.task_id),
    );
  });

  it("excludes idle and terminal tasks and tasks under terminal scopes", () => {
    const live = scopeWithTasks("wave", [
      "Running",
      "Queued",
      "Blocked",
      "Merged",
      "Canceled",
    ]);
    advanceTask(live.task_ids[0]!, "running");
    // `queued` and `blocked` are idle: the console surfaces them as tallies.
    const blocked = store.transitionTask(
      live.task_ids[2]!,
      0,
      "running",
      "svc:colonyd",
    );
    store.transitionTask(
      live.task_ids[2]!,
      blocked.state_version,
      "blocked",
      "svc:colonyd",
    );
    terminateTask(live.task_ids[3]!, "merged");
    terminateTask(live.task_ids[4]!, "canceled");

    const abandoned = scopeWithTasks("wave", ["Abandoned"]);
    advanceTask(abandoned.task_ids[0]!, "running");
    store.setScopeStatus(abandoned.scope_id, "abandoned", "svc:colonyd");

    const done = scopeWithTasks("wave", ["Done"]);
    advanceTask(done.task_ids[0]!, "running");
    store.setScopeStatus(done.scope_id, "validating", "svc:colonyd");
    store.setScopeStatus(done.scope_id, "done", "svc:colonyd");

    // Only the running task of the active scope survives.
    const rows = store.listProjectRunning("wave");
    expect(rows.map((row) => row.task_title)).toEqual(["Running"]);
    expect(rows[0]!.task_state).toBe("running");
  });

  it("returns [] for a project with unknown or only terminal scopes", () => {
    expect(store.listProjectRunning("ghost")).toEqual([]);

    store.ensureProject("settled");
    expect(store.listProjectRunning("settled")).toEqual([]);

    const done = scopeWithTasks("settled", ["Running"]);
    advanceTask(done.task_ids[0]!, "running");
    store.setScopeStatus(done.scope_id, "validating", "svc:colonyd");
    store.setScopeStatus(done.scope_id, "done", "svc:colonyd");
    expect(store.listProjectRunning("settled")).toEqual([]);
  });

  it("zero-fills getProject task_state_counts across every TASK_STATES key", () => {
    const zeroCounts = () =>
      Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as Record<
        TaskState,
        number
      >;
    store.createProject({ name: "empty", context_doc: null });
    expect(store.getProject("empty")!.task_state_counts).toEqual(zeroCounts());

    const live = scopeWithTasks("wave", [
      "Queued",
      "Running",
      "Merged",
      "Blocked",
      "Canceled",
      "MrOpen",
    ]);
    advanceTask(live.task_ids[1]!, "running");
    const blocked = store.transitionTask(
      live.task_ids[3]!,
      0,
      "running",
      "svc:colonyd",
    );
    store.transitionTask(
      live.task_ids[3]!,
      blocked.state_version,
      "blocked",
      "svc:colonyd",
    );
    terminateTask(live.task_ids[2]!, "merged");
    terminateTask(live.task_ids[4]!, "canceled");
    advanceTask(live.task_ids[5]!, "mr_open");

    // Terminal scopes still contribute their tasks: tallies count everything.
    const done = scopeWithTasks("wave", ["UnderDone"]);
    store.setScopeStatus(done.scope_id, "validating", "svc:colonyd");
    store.setScopeStatus(done.scope_id, "done", "svc:colonyd");

    const expected = {
      ...zeroCounts(),
      queued: 2,
      running: 1,
      mr_open: 1,
      merged: 1,
      blocked: 1,
      canceled: 1,
    };
    expect(store.getProject("wave")!.task_state_counts).toEqual(expected);
    expect(
      Object.keys(store.getProject("wave")!.task_state_counts).sort(),
    ).toEqual([...TASK_STATES].sort());

    const page = store.pageProjects(10, 0);
    expect(
      page.projects.find((p) => p.name === "wave")!.task_state_counts,
    ).toEqual(expected);
    expect(
      page.projects.find((p) => p.name === "empty")!.task_state_counts,
    ).toEqual(zeroCounts());
  });
});

describe("run artifacts", () => {
  function createRun(goal: string): string {
    const scope = store.createScope({
      goal,
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
    });
    return store.startRun({
      scope_id: scope.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    }).id;
  }

  it("records artifact rows with defaults and reads them back", () => {
    const runId = createRun("artifact rows");
    const row = store.recordRunArtifact(runId, {
      kind: "log",
      key: "runs/r1/log.txt",
      ref: "runs/r1/log.txt",
      sha256: "abc123",
      bytes: 42,
      contentType: "text/plain",
    });
    expect(row.id).toMatch(/^ra-[0-9a-f]{12}$/);
    expect(row.run_id).toBe(runId);
    expect(row.kind).toBe("log");
    expect(row.key).toBe("runs/r1/log.txt");
    expect(row.ref).toBe("runs/r1/log.txt");
    expect(row.sha256).toBe("abc123");
    expect(row.bytes).toBe(42);
    expect(row.content_type).toBe("text/plain");
    expect(row.created_at).toBeTruthy();
    const fetched = store.getRunArtifact(runId, row.id);
    expect(fetched).toEqual(row);
  });

  it("lists a run's artifacts with the paginated envelope", () => {
    const runId = createRun("artifact pagination");
    const otherRun = createRun("other run");
    // created_at has millisecond resolution and recordRunArtifact does not
    // take a timestamp; busy-wait one clock tick between inserts so each
    // row's created_at differs.
    const tick = (): void => {
      const t = Date.now();
      while (Date.now() === t) {}
    };
    for (let i = 1; i <= 5; i++) {
      store.recordRunArtifact(runId, {
        kind: "file",
        key: `k${i}`,
        ref: `k${i}`,
      });
      tick();
    }
    store.recordRunArtifact(otherRun, { kind: "file", key: "x", ref: "x" });

    const page = store.listRunArtifacts(runId);
    expect(page.total).toBe(5);
    expect(page.limit).toBe(200);
    expect(page.offset).toBe(0);
    expect(page.items).toHaveLength(5);
    // Ascending (created_at, id): insertion order.
    expect(page.items.map((r) => r.key)).toEqual([
      "k1",
      "k2",
      "k3",
      "k4",
      "k5",
    ]);

    const window = store.listRunArtifacts(runId, { limit: 2, offset: 1 });
    expect(window.items).toHaveLength(2);
    expect(window.limit).toBe(2);
    expect(window.offset).toBe(1);
    expect(window.total).toBe(5);
    // The window is a slice of the same creation order.
    expect(window.items.map((r) => r.key)).toEqual(["k2", "k3"]);

    // Limit clamps like every other paginated store API.
    expect(store.listRunArtifacts(runId, { limit: 5000 }).limit).toBe(1000);
    expect(store.listRunArtifacts(runId, { limit: 0 }).limit).toBe(1);
  });

  it("getRunArtifact scopes by run and returns undefined when unknown", () => {
    const runA = createRun("scope a");
    const runB = createRun("scope b");
    const row = store.recordRunArtifact(runA, {
      kind: "file",
      key: "k",
      ref: "k",
    });
    expect(store.getRunArtifact(runB, row.id)).toBeUndefined();
    expect(store.getRunArtifact(runA, "ra-missing")).toBeUndefined();
  });

  it("enforces append-only: UPDATE and DELETE abort", () => {
    const runId = createRun("append only");
    const row = store.recordRunArtifact(runId, {
      kind: "file",
      key: "k",
      ref: "k",
    });
    expect(() =>
      store.db
        .prepare(`UPDATE run_artifacts SET key = 'tampered' WHERE id = ?`)
        .run(row.id),
    ).toThrow(/run_artifacts is append-only/);
    expect(() =>
      store.db.prepare(`DELETE FROM run_artifacts WHERE id = ?`).run(row.id),
    ).toThrow(/run_artifacts is append-only/);
  });

  it("rejects artifact rows for unknown runs (foreign key)", () => {
    expect(() =>
      store.recordRunArtifact("no-such-run", {
        kind: "file",
        key: "k",
        ref: "k",
      }),
    ).toThrow(/FOREIGN KEY/);
  });
});
