import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import {
  ProviderProjectRepository,
  RepositoryError,
  TaskGraphRepository,
} from "../src/index.js";

const TEST_URL = process.env.COLONY_TEST_DATABASE_URL;

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

const SCOPE_ID = "col-pproj" as ScopeId;
const TASK_FE = "col-pproj.1" as TaskId;
const TASK_BE = "col-pproj.2" as TaskId;
const SUPERVISOR = "svc:supervisor" as ActorId;

describe.runIf(TEST_URL)("ProviderProjectRepository", () => {
  const databaseUrl = TEST_URL!;
  let pool: Pool;
  let repo: ProviderProjectRepository;
  let graph: TaskGraphRepository;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: databaseUrl });
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

    pool = new Pool({ connectionString: databaseUrl });
    repo = new ProviderProjectRepository(pool);
    graph = new TaskGraphRepository(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE
         scope_targets, task_targets, provider_projects,
         task_dependencies, assignments, gates, reviews, approvals,
         agent_runs, events, audit_log, artifacts, tasks, scopes
       RESTART IDENTITY CASCADE`,
    );
  });

  it("upserts provider projects keyed on (provider, provider_id)", async () => {
    const created = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "100",
      path: "colony/frontend",
      visibility: "private",
    });
    expect(created.path).toBe("colony/frontend");

    const updated = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "100",
      path: "colony/frontend-renamed",
      visibility: "internal",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.path).toBe("colony/frontend-renamed");
    expect(updated.visibility).toBe("internal");

    expect(
      await repo.getProjectByProviderId("gitlab", "100"),
    ).toMatchObject({ path: "colony/frontend-renamed" });
    expect(
      await repo.getProjectByPath("gitlab", "colony/frontend-renamed"),
    ).toMatchObject({ id: created.id });
  });

  it("links a single scope to multiple provider projects", async () => {
    await graph.createScope(
      { id: SCOPE_ID, title: "multi-repo", description: "x" },
      { actor: SUPERVISOR },
    );
    const fe = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "100",
      path: "colony/frontend",
      visibility: "private",
    });
    const be = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "200",
      path: "colony/backend",
      visibility: "private",
    });

    await repo.linkScopeTarget({
      scope_id: SCOPE_ID,
      provider_project_id: fe.id,
      role: "primary",
    });
    await repo.linkScopeTarget({
      scope_id: SCOPE_ID,
      provider_project_id: be.id,
      role: "backend",
    });

    const targets = await repo.listScopeTargets(SCOPE_ID);
    expect(targets.map((t) => t.provider_project_id).sort()).toEqual(
      [fe.id, be.id].sort(),
    );
    expect(await repo.getPrimaryScopeTarget(SCOPE_ID)).toMatchObject({
      provider_project_id: fe.id,
      role: "primary",
    });
  });

  it("rejects two primary scope targets on the same scope", async () => {
    await graph.createScope(
      { id: SCOPE_ID, title: "x", description: "y" },
      { actor: SUPERVISOR },
    );
    const a = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "1",
      path: "g/a",
      visibility: "private",
    });
    const b = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "2",
      path: "g/b",
      visibility: "private",
    });
    await repo.linkScopeTarget({
      scope_id: SCOPE_ID,
      provider_project_id: a.id,
      role: "primary",
    });
    await expect(
      repo.linkScopeTarget({
        scope_id: SCOPE_ID,
        provider_project_id: b.id,
        role: "primary",
      }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });

  it("supports tasks under one scope targeting different primary projects", async () => {
    await graph.createScope(
      { id: SCOPE_ID, title: "s", description: "d" },
      { actor: SUPERVISOR },
    );
    await graph.createTask(
      { id: TASK_FE, scope_id: SCOPE_ID, title: "fe", description: "" },
      { actor: SUPERVISOR },
    );
    await graph.createTask(
      { id: TASK_BE, scope_id: SCOPE_ID, title: "be", description: "" },
      { actor: SUPERVISOR },
    );
    const fe = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "100",
      path: "g/fe",
      visibility: "private",
    });
    const be = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "200",
      path: "g/be",
      visibility: "private",
    });

    await repo.linkTaskTarget({
      task_id: TASK_FE,
      provider_project_id: fe.id,
      role: "primary",
    });
    await repo.linkTaskTarget({
      task_id: TASK_FE,
      provider_project_id: be.id,
      role: "secondary",
    });
    await repo.linkTaskTarget({
      task_id: TASK_BE,
      provider_project_id: be.id,
      role: "primary",
    });

    expect(await repo.getPrimaryTaskTarget(TASK_FE)).toMatchObject({
      provider_project_id: fe.id,
    });
    expect(await repo.getPrimaryTaskTarget(TASK_BE)).toMatchObject({
      provider_project_id: be.id,
    });
    expect(await repo.listTaskTargets(TASK_FE)).toHaveLength(2);
  });

  it("rejects two primary task targets on the same task", async () => {
    await graph.createScope(
      { id: SCOPE_ID, title: "s", description: "d" },
      { actor: SUPERVISOR },
    );
    await graph.createTask(
      { id: TASK_FE, scope_id: SCOPE_ID, title: "fe", description: "" },
      { actor: SUPERVISOR },
    );
    const a = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "1",
      path: "g/a",
      visibility: "private",
    });
    const b = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "2",
      path: "g/b",
      visibility: "private",
    });
    await repo.linkTaskTarget({
      task_id: TASK_FE,
      provider_project_id: a.id,
      role: "primary",
    });
    await expect(
      repo.linkTaskTarget({
        task_id: TASK_FE,
        provider_project_id: b.id,
        role: "primary",
      }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });

  it("allows the same provider_id across distinct provider_mirrors when scoped to different projects", async () => {
    await graph.createScope(
      { id: SCOPE_ID, title: "s", description: "d" },
      { actor: SUPERVISOR },
    );
    const a = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "100",
      path: "g/a",
      visibility: "private",
    });
    const b = await repo.upsertProject({
      provider: "gitlab",
      provider_id: "200",
      path: "g/b",
      visibility: "private",
    });
    // Two different scope mirrors keyed on the same provider issue iid "7"
    // but in different provider projects must coexist.
    await pool.query(
      `INSERT INTO provider_mirrors
         (id, colony_id, entity_kind, provider, provider_id, provider_project_id)
       VALUES ($1, $2, 'task', 'gitlab', '7', $3)`,
      ["m1", "col-pproj.1", a.id],
    );
    await pool.query(
      `INSERT INTO provider_mirrors
         (id, colony_id, entity_kind, provider, provider_id, provider_project_id)
       VALUES ($1, $2, 'task', 'gitlab', '7', $3)`,
      ["m2", "col-pproj.2", b.id],
    );
    // But a duplicate within the same project must fail.
    await expect(
      pool.query(
        `INSERT INTO provider_mirrors
           (id, colony_id, entity_kind, provider, provider_id, provider_project_id)
         VALUES ($1, $2, 'task', 'gitlab', '7', $3)`,
        ["m3", "col-pproj.1", a.id],
      ),
    ).rejects.toThrow(/duplicate|unique/i);
  });
});
