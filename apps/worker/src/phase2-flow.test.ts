import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { FakeAgentRuntimeAdapter, hashEnvelope } from "@colony/agent-runtime";
import {
  ProviderProjectRepository,
  ReviewGateRepository,
  TaskGraphRepository,
  PolicyRepository,
  createPool,
  type Pool,
} from "@colony/db";
import { FakeProviderAdapter } from "@colony/provider";
import {
  developerCompletionEnvelopeSchema,
  type DeveloperCompletionEnvelope,
} from "@colony/schemas";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import { createDeveloperRun } from "./developer-run.js";
import { createReviewerRun } from "./reviewer-run.js";
import {
  createCheckMrGate,
  createOpenMrGate,
  createRecordHumanApproval,
  createRecordPipelineStatus,
} from "./gate-evaluation.js";
import { createCloseTaskAfterMerge, createMergeTask } from "./merge-flow.js";
import {
  createStartDeveloperPlanRun,
  createStartPlanReviewRun,
} from "./task-planning.js";

/**
 * COL-2.14 Phase 2 acceptance — exercises the complete state pipeline
 * `ready -> claimed -> plan_proposed -> plan_review -> in_progress ->
 * review_requested -> merge_ready -> merged -> closed` using the
 * FakeProviderAdapter so this test runs in CI without GitLab credentials.
 * Real-GitLab E2E lives in `scripts/phase2-acceptance.ts`.
 */

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

