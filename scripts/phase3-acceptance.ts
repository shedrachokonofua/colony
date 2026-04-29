#!/usr/bin/env -S tsx
// Phase 3 acceptance — drives a real scope from `draft` through `closed`
// against the home-lab GitLab. Live by default (AGENT_RUNTIME=fake is
// refused). One task by default; pass COLONY_PHASE3_TASK_COUNT to
// scale up once you've verified the wiring.
//
// Lifecycle covered:
//   draft
//     -> architect run -> decomposition_proposed
//     -> reviewer spec/DAG run -> review_approved
//     -> programmatic operator /approve -> human_approved
//     -> commit DAG -> active (tasks created)
//   for each task:
//     -> claim -> developer run -> review_requested
//     -> reviewer run -> approved
//     -> human approval + green pipeline -> merge_ready
//     -> merge -> closed
//   -> request scope review -> scope_review_requested
//   -> programmatic scope_review_approved
//   -> closeScope -> closed
//
// Prereqs:
//   - Local stack up (`task up`)
//   - secrets/dev.yaml decryptable + GITLAB_TOKEN sourced
//   - config/colony.yaml configured for AGENT_RUNTIME=pi
//   - active OAuth connection in provider_oauth_connections (Codex)
//
// Teardown: throwaway GitLab group is deleted in the finally block.
// Postgres rows are left for forensic inspection.

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
import { ColonyConfigError, env as loadEnv } from "@colony/config";
import {
  developerCompletionEnvelopeSchema,
  type DeveloperCompletionEnvelope,
} from "@colony/schemas";
import type { ActorId, ScopeId, Task, TaskId } from "@colony/domain";
import { createArchitectRun } from "../apps/worker/src/architect-run.js";
import { createDecompositionReviewRun } from "../apps/worker/src/decomposition-review-run.js";
import { createDeveloperRun } from "../apps/worker/src/developer-run.js";
import { createReviewerRun } from "../apps/worker/src/reviewer-run.js";
import {
  createAgentRuntimeWiring,
  type AgentRuntimeWiring,
} from "../apps/worker/src/agent-runtime-factory.js";
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
import {
  createCloseScope,
  createRequestScopeReview,
} from "../apps/worker/src/scope-close.js";

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  quiet: true,
});

const env = loadEnv();
const databaseUrl = env.DATABASE_URL;
const gitlabBaseUrl = mustEnv("GITLAB_BASE_URL");
const gitlabToken = mustEnv("GITLAB_TOKEN");
const webUrl = process.env["COLONY_WEB_URL"] ?? "http://localhost:3000";

const stamp = Date.now().toString(36);
const scopeId = (process.env["COLONY_PHASE3_SCOPE_ID"] ??
  `col-p3${stamp}`) as ScopeId;
const supervisor = "svc:supervisor" as ActorId;
const developerActor = (process.env["COLONY_PHASE3_DEVELOPER"] ??
  "bot:engine") as ActorId;
const reviewerActor = (process.env["COLONY_PHASE3_REVIEWER"] ??
  "bot:reviewer") as ActorId;
const human = (process.env["COLONY_PHASE3_HUMAN"] ?? "human:op-1") as ActorId;
const groupPath = `colony-phase3-${stamp}`;
const projectPath = process.env["COLONY_PHASE3_PROJECT_PATH"] ?? "csv-export";

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

const agentRuntime = await bootAgentRuntime();

async function bootAgentRuntime(): Promise<AgentRuntimeWiring> {
  if (env.AGENT_RUNTIME === "fake") {
    throw new Error(
      "phase3 acceptance refuses AGENT_RUNTIME=fake — this target is live-only.",
    );
  }
  try {
    const wiring = await createAgentRuntimeWiring(env);
    if (
      wiring.developer.constructor.name === "FakeAgentRuntimeAdapter" ||
      wiring.reviewer.constructor.name === "FakeAgentRuntimeAdapter" ||
      wiring.architect.constructor.name === "FakeAgentRuntimeAdapter"
    ) {
      throw new Error("agent runtime resolved to fake; check colony.yaml");
    }
    return wiring;
  } catch (e) {
    if (e instanceof ColonyConfigError) {
      throw new Error(`colony config error [${e.code}] ${e.message}`);
    }
    throw e;
  }
}

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

