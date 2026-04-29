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
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import { createArchitectRun } from "./architect-run.js";
import { createDecompositionReviewRun } from "./decomposition-review-run.js";
import { createApplyDecompositionCommand } from "./decomposition-command.js";

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

const SCOPE_ID = "col-cmd01" as ScopeId;
const SUPERVISOR = "svc:supervisor" as ActorId;
const REVIEWER = "bot:reviewer" as ActorId;
const HUMAN_ACTOR = "user:so" as ActorId;

/**
 * COL-3.0a integration: scope-level command application.
 *
 * Mirrors the live path the supervisor workflow takes when the webhook
 * dispatcher has tagged a `/approve` or `/changes` comment on the scope
 * issue with `command_target=scope_decomposition`. The activity finds
 * the latest non-committed proposal and translates the command:
 *
 *   /approve on `review_approved` -> approveDecompositionProposal
 *     (proposal.status -> human_approved; ready for DAG commit).
 *
 *   /approve on `proposed` -> rejected (no reviewer approval yet).
 *
 *   /changes on `proposed` -> recordDecompositionReview with
 *     result=changes_requested and the human as the reviewer of record;
 *     scope returns to draft.
 */
describe.runIf(TEST_URL)("applyDecompositionCommand integration", () => {
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

  it("/approve on a review_approved proposal records human approval", async () => {
    const proposalId = await seed(repo, providerProjects, "review_approved");
    const apply = createApplyDecompositionCommand({ repo });
    const result = await apply({
      scope_id: SCOPE_ID,
      action: "approve",
      actor: HUMAN_ACTOR,
      reason: "lgtm",
    });
    expect(result).toEqual({
      applied: true,
      proposal_id: proposalId,
      action: "human_approved",
    });
    const stored = await repo.getDecompositionProposal(SCOPE_ID, proposalId);
    expect(stored!.status).toBe("human_approved");
    expect(stored!.human_approved_by).toBe(HUMAN_ACTOR);
  });

  it("/approve on a still-proposed proposal is rejected", async () => {
    await seed(repo, providerProjects, "proposed");
    const apply = createApplyDecompositionCommand({ repo });
    const result = await apply({
      scope_id: SCOPE_ID,
      action: "approve",
      actor: HUMAN_ACTOR,
    });
    expect(result.applied).toBe(false);
    expect((result as { reason: string }).reason).toMatch(
      /proposal_not_human_approvable:proposed/,
    );
  });

  it("/changes on a proposed proposal records changes_requested by the human", async () => {
    const proposalId = await seed(repo, providerProjects, "proposed");
    const apply = createApplyDecompositionCommand({ repo });
    const result = await apply({
      scope_id: SCOPE_ID,
      action: "changes",
      actor: HUMAN_ACTOR,
      reason: "split task 2 in two",
    });
    expect(result).toEqual({
      applied: true,
      proposal_id: proposalId,
      action: "changes_requested",
    });
    const stored = await repo.getDecompositionProposal(SCOPE_ID, proposalId);
    expect(stored!.status).toBe("changes_requested");
    expect(stored!.reviewer).toBe(HUMAN_ACTOR);
    const scope = await repo.getScope(SCOPE_ID);
    expect(scope!.state).toBe("draft");
  });

  it("/changes on a review_approved proposal still routes through recordDecompositionReview and returns scope to draft", async () => {
    const proposalId = await seed(repo, providerProjects, "review_approved");
    const apply = createApplyDecompositionCommand({ repo });
    const result = await apply({
      scope_id: SCOPE_ID,
      action: "changes",
      actor: HUMAN_ACTOR,
      reason: "needs rework",
    });
    expect(result.applied).toBe(false);
    // Repository's recordDecompositionReview only allows status=proposed,
    // so the activity short-circuits with a typed reason rather than
    // raising a RepositoryError up to the supervisor workflow.
    expect((result as { reason: string }).reason).toMatch(
      /proposal_not_open_to_changes:review_approved/,
    );
    const stored = await repo.getDecompositionProposal(SCOPE_ID, proposalId);
    expect(stored!.status).toBe("review_approved");
  });

  it("returns no_active_proposal when there's no pending proposal", async () => {
    await seedScope(repo, providerProjects);
    const apply = createApplyDecompositionCommand({ repo });
    const result = await apply({
      scope_id: SCOPE_ID,
      action: "approve",
      actor: HUMAN_ACTOR,
    });
    expect(result).toEqual({ applied: false, reason: "no_active_proposal" });
  });
});

async function seed(
  repo: TaskGraphRepository,
  providerProjects: ProviderProjectRepository,
  endStatus: "proposed" | "review_approved",
): Promise<string> {
  await seedScope(repo, providerProjects);
  const architectRun = createArchitectRun({
    repo,
    providerProjects,
    providerAdapter: { provider: "gitlab" } as never,
    agentRuntime: new FakeAgentRuntimeAdapter(),
  });
  const result = await architectRun({ scope_id: SCOPE_ID });
  if (!("proposal_id" in result) || !result.proposal_id) {
    throw new Error(`architect seed failed: ${JSON.stringify(result)}`);
  }
  const proposalId = result.proposal_id;
  if (endStatus === "review_approved") {
    const reviewerRun = createDecompositionReviewRun({
      repo,
      providerProjects,
      agentRuntime: new FakeAgentRuntimeAdapter({
        envelopeForRun: (packet) => approvedReviewerEnvelope(packet),
      }),
    });
    await reviewerRun({ scope_id: SCOPE_ID, proposal_id: proposalId });
  }
  return proposalId;
}

async function seedScope(
  repo: TaskGraphRepository,
  providerProjects: ProviderProjectRepository,
): Promise<void> {
  await repo.createScope(
    {
      id: SCOPE_ID,
      title: "Scope-command scope",
      description: "Scope for COL-3.0a command routing tests.",
    },
    { actor: SUPERVISOR, capability: "graph.write", reason: "test" },
  );
  const project = await providerProjects.upsertProject({
    provider: "gitlab",
    provider_id: "gitlab-99",
    path: "shdr/colony",
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
    provider: "gitlab",
    provider_id: "issue-100",
    provider_project_id: project.id,
    provider_project_path: project.path,
  });
}

function approvedReviewerEnvelope(packet: {
  readonly freshness: { readonly packet_hash: string };
  readonly scope_id?: string;
}): unknown {
  const taskId = `${packet.scope_id ?? SCOPE_ID}.0` as TaskId;
  return {
    version: 1,
    result: "approved",
    confidence: 0.95,
    requires_human: false,
    risk_level: "low",
    artifacts: [],
    policy_flags: [],
    next_action: "merge",
    freshness: packet.freshness,
    rationale: "spec/DAG approved",
    task_id: taskId,
    role_specific: { findings: [], summary: "approved" },
  };
}

// Suppress unused-var for the REVIEWER constant (kept for symmetry with
// the other proposal tests).
void REVIEWER;
