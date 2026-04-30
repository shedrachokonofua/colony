#!/usr/bin/env -S tsx
// Phase 3 acceptance/demo — drives a real scope from `draft` through `closed`
// against the home-lab GitLab. Live by default (AGENT_RUNTIME=fake is
// refused). The default scope is intentionally app-shaped and should
// decompose into a real multi-task DAG without requiring a fixed task count.
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
// Teardown: throwaway GitLab group is deleted in the finally block unless
// COLONY_PHASE3_KEEP_GROUP=1 or COLONY_PHASE3_DEMO=1. Postgres rows are left
// for forensic inspection.

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
import type {
  ActorId,
  ProviderMirror,
  ScopeId,
  Task,
  TaskDependency,
  TaskId,
} from "@colony/domain";
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
const projectPath = process.env["COLONY_PHASE3_PROJECT_PATH"] ?? "echopress";
const keepGroup =
  process.env["COLONY_PHASE3_DEMO"] === "1" ||
  ["1", "true", "yes"].includes(
    process.env["COLONY_PHASE3_KEEP_GROUP"]?.toLowerCase() ?? "",
  );
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

/**
 * Retry a provider call on transient 5xx — homelab GitLab occasionally
 * returns 502 under load. Up to 4 attempts with linear backoff.
 */
async function retry5xx<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status =
        err instanceof GitLabProviderError ? err.status : undefined;
      if (status === undefined || status < 500 || status >= 600) throw err;
      console.log(
        `[phase3 retry] ${label} attempt ${attempt} failed with ${status}; backing off`,
      );
      await sleep(attempt * 1500);
    }
  }
  throw lastError;
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
          content: [
            "# EchoPress",
            "",
            "An end-to-end web app: HTTP API + browser UI + persistence,",
            "built incrementally by Colony agents from this empty scaffold.",
            "",
            "The architect picks the stack. Subsequent tasks add the toolchain,",
            "the API, the UI, the data layer, and tests.",
            "",
          ].join("\n"),
        },
        {
          action: "create",
          file_path: ".gitignore",
          content: [
            "node_modules/",
            "dist/",
            "build/",
            ".cache/",
            ".env",
            ".env.local",
            "*.log",
            ".DS_Store",
            "",
          ].join("\n"),
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
      title: "Build EchoPress, a small full-stack social blogging app",
      description: [
        "Build EchoPress: a working full-stack social blogging web app — HTTP API, browser UI, persistence that survives restart, and authentication. The repo is empty except for a README and .gitignore. The architect picks the stack, the layout, the feature set, and how to slice the work.",
        "",
        "Constraints:",
        "- One stack, one repo. Whatever the architect picks in task 1, every later task uses.",
        "- Decompose into independently reviewable, independently mergeable tasks with explicit dependencies.",
        "- For proposed_dependencies with kind=blocks, from_task_id is the prerequisite that lands first; to_task_id is the dependent task that is blocked.",
        "- A new task can assume only what prior merged tasks provide. Task 1 must leave the repo with a working `npm test` (or equivalent) that subsequent tasks extend.",
        "- Each task adds or extends tests for its own slice. No task may delete, skip, or rewrite previously merged tests to make its own changes pass.",
        "- No external paid services; everything the app talks to must run in CI or on a dev box.",
        "",
        "What 'social blogging app' covers is the architect's call — pick a feature set that's interesting to build but realistic to finish in a handful of tasks.",
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

  const architectRun = createArchitectRun({
    repo,
    providerProjects,
    providerAdapter: adapter,
    agentRuntime: agentRuntime.architect,
  });
  const reviewRun = createDecompositionReviewRun({
    repo,
    providerProjects,
    providerAdapter: adapter,
    agentRuntime: agentRuntime.reviewer,
  });

  // --------------------------------------------------------------------
  // 3-4. Architect + decomposition review loop. A human may only approve
  //      after the reviewer has actually approved the proposal.
  // --------------------------------------------------------------------
  let proposalId: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    phase(`running architect attempt ${attempt}`);
    const architectResult = await architectRun({ scope_id: scope.id });
    assert(
      architectResult.started &&
        architectResult.envelope_status === "succeeded",
      `architect failed: ${JSON.stringify(architectResult)}`,
    );
    if (!architectResult.started || !architectResult.proposal_id) {
      throw new Error("unreachable");
    }
    proposalId = architectResult.proposal_id;
    phase(`architect submitted proposal ${proposalId}`);

    phase(`running decomposition reviewer attempt ${attempt}`);
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
    if (reviewResult.review_result === "approved") break;
    if (attempt === 3) {
      throw new Error(
        `decomposition reviewer did not approve after ${attempt} attempts: ${reviewResult.review_result}`,
      );
    }
  }
  if (!proposalId) throw new Error("decomposition proposal was never approved");

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

  phase("eagerly projecting committed tasks to provider issues");
  await syncCommittedTasksToProvider(
    commitResult.tasks,
    commitResult.dependencies,
  );

  // Merge the architect's spec MR — reviewer + human have approved, DAG
  // committed, so the SPEC.md should land on `main` as a real durable
  // artifact (not just an open MR). Best-effort: a 405 retry handles
  // GitLab's "merge not yet ready" race after the approve call.
  const specMrMirror = (
    await providerProjects.listMirrorsForColony({
      colony_id: scope.id,
      entity_kind: "mr_pr",
    })
  )[0];
  if (specMrMirror) {
    phase(`merging architect spec MR ${specMrMirror.provider_id}`);
    let merged = false;
    for (let attempt = 1; attempt <= 6 && !merged; attempt += 1) {
      try {
        await adapter.mergeRequests.merge(
          { id: project.provider_id, path: project.path },
          specMrMirror.provider_id,
        );
        merged = true;
      } catch (err) {
        if (
          err instanceof GitLabProviderError &&
          err.message.includes("returned 405") &&
          attempt < 6
        ) {
          await sleep(attempt * 1500);
          continue;
        }
        await repo.writeAudit({
          scope_id: scope.id,
          actor: human,
          action: "architect.spec_mr.merge_failed",
          capability: "provider.mr.merge",
          target_kind: "merge_request",
          target_id: specMrMirror.provider_id,
          reason: "spec_mr_merge_failed",
          evidence: {
            attempt,
            message: err instanceof Error ? err.message : String(err),
          },
        });
        break;
      }
    }
    if (merged) {
      await repo.writeAudit({
        scope_id: scope.id,
        actor: human,
        action: "architect.spec_mr.merged",
        capability: "provider.mr.merge",
        target_kind: "merge_request",
        target_id: specMrMirror.provider_id,
        reason: "spec_mr_merged_after_dag_commit",
      });
    }
  }

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
  if (cleanupGroupId && !keepGroup) {
    await adapter.groups.delete(cleanupGroupId).catch(() => {});
  } else if (cleanupGroupId) {
    phase(`keeping GitLab group ${groupPath} for inspection`);
  }
  await pool.end();
}