const phase = (label: string): void =>
  console.log(`[phase3 ${new Date().toISOString()}] ${label}`);

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
  // --------------------------------------------------------------------
  // 1. Provision a throwaway GitLab group + project + base commit so the
  //    feature branches the architect-proposed tasks land on can be
  //    pushed.
  // --------------------------------------------------------------------
  phase(`bootstrapping disposable group ${groupPath}`);
  const group = await adapter.groups.create({
    name: `Colony Phase 3 ${stamp}`,
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
        {
          action: "create",
          file_path: "README.md",
          content: "# csv-export\n\nA tiny CSV utility produced by Colony.\n",
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

  // Bot identities for the dev + reviewer actors.
  const adapterIdentity = await adapter.identity();
  // Upsert a single identity for the developer actor. The reviewer in
  // this acceptance reuses the same GitLab user so a second
  // upsertProviderIdentity would collide on (provider, provider_user_id).
  // Tolerate the existing identity if a previous acceptance run left it
  // around.
  try {
    await policy.upsertProviderIdentity({
      actor: developerActor,
      provider: "gitlab",
      provider_user_id: adapterIdentity.user_id,
      provider_username: adapterIdentity.username,
      role: "developer",
      is_bot: true,
      allowed_namespaces: [project.path],
    });
  } catch (e) {
    if (
      e instanceof Error &&
      "code" in e &&
      (e as { code?: string }).code === "23505"
    ) {
      phase("provider_identity already present; continuing");
    } else {
      throw e;
    }
  }

  // --------------------------------------------------------------------
  // 2. Create a draft scope + scope-level provider issue (the parent the
  //    architect anchors to) + scope target.
  // --------------------------------------------------------------------
  phase(`creating draft scope ${scopeId}`);
  const scope = await repo.createScope(
    {
      id: scopeId,
      title: "Build a tiny CSV export utility",
      description: [
        "Build a small TypeScript module exporting a `toCsv(rows)` function.",
        "",
        "- src/csv.ts exports `toCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string`",
        "- Values containing quote, comma, or newline are wrapped in double quotes; embedded quotes doubled (RFC4180)",
        "- src/csv.test.ts covers a simple-rows case and an escape case using vitest",
      ].join("\n"),
      // Stay in draft so the architect run is the entry point.
    },
    {
      actor: supervisor,
      capability: "graph.write",
      reason: "phase3_acceptance",
    },
  );
  await providerProjects.linkScopeTarget({
    scope_id: scope.id,
    provider_project_id: project.id,
    role: "primary",
  });
  const scopeIssue = await adapter.issues.create(
    { id: project.provider_id, path: project.path },
    {
      title: scope.title,
      description: scope.description,
      labels: ["state:draft", "scope:parent"],
    },
  );
  await providerProjects.upsertMirror({
    colony_id: scope.id,
    entity_kind: "scope",
    provider: "gitlab",
    provider_id: scopeIssue.id,
    provider_project_id: project.id,
    provider_project_path: project.path,
  });

  // --------------------------------------------------------------------
  // 3. Architect run.
  // --------------------------------------------------------------------
  phase("running architect");
  const architectRun = createArchitectRun({
    repo,
    providerProjects,
    providerAdapter: adapter,
    agentRuntime: agentRuntime.architect,
  });
  const architectResult = await architectRun({ scope_id: scope.id });
  assert(
    architectResult.started && architectResult.envelope_status === "succeeded",
    `architect failed: ${JSON.stringify(architectResult)}`,
  );
  if (!architectResult.started || !architectResult.proposal_id) {
    throw new Error("unreachable");
  }
  const proposalId = architectResult.proposal_id;
  phase(`architect submitted proposal ${proposalId}`);

  // --------------------------------------------------------------------
  // 4. Decomposition reviewer run.
  // --------------------------------------------------------------------
  phase("running decomposition reviewer");
  const reviewRun = createDecompositionReviewRun({
    repo,
    providerProjects,
    agentRuntime: agentRuntime.reviewer,
  });
  const reviewResult = await reviewRun({
    scope_id: scope.id,
    proposal_id: proposalId,
  });
  assert(
    reviewResult.started && reviewResult.envelope_status === "succeeded",
    `decomposition review failed: ${JSON.stringify(reviewResult)}`,
  );
  if (!reviewResult.started) throw new Error("unreachable");
  phase(`decomposition reviewer: ${reviewResult.review_result}`);
  if (reviewResult.review_result !== "approved") {
    throw new Error(
      `reviewer requested changes: ${reviewResult.review_result}; aborting acceptance`,
    );
  }

  // --------------------------------------------------------------------
  // 5. Programmatic operator approval + DAG commit.
  // --------------------------------------------------------------------
  phase("operator approving + committing DAG");
  const liveScope = await repo.getScope(scope.id);
  assert(liveScope, "scope vanished");
  if (!liveScope) throw new Error("unreachable");
  const proposal = await repo.getDecompositionProposal(scope.id, proposalId);
  assert(proposal, "proposal vanished");
  if (!proposal) throw new Error("unreachable");
  await repo.approveDecompositionProposal(
    {
      scope_id: scope.id,
      proposal_id: proposalId,
      expected_scope_state_version: liveScope.state_version,
      envelope_hash: proposal.envelope_hash,
    },
    {
      actor: human,
      capability: "graph.write",
      reason: "phase3_acceptance_human_approve",
    },
  );
  const approvedScope = await repo.getScope(scope.id);
  if (!approvedScope) throw new Error("unreachable");
  const commitResult = await repo.commitDecompositionProposal(
    {
      scope_id: scope.id,
      proposal_id: proposalId,
      expected_scope_state_version: approvedScope.state_version,
      envelope_hash: proposal.envelope_hash,
    },
    {
      actor: supervisor,
      capability: "graph.write",
      reason: "phase3_acceptance_commit",
    },
  );
  phase(
    `DAG committed; ${commitResult.tasks.length} tasks, ${commitResult.dependencies.length} deps`,
  );
  assert(commitResult.tasks.length > 0, "no tasks committed");

  // --------------------------------------------------------------------
  // 6. For each committed task: drive it through the standard task
  //    lifecycle (developer → review → human approval → merge → close).
  //    Iterate in dependency order using `repo.readyTasks`.
  // --------------------------------------------------------------------
  for (let i = 0; i < commitResult.tasks.length; i += 1) {
    const ready = await repo.readyTasks(scope.id);
    if (ready.length === 0) {
      throw new Error("no ready tasks left but committed tasks remain open");
    }
    const candidate = ready[0];
    phase(`task ${i + 1}/${commitResult.tasks.length}: ${candidate.id}`);
    await driveTaskToClose(candidate);
  }

  // --------------------------------------------------------------------
  // 7. Scope close path.
  // --------------------------------------------------------------------
  phase("requesting scope close review");
  const requestScopeReview = createRequestScopeReview({ repo });
  const reviewReq = await requestScopeReview({
    scope_id: scope.id,
    actor: supervisor,
    reason: "all child tasks closed",
  });
  assert(
    reviewReq.applied,
    `scope review request failed: ${JSON.stringify(reviewReq)}`,
  );

  // Programmatic scope-review approval (production path drives this via
  // a /approve comment on the scope issue).
  phase("operator approving scope_review_approved");
  const reviewedScope = await repo.getScope(scope.id);
  if (!reviewedScope) throw new Error("unreachable");
  await repo.updateScopeState(
    scope.id,
    reviewedScope.state_version,
    "scope_review_approved",
    {
      actor: human,
      capability: "graph.write",
      reason: "phase3_acceptance_scope_approved",
    },
  );

  phase("closing scope");
  const closeScope = createCloseScope({ repo });
  const closeResult = await closeScope({
    scope_id: scope.id,
    actor: human,
    reason: "phase3 acceptance close",
  });
  assert(
    closeResult.applied,
    `closeScope failed: ${JSON.stringify(closeResult)}`,
  );

  // Project the closed state to the provider scope artifact.
  await adapter.issues.addLabel(
    { id: project.provider_id, path: project.path },
    scopeIssue.id,
    "state:closed",
  );
  await adapter.issues.close(
    { id: project.provider_id, path: project.path },
    scopeIssue.id,
  );

  const final = await repo.getScope(scope.id);
  assert(
    final?.state === "closed",
    `final scope state was ${final?.state}, expected closed`,
  );

  console.log("");
  console.log("=== Phase 3 acceptance passed ===");
  console.log(`scope: ${scope.id} -> closed`);
  console.log(`provider project: ${project.path}`);
  console.log(`tasks committed: ${commitResult.tasks.length}`);
  console.log(`scope UI: ${webUrl}/scopes/${scope.id}`);
} finally {
  if (cleanupGroupId) {
    await adapter.groups.delete(cleanupGroupId).catch(() => {});
  }
  await pool.end();
}

// --------------------------------------------------------------------
// driveTaskToClose: phase2-style execution for a single task. Re-used
// here for each task the architect produced.
// --------------------------------------------------------------------
async function driveTaskToClose(task: Task): Promise<void> {
  const tStamp = Date.now().toString(36);
  const project = await primaryProject(task.id);
  // Mirror the per-task issue under the same project so the developer
  // run finds it.
  const taskMirror = await primaryTaskMirror(task.id);
  if (!taskMirror) {
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
  }

  // Task target.
  const existing = await providerProjects.listTaskTargets(task.id);
  if (existing.length === 0) {
    await providerProjects.linkTaskTarget({
      task_id: task.id,
      provider_project_id: project.id,
      role: "primary",
    });
  }

  // Claim.
  const claimed = await repo.claimTask(
    task.id,
    developerActor,
    task.state_version,
    {
      actor: supervisor,
      capability: "task.claim",
    },
  );
  assert(claimed?.state === "claimed", `claim failed for ${task.id}`);

  // Developer.
  const startDeveloperRun = createDeveloperRun({
    repo,
    providerProjects,
    providerAdapter: adapter,
    agentRuntime: agentRuntime.developer,
  });
  const devResult = await startDeveloperRun({
    task_id: task.id,
    assignee: developerActor,
  });
  assert(
    devResult.started && devResult.envelope_status === "succeeded",
    `developer failed for ${task.id}: ${JSON.stringify(devResult)}`,
  );
  if (!devResult.started) throw new Error("unreachable");

  // Open MR gate.
  const openMrGate = createOpenMrGate({
    repo,
    providerProjects,
    reviewGate,
    policy,
  });
  const gateOpen = await openMrGate({ task_id: task.id });
  assert(gateOpen.opened, `mr gate did not open for ${task.id}`);

  const devOutput = await agentRuntime.developer.getRunOutput(devResult.run_id);
  const developerEnvelope = developerCompletionEnvelopeSchema.parse(
    devOutput?.envelope,
  ) satisfies DeveloperCompletionEnvelope;

  // Reviewer.
  const startReviewerRun = createReviewerRun({
    repo,
    providerProjects,
    reviewGate,
    providerAdapter: adapter,
    agentRuntime: agentRuntime.reviewer,
  });
  const revResult = await startReviewerRun({
    task_id: task.id,
    reviewer: reviewerActor,
    developer_envelope: developerEnvelope,
  });
  assert(
    revResult.started && revResult.review_result === "approved",
    `reviewer failed/declined for ${task.id}: ${JSON.stringify(revResult)}`,
  );

  // Human approval + green pipeline + gate evaluation.
  const commit = developerEnvelope.artifacts.find((a) => a.kind === "commit");
  const headSha =
    commit?.hash ?? commit?.id ?? developerEnvelope.freshness.commit_sha;
  const recordHumanApproval = createRecordHumanApproval({
    repo,
    providerProjects,
    reviewGate,
    policy,
  });
  await recordHumanApproval({
    task_id: task.id,
    actor: human,
    commit_sha: headSha,
  });
  const recordPipelineStatus = createRecordPipelineStatus({
    repo,
    providerProjects,
    reviewGate,
    policy,
  });
  await recordPipelineStatus({
    task_id: task.id,
    pipeline_id: `phase3-pipeline-${tStamp}`,
    commit_sha: headSha,
    status: "success",
  });
  const checkMrGate = createCheckMrGate({
    repo,
    providerProjects,
    reviewGate,
    policy,
  });
  const gateCheck = await checkMrGate({ task_id: task.id });
  assert(
    gateCheck.checked && gateCheck.gate_open,
    `gate did not open for ${task.id}`,
  );

  // Merge + close (with retry for the typical 405-merge-not-ready).
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
  assert(mergeResult.merged, `merge failed for ${task.id}`);
  if (!mergeResult.merged) throw new Error("unreachable");

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
  assert(closeResult.closed, `task ${task.id} did not close`);
}

async function primaryProject(taskId: TaskId): Promise<{
  readonly id: string;
  readonly provider_id: string;
  readonly path: string;
}> {
  const targets = await providerProjects.listTaskTargets(taskId);
  if (targets[0]) {
    const project = await providerProjects.getProject(
      targets[0].provider_project_id,
    );
    if (project) return project;
  }
  // Fallback to the scope's primary target (architect commits provide
  // task_targets, but we accept either path).
  const scopeTargets = await providerProjects.listScopeTargets(scopeId);
  const primary = scopeTargets.find((t) => t.role === "primary");
  assert(primary, "scope has no primary target");
  if (!primary) throw new Error("unreachable");
  const project = await providerProjects.getProject(
    primary.provider_project_id,
  );
  if (!project)
    throw new Error(`project ${primary.provider_project_id} missing`);
  return project;
}

async function primaryTaskMirror(taskId: TaskId): Promise<unknown> {
  const mirrors = await providerProjects.listMirrorsForColony({
    colony_id: taskId,
    entity_kind: "task",
  });
  return mirrors[0] ?? null;
}
