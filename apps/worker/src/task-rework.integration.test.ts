import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ProviderProjectRepository,
  ReviewGateRepository,
  TaskGraphRepository,
  createPool,
  type Pool,
} from "@colony/db";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import { createRequestTaskRework } from "./task-rework.js";

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

const SCOPE_ID = "col-rwk01" as ScopeId;
const TASK_ID = "col-rwk01.1" as TaskId;
const SUPERVISOR = "svc:supervisor" as ActorId;
const HUMAN_ACTOR = "user:so" as ActorId;

/**
 * COL-3.1a integration test for the task rework activity.
 *
 * Seeds a task in `review_requested` state with a recorded approval on
 * its MR artifact, then drives `requestTaskRework` and asserts:
 *   - state goes review_requested -> changes_requested so the planning gate
 *     can drive changes_requested -> plan_proposed -> plan_review -> in_progress
 *   - the MR's active approval is invalidated
 *   - the rework counter increments
 *   - hitting the loop cap returns loop_cap_exceeded
 *   - re-applying while already changes_requested is idempotent
 */
describe.runIf(TEST_URL)("requestTaskRework integration", () => {
  const databaseUrl = TEST_URL!;
  let pool: Pool;
  let repo: TaskGraphRepository;
  let providerProjects: ProviderProjectRepository;
  let reviewGate: ReviewGateRepository;

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
    reviewGate = new ReviewGateRepository(pool);
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

  it("kicks task back to changes_requested and invalidates the active approval", async () => {
    const { artifactId } = await seedTaskWithApproval();
    const rework = createRequestTaskRework({
      repo,
      providerProjects,
      reviewGate,
    });

    const result = await rework({
      task_id: TASK_ID,
      actor: HUMAN_ACTOR,
      reason: "rename function",
    });
    expect(result).toMatchObject({
      applied: true,
      task_id: TASK_ID,
      previous_state: "review_requested",
      new_state: "changes_requested",
      invalidated_approvals: 1,
      rework_count: 1,
    });

    const task = await repo.getTask(TASK_ID);
    expect(task!.state).toBe("changes_requested");
    const approvals = await reviewGate.listActiveApprovals(artifactId as never);
    expect(approvals).toHaveLength(0);

    const audit = await audited(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "task.rework.kicked_off")).toBe(true);
  });

  it("is idempotent when the task is already changes_requested", async () => {
    await seedTaskWithApproval();
    const rework = createRequestTaskRework({
      repo,
      providerProjects,
      reviewGate,
    });

    await rework({ task_id: TASK_ID, actor: HUMAN_ACTOR });
    const second = await rework({ task_id: TASK_ID, actor: HUMAN_ACTOR });
    expect(second).toMatchObject({
      applied: true,
      task_id: TASK_ID,
      previous_state: "changes_requested",
      new_state: "changes_requested",
      invalidated_approvals: 0,
      rework_count: 1,
    });
  });

  it("returns loop_cap_exceeded once the cap is reached", async () => {
    await seedTaskWithApproval();
    const rework = createRequestTaskRework({
      repo,
      providerProjects,
      reviewGate,
    });

    // Cycle the task through review_requested -> rework three times.
    for (let i = 0; i < 3; i++) {
      const r = await rework({
        task_id: TASK_ID,
        actor: HUMAN_ACTOR,
        review_loop_cap: 3,
      });
      expect(r.applied).toBe(true);
      // Move through the planning gate path and back to review_requested
      // to allow another rework without bypassing the state machine.
      await moveTaskBackToReviewRequested();
    }
    const blocked = await rework({
      task_id: TASK_ID,
      actor: HUMAN_ACTOR,
      review_loop_cap: 3,
    });
    expect(blocked.applied).toBe(false);
    expect((blocked as { reason: string }).reason).toMatch(/loop_cap_exceeded/);

    const audit = await audited(pool, SCOPE_ID);
    expect(
      audit.some((a) => a.action === "task.rework.loop_cap_exceeded"),
    ).toBe(true);
  });

  async function seedTaskWithApproval(): Promise<{
    readonly artifactId: string;
  }> {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "Rework scope",
        description: "Rework integration test scope.",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: TASK_ID,
        scope_id: SCOPE_ID,
        title: "Add CSV export",
        description: "Implement the CSV export endpoint.",
        acceptance_criteria: ["streams bytes"],
        state: "review_requested",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    const project = await providerProjects.upsertProject({
      provider: "gitlab",
      provider_id: "gitlab-99",
      path: "shdr/colony",
      default_branch: "main",
    });
    const mr = await providerProjects.upsertMirror({
      colony_id: TASK_ID,
      entity_kind: "mr_pr",
      provider: "gitlab",
      provider_id: "mr-1",
      provider_project_id: project.id,
      provider_project_path: project.path,
    });
    void mr;
    const artifact = await reviewGate.upsertArtifact({
      provider: "gitlab",
      kind: "mr",
      provider_id: "mr-1",
      task_id: TASK_ID,
      uri: "https://gitlab.example/mr/1",
      hash: "abc123",
    });
    await reviewGate.recordApproval({
      artifact_id: artifact.id,
      actor: HUMAN_ACTOR,
      commit_sha: "abc123",
    });
    return { artifactId: artifact.id };
  }

  async function moveTaskBackToReviewRequested(): Promise<void> {
    for (const state of [
      "plan_proposed",
      "plan_review",
      "in_progress",
      "review_requested",
    ] as const) {
      const current = await repo.getTask(TASK_ID);
      if (!current) throw new Error("task missing during rework test cycle");
      await repo.updateTaskState(TASK_ID, current.state_version, state, {
        actor: SUPERVISOR,
        capability: "task.assign",
        reason: "test_cycle",
      });
    }
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