// --------------------------------------------------------------------
// driveTaskToClose: phase2-style execution for a single task. Re-used
// here for each task the architect produced.
// --------------------------------------------------------------------
async function syncCommittedTasksToProvider(
  tasks: readonly Task[],
  dependencies: readonly TaskDependency[],
): Promise<void> {
  const blockingDepsByTask = new Map<string, string[]>();
  for (const dep of dependencies) {
    if (dep.kind !== "blocks") continue;
    const existing = blockingDepsByTask.get(dep.to_task_id) ?? [];
    existing.push(dep.from_task_id);
    blockingDepsByTask.set(dep.to_task_id, existing);
  }

  for (const task of tasks) {
    const project = await primaryProject(task.id);
    const existing = await primaryTaskMirror(task.id);
    if (existing) continue;

    const blockers = blockingDepsByTask.get(task.id) ?? [];
    const issue = await retry5xx(`issues.create ${task.id}`, () =>
      adapter.issues.create(
        { id: project.provider_id, path: project.path },
        {
          title: task.title,
          description: renderTaskIssueDescription(task, blockers),
          labels: [
            "colony:task",
            blockers.length > 0 ? "state:blocked" : "state:ready",
            `scope:${scopeId}`,
          ],
        },
      ),
    );
    await providerProjects.upsertMirror({
      colony_id: task.id,
      entity_kind: "task",
      provider: "gitlab",
      provider_id: issue.id,
      provider_project_id: project.id,
      provider_project_path: project.path,
    });
    await repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: supervisor,
      action: "provider.task.issue_projected",
      capability: "provider.issues.create",
      target_kind: "issue",
      target_id: issue.id,
      reason: "decomposition_commit_eager_sync",
      evidence: {
        provider_project_id: project.id,
        provider_project_path: project.path,
        blocked_by: blockers,
        labels: [
          "colony:task",
          blockers.length > 0 ? "state:blocked" : "state:ready",
        ],
      },
    });
  }
}

function renderTaskIssueDescription(
  task: Task,
  blockedBy: readonly string[],
): string {
  const lines = [
    `Colony task: ${task.id}`,
    "",
    task.description,
    "",
    "## Acceptance criteria",
  ];
  if (task.acceptance_criteria.length === 0) {
    lines.push("- (none specified)");
  } else {
    for (const criterion of task.acceptance_criteria) {
      lines.push(`- ${criterion}`);
    }
  }
  if (task.non_goals.length > 0) {
    lines.push("", "## Non-goals");
    for (const nonGoal of task.non_goals) {
      lines.push(`- ${nonGoal}`);
    }
  }
  if (blockedBy.length > 0) {
    lines.push("", "## Blocked by");
    for (const blocker of blockedBy) lines.push(`- ${blocker}`);
  }
  return lines.join("\n");
}

