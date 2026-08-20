import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { DomainStateError } from "@colony/domain";
import { LATEST_SCHEMA_VERSION } from "../src/migrations.js";
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
      ["validating", "planning"],
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
    expect(String(tasks[0]!.id)).toBe(`${scopeId}.1`);
    expect(String(tasks[1]!.id)).toBe(`${scopeId}.2`);
    expect(store.getScope(scopeId)!.status).toBe("active");
    expect(store.taskDeps(tasks[1]!.id)).toEqual([tasks[0]!.id]);
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
        for (const table of ["scopes", "tasks", "runs"]) {
          expect(tableColumns(migrated.db, table)).toEqual(
            tableColumns(fresh.db, table),
          );
        }
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
        expect(cols).toContain("group");
        expect(cols).not.toContain("initiative");
        renamedStore.close();
      } finally {
        migrated.close();
        fresh.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
