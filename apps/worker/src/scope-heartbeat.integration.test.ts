import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TaskGraphRepository, createPool, type Pool } from "@colony/db";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import { createScopeHeartbeatTick } from "./scope-heartbeat.js";

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

const SCOPE_ID = "col-hb01" as ScopeId;
const TASK_A = "col-hb01.1" as TaskId;
const SUPERVISOR = "svc:supervisor" as ActorId;

describe.runIf(TEST_URL)("scopeHeartbeatTick integration", () => {
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

  it("returns healthy when scope was just updated", async () => {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "fresh",
        description: "fresh scope",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    const tick = createScopeHeartbeatTick({ repo });
    const result = await tick({
      scope_id: SCOPE_ID,
      stall_threshold_ms: 60_000,
      idempotency_key: "key-1",
    });
    expect(result.status).toBe("healthy");
    const audit = await audit_(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "scope.heartbeat.healthy")).toBe(
      true,
    );
  });

  it("returns scope_terminal for closed scopes", async () => {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "closed",
        description: "closed scope",
        state: "closed",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    const tick = createScopeHeartbeatTick({ repo });
    const result = await tick({
      scope_id: SCOPE_ID,
      stall_threshold_ms: 1_000,
      idempotency_key: "key-1",
    });
    expect(result.status).toBe("scope_terminal");
  });

  it("classifies a draft scope past the stall threshold as awaiting_architect", async () => {
    await repo.createScope(
      { id: SCOPE_ID, title: "draft", description: "draft" },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    // Backdate updated_at to simulate a stale scope.
    await pool.query(
      `UPDATE scopes SET updated_at = now() - interval '1 hour' WHERE id = $1`,
      [SCOPE_ID],
    );
    const tick = createScopeHeartbeatTick({ repo });
    const result = await tick({
      scope_id: SCOPE_ID,
      stall_threshold_ms: 60_000,
      idempotency_key: "key-1",
    });
    expect(result.status).toBe("stalled");
    expect(result.classifier).toBe("awaiting_architect");
    expect(result.recovery).toMatch(/startArchitectRun/);
    const audit = await audit_(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "scope.heartbeat.stalled")).toBe(
      true,
    );
  });

  it("trips the durable recovery breaker and resets after success", async () => {
    await repo.createScope(
      { id: SCOPE_ID, title: "failing architect", description: "draft" },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    for (let i = 1; i <= 5; i += 1) {
      await pool.query(
        `INSERT INTO agent_runs
           (id, scope_id, role, packet_hash, status, started_at, finished_at)
         VALUES ($1, $2, 'architect', $3, 'failed',
                 now() - interval '10 minutes', now() - interval '10 minutes')`,
        [`run-hb-${i}`, SCOPE_ID, `packet-${i}`],
      );
    }
    await pool.query(
      `UPDATE scopes SET updated_at = now() - interval '1 hour' WHERE id = $1`,
      [SCOPE_ID],
    );

    const tick = createScopeHeartbeatTick({ repo });
    const tripped = await tick({
      scope_id: SCOPE_ID,
      stall_threshold_ms: 60_000,
      idempotency_key: "breaker-1",
    });
    expect(tripped.recovery_circuit_open).toBe(true);
    expect(tripped.recovery_failure_count).toBe(5);
    expect(tripped.recovery_allowed).toBe(false);
    expect(tripped.last_failure_reason).toBe("agent_run_failed");
    const blocked = await repo.getScope(SCOPE_ID);
    expect(blocked?.state).toBe("blocked");
    const audit = await audit_(pool, SCOPE_ID);
    expect(
      audit.some((a) => a.action === "scope.heartbeat.recovery_circuit_open"),
    ).toBe(true);

    await repo.updateScopeState(SCOPE_ID, blocked!.state_version, "draft", {
      actor: SUPERVISOR,
      capability: "graph.write",
      reason: "operator_reset",
    });
    await pool.query(
      `INSERT INTO agent_runs
         (id, scope_id, role, packet_hash, status, started_at, finished_at)
       VALUES ($1, $2, 'architect', $3, 'succeeded', now(), now())`,
      ["run-hb-success", SCOPE_ID, "packet-success"],
    );
    await pool.query(
      `UPDATE scopes SET updated_at = now() - interval '1 hour' WHERE id = $1`,
      [SCOPE_ID],
    );
    const reset = await tick({
      scope_id: SCOPE_ID,
      stall_threshold_ms: 60_000,
      idempotency_key: "breaker-2",
    });
    expect(reset.recovery_failure_count).toBe(0);
    expect(reset.recovery_circuit_open).toBe(false);
    expect(reset.recovery_allowed).toBe(true);
  });

  it("backs off a failed recovery before allowing the next tick", async () => {
    await repo.createScope(
      { id: SCOPE_ID, title: "backoff", description: "draft" },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await pool.query(
      `INSERT INTO agent_runs
         (id, scope_id, role, packet_hash, status, started_at, finished_at)
       VALUES ($1, $2, 'architect', $3, 'failed', now(), now())`,
      ["run-hb-backoff", SCOPE_ID, "packet-backoff"],
    );
    await pool.query(
      `UPDATE scopes SET updated_at = now() - interval '1 hour' WHERE id = $1`,
      [SCOPE_ID],
    );
    const tick = createScopeHeartbeatTick({ repo });
    const deferred = await tick({
      scope_id: SCOPE_ID,
      stall_threshold_ms: 60_000,
      idempotency_key: "backoff-1",
    });
    expect(deferred.recovery_allowed).toBe(false);
    expect(deferred.recovery_backoff_ticks).toBe(1);

    await pool.query(
      `UPDATE agent_runs
          SET started_at = now() - interval '2 minutes',
              finished_at = now() - interval '2 minutes'
        WHERE id = $1`,
      ["run-hb-backoff"],
    );
    const allowed = await tick({
      scope_id: SCOPE_ID,
      stall_threshold_ms: 60_000,
      idempotency_key: "backoff-2",
    });
    expect(allowed.recovery_allowed).toBe(true);
    expect(allowed.recovery_backoff_ticks).toBe(0);
  });

  it("classifies an active scope with ready tasks as unclaimed_ready", async () => {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "active",
        description: "active scope",
        state: "active",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: TASK_A,
        scope_id: SCOPE_ID,
        title: "ready task",
        description: "ready",
        acceptance_criteria: ["x"],
        state: "ready",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await pool.query(
      `UPDATE scopes SET updated_at = now() - interval '1 hour' WHERE id = $1`,
      [SCOPE_ID],
    );
    await pool.query(
      `UPDATE tasks SET updated_at = now() - interval '1 hour' WHERE id = $1`,
      [TASK_A],
    );
    const tick = createScopeHeartbeatTick({ repo });
    const result = await tick({
      scope_id: SCOPE_ID,
      stall_threshold_ms: 60_000,
      idempotency_key: "key-1",
    });
    expect(result.classifier).toBe("unclaimed_ready");
  });

  it("classifies merge_ready as awaiting_merge", async () => {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "active",
        description: "active",
        state: "active",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: TASK_A,
        scope_id: SCOPE_ID,
        title: "ready to merge",
        description: "rdy",
        acceptance_criteria: ["x"],
        state: "merge_ready",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await pool.query(
      `UPDATE scopes SET updated_at = now() - interval '1 hour' WHERE id = $1`,
      [SCOPE_ID],
    );
    await pool.query(
      `UPDATE tasks SET updated_at = now() - interval '1 hour' WHERE id = $1`,
      [TASK_A],
    );
    const tick = createScopeHeartbeatTick({ repo });
    const result = await tick({
      scope_id: SCOPE_ID,
      stall_threshold_ms: 60_000,
      idempotency_key: "key-1",
    });
    expect(result.classifier).toBe("awaiting_merge");
  });
});

async function audit_(
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
