import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProviderProjectRepository,
  TaskGraphRepository,
  createPool,
  type Pool,
} from "@colony/db";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import { FakeProviderAdapter } from "@colony/provider";
import { createRequestArchitectReplan } from "./architect-replan.js";

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
const SCOPE_ID = "col-replan" as ScopeId;
const FAILING_ID = `${SCOPE_ID}.1` as TaskId;
const SIBLING_ID = `${SCOPE_ID}.2` as TaskId;
const REPLACEMENT_A = `${SCOPE_ID}.10` as TaskId;
const REPLACEMENT_B = `${SCOPE_ID}.11` as TaskId;
const SUPERVISOR = "svc:supervisor" as ActorId;

describe.runIf(TEST_URL)("requestArchitectReplan integration", () => {
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
        `TRUNCATE decomposition_proposals, gates, task_targets, scope_targets, provider_mirrors, provider_projects, task_dependencies, assignments, reviews, approvals, agent_runs, events, audit_log, artifacts, tasks, scopes RESTART IDENTITY CASCADE`,
      );
    } finally {
      await cleanup.end();
    }
  });

  it("supersedes the failing task and rewires the existing graph transactionally", async () => {
    await seedGraph("blocked");
    const runtime = new FakeAgentRuntimeAdapter({
      envelopeForRun: (packet) =>
        architectEnvelope(packet, [REPLACEMENT_A, REPLACEMENT_B]),
    });
    const run = createRequestArchitectReplan({
      repo,
      providerProjects,
      providerAdapter: new FakeProviderAdapter(),
      agentRuntime: runtime,
    });

    const result = await run({
      scope_id: SCOPE_ID,
      task_id: FAILING_ID,
      reason: "developer_plan_escalate:shared file ownership",
      attempt: 1,
    });
    expect(result).toEqual({
      replanned: true,
      task_ids: [REPLACEMENT_A, REPLACEMENT_B],
    });
    expect((await repo.getTask(FAILING_ID))!.state).toBe("canceled");
    expect((await repo.getTask(REPLACEMENT_A))!.state).toBe("ready");
    expect((await repo.getTask(REPLACEMENT_B))!.state).toBe("ready");
    const deps = await repo.getTaskDependencies(SIBLING_ID);
    expect([...deps.blocked_by].sort()).toEqual(
      [REPLACEMENT_A, REPLACEMENT_B].sort(),
    );
    const audit = await repo.listAuditForScope(SCOPE_ID, {
      task_id: FAILING_ID,
      limit: 500,
    });
    expect(
      audit.some(
        (row) =>
          row.action === "task.replan.applied" && row.evidence?.attempt === 1,
      ),
    ).toBe(true);
  });

  it("returns false for a declining architect without changing the graph", async () => {
    await seedGraph();
    const before = await repo.listTasks(SCOPE_ID);
    const runtime = new FakeAgentRuntimeAdapter({
      envelopeForRun: (packet) => ({
        ...architectEnvelope(packet, [REPLACEMENT_A]),
        result: "escalate",
        next_action: "escalate",
      }),
    });
    const run = createRequestArchitectReplan({
      repo,
      providerProjects,
      providerAdapter: new FakeProviderAdapter(),
      agentRuntime: runtime,
    });
    const result = await run({
      scope_id: SCOPE_ID,
      task_id: FAILING_ID,
      reason: "planner escalation",
      attempt: 2,
    });
    expect(result.replanned).toBe(false);
    expect(
      (await repo.listTasks(SCOPE_ID)).map((task) => [task.id, task.state]),
    ).toEqual(before.map((task) => [task.id, task.state]));
    expect((await repo.getTaskDependencies(SIBLING_ID)).blocked_by).toEqual([
      FAILING_ID,
    ]);
    const audit = await repo.listAuditForScope(SCOPE_ID, {
      task_id: FAILING_ID,
      limit: 500,
    });
    expect(
      audit.some(
        (row) =>
          row.action === "task.replan.failed" && row.evidence?.attempt === 2,
      ),
    ).toBe(true);
  });

  async function seedGraph(
    failingState: "changes_requested" | "blocked" = "changes_requested",
  ) {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "Replan scope",
        description: "Website scope",
        state: "active",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    const project = await providerProjects.upsertProject({
      provider: "fake",
      provider_id: "fake-1",
      path: "org/site",
      default_branch: "main",
    });
    await providerProjects.linkScopeTarget({
      scope_id: SCOPE_ID,
      provider_project_id: project.id,
      role: "primary",
    });
    await providerProjects.upsertMirror({
      colony_id: SCOPE_ID,
      entity_kind: "scope",
      provider: "fake",
      provider_id: "issue-1",
      provider_project_id: project.id,
      provider_project_path: project.path,
    });
    await repo.createTask(
      {
        id: FAILING_ID,
        scope_id: SCOPE_ID,
        title: "Website",
        description: "Edit the site",
        state: failingState,
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.createTask(
      {
        id: SIBLING_ID,
        scope_id: SCOPE_ID,
        title: "Downstream",
        description: "Depends on website",
        state: "ready",
      },
      { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
    );
    await repo.addDependency(FAILING_ID, SIBLING_ID, "blocks", {
      actor: SUPERVISOR,
      capability: "graph.write",
      reason: "test",
    });
    return project;
  }
});

function architectEnvelope(
  packet: { freshness: { packet_hash: string }; scope_id: string },
  ids: readonly string[],
) {
  return {
    version: 1,
    result: "done",
    confidence: 0.9,
    requires_human: true,
    risk_level: "medium",
    artifacts: [],
    policy_flags: [],
    next_action: "propose_decomposition",
    freshness: packet.freshness,
    rationale:
      "Re-decomposed around filesystem ownership and shared-file conflicts.",
    scope_id: packet.scope_id,
    role_specific: {
      proposed_tasks: ids.map((id) => ({
        proposed_task_id: id,
        title: `Replacement ${id}`,
        description: "Independent replacement task",
        acceptance_criteria: ["Complete safely"],
        non_goals: [],
        suggested_role: "developer",
        suggested_capabilities: [],
      })),
      proposed_dependencies: [],
      open_questions: [],
      assumptions: [],
    },
  };
}
