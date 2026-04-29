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

const SCOPE_ID = "col-rvw01" as ScopeId;
const SUPERVISOR = "svc:supervisor" as ActorId;
const REVIEWER_ACTOR = "bot:reviewer" as ActorId;

/**
 * COL-3.0a integration test for the spec/DAG Reviewer run.
 *
 * Seeds a real architect-submitted proposal via `startArchitectRun` (fake
 * adapter), then drives `startDecompositionReviewRun` and asserts the
 * proposal lands in either `review_approved` or `changes_requested`
 * depending on the reviewer envelope. Also verifies scope state
 * transitions: changes_requested returns the scope to `draft`.
 */
describe.runIf(TEST_URL)("createDecompositionReviewRun integration", () => {
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

  it("approves a proposal when the reviewer returns result=approved", async () => {
    const proposalId = await seedArchitectProposal(repo, providerProjects);

    const run = createDecompositionReviewRun({
      repo,
      providerProjects,
      agentRuntime: new FakeAgentRuntimeAdapter({
        envelopeForRun: (packet) => buildReviewerEnvelope(packet, "approved"),
      }),
    });

    const result = await run({
      scope_id: SCOPE_ID,
      proposal_id: proposalId,
    });

    expect(result).toMatchObject({
      started: true,
      scope_id: SCOPE_ID,
      proposal_id: proposalId,
      envelope_status: "succeeded",
      review_result: "approved",
    });

    const stored = await repo.getDecompositionProposal(SCOPE_ID, proposalId);
    expect(stored!.status).toBe("review_approved");
    expect(stored!.reviewer).toBe(REVIEWER_ACTOR);
    expect(stored!.reviewer_result).toBe("approved");

    const scope = await repo.getScope(SCOPE_ID);
    expect(scope!.state).toBe("decomposition_proposed");

    const audit = await audited(pool, SCOPE_ID);
    expect(
      audit.some((a) => a.action === "decomposition.review.approved"),
    ).toBe(true);
  });

  it("requests changes and returns scope to draft when reviewer returns changes_requested", async () => {
    const proposalId = await seedArchitectProposal(repo, providerProjects);

    const run = createDecompositionReviewRun({
      repo,
      providerProjects,
      agentRuntime: new FakeAgentRuntimeAdapter({
        envelopeForRun: (packet) =>
          buildReviewerEnvelope(packet, "changes_requested"),
      }),
    });

    const result = await run({
      scope_id: SCOPE_ID,
      proposal_id: proposalId,
    });
    expect(result).toMatchObject({
      envelope_status: "succeeded",
      review_result: "changes_requested",
    });

    const stored = await repo.getDecompositionProposal(SCOPE_ID, proposalId);
    expect(stored!.status).toBe("changes_requested");

    const scope = await repo.getScope(SCOPE_ID);
    expect(scope!.state).toBe("draft");
    expect(scope!.state_version).toBeGreaterThan(0);

    const audit = await audited(pool, SCOPE_ID);
    expect(
      audit.some((a) => a.action === "decomposition.review.changes_requested"),
    ).toBe(true);
  });

  it("rejects an envelope whose task_id doesn't match the synthetic <scope_id>.0", async () => {
    const proposalId = await seedArchitectProposal(repo, providerProjects);

    const run = createDecompositionReviewRun({
      repo,
      providerProjects,
      agentRuntime: new FakeAgentRuntimeAdapter({
        envelopeForRun: (packet) =>
          buildReviewerEnvelope(
            packet,
            "approved",
            `${SCOPE_ID}.999` as TaskId,
          ),
      }),
    });

    const result = await run({ scope_id: SCOPE_ID, proposal_id: proposalId });
    expect(result).toMatchObject({
      envelope_status: "envelope_rejected",
      reason: "envelope_missing_or_mismatched",
    });

    const stored = await repo.getDecompositionProposal(SCOPE_ID, proposalId);
    expect(stored!.status).toBe("proposed");
    const audit = await audited(pool, SCOPE_ID);
    expect(
      audit.some((a) => a.action === "decomposition.review.envelope_rejected"),
    ).toBe(true);
  });

  it("refuses to run against a proposal that's already approved", async () => {
    const proposalId = await seedArchitectProposal(repo, providerProjects);
    const proposal = await repo.getDecompositionProposal(SCOPE_ID, proposalId);
    await repo.recordDecompositionReview(
      {
        scope_id: SCOPE_ID,
        proposal_id: proposalId,
        envelope_hash: proposal!.envelope_hash,
        reviewer: REVIEWER_ACTOR,
        result: "approved",
      },
      {
        actor: REVIEWER_ACTOR,
        capability: "graph.write",
        reason: "preset",
      },
    );

    const run = createDecompositionReviewRun({
      repo,
      providerProjects,
      agentRuntime: new FakeAgentRuntimeAdapter({
        envelopeForRun: (packet) => buildReviewerEnvelope(packet, "approved"),
      }),
    });

    const result = await run({ scope_id: SCOPE_ID, proposal_id: proposalId });
    expect(result).toEqual({
      started: false,
      scope_id: SCOPE_ID,
      proposal_id: proposalId,
      reason: "proposal_not_awaiting_review:review_approved",
    });
  });
});

async function seedArchitectProposal(
  repo: TaskGraphRepository,
  providerProjects: ProviderProjectRepository,
): Promise<string> {
  await repo.createScope(
    {
      id: SCOPE_ID,
      title: "Reviewer-run scope",
      description:
        "Scope for the spec/DAG reviewer integration test.\n- Provide CSV export\n- Cover empty rows",
    },
    {
      actor: SUPERVISOR,
      capability: "graph.write",
      reason: "review_integration_test",
    },
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

  const architectRun = createArchitectRun({
    repo,
    providerProjects,
    providerAdapter: { provider: "gitlab" } as never,
    agentRuntime: new FakeAgentRuntimeAdapter(),
  });
  const result = await architectRun({ scope_id: SCOPE_ID });
  if (!("proposal_id" in result) || !result.proposal_id) {
    throw new Error(`seedArchitectProposal failed: ${JSON.stringify(result)}`);
  }
  return result.proposal_id;
}

function buildReviewerEnvelope(
  packet: {
    readonly freshness: { readonly packet_hash: string };
    readonly scope_id?: string;
  } & Record<string, unknown>,
  result: "approved" | "changes_requested",
  taskIdOverride?: TaskId,
): unknown {
  const taskId = taskIdOverride ?? `${packet.scope_id ?? SCOPE_ID}.0`;
  return {
    version: 1,
    result,
    confidence: 0.9,
    requires_human: false,
    risk_level: "low",
    artifacts: [],
    policy_flags: [],
    next_action: result === "approved" ? "merge" : "return_to_author",
    freshness: packet.freshness,
    rationale: `synthetic ${result}`,
    task_id: taskId,
    role_specific: {
      findings: [],
      summary: `Spec/DAG ${result}`,
    },
  };
}

async function audited(
  pool: Pool,
  scopeId: ScopeId,
): Promise<ReadonlyArray<{ action: string; actor: string }>> {
  const { rows } = await pool.query<{ action: string; actor: string }>(
    `SELECT action, actor FROM audit_log
     WHERE scope_id = $1
     ORDER BY recorded_at`,
    [scopeId],
  );
  return rows;
}
