import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPool,
  ProviderProjectRepository,
  TaskGraphRepository,
  type Pool,
} from "@colony/db";
import { scopeId, taskId, type ActorId } from "@colony/domain";
import { FakeProviderAdapter } from "@colony/provider";
import { createSyncCommittedTasksToProvider } from "./task-provider-projection.js";

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
const SCOPE_ID = scopeId("col-projtest");
const SUPERVISOR = "svc:supervisor" as ActorId;

describe.runIf(TEST_URL)("committed task provider projection", () => {
  const databaseUrl = TEST_URL!;
  let pool: Pool;
  let repo: TaskGraphRepository;
  let providerProjects: ProviderProjectRepository;
  let adapter: FakeProviderAdapter;

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

  beforeEach(async () => {
    const cleanup = new Client({ connectionString: databaseUrl });
    await cleanup.connect();
    try {
      await cleanup.query(
        `TRUNCATE
           task_targets, scope_targets, provider_mirrors, provider_projects,
           task_dependencies, assignments, reviews, approvals,
           agent_runs, events, audit_log, artifacts, tasks, scopes
         RESTART IDENTITY CASCADE`,
      );
    } finally {
      await cleanup.end();
    }
    adapter = new FakeProviderAdapter();
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("projects every committed task and is a no-op on replay", async () => {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "Projection scope",
        description: "Verify eager task projection",
      },
      {
        actor: SUPERVISOR,
        capability: "graph.write",
        reason: "projection_test",
      },
    );
    const project = await providerProjects.upsertProject({
      provider: "fake",
      provider_id: "fake-project-1",
      path: "colony/projection",
    });
    await providerProjects.linkScopeTarget({
      scope_id: SCOPE_ID,
      provider_project_id: project.id,
      role: "primary",
    });

    const taskIds = [taskId(`${SCOPE_ID}.1`), taskId(`${SCOPE_ID}.2`)];
    for (const [index, id] of taskIds.entries()) {
      await repo.createTask(
        {
          id,
          scope_id: SCOPE_ID,
          title: `Committed task ${index + 1}`,
          description: "Task description",
          acceptance_criteria: ["works"],
          state: "ready",
        },
        {
          actor: SUPERVISOR,
          capability: "graph.write",
          reason: "decomposition_commit",
        },
      );
      await providerProjects.linkTaskTarget({
        task_id: id,
        provider_project_id: project.id,
        role: "primary",
      });
    }

    const sync = createSyncCommittedTasksToProvider({
      repo,
      providerProjects,
      providerAdapter: adapter,
    });
    await expect(sync({ scope_id: SCOPE_ID })).resolves.toMatchObject({
      scope_id: SCOPE_ID,
      projected: 2,
      skipped: 0,
      failed: 0,
    });

    for (const id of taskIds) {
      const mirrors = await providerProjects.listMirrorsForColony({
        colony_id: id,
        entity_kind: "task",
      });
      expect(mirrors).toHaveLength(1);
      expect(mirrors[0].provider_project_id).toBe(project.id);
      expect(await providerProjects.getPrimaryTaskTarget(id)).toMatchObject({
        provider_project_id: project.id,
      });
    }

    await expect(sync({ scope_id: SCOPE_ID })).resolves.toMatchObject({
      scope_id: SCOPE_ID,
      projected: 0,
      skipped: 2,
      failed: 0,
    });
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM provider_mirrors
       WHERE entity_kind = 'task' AND colony_id LIKE $1`,
      [`${SCOPE_ID}.%`],
    );
    expect(rows[0].count).toBe("2");
  });
});