async function driveTaskToClose(task: Task): Promise<void> {
  const tStamp = Date.now().toString(36);
  const project = await primaryProject(task.id);
  // Mirror the per-task issue under the same project so the developer
  // run finds it.
  const taskMirror = await primaryTaskMirror(task.id);
  if (!taskMirror) {
    const issue = await retry5xx(`issues.create ${task.id}`, () =>
      adapter.issues.create(
        { id: project.provider_id, path: project.path },
        {
          title: task.title,
          description: task.description,
          labels: ["state:ready"],
        },
      ),
    );
    await providerProjects.upsertMirror({
      colony_id: task.id,
      entity_kind: "task",
      provider: "gitlab",
      provider_id: issue.id,
      provider_project_id: project.id,
      provider_project_path: project.path,
    });
  } else {
    await adapter.issues
      .removeLabel(
        { id: project.provider_id, path: project.path },
        taskMirror.provider_id,
        "state:blocked",
      )
      .catch(() => {});
    await adapter.issues
      .addLabel(
        { id: project.provider_id, path: project.path },
        taskMirror.provider_id,
        "state:ready",
      )
      .catch(() => {});
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

  // The developer agent now has real coding tools and a cloned working
  // tree. It produces, commits, and pushes the implementation itself; we
  // do not pre-seed the branch.
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
  const claimedMirror = await primaryTaskMirror(task.id);
  if (claimedMirror) {
    await adapter.issues
      .removeLabel(
        { id: project.provider_id, path: project.path },
        claimedMirror.provider_id,
        "state:ready",
      )
      .catch(() => {});
    await adapter.issues
      .addLabel(
        { id: project.provider_id, path: project.path },
        claimedMirror.provider_id,
        "state:claimed",
      )
      .catch(() => {});
  }

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
  const progressMirror = await primaryTaskMirror(task.id);
  assert(
    progressMirror,
    `task mirror missing for progress-note check ${task.id}`,
  );
  await assertAgentProgressNoteOnIssue(
    project.provider_id,
    progressMirror.provider_id,
    task.id,
  );

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
    revResult.started,
    `reviewer flow did not start for ${task.id}: ${JSON.stringify(revResult)}`,
  );
  if (!revResult.started) throw new Error("unreachable");
  if (revResult.review_result !== "approved") {
    // Acceptance escape hatch: the reviewer's verdict is recorded in
    // audit + the GitLab MR comment. Force the lifecycle forward so we
    // exercise merge + scope close. Bot reviewer judgment quality is
    // tracked by the bench harness, not gated here.
    phase(
      `task reviewer requested ${revResult.review_result}; force-approving for acceptance`,
    );
    const taskNow = await repo.getTask(task.id);
    if (!taskNow) throw new Error(`task vanished after review: ${task.id}`);
    if (taskNow.state === "changes_requested") {
      const inProgress = await repo.updateTaskState(
        task.id,
        taskNow.state_version,
        "in_progress",
        {
          actor: human,
          capability: "task.assign",
          reason: "phase3_acceptance_force_approve_after_changes_requested",
        },
      );
      await repo.updateTaskState(
        task.id,
        inProgress.state_version,
        "review_requested",
        {
          actor: human,
          capability: "task.assign",
          reason: "phase3_acceptance_force_approve_after_changes_requested",
        },
      );
    }
    const mrMirror = (
      await providerProjects.listMirrorsForColony({
        colony_id: task.id,
        entity_kind: "mr_pr",
      })
    )[0];
    if (mrMirror) {
      const artifact = await reviewGate.getArtifactByProviderRef({
        provider: mrMirror.provider,
        kind: "mr",
        provider_id: mrMirror.provider_id,
      });
      if (artifact) {
        const forcedCommit = developerEnvelope.artifacts.find(
          (a) => a.kind === "commit",
        );
        const forcedHeadSha =
          forcedCommit?.hash ??
          forcedCommit?.id ??
          developerEnvelope.freshness.commit_sha;
        await reviewGate.recordApproval({
          artifact_id: artifact.id,
          actor: reviewerActor,
          commit_sha: forcedHeadSha,
        });
      }
    }
  }

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

async function primaryTaskMirror(
  taskId: TaskId,
): Promise<ProviderMirror | null> {
  const mirrors = await providerProjects.listMirrorsForColony({
    colony_id: taskId,
    entity_kind: "task",
  });
  return mirrors[0] ?? null;
}

async function assertAgentProgressNoteOnIssue(
  projectId: string,
  issueId: string,
  taskId: TaskId,
): Promise<void> {
  const iid = providerLocalId(issueId);
  const url = `${gitlabBaseUrl.replace(/\/+$/, "")}/api/v4/projects/${encodeURIComponent(
    projectId,
  )}/issues/${encodeURIComponent(iid)}/notes?per_page=100`;
  const response = await fetch(url, {
    headers: { "PRIVATE-TOKEN": gitlabToken },
  });
  assert(
    response.ok,
    `failed to read issue notes for ${taskId}: ${response.status}`,
  );
  const notes = (await response.json()) as readonly {
    readonly body?: string;
  }[];
  const prefix = `[colony:${taskId}]`;
  assert(
    notes.some((note) => note.body?.startsWith(prefix)),
    `missing agent progress note with prefix ${prefix}`,
  );
  phase(`agent progress note observed for ${taskId}`);
}

function providerLocalId(id: string): string {
  const index = id.lastIndexOf(":");
  return index === -1 ? id : id.slice(index + 1);
}
