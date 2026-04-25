#!/usr/bin/env -S tsx
// Phase 1 acceptance demo against the configured home-lab GitLab:
// - creates a throwaway provider project for this run
// - opens a provider parent issue and records the scope mirror
// - creates a ready task from a mock approved decomposition
// - runs the supervisor claim activity and verifies provider projection audit

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type {
  ActorId,
  ProviderProjectId,
  ScopeId,
  TaskId,
} from "@colony/domain";
import {
  createPool,
  PolicyRepository,
  ProviderProjectRepository,
  TaskGraphRepository,
} from "@colony/db";
import {
  GitLabProviderAdapter,
  GitLabProviderError,
} from "@colony/provider-gitlab";
import { claimReadyTask } from "../apps/worker/src/activities.js";

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  quiet: true,
});

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgres://colony:colony@localhost:5432/colony";
const gitlabBaseUrl = mustEnv("GITLAB_BASE_URL");
const gitlabToken = mustEnv("GITLAB_TOKEN");
const webUrl = process.env["COLONY_WEB_URL"] ?? "http://localhost:3000";

const scopeId = (process.env["COLONY_ACCEPTANCE_SCOPE_ID"] ??
  `col-p1${Date.now().toString(36)}`) as ScopeId;
const taskId = `${scopeId}.1` as TaskId;
const supervisor = "svc:supervisor" as ActorId;
const assignee = (process.env["COLONY_ACCEPTANCE_ASSIGNEE"] ??
  "bot:engine") as ActorId;

const pool = createPool({
  connectionString: databaseUrl,
  role: "colony_writer",
});
const repo = new TaskGraphRepository(pool);
const providerProjects = new ProviderProjectRepository(pool);
const policies = new PolicyRepository(pool);
const adapter = new GitLabProviderAdapter({
  baseUrl: gitlabBaseUrl,
  token: gitlabToken,
});

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function retryProvider<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const retriable = e instanceof GitLabProviderError && e.status >= 500;
      if (!retriable || attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  if (last instanceof Error) {
    throw new Error(`${label} failed after retries: ${last.message}`, {
      cause: last,
    });
  }
  throw new Error(`${label} failed after retries`);
}

