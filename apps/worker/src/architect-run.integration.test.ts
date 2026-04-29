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
import type { ActorId, ScopeId } from "@colony/domain";
import type { ProviderAdapter } from "@colony/provider";
import { createArchitectRun } from "./architect-run.js";

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

const SCOPE_ID = "col-archit" as ScopeId;
const SUPERVISOR = "svc:supervisor" as ActorId;
const ARCHITECT_ACTOR = "bot:architect" as ActorId;

/**
 * COL-3.0a integration test: drive `startArchitectRun` against a real
 * Postgres + the actual TaskGraphRepository / ProviderProjectRepository.
 * The agent layer is the FakeAgentRuntimeAdapter so the test stays
 * deterministic, but everything DB-side — scope state machine, scope
 * targets, provider mirrors, decomposition_proposals, audit log — is
 * exercised end-to-end. Skips unless COLONY_TEST_DATABASE_URL is set.
 */
describe.runIf(TEST_URL)("createArchitectRun integration", () => {
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

  it("submits a real decomposition proposal that reaches `decomposition_proposed`", async () => {
    await seedDraftScopeWithMirror(repo, providerProjects);

    const run = createArchitectRun({
      repo,
      providerProjects,
      providerAdapter: { provider: "gitlab" } as unknown as ProviderAdapter,
      agentRuntime: new FakeAgentRuntimeAdapter(),
    });

    const result = await run({ scope_id: SCOPE_ID });

    expect(result).toMatchObject({
      started: true,
      scope_id: SCOPE_ID,
      envelope_status: "succeeded",
    });
    const proposalId = (result as { proposal_id?: string }).proposal_id;
    expect(proposalId).toMatch(/^decomp-/);

    const stored = await repo.getDecompositionProposal(SCOPE_ID, proposalId!);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("proposed");
    expect(stored!.proposed_tasks).toHaveLength(1);
    expect(stored!.target_project_mapping).toEqual({
      [`${SCOPE_ID}.1`]: "gitlab-99",
    });

    const scope = await repo.getScope(SCOPE_ID);
    expect(scope!.state).toBe("decomposition_proposed");
    expect(scope!.state_version).toBeGreaterThan(0);

    // Audit trail must include a non-empty `decomposition.proposed` row
    // produced by the architect actor.
    const audit = await audited(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "decomposition.proposed")).toBe(true);
    expect(
      audit.some(
        (a) =>
          a.action === "decomposition.proposed" && a.actor === ARCHITECT_ACTOR,
      ),
    ).toBe(true);
  });

  it("rejects an envelope whose freshness no longer matches the packet and writes a stale audit row", async () => {
    await seedDraftScopeWithMirror(repo, providerProjects);

    const adapter = new FakeAgentRuntimeAdapter({
      envelopeForRun: (packet) => ({
        version: 1,
        result: "done",
        confidence: 0.7,
        requires_human: true,
        risk_level: "low",
        artifacts: [],
        policy_flags: [],
        next_action: "propose_decomposition",
        freshness: {
          ...packet.freshness,
          packet_hash: "sha256:tampered",
        },
        rationale: "tampered freshness",
        scope_id: (packet as { scope_id: string }).scope_id,
        role_specific: {
          proposed_tasks: [
            {
              proposed_task_id: `${SCOPE_ID}.1`,
              title: "T1",
              description: "T1",
              acceptance_criteria: ["ok"],
              non_goals: [],
              suggested_role: "developer",
              suggested_capabilities: [],
            },
          ],
          proposed_dependencies: [],
          open_questions: [],
          assumptions: [],
        },
      }),
    });

    const run = createArchitectRun({
      repo,
      providerProjects,
      providerAdapter: { provider: "gitlab" } as unknown as ProviderAdapter,
      agentRuntime: adapter,
    });

    const result = await run({ scope_id: SCOPE_ID });
    expect(result).toMatchObject({
      started: true,
      envelope_status: "envelope_rejected",
      reason: "envelope_freshness_mismatch",
    });

    const scope = await repo.getScope(SCOPE_ID);
    expect(scope!.state).toBe("draft");

    const audit = await audited(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "architect.envelope.stale")).toBe(
      true,
    );
    expect(audit.some((a) => a.action === "decomposition.proposed")).toBe(
      false,
    );
  });

  it("returns scope_has_no_provider_mirror without writing audit when the mirror is missing", async () => {
    await repo.createScope(
      {
        id: SCOPE_ID,
        title: "Mirrorless scope",
        description: "- Provide CSV export",
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

    const run = createArchitectRun({
      repo,
      providerProjects,
      providerAdapter: { provider: "gitlab" } as unknown as ProviderAdapter,
      agentRuntime: new FakeAgentRuntimeAdapter(),
    });

    const result = await run({ scope_id: SCOPE_ID });
    expect(result).toEqual({
      started: false,
      scope_id: SCOPE_ID,
      reason: "scope_has_no_provider_mirror",
    });

    const audit = await audited(pool, SCOPE_ID);
    expect(audit.some((a) => a.action === "architect.envelope.stale")).toBe(
      false,
    );
    expect(audit.some((a) => a.action === "decomposition.proposed")).toBe(
      false,
    );
  });
});

async function seedDraftScopeWithMirror(
  repo: TaskGraphRepository,
  providerProjects: ProviderProjectRepository,
): Promise<void> {
  await repo.createScope(
    {
      id: SCOPE_ID,
      title: "Architect smoke scope",
      description:
        "Scope for the integration test.\n- Provide CSV export\n- Cover empty rows",
    },
    {
      actor: SUPERVISOR,
      capability: "graph.write",
      reason: "architect_integration_test",
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
