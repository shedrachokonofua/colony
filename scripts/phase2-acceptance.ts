#!/usr/bin/env -S tsx
// Phase 2 acceptance demo against the configured home-lab GitLab.
//
// Walks a single CSV-export task through:
//   ready -> claimed -> in_progress -> review_requested -> merge_ready
//        -> merged -> closed
//
// Touches a real GitLab project (provisioned per-run, deleted at the end)
// and a real Postgres `colony_test` database. The agent layer remains the
// FakeAgentRuntimeAdapter — pi-coding-agent / pi-mono integration ships
// behind a deployer-supplied adapter and is exercised in higher-level live
// pilot environments, not the acceptance script.

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  PolicyRepository,
  ProviderProjectRepository,
  ReviewGateRepository,
  TaskGraphRepository,
  createPool,
} from "@colony/db";
import {
  GitLabProviderAdapter,
  GitLabProviderError,
} from "@colony/provider-gitlab";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import {
  developerCompletionEnvelopeSchema,
  type DeveloperCompletionEnvelope,
} from "@colony/schemas";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import { createDeveloperRun } from "../apps/worker/src/developer-run.js";
import { createReviewerRun } from "../apps/worker/src/reviewer-run.js";
import {
  createCheckMrGate,
  createOpenMrGate,
  createRecordHumanApproval,
  createRecordPipelineStatus,
} from "../apps/worker/src/gate-evaluation.js";
import {
  createCloseTaskAfterMerge,
  createMergeTask,
} from "../apps/worker/src/merge-flow.js";

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  quiet: true,
});

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgres://colony:colony@localhost:5432/colony";
const gitlabBaseUrl = mustEnv("GITLAB_BASE_URL");
const gitlabToken = mustEnv("GITLAB_TOKEN");
const gitlabReviewerToken = process.env["GITLAB_REVIEWER_TOKEN"];
const webUrl = process.env["COLONY_WEB_URL"] ?? "http://localhost:3000";

const stamp = Date.now().toString(36);
const scopeId = (process.env["COLONY_ACCEPTANCE_SCOPE_ID"] ??
  `col-p2${stamp}`) as ScopeId;
const taskId = `${scopeId}.1` as TaskId;
const supervisor = "svc:supervisor" as ActorId;
const developer = (process.env["COLONY_ACCEPTANCE_DEVELOPER"] ??
  "bot:engine") as ActorId;
const reviewer = (process.env["COLONY_ACCEPTANCE_REVIEWER"] ??
  "bot:reviewer") as ActorId;
const human = (process.env["COLONY_ACCEPTANCE_HUMAN"] ??
  "human:op-1") as ActorId;
const groupPath = `colony-phase2-${stamp}`;
const projectPath =
  process.env["COLONY_ACCEPTANCE_PROJECT_PATH"] ?? "csv-export";
const featureBranch = `colony/${taskId.replace(/[^a-zA-Z0-9._/-]/g, "-")}`;

