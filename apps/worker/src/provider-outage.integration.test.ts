import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ProviderProjectRepository,
  TaskGraphRepository,
  createPool,
  type Pool,
} from "@colony/db";
import { FakeProviderAdapter } from "@colony/provider";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import {
  createCheckProviderHealth,
  createMarkScopePendingSync,
} from "./provider-outage.js";

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

const SCOPE_ID = "col-out01" as ScopeId;
const TASK_A = "col-out01.1" as TaskId;
const TASK_B = "col-out01.2" as TaskId;
const TASK_C = "col-out01.3" as TaskId;
const SUPERVISOR = "svc:supervisor" as ActorId;

/**
 * COL-3.3 integration test for provider outage handling.
 *
 * Drives `checkProviderHealth` against a `FakeProviderAdapter` whose
 * `setHealthOverride` we toggle, and verifies `markScopePendingSync`
 * transitions in-flight tasks to `pending_sync` while leaving terminal
 * states alone.
 */
describe.runIf(TEST_URL)("provider outage handling", () => {
  const databaseUrl = TEST_URL!;
  let pool: Pool;
  let repo: TaskGraphRepository;
  let providerProjects: ProviderProjectRepository;

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
    providerProjects = new ProviderProjectRepository(pool);
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
           decomposition_proposals, gates,
           task_targets, scope_targets, provider_mirrors, provider_projects,
           task_dependencies, assignments, reviews, approvals,
           agent_runs, events, audit_log, artifacts, tasks, scopes
         RESTART IDENTITY CASCADE`,
      );
    } finally {
      await cleanup.end();
    }
  });

  it("checkProviderHealth returns ok=true normally and ok=false under override", async () => {
    const adapter = new FakeProviderAdapter();
    const check = createCheckProviderHealth({ providerAdapter: adapter });
    const ok = await check();
    expect(ok.ok).toBe(true);
    expect(ok.provider).toBe("fake");
    expect(ok.version).toBe("fake-1.0.0");

    adapter.setHealthOverride({ ok: false, error: "503_service_unavailable" });
    const down = await check();
    expect(down.ok).toBe(false);
    expect(down.error).toBe("503_service_unavailable");

    adapter.setHealthOverride(null);
    const recovered = await check();
    expect(recovered.ok).toBe(true);
  });

  it("markScopePendingSync flips active tasks to pending_sync, skips terminal/blocked", async () => {
    await seedScopeWithTasks();
    const mark = createMarkScopePendingSync({ repo, providerProjects });
    const result = await mark({
      scope_id: SCOPE_ID,
      reason: "provider_unhealthy:503",
      health: {
        ok: false,
        checked_at: new Date().toISOString(),
        error: "503",
      },
    });

    expect(result.transitioned).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.already_pending).toBe(0);
    expect([...result.task_ids].sort()).toEqual([TASK_A, TASK_B].sort());

    const a = await repo.getTask(TASK_A);
    const b = await repo.getTask(TASK_B);
    const c = await repo.getTask(TASK_C);
    expect(a!.state).toBe("pending_sync");
    expect(b!.state).toBe("pending_sync");
    expect(c!.state).toBe("closed");

    const audit = await audited(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "scope.pending_sync.bulk")).toBe(
      true,
    );
    expect(
      audit.filter((a) => a.action === "task.pending_sync.entered"),
    ).toHaveLength(2);
  });

  it("re-running markScopePendingSync after recovery doesn't double-transition", async () => {
    await seedScopeWithTasks();
    const mark = createMarkScopePendingSync({ repo, providerProjects });
    await mark({ scope_id: SCOPE_ID, reason: "first_outage" });
    const second = await mark({ scope_id: SCOPE_ID, reason: "still_down" });
    expect(second.transitioned).toBe(0);
    expect(second.already_pending).toBe(2);
  });

  async function seedScopeWithTasks(): Promise<void> {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "Outage scope",
        description: "Outage integration test scope.",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: TASK_A,
        scope_id: SCOPE_ID,
        title: "In-progress task",
        description: "currently being worked on",
        acceptance_criteria: ["x"],
        state: "in_progress",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: TASK_B,
        scope_id: SCOPE_ID,
        title: "Awaiting review",
        description: "developer envelope landed",
        acceptance_criteria: ["x"],
        state: "review_requested",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: TASK_C,
        scope_id: SCOPE_ID,
        title: "Already closed",
        description: "done before outage",
        acceptance_criteria: ["x"],
        state: "closed",
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