try {
  const existing = await repo.getScope(scopeId);
  assert(!existing, `scope already exists: ${scopeId}`);

  const runSuffix = scopeId.replace(/^col-/, "");
  const providerIdentity = await adapter.identity();
  const projectPath =
    process.env["COLONY_ACCEPTANCE_PROJECT_PATH"] ??
    `colony-phase1-${runSuffix}`;
  const projectInfo = await retryProvider("create acceptance project", () =>
    adapter.projects.create({
      name: `Colony Phase 1 ${runSuffix}`,
      path: projectPath,
      description: `Colony Phase 1 acceptance project for ${scopeId}`,
      visibility: "private",
    }),
  );
  const project = await providerProjects.upsertProject({
    provider: "gitlab",
    provider_id: projectInfo.id,
    path: projectInfo.path,
    default_branch: projectInfo.default_branch,
    visibility: projectInfo.visibility,
  });
  await policies.upsertProviderIdentity({
    actor: assignee,
    provider: "gitlab",
    provider_user_id: providerIdentity.user_id,
    provider_username: providerIdentity.username,
    role: "developer",
    is_bot: true,
    allowed_namespaces: [project.path],
  });

  const scope = await repo.createScope(
    {
      id: scopeId,
      title: "Phase 1 acceptance",
      description:
        "Home-lab GitLab acceptance scope for provider mirrors, ready-task claim, and provider projection.",
      state: "decomposition_approved",
    },
    {
      actor: supervisor,
      capability: "graph.write",
      reason: "phase1_acceptance",
    },
  );

  const parentIssue = await retryProvider("create provider scope issue", () =>
    adapter.epics.create(
      { id: project.provider_id, path: project.path },
      {
        title: scope.title,
        description: `${scope.description}\n\nColony scope: ${scope.id}`,
        labels: ["colony:scope", `state:${scope.state}`],
      },
    ),
  );
  const scopeMirror = await providerProjects.upsertMirror({
    colony_id: scope.id,
    entity_kind: "scope",
    provider: "gitlab",
    provider_id: parentIssue.id,
    provider_project_id: project.id as ProviderProjectId,
    provider_project_path: project.path,
    source_version: parentIssue.metadata.version,
  });
  await repo.writeAudit({
    scope_id: scope.id,
    actor: supervisor,
    action: "provider.mirror.scope",
    capability: "provider.epics.create",
    target_kind: "provider_mirror",
    target_id: scopeMirror.id,
    reason: "phase1_acceptance",
    evidence: { provider_id: parentIssue.id },
  });

  const task = await repo.createTask(
    {
      id: taskId,
      scope_id: scopeId,
      title: "Implement acceptance-ready task",
      description:
        "Mock decomposition output. The supervisor should claim this task and project claimed state to GitLab.",
      acceptance_criteria: [
        "task is created in state:ready",
        "supervisor claims exactly one task",
        "provider issue receives state:claimed",
      ],
      state: "ready",
    },
    {
      actor: supervisor,
      capability: "graph.write",
      reason: "phase1_acceptance",
    },
  );
  const taskIssue = await retryProvider("create provider task issue", () =>
    adapter.issues.create(
      { id: project.provider_id, path: project.path },
      {
        title: task.title,
        description: `${task.description}\n\nColony task: ${task.id}`,
        labels: ["colony:task", "state:ready"],
      },
    ),
  );
  const taskMirror = await providerProjects.upsertMirror({
    colony_id: task.id,
    entity_kind: "task",
    provider: "gitlab",
    provider_id: taskIssue.id,
    provider_project_id: project.id,
    provider_project_path: project.path,
    source_version: taskIssue.metadata.version,
  });
  await providerProjects.linkTaskTarget({
    task_id: task.id,
    provider_project_id: project.id,
    role: "primary",
  });
  await repo.writeAudit({
    scope_id: scope.id,
    task_id: task.id,
    actor: supervisor,
    action: "provider.mirror.task",
    capability: "provider.issues.create",
    target_kind: "provider_mirror",
    target_id: taskMirror.id,
    reason: "phase1_acceptance",
    evidence: { provider_id: taskIssue.id },
  });

  const result = await claimReadyTask({ scope_id: scopeId, assignee });
  assert(result.claimed, `supervisor did not claim a task: ${result.reason}`);
  assert(
    result.task_id === taskId,
    `unexpected claimed task: ${result.task_id}`,
  );
  assert(
    result.provider_projection?.status === "synced",
    `provider projection failed: ${result.provider_projection?.reason}`,
  );

  const claimed = await repo.getTask(taskId);
  assert(claimed?.state === "claimed", "task is not claimed in Task Graph");
  assert(claimed.assignee === assignee, "task assignee did not persist");

  const audit = await repo.listAuditForScope(scopeId, { limit: 100 });
  const projectionAudit = audit.find(
    (record) => record.action === "provider.project.task_assignment",
  );
  assert(projectionAudit, "missing provider projection audit");
  assert(
    projectionAudit.evidence.provider_assignee_id === providerIdentity.user_id,
    "provider assignment was not audited",
  );

  console.log("Phase 1 acceptance passed");
  console.log(`scope: ${scopeId}`);
  console.log(`provider project: ${projectInfo.path}`);
  console.log(
    `parent issue: ${parentIssue.metadata.web_url ?? parentIssue.id}`,
  );
  console.log(`task issue: ${taskIssue.metadata.web_url ?? taskIssue.id}`);
  console.log(`claimed task: ${taskId} -> ${assignee}`);
  console.log(`scope UI: ${webUrl}/scopes/${scopeId}`);
  console.log(`task UI: ${webUrl}/scopes/${scopeId}/tasks/${taskId}`);
} finally {
  await pool.end();
}