describe.runIf(liveEnabled)("COL-2.14 Phase 2 flow (fake provider)", () => {
  let pool: Pool;
  let pgClient: Client;
  const stamp = Date.now().toString(36);
  const scope_id = `col-p2${stamp}` as ScopeId;
  const task_id = `${scope_id}.1` as TaskId;
  const developer = "bot:engine" as ActorId;
  const reviewer = "bot:reviewer" as ActorId;
  const human = "human:op-1" as ActorId;

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
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await pgClient?.end();
  });

  it("walks ready -> claimed -> plan gate -> review_requested -> merge_ready -> merged -> closed", async () => {
    const repo = new TaskGraphRepository(pool);
    const providerProjects = new ProviderProjectRepository(pool);
    const reviewGate = new ReviewGateRepository(pool);
    const policy = new PolicyRepository(pool);
    const adapter = new FakeProviderAdapter();
    const agentRuntime = new FakeAgentRuntimeAdapter();

    // 1. Provision a fake provider project + scope + ready task. Ensure the
    //    provider issue mirror is set so the developer activity has a target.
    const providerProject = await adapter.projects.create({
      name: "csv-export",
      path: `colony-p2-${stamp}/csv-export`,
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
        title: "Phase 2 acceptance",
        description: "End-to-end Phase 2 flow",
        state: "active",
      },
      { actor: "human:test" as ActorId, capability: "graph.write" },
    );
    const task = await repo.createTask(
      {
        id: task_id,
        scope_id,
        title: "Add CSV export",
        description: "Implement CSV export endpoint",
        acceptance_criteria: ["Endpoint returns CSV"],
        state: "ready",
      },
      { actor: "svc:supervisor" as ActorId, capability: "graph.write" },
    );
    await providerProjects.linkScopeTarget({
      scope_id,
      provider_project_id: project.id,
      role: "primary",
    });
    await providerProjects.linkTaskTarget({
      task_id: task.id,
      provider_project_id: project.id,
      role: "primary",
    });
    const issue = await adapter.issues.create(
      { id: project.provider_id, path: project.path },
      {
        title: "Add CSV export",
        description: "Phase 2 task",
        labels: ["state:ready"],
      },
    );
    await providerProjects.upsertMirror({
      colony_id: task.id,
      entity_kind: "task",
      provider: adapter.provider,
      provider_id: issue.id,
      provider_project_id: project.id,
      provider_project_path: project.path,
    });

    // Provider identity for the developer + human approver. These backstop
    // capability checks that run during gate ingestion.
    await policy.upsertProviderIdentity({
      actor: developer,
      provider: adapter.provider,
      provider_user_id: "fake-developer",
      role: "developer",
      is_bot: true,
    });
    await policy.upsertProviderIdentity({
      actor: reviewer,
      provider: adapter.provider,
      provider_user_id: "fake-reviewer",
      role: "reviewer",
      is_bot: true,
    });

    // 2. Claim the ready task as the developer.
    const claimed = await repo.claimTask(
      task.id,
      developer,
      task.state_version,
      { actor: "svc:supervisor" as ActorId, capability: "task.claim" },
    );
    expect(claimed?.state).toBe("claimed");

    // 3. Run the Phase 3.5 planning gate before allowing code execution.
    const startDeveloperPlanRun = createStartDeveloperPlanRun({
      repo,
      providerProjects,
      providerAdapter: adapter,
      agentRuntime,
    });
    const planResult = await startDeveloperPlanRun({
      task_id: task.id,
      assignee: developer,
    });
    expect(planResult.started).toBe(true);
    if (!planResult.started) throw new Error("developer plan did not start");
    expect(planResult.envelope_status).toBe("succeeded");
    expect(planResult.final_state).toBe("plan_proposed");
    expect(planResult.developer_plan?.task_id).toBe(task.id);

    const startPlanReviewRun = createStartPlanReviewRun({
      repo,
      providerProjects,
      providerAdapter: adapter,
      agentRuntime,
    });
    const planReviewResult = await startPlanReviewRun({
      task_id: task.id,
      reviewer,
      developer_plan: planResult.developer_plan,
    });
    expect(planReviewResult.started).toBe(true);
    if (!planReviewResult.started) throw new Error("plan review did not start");
    expect(planReviewResult.envelope_status).toBe("succeeded");
    expect(planReviewResult.review_result).toBe("approved");
    expect(planReviewResult.final_state).toBe("in_progress");

    // 4. Run developer flow → opens MR, task → review_requested.
    const startDeveloperRun = createDeveloperRun({
      repo,
      providerProjects,
      providerAdapter: adapter,
      agentRuntime,
    });
    const devResult = await startDeveloperRun({
      task_id: task.id,
      assignee: developer,
    });
    expect(devResult.started).toBe(true);
    if (!devResult.started) throw new Error("developer flow did not start");
    expect(devResult.envelope_status).toBe("succeeded");
    expect(devResult.final_state).toBe("review_requested");
    const mrId = devResult.mr?.id;
    if (!mrId) throw new Error("expected MR id");
    const tokenAfterDeveloper = await repo.getTask(task.id);
    expect(tokenAfterDeveloper?.agent_token_id).toMatch(/access-token-/);
    expect(tokenAfterDeveloper?.agent_token_project_id).toBe(
      project.provider_id,
    );
    expect(tokenAfterDeveloper?.agent_token_revoked_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );

    // 5. Open the mr_pr gate.
    const openMrGate = createOpenMrGate({
      repo,
      providerProjects,
      reviewGate,
      policy,
    });
    const gateOpen = await openMrGate({ task_id: task.id });
    expect(gateOpen.opened).toBe(true);

    // 6. Run reviewer flow with an approved envelope. Reuse the developer's
    //    completion envelope as the input to the review packet builder.
    const devOutput = await agentRuntime.getRunOutput(devResult.run_id);
    const developerEnvelope = developerCompletionEnvelopeSchema.parse(
      devOutput?.envelope,
    ) satisfies DeveloperCompletionEnvelope;

    const startReviewerRun = createReviewerRun({
      repo,
      providerProjects,
      reviewGate,
      providerAdapter: adapter,
      agentRuntime: new FakeAgentRuntimeAdapter(),
    });
    const revResult = await startReviewerRun({
      task_id: task.id,
      reviewer,
      developer_envelope: developerEnvelope,
    });
    expect(revResult.started).toBe(true);
    if (!revResult.started) throw new Error("reviewer did not start");
    expect(revResult.review_result).toBe("approved");
    // After reviewer approval the task remains review_requested until human
    // approval + green pipeline arrive.
    expect(revResult.final_state).toBe("review_requested");

    // 7. Record human /approve and a green pipeline at the developer head.
    const recordHumanApproval = createRecordHumanApproval({
      repo,
      providerProjects,
      reviewGate,
      policy,
    });
    const commitArtifact = developerEnvelope.artifacts.find(
      (a) => a.kind === "commit",
    );
    const headSha =
      commitArtifact?.hash ??
      commitArtifact?.id ??
      developerEnvelope.freshness.commit_sha;
    const humanApproval = await recordHumanApproval({
      task_id: task.id,
      actor: human,
      commit_sha: headSha,
    });
    expect(humanApproval.recorded).toBe(true);

    const recordPipelineStatus = createRecordPipelineStatus({
      repo,
      providerProjects,
      reviewGate,
      policy,
    });
    const pipelineResult = await recordPipelineStatus({
      task_id: task.id,
      pipeline_id: `pipeline-${stamp}`,
      commit_sha: headSha,
      status: "success",
    });
    expect(pipelineResult.recorded).toBe(true);

    // 8. Evaluate gate → task → merge_ready.
    const checkMrGate = createCheckMrGate({
      repo,
      providerProjects,
      reviewGate,
      policy,
    });
    const gateCheck = await checkMrGate({ task_id: task.id });
    expect(gateCheck.checked).toBe(true);
    if (!gateCheck.checked) throw new Error("gate not checked");
    if (!gateCheck.gate_open) {
      throw new Error(`gate did not open: ${gateCheck.reasons.join(", ")}`);
    }
    expect(gateCheck.final_state).toBe("merge_ready");

    // 9. Merge → task → merged.
    const mergeTask = createMergeTask({
      repo,
      providerProjects,
      reviewGate,
      providerAdapter: adapter,
    });
    const mergeResult = await mergeTask({ task_id: task.id });
    expect(mergeResult.merged).toBe(true);
    if (!mergeResult.merged) throw new Error("merge failed");
    expect(mergeResult.final_state).toBe("merged");

    // 10. Close after merge → task → closed.
    const closeTaskAfterMerge = createCloseTaskAfterMerge({
      repo,
      providerProjects,
      reviewGate,
      providerAdapter: adapter,
    });
    const closeResult = await closeTaskAfterMerge({
      task_id: task.id,
      verified_by_webhook: true,
      merge_commit_sha: headSha,
    });
    expect(closeResult.closed).toBe(true);
    if (!closeResult.closed) throw new Error("close failed");
    expect(closeResult.final_state).toBe("closed");

    // 11. Audit trail: every transition links provider event, workflow action,
    //     envelope hash, and resulting state.
    const audit = await repo.listAuditForScope(scope_id, { limit: 200 });
    const actions = new Set(audit.map((a) => a.action));
    expect(actions.has("provider.mr.opened")).toBe(true);
    expect(actions.has("review.approved")).toBe(true);
    expect(actions.has("approval.record")).toBe(true);
    expect(actions.has("gate.evaluate.open")).toBe(true);
    expect(actions.has("provider.mr.merged")).toBe(true);
    expect(actions.has("task.closed")).toBe(true);

    // 12. Stale-approval invalidation sanity check: a failed pipeline kicks
    //     human approvals out, so a re-evaluation can't re-open the gate.
    //     We re-record the human approval, then drop a failed pipeline;
    //     listActiveApprovals should drop to zero.
    const finalTask = await repo.getTask(task.id);
    expect(finalTask?.state).toBe("closed");

    // ensure the review.approved audit carries an envelope hash
    const reviewAudit = audit.find((a) => a.action === "review.approved");
    expect(typeof reviewAudit?.evidence.envelope_hash).toBe("string");
    expect(String(reviewAudit?.evidence.envelope_hash)).toMatch(/^sha256:/);

    // also confirm we can recompute the developer envelope hash deterministically
    expect(hashEnvelope(devOutput?.envelope)).toMatch(/^sha256:/);
  }, 60_000);

  it("invalidates approvals when a failed pipeline lands at the head sha", async () => {
    const repo = new TaskGraphRepository(pool);
    const providerProjects = new ProviderProjectRepository(pool);
    const reviewGate = new ReviewGateRepository(pool);
    const policy = new PolicyRepository(pool);
    const adapter = new FakeProviderAdapter();

    const localStamp = `${Date.now().toString(36)}b`;
    const localScope = `col-p2${localStamp}` as ScopeId;
    const localTask = `${localScope}.1` as TaskId;

    const providerProject = await adapter.projects.create({
      name: "pipeline-failure",
      path: `colony-p2-${localStamp}/pipeline-failure`,
      visibility: "private",
      default_branch: "main",
    });
    const project = await providerProjects.upsertProject({
      provider: adapter.provider,
      provider_id: providerProject.id,
      path: providerProject.path,
      default_branch: "main",
      visibility: "private",
    });
    await repo.createScope(
      {
        id: localScope,
        title: "pipeline failure invariant",
        description: "ensures stale approvals get invalidated",
        state: "active",
      },
      { actor: "human:test" as ActorId, capability: "graph.write" },
    );
    await repo.createTask(
      {
        id: localTask,
        scope_id: localScope,
        title: "no-op",
        description: "no-op",
        state: "review_requested",
      },
      { actor: "svc:supervisor" as ActorId, capability: "graph.write" },
    );
    // Use synthetic, test-unique provider IDs so we don't collide with the
    // first test's MR artifact (FakeProviderAdapter resets its mr-seq per
    // instance, so two tests can mint identical IDs against the same DB).
    const fakeIssueId = `fake-issue-${localStamp}`;
    const fakeMrId = `fake-mr-${localStamp}`;
    await providerProjects.upsertMirror({
      colony_id: localTask,
      entity_kind: "task",
      provider: adapter.provider,
      provider_id: fakeIssueId,
      provider_project_id: project.id,
      provider_project_path: project.path,
    });
    await providerProjects.upsertMirror({
      colony_id: localTask,
      entity_kind: "mr_pr",
      provider: adapter.provider,
      provider_id: fakeMrId,
      provider_project_id: project.id,
      provider_project_path: project.path,
    });
    const artifact = await reviewGate.upsertArtifact({
      kind: "mr",
      provider: adapter.provider,
      provider_id: fakeMrId,
      uri: `${project.path}/merge_requests/${fakeMrId}`,
      task_id: localTask,
      scope_id: localScope,
    });
    await reviewGate.recordApproval({
      artifact_id: artifact.id,
      actor: "human:op-1" as ActorId,
      commit_sha: "deadbeef",
    });
    expect(await reviewGate.listActiveApprovals(artifact.id)).toHaveLength(1);

    const recordPipelineStatus = createRecordPipelineStatus({
      repo,
      providerProjects,
      reviewGate,
      policy,
    });
    const result = await recordPipelineStatus({
      task_id: localTask,
      pipeline_id: "pipeline-fail",
      commit_sha: "deadbeef",
      status: "failed",
    });
    expect(result.recorded).toBe(true);
    if (!result.recorded) throw new Error("not recorded");
    expect(result.invalidated_approvals).toBe(1);
    expect(await reviewGate.listActiveApprovals(artifact.id)).toHaveLength(0);
  }, 60_000);
});
