import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TaskGraphRepository, createPool, type Pool } from "@colony/db";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import {
  createIngestBlockedEnvelope,
  createRequeueBlockedTask,
} from "./blocker-ingest.js";

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

const SCOPE_ID = "col-blk01" as ScopeId;
const TASK_ID = "col-blk01.1" as TaskId;
const SUPERVISOR = "svc:supervisor" as ActorId;
const HUMAN = "user:so" as ActorId;

const VALID_FRESHNESS = {
  packet_hash: "sha256:packet-1",
  task_graph_version: "scope:1",
  provider_event_ts: "1970-01-01T00:00:00Z",
  commit_sha: "main",
  policy_version: "policy:1",
  memory_bundle_version: "memory:1",
};

function blockedEnvelope(
  taskId: string,
  blockerClass:
    | "missing_approval"
    | "failing_pipeline"
    | "external_dep"
    | "ambiguous_requirement"
    | "missing_capability"
    | "provider_outage"
    | "infrastructure"
    | "policy_violation"
    | "other" = "ambiguous_requirement",
): unknown {
  return {
    version: 1,
    result: "blocked",
    confidence: 0.9,
    requires_human: true,
    risk_level: "low",
    artifacts: [],
    policy_flags: [],
    next_action: "report_blocked",
    freshness: VALID_FRESHNESS,
    rationale: "missing requirements clarification",
    task_id: taskId,
    role_specific: {
      blocker_class: blockerClass,
      description: "need product to clarify CSV schema",
      expected_unblock: "human:product_clarification",
      needs_human: true,
      referenced_artifacts: [],
    },
  };
}

/**
 * COL-3.5a integration tests for blocker ingestion + requeue.
 */
describe.runIf(TEST_URL)("blocker ingestion + requeue", () => {
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

  it("transitions an in_progress task to blocked when a valid envelope arrives", async () => {
    await seed("in_progress");
    const ingest = createIngestBlockedEnvelope({ repo });
    const result = await ingest({
      task_id: TASK_ID,
      envelope: blockedEnvelope(TASK_ID, "ambiguous_requirement"),
      run_id: "run-1",
    });
    expect(result).toMatchObject({
      applied: true,
      task_id: TASK_ID,
      new_state: "blocked",
      blocker_class: "ambiguous_requirement",
    });
    const task = await repo.getTask(TASK_ID);
    expect(task!.state).toBe("blocked");
    const audit = await audited(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "task.blocked.recorded")).toBe(true);
  });

  it("rejects envelope with mismatched task_id", async () => {
    await seed("in_progress");
    const ingest = createIngestBlockedEnvelope({ repo });
    const result = await ingest({
      task_id: TASK_ID,
      envelope: blockedEnvelope("col-blk01.99"),
    });
    expect(result.applied).toBe(false);
    expect((result as { reason: string }).reason).toBe(
      "envelope_task_id_mismatch",
    );
  });

  it("is idempotent on already-blocked tasks", async () => {
    await seed("in_progress");
    const ingest = createIngestBlockedEnvelope({ repo });
    await ingest({
      task_id: TASK_ID,
      envelope: blockedEnvelope(TASK_ID, "external_dep"),
    });
    const second = await ingest({
      task_id: TASK_ID,
      envelope: blockedEnvelope(TASK_ID, "external_dep"),
    });
    expect(second.applied).toBe(true);
    const audit = await audited(pool, SCOPE_ID);
    expect(
      audit.filter((a) => a.action === "task.blocked.recorded"),
    ).toHaveLength(1);
    expect(audit.some((a) => a.action === "task.blocked.observed")).toBe(true);
  });

  it("requeueBlockedTask returns blocked task to ready", async () => {
    await seed("in_progress");
    const ingest = createIngestBlockedEnvelope({ repo });
    await ingest({ task_id: TASK_ID, envelope: blockedEnvelope(TASK_ID) });
    const requeue = createRequeueBlockedTask({ repo });
    const result = await requeue({
      task_id: TASK_ID,
      action: "requeue_ready",
      actor: HUMAN,
      reason: "product clarified the schema",
    });
    expect(result.applied).toBe(true);
    expect((result as { new_state: string }).new_state).toBe("ready");
    const task = await repo.getTask(TASK_ID);
    expect(task!.state).toBe("ready");
    const audit = await audited(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "task.unblocked")).toBe(true);
  });

  async function seed(state: "ready" | "in_progress"): Promise<void> {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "Blocker scope",
        description: "Blocker integration test scope.",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: TASK_ID,
        scope_id: SCOPE_ID,
        title: "Blockable task",
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