const pool = createPool({
  connectionString: databaseUrl,
  role: "colony_writer",
});
const repo = new TaskGraphRepository(pool);
const providerProjects = new ProviderProjectRepository(pool);
const policy = new PolicyRepository(pool);
const reviewGate = new ReviewGateRepository(pool);
const adapter = new GitLabProviderAdapter({
  baseUrl: gitlabBaseUrl,
  token: gitlabToken,
});
const reviewerAdapter = new GitLabProviderAdapter({
  baseUrl: gitlabBaseUrl,
  token: gitlabReviewerToken || gitlabToken,
});
const agentRuntime = new FakeAgentRuntimeAdapter();

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawApi<T>(args: {
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}): Promise<T> {
  const res = await fetch(`${gitlabBaseUrl}/api/v4${args.path}`, {
    method: args.method ?? "GET",
    headers: {
      "PRIVATE-TOKEN": gitlabToken,
      "Content-Type": "application/json",
    },
    body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GitLabProviderError(
      `raw ${args.method ?? "GET"} ${args.path} failed ${res.status}: ${text}`,
      res.status,
      text,
    );
  }
  return text ? (JSON.parse(text) as T) : (null as T);
}

let cleanupGroupId: string | null = null;

try {
  // ---------------------------------------------------------------------
  // 1. Provision a throwaway GitLab group + project + base commit so the
  //    feature branch can be pushed.
  // ---------------------------------------------------------------------
  const group = await adapter.groups.create({
    name: `Colony Phase 2 ${stamp}`,
    path: groupPath,
    visibility: "private",
  });
  cleanupGroupId = group.id;
  const projectInfo = await adapter.projects.create({
    name: projectPath,
    path: projectPath,
    namespace: group.id,
    visibility: "private",
    default_branch: "main",
  });
  await rawApi({
    method: "POST",
    path: `/projects/${encodeURIComponent(projectInfo.id)}/repository/commits`,
    body: {
      branch: "main",
      commit_message: "chore: initial commit",
      actions: [
        { action: "create", file_path: "README.md", content: "# csv-export" },
      ],
    },
  });
  // Simulate developer push of the feature branch.
  await adapter.branches.create(
    { id: projectInfo.id, path: projectInfo.path },
    featureBranch,
    "main",
  );
  await rawApi({
    method: "POST",
    path: `/projects/${encodeURIComponent(projectInfo.id)}/repository/commits`,
    body: {
      branch: featureBranch,
      commit_message: "feat: csv export",
      actions: [
        {
          action: "create",
          file_path: "src/csv.ts",
          content: "export const csv = '';\n",
        },
      ],
    },
  });

  const project = await providerProjects.upsertProject({
    provider: "gitlab",
    provider_id: projectInfo.id,
    path: projectInfo.path,
    default_branch: projectInfo.default_branch,
    visibility: projectInfo.visibility,
  });
  const providerIdentity = await adapter.identity();
  const reviewerIdentity = await reviewerAdapter.identity();
  await policy.upsertProviderIdentity({
    actor: developer,
    provider: "gitlab",
    provider_user_id: providerIdentity.user_id,
    provider_username: providerIdentity.username,
    role: "developer",
    is_bot: true,
    allowed_namespaces: [project.path],
  });
  if (
    reviewer === developer ||
    reviewerIdentity.user_id !== providerIdentity.user_id
  ) {
    await policy.upsertProviderIdentity({
      actor: reviewer,
      provider: "gitlab",
      provider_user_id: reviewerIdentity.user_id,
      provider_username: reviewerIdentity.username,
      role: "reviewer",
      is_bot: true,
      allowed_namespaces: [project.path],
    });
  }

  // ---------------------------------------------------------------------
  // 2. Seed Colony view of the world.
  // ---------------------------------------------------------------------
  const existing = await repo.getScope(scopeId);
  assert(!existing, `scope already exists: ${scopeId}`);

  const scope = await repo.createScope(
    {
      id: scopeId,
      title: "Phase 2 acceptance",
      description: "End-to-end Phase 2 flow against home-lab GitLab.",
      state: "active",
    },
    {
      actor: supervisor,
      capability: "graph.write",
      reason: "phase2_acceptance",
    },
  );

  const task = await repo.createTask(
    {
      id: taskId,
      scope_id: scope.id,
      title: "Add CSV export",
      description: "Implement CSV export endpoint.",
      acceptance_criteria: ["Endpoint returns CSV"],
      state: "ready",
    },
    {
      actor: supervisor,
      capability: "graph.write",
      reason: "phase2_acceptance",
    },
  );

  await providerProjects.linkScopeTarget({
    scope_id: scope.id,
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
      title: task.title,
      description: task.description,
      labels: ["state:ready"],
    },
  );
  await providerProjects.upsertMirror({
    colony_id: task.id,
    entity_kind: "task",
    provider: "gitlab",
    provider_id: issue.id,
    provider_project_id: project.id,
    provider_project_path: project.path,
  });

  // ---------------------------------------------------------------------
  // 3. Claim → developer flow → review_requested.
  // ---------------------------------------------------------------------
  const claimed = await repo.claimTask(task.id, developer, task.state_version, {
    actor: supervisor,
    capability: "task.claim",
  });
  assert(claimed?.state === "claimed", "task did not transition to claimed");

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
  assert(devResult.started, "developer flow did not start");
  if (!devResult.started) throw new Error("unreachable");
  assert(
    devResult.envelope_status === "succeeded",
    "developer envelope rejected",
  );
  assert(
    devResult.final_state === "review_requested",
    "task did not reach review_requested",
  );

  // ---------------------------------------------------------------------
  // 4. Open MR gate, run reviewer (auto-approves via FakeAgentRuntime).
  // ---------------------------------------------------------------------
  const openMrGate = createOpenMrGate({
    repo,
    providerProjects,
    reviewGate,
    policy,
  });
  const gateOpen = await openMrGate({ task_id: task.id });
  assert(gateOpen.opened, "mr_pr gate did not open");

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
  assert(revResult.started, "reviewer flow did not start");
  if (!revResult.started) throw new Error("unreachable");
  assert(revResult.review_result === "approved", "reviewer did not approve");

  // ---------------------------------------------------------------------
  // 5. Human /approve + green pipeline → checkMrGate → merge_ready.
  // ---------------------------------------------------------------------
  const commit = developerEnvelope.artifacts.find((a) => a.kind === "commit");
  const headSha =
    commit?.hash ?? commit?.id ?? developerEnvelope.freshness.commit_sha;

  const recordHumanApproval = createRecordHumanApproval({
    repo,
    providerProjects,
    reviewGate,
    policy,
  });
  const human_approval = await recordHumanApproval({
    task_id: task.id,
    actor: human,
    commit_sha: headSha,
  });
  assert(
    human_approval.recorded,
    `human approval rejected: ${(human_approval as { reason?: string }).reason}`,
  );

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
  assert(pipelineResult.recorded, "pipeline status not recorded");

  const checkMrGate = createCheckMrGate({
    repo,
    providerProjects,
    reviewGate,
    policy,
  });
  const gateCheck = await checkMrGate({ task_id: task.id });
  assert(gateCheck.checked, "gate not checked");
  if (!gateCheck.checked) throw new Error("unreachable");
  if (!gateCheck.gate_open) {
    throw new Error(`gate did not open: ${gateCheck.reasons.join(", ")}`);
  }
  assert(
    gateCheck.final_state === "merge_ready",
    "task did not transition to merge_ready",
  );

  // ---------------------------------------------------------------------
  // 6. Merge → merged. Close → closed.
  // ---------------------------------------------------------------------
  const mergeTask = createMergeTask({
    repo,
    providerProjects,
    reviewGate,
    providerAdapter: adapter,
  });
  let mergeResult = await mergeTask({ task_id: task.id });
  for (let attempt = 1; !mergeResult.merged && attempt <= 6; attempt += 1) {
    if (!mergeResult.reason.includes("returned 405")) break;
    await sleep(attempt * 1000);
    mergeResult = await mergeTask({ task_id: task.id });
  }
  assert(
    mergeResult.merged,
    `merge failed: ${(mergeResult as { reason?: string }).reason}`,
  );
  if (!mergeResult.merged) throw new Error("unreachable");
  assert(
    mergeResult.final_state === "merged",
    "task did not transition to merged",
  );

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
  assert(closeResult.closed, "close failed");
  if (!closeResult.closed) throw new Error("unreachable");
  assert(
    closeResult.final_state === "closed",
    "task did not transition to closed",
  );

  // ---------------------------------------------------------------------
  // 7. Verify audit trail.
  // ---------------------------------------------------------------------
  const audit = await repo.listAuditForScope(scopeId, { limit: 200 });
  const expected = [
    "provider.mr.opened",
    "review.approved",
    "approval.record",
    "gate.evaluate.open",
    "provider.mr.merged",
    "task.closed",
  ];
  for (const action of expected) {
    assert(
      audit.some((a) => a.action === action),
      `missing audit action: ${action}`,
    );
  }

  console.log("Phase 2 acceptance passed");
  console.log(`scope: ${scope.id}`);
  console.log(`provider project: ${project.path}`);
  console.log(`task: ${task.id} -> closed`);
  console.log(`MR id: ${devResult.mr?.id}`);
  console.log(`merge result: ${mergeResult.mr_id} -> merged`);
  console.log(`scope UI: ${webUrl}/scopes/${scope.id}`);
} finally {
  if (cleanupGroupId) {
    await adapter.groups.delete(cleanupGroupId).catch(() => {});
  }
  await pool.end();
}
