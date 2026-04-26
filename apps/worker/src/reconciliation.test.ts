import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import {
  ProviderProjectRepository,
  ReviewGateRepository,
  TaskGraphRepository,
  createPool,
  type Pool,
} from "@colony/db";
import { FakeProviderAdapter } from "@colony/provider";
import type { ActorId, ScopeId, TaskId, TaskState } from "@colony/domain";
import { createReconcileScope } from "./reconciliation.js";

const TEST_URL = process.env.COLONY_TEST_DATABASE_URL;
const liveEnabled = Boolean(TEST_URL);

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

describe.runIf(liveEnabled)("COL-3.1 reconcileScope", () => {
  let pool: Pool;
  let pgClient: Client;
  let repo: TaskGraphRepository;
  let providerProjects: ProviderProjectRepository;
  let reviewGate: ReviewGateRepository;
  let adapter: FakeProviderAdapter;

  beforeAll(async () => {
    pgClient = new Client({ connectionString: TEST_URL! });
    await pgClient.connect();
    await pgClient.query("DROP SCHEMA public CASCADE");
    await pgClient.query("CREATE SCHEMA public");
    await pgClient.query("GRANT ALL ON SCHEMA public TO public");
    await runner({
      databaseUrl: TEST_URL!,
      dir: MIGRATIONS_DIR,
      migrationsTable: "pgmigrations",
      direction: "up",
      log: () => {},
    });
    pool = createPool({ connectionString: TEST_URL!, role: "colony_writer" });
    repo = new TaskGraphRepository(pool);
    providerProjects = new ProviderProjectRepository(pool);
    reviewGate = new ReviewGateRepository(pool);
    adapter = new FakeProviderAdapter();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await pgClient?.end();
  });

  it("detects active approvals tied to a stale commit", async () => {
    const fixture = await seedTask({
      slug: "stale",
      state: "review_requested",
      issueLabels: ["state:review_requested"],
    });
    const artifact = await reviewGate.upsertArtifact({
      kind: "mr",
      provider: adapter.provider,
      provider_id: fixture.mr.id,
      uri: `${fixture.project.path}/merge_requests/${fixture.mr.id}`,
      task_id: fixture.task_id,
      scope_id: fixture.scope_id,
      hash: "new-head-sha",
    });
    const approval = await reviewGate.recordApproval({
      artifact_id: artifact.id,
      actor: "human:op-1" as ActorId,
      commit_sha: "old-head-sha",
    });

    const report = await reconcile(fixture.scope_id);

    expect(report.ok).toBe(false);
    expect(report.conflicts).toBe(1);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "stale_commit_approval",
        severity: "conflict",
        task_id: fixture.task_id,
        approval_id: approval.id,
        expected: { commit_sha: "new-head-sha" },
        actual: { commit_sha: "old-head-sha" },
      }),
    );
  });

  it("detects provider issue closed while the MR is still open", async () => {
    const fixture = await seedTask({
      slug: "closed",
      state: "review_requested",
      issueLabels: ["state:review_requested"],
    });
    await adapter.issues.close(
      { id: fixture.project.provider_id, path: fixture.project.path },
      fixture.issue.id,
    );

    const report = await reconcile(fixture.scope_id);

    expect(report.ok).toBe(false);
    expect(report.conflicts).toBe(1);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "provider_issue_closed_mr_open",
        severity: "conflict",
        task_id: fixture.task_id,
        actual: expect.objectContaining({
          issue_state: "closed",
          mr_state: "opened",
          mr_id: fixture.mr.id,
        }),
      }),
    );
    const audit = await repo.listAuditForScope(fixture.scope_id, {
      task_id: fixture.task_id,
      limit: 100,
    });
    expect(audit.some((a) => a.action === "reconcile.conflict.detected")).toBe(
      true,
    );
  });

  it("auto-corrects provider state label drift and becomes a no-op on repeat", async () => {
    const fixture = await seedTask({
      slug: "labels",
      state: "ready",
      issueLabels: ["state:claimed", "agent:developer"],
    });

    const report = await reconcile(fixture.scope_id);

    expect(report.ok).toBe(true);
    expect(report.auto_corrected).toBe(1);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "label_drift",
        action: "auto_corrected",
        expected: { labels: ["state:ready"] },
        actual: { labels: ["state:claimed"] },
      }),
    );
    const issue = await adapter.issues.get(
      { id: fixture.project.provider_id, path: fixture.project.path },
      fixture.issue.id,
    );
    expect(issue.labels).toContain("state:ready");
    expect(issue.labels).not.toContain("state:claimed");
    expect(issue.labels).toContain("agent:developer");

    const repeat = await reconcile(fixture.scope_id);
    expect(repeat.findings).toHaveLength(0);
    expect(repeat.auto_corrected).toBe(0);
    expect(repeat.ok).toBe(true);
  });

  async function reconcile(scope_id: ScopeId) {
    return createReconcileScope({
      repo,
      providerProjects,
      reviewGate,
      providerAdapter: adapter,
    })({ scope_id });
  }

  async function seedTask(input: {
    readonly slug: string;
    readonly state: TaskState;
    readonly issueLabels: readonly string[];
  }) {
    const stamp = `${Date.now().toString(36)}${input.slug}`;
    const scope_id = `col-r${stamp}` as ScopeId;
    const task_id = `${scope_id}.1` as TaskId;
    const providerProject = await adapter.projects.create({
      name: `reconcile-${input.slug}`,
      path: `reconcile/${stamp}`,
      visibility: "private",
      default_branch: "main",
    });
    const project = await providerProjects.upsertProject({
      provider: adapter.provider,
      provider_id: providerProject.id,
      path: providerProject.path,
      default_branch: providerProject.default_branch,
      visibility: providerProject.visibility,
    });
    await repo.createScope(
      {
        id: scope_id,
        title: `Reconcile ${input.slug}`,
        description: "COL-3.1 reconciliation fixture",
        state: "active",
      },
      { actor: "human:test" as ActorId, capability: "graph.write" },
    );
    await repo.createTask(
      {
        id: task_id,
        scope_id,
        title: "Reconcile task",
        description: "Exercise reconciliation",
        state: input.state,
      },
      { actor: "svc:supervisor" as ActorId, capability: "graph.write" },
    );
    await providerProjects.linkScopeTarget({
      scope_id,
      provider_project_id: project.id,
      role: "primary",
    });
    await providerProjects.linkTaskTarget({
      task_id,
      provider_project_id: project.id,
      role: "primary",
    });
    const projectRef = { id: project.provider_id, path: project.path };
    const issue = await adapter.issues.create(projectRef, {
      title: "Reconcile task",
      description: "Provider task",
      labels: input.issueLabels,
    });
    const mr = await adapter.mergeRequests.open(projectRef, {
      title: "Reconcile MR",
      description: "Provider MR",
      source_branch: `colony/${task_id}`,
      target_branch: "main",
    });
    await providerProjects.upsertMirror({
      colony_id: task_id,
      entity_kind: "task",
      provider: adapter.provider,
      provider_id: issue.id,
      provider_project_id: project.id,
      provider_project_path: project.path,
    });
    await providerProjects.upsertMirror({
      colony_id: task_id,
      entity_kind: "mr_pr",
      provider: adapter.provider,
      provider_id: mr.id,
      provider_project_id: project.id,
      provider_project_path: project.path,
    });
    return { scope_id, task_id, project, issue, mr };
  }
});
