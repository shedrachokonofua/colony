import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TaskGraphRepository, createPool, type Pool } from "@colony/db";
import type { ActorId, ScopeId, TaskId, TaskState } from "@colony/domain";
import {
  createCloseScope,
  createEvaluateScopeCloseReadiness,
  createRequestScopeReview,
} from "./scope-close.js";

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

const SCOPE_ID = "col-cls01" as ScopeId;
const TASK_A = "col-cls01.1" as TaskId;
const TASK_B = "col-cls01.2" as TaskId;
const SUPERVISOR = "svc:supervisor" as ActorId;
const HUMAN = "user:so" as ActorId;

/**
 * COL-3.5b integration tests for scope close readiness + closure.
 */
describe.runIf(TEST_URL)("scope close lifecycle", () => {
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

  it("evaluateScopeCloseReadiness reports blockers per kind", async () => {
    await seed("active", { taskAState: "closed", taskBState: "blocked" });
    const evaluate = createEvaluateScopeCloseReadiness({ repo });
    const r = await evaluate({ scope_id: SCOPE_ID });
    expect(r.ready).toBe(false);
    expect(r.blocked_task_ids).toEqual([TASK_B]);
    expect(r.reasons).toContain("blocked_tasks:1");
  });

  it("requestScopeReview transitions active scope to scope_review_requested when ready", async () => {
    await seed("active", { taskAState: "closed", taskBState: "closed" });
    const request = createRequestScopeReview({ repo });
    const result = await request({
      scope_id: SCOPE_ID,
      actor: SUPERVISOR,
      reason: "happy path",
    });
    expect(result.applied).toBe(true);
    expect((result as { new_state: string }).new_state).toBe(
      "scope_review_requested",
    );
    const scope = await repo.getScope(SCOPE_ID);
    expect(scope!.state).toBe("scope_review_requested");
  });

  it("requestScopeReview refuses when any task is still in flight", async () => {
    await seed("active", { taskAState: "closed", taskBState: "in_progress" });
    const request = createRequestScopeReview({ repo });
    const result = await request({
      scope_id: SCOPE_ID,
      actor: SUPERVISOR,
    });
    expect(result.applied).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/not_ready/);
  });

  it("closeScope refuses if scope is not scope_review_approved", async () => {
    await seed("active", { taskAState: "closed", taskBState: "closed" });
    const close = createCloseScope({ repo });
    const result = await close({
      scope_id: SCOPE_ID,
      actor: HUMAN,
      reason: "test",
    });
    expect(result.applied).toBe(false);
    expect((result as { reason: string }).reason).toMatch(
      /scope_not_review_approved/,
    );
  });

  it("happy path: active -> scope_review_requested -> scope_review_approved -> closed", async () => {
    await seed("active", { taskAState: "closed", taskBState: "closed" });
    const request = createRequestScopeReview({ repo });
    await request({ scope_id: SCOPE_ID, actor: SUPERVISOR });
    // Operator approves the scope review (not modeled here as a separate
    // activity — the production path drives this through
    // applyDecompositionCommand for scopes; for this unit-level test we
    // transition directly).
    const reviewed = await repo.getScope(SCOPE_ID);
    await repo.updateScopeState(
      SCOPE_ID,
      reviewed!.state_version,
      "scope_review_approved",
      {
        actor: HUMAN,
        capability: "graph.write",
        reason: "test_approval",
      },
    );

    const close = createCloseScope({ repo });
    const result = await close({
      scope_id: SCOPE_ID,
      actor: HUMAN,
      reason: "scope ready",
    });
    expect(result.applied).toBe(true);
    expect((result as { new_state: string }).new_state).toBe("closed");
    const scope = await repo.getScope(SCOPE_ID);
    expect(scope!.state).toBe("closed");
    const audit = await audited(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "scope.closed")).toBe(true);
  });

  async function seed(
    scopeState: "active",
    options: { taskAState: TaskState; taskBState: TaskState },
  ): Promise<void> {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "Close scope",
        description: "Scope close integration test scope.",
        state: scopeState,
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: TASK_A,
        scope_id: SCOPE_ID,
        title: "Task A",
        description: "test",
        acceptance_criteria: ["x"],
        state: options.taskAState,
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: TASK_B,
        scope_id: SCOPE_ID,
        title: "Task B",
        description: "test",
        acceptance_criteria: ["x"],
        state: options.taskBState,
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
