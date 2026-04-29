import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TaskGraphRepository, createPool, type Pool } from "@colony/db";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import {
  createRecordTaskConflict,
  createResolveTaskConflict,
} from "./task-conflict.js";

const TEST_URL = process.env.COLONY_TEST_DATABASE_URL;

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

const SCOPE_ID = "col-cnf01" as ScopeId;
const TASK_ID = "col-cnf01.1" as TaskId;
const SUPERVISOR = "svc:supervisor" as ActorId;
const HUMAN = "user:so" as ActorId;

/**
 * COL-3.4 integration tests for task conflict state + resolution.
 */
describe.runIf(TEST_URL)("task conflict handling", () => {
  const databaseUrl = TEST_URL!;
  let pool: Pool;
  let repo: TaskGraphRepository;

  beforeAll(async () => {
    const bootstrap = new Client({ connectionString: databaseUrl });
    await bootstrap.connect();
    await bootstrap.query("DROP SCHEMA public CASCADE");
    await bootstrap.query("CREATE SCHEMA public");
    await bootstrap.query("GRANT ALL ON SCHEMA public TO public");
    await bootstrap.end();
    await runner({
      databaseUrl,
      dir: MIGRATIONS_DIR,
      migrationsTable: "pgmigrations",
      direction: "up",
      log: () => {},
    });
    pool = createPool({ connectionString: databaseUrl, role: "colony_writer" });
    repo = new TaskGraphRepository(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    const cleanup = new Client({ connectionString: databaseUrl });
    await cleanup.connect();
    try {
      await cleanup.query(
        `TRUNCATE
           task_dependencies, assignments, reviews, approvals,
           agent_runs, events, audit_log, artifacts, tasks, scopes
         RESTART IDENTITY CASCADE`,
      );
    } finally {
      await cleanup.end();
    }
  });

  it("records a conflict and transitions task state", async () => {
    await seed("review_requested");
    const record = createRecordTaskConflict({ repo });
    const result = await record({
      task_id: TASK_ID,
      kind: "manual_merge",
      evidence: { observed_merge_sha: "deadbeef" },
    });
    expect(result.applied).toBe(true);
    expect((result as { new_state: string }).new_state).toBe("conflict");
    const task = await repo.getTask(TASK_ID);
    expect(task!.state).toBe("conflict");
    const audit = await audited(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "task.conflict.recorded")).toBe(true);
  });

  it("is idempotent when called twice on a task already in conflict", async () => {
    await seed("review_requested");
    const record = createRecordTaskConflict({ repo });
    await record({ task_id: TASK_ID, kind: "manual_merge" });
    const second = await record({ task_id: TASK_ID, kind: "manual_merge" });
    expect(second.applied).toBe(true);
    const audit = await audited(pool, SCOPE_ID);
    expect(
      audit.filter((a) => a.action === "task.conflict.recorded"),
    ).toHaveLength(1);
    expect(audit.some((a) => a.action === "task.conflict.observed")).toBe(true);
  });

  it("refuses to mark a fresh `ready` task as conflict (state machine guard)", async () => {
    await seed("ready");
    const record = createRecordTaskConflict({ repo });
    const result = await record({ task_id: TASK_ID, kind: "label_drift" });
    expect(result.applied).toBe(false);
  });

  it("resolveTaskConflict requeues a conflict task back to ready", async () => {
    await seed("review_requested");
    const record = createRecordTaskConflict({ repo });
    await record({ task_id: TASK_ID, kind: "stale_commit_approval" });
    const resolve = createResolveTaskConflict({ repo });
    const result = await resolve({
      task_id: TASK_ID,
      action: "requeue_ready",
      actor: HUMAN,
      reason: "operator handled the stale approval",
    });
    expect(result.applied).toBe(true);
    expect((result as { new_state: string }).new_state).toBe("ready");
    const task = await repo.getTask(TASK_ID);
    expect(task!.state).toBe("ready");
    const audit = await audited(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "task.conflict.resolved")).toBe(true);
  });

  async function seed(state: "ready" | "review_requested"): Promise<void> {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "Conflict scope",
        description: "Task conflict integration test scope.",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: TASK_ID,
        scope_id: SCOPE_ID,
        title: "Conflict task",
        description: "test",
        acceptance_criteria: ["x"],
        state,
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
  }
});

async function audited(
  pool: Pool,
  scopeId: ScopeId,
): Promise<ReadonlyArray<{ action: string }>> {
  const { rows } = await pool.query<{ action: string }>(
    `SELECT action FROM audit_log
     WHERE scope_id = $1
     ORDER BY recorded_at`,
    [scopeId],
  );
  return rows;
}
