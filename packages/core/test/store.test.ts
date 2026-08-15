import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainStateError } from "@colony/domain";
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import {
  Store,
  assertScopeTransition,
  assertTaskTransition,
  retryBackoffMs,
  type Task,
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
      ["running", "mr_open"],
      ["running", "queued"],
      ["running", "blocked"],
      ["mr_open", "merged"],
      ["mr_open", "queued"],
      ["mr_open", "blocked"],
      ["blocked", "queued"],
      ["queued", "canceled"],
      ["running", "canceled"],
      ["mr_open", "canceled"],
      ["blocked", "canceled"],
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
      ["queued", "merged"],
      ["queued", "blocked"],
      ["queued", "queued"],
      ["running", "merged"],
      ["mr_open", "running"],
      ["merged", "queued"],
      ["merged", "blocked"],
      ["merged", "canceled"],
      ["canceled", "queued"],
      ["blocked", "running"],
      ["blocked", "merged"],
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
      ["blocked", "planning"],
      ["blocked", "active"],
      ["draft", "abandoned"],
      ["planning", "abandoned"],
      ["active", "abandoned"],
      ["blocked", "abandoned"],
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
      ["active", "planning"],
      ["done", "active"],
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
    provider_project_id: "42",
    provider_project_path: "so/test",
  });
  return scope.id;
}

describe("Store", () => {
  it("creates scopes and materializes a plan into tasks + deps", () => {
    const scopeId = seededScope();
    store.setScopeStatus(scopeId, "planning", "svc:colonyd");
    const tasks = store.materializePlan(scopeId, plan(), "svc:colonyd");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.id).toBe(`${scopeId}.1`);
    expect(tasks[1]!.id).toBe(`${scopeId}.2`);
    expect(store.getScope(scopeId)!.status).toBe("active");
    expect(store.taskDeps(tasks[1]!.id)).toEqual([tasks[0]!.id]);
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
      store.transitionTask(a!.id, 0, "merged", "svc:colonyd"),
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
    expect(store.listAudit()).toHaveLength(1);
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
});
