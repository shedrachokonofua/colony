import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  PolicyRepository,
  TaskGraphRepository,
  createPool,
  type Pool,
} from "@colony/db";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import { createApplyOperatorOverride } from "./operator-override.js";

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

const SCOPE_ID = "col-ovr01" as ScopeId;
const TASK_ID = "col-ovr01.1" as TaskId;
const SUPERVISOR = "svc:supervisor" as ActorId;
const OPERATOR = "user:so" as ActorId;
const NON_OPERATOR = "user:guest" as ActorId;

/**
 * COL-3.5 integration tests for operator override.
 */
describe.runIf(TEST_URL)("operator override", () => {
  const databaseUrl = TEST_URL!;
  let pool: Pool;
  let repo: TaskGraphRepository;
  let policy: PolicyRepository;

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
    policy = new PolicyRepository(pool);
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
           capability_grants, task_dependencies, assignments, reviews,
           approvals, agent_runs, events, audit_log, artifacts,
           tasks, scopes
         RESTART IDENTITY CASCADE`,
      );
    } finally {
      await cleanup.end();
    }
  });

  it("rejects override without policy.override capability", async () => {
    await seedTask("in_progress");
    const override = createApplyOperatorOverride({ repo, policy });
    const result = await override({
      target: "task",
      task_id: TASK_ID,
      action: "block",
      actor: NON_OPERATOR,
      reason: "stop the dev",
    });
    expect(result).toEqual({
      applied: false,
      reason: "policy.override_not_granted",
    });
    const task = await repo.getTask(TASK_ID);
    expect(task!.state).toBe("in_progress");
  });

  it("requires a non-empty reason", async () => {
    await seedTask("in_progress");
    await grantOverride();
    const override = createApplyOperatorOverride({ repo, policy });
    const result = await override({
      target: "task",
      task_id: TASK_ID,
      action: "block",
      actor: OPERATOR,
      reason: "  ",
    });
    expect(result).toEqual({ applied: false, reason: "reason_required" });
  });

  it("blocks an in_progress task when the operator has policy.override", async () => {
    await seedTask("in_progress");
    await grantOverride();
    const override = createApplyOperatorOverride({ repo, policy });
    const result = await override({
      target: "task",
      task_id: TASK_ID,
      action: "block",
      actor: OPERATOR,
      reason: "needs human investigation",
    });
    expect(result).toMatchObject({
      applied: true,
      target: "task",
      previous_state: "in_progress",
      new_state: "blocked",
    });
    const task = await repo.getTask(TASK_ID);
    expect(task!.state).toBe("blocked");
    const audit = await audited(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "task.operator_override")).toBe(true);
  });

  it("is a no-op when the task is already in the target state", async () => {
    await seedTask("blocked");
    await grantOverride();
    const override = createApplyOperatorOverride({ repo, policy });
    const result = await override({
      target: "task",
      task_id: TASK_ID,
      action: "block",
      actor: OPERATOR,
      reason: "double-clicked the override button",
    });
    expect(result).toMatchObject({
      applied: true,
      previous_state: "blocked",
      new_state: "blocked",
    });
  });

  async function seedTask(
    state: "ready" | "in_progress" | "blocked",
  ): Promise<void> {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "Override scope",
        description: "Override integration test scope.",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: TASK_ID,
        scope_id: SCOPE_ID,
        title: "Override task",
        description: "test",
        acceptance_criteria: ["x"],
        state,
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
  }

  async function grantOverride(): Promise<void> {
    await policy.grantCapabilitiesForActor({
      actor: OPERATOR,
      role: "supervisor",
      capabilities: ["policy.override"],
      granted_by: SUPERVISOR,
    });
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
