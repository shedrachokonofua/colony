import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, type Pool } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import { createPool, TaskGraphRepository } from "../src/index.js";

const TEST_URL = process.env.COLONY_TEST_DATABASE_URL;

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

const SCOPE = "col-p0acc" as ScopeId;
const TASK_A = "col-p0acc.1" as TaskId;
const TASK_B = "col-p0acc.2" as TaskId;
const SUPERVISOR = "svc:supervisor" as ActorId;
const DEV_1 = "agent:dev-1" as ActorId;
const DEV_2 = "agent:dev-2" as ActorId;

describe.runIf(TEST_URL)("Phase 0 end-to-end acceptance", () => {
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
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    const cleanup = new Client({ connectionString: databaseUrl });
    await cleanup.connect();
    try {
      await cleanup.query(
        `TRUNCATE
           task_dependencies, assignments, gates, reviews, approvals,
           agent_runs, events, audit_log, artifacts, tasks, scopes
         RESTART IDENTITY CASCADE`,
      );
    } finally {
      await cleanup.end();
    }
  });

  it("creates synthetic graph data, races claimers, and exposes the UI audit trail", async () => {
    await repo.createScope(
      {
        id: SCOPE,
        title: "Phase 0 acceptance",
        description: "Synthetic scope for acceptance verification.",
      },
      {
        actor: SUPERVISOR,
        capability: "graph.write",
        reason: "phase0_acceptance",
      },
    );

    await repo.createTask(
      {
        id: TASK_A,
        scope_id: SCOPE,
        title: "Claimable task",
        description: "Exactly one concurrent claimer should win.",
        acceptance_criteria: ["one winner"],
        state: "ready",
      },
      {
        actor: SUPERVISOR,
        capability: "graph.write",
        reason: "phase0_acceptance",
      },
    );

    await repo.createTask(
      {
        id: TASK_B,
        scope_id: SCOPE,
        title: "Blocked task",
        description: "Visible dependency and audit target.",
        acceptance_criteria: ["dependency visible"],
        state: "ready",
      },
      {
        actor: SUPERVISOR,
        capability: "graph.write",
        reason: "phase0_acceptance",
      },
    );

    await repo.addDependency(TASK_A, TASK_B, "blocks", {
      actor: SUPERVISOR,
      capability: "graph.write",
      reason: "phase0_acceptance",
    });

    await repo.withTransaction(async (tx) => {
      const event = await tx.recordEvent({
        scope_id: SCOPE,
        task_id: TASK_A,
        kind: "provider_event",
        actor: SUPERVISOR,
        payload: { source: "phase0_acceptance" },
      });
      await tx.writeAudit({
        scope_id: SCOPE,
        task_id: TASK_A,
        actor: SUPERVISOR,
        action: "event.record",
        capability: "graph.write",
        target_kind: "event",
        target_id: event.id,
        reason: "phase0_acceptance",
        evidence: { kind: event.kind },
      });
    });

    const [claimA, claimB] = await Promise.all([
      repo.claimTask(TASK_A, DEV_1, 0, {
        actor: SUPERVISOR,
        capability: "task.claim",
        reason: "phase0_acceptance",
      }),
      repo.claimTask(TASK_A, DEV_2, 0, {
        actor: SUPERVISOR,
        capability: "task.claim",
        reason: "phase0_acceptance",
      }),
    ]);

    const winners = [claimA, claimB].filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ id: TASK_A, state: "claimed" });
    expect([DEV_1, DEV_2]).toContain(winners[0]?.assignee);

    const tasks = await repo.listTasks(SCOPE);
    expect(tasks.map((task) => task.id)).toEqual([TASK_A, TASK_B]);
    expect(tasks.find((task) => task.id === TASK_A)?.assignee).toBe(
      winners[0]?.assignee,
    );

    const dependencies = await repo.getTaskDependencies(TASK_B);
    expect(dependencies.blocked_by).toEqual([TASK_A]);

    const audit = await repo.listAuditForScope(SCOPE, { limit: 100 });
    const actions = audit.map((record) => record.action);
    expect(actions).toContain("scope.create");
    expect(actions.filter((action) => action === "task.create")).toHaveLength(
      2,
    );
    expect(actions).toContain("dependency.add");
    expect(actions).toContain("event.record");
    expect(actions).toContain("task.claim");
    expect(actions).toContain("task.claim_failed");

    const uiVisibleAudit = audit.filter(
      (record) => record.scope_id === SCOPE && record.actor && record.action,
    );
    expect(uiVisibleAudit).toHaveLength(audit.length);
  });
});
