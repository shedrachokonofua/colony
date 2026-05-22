#!/usr/bin/env -S tsx
// Real local E2E: API/operator surfaces create and drive the graph, Temporal
// owns the agent lifecycle, and webhook-dispatcher ingests the review/pipeline
// events that open the merge gate.

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Connection, Client as TemporalClient } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  IdempotencyRepository,
  PolicyRepository,
  ProviderProjectRepository,
  TaskGraphRepository,
  createPool,
} from "@colony/db";
import { env as loadEnv, resetEnvCache } from "@colony/config";
import type {
  ActorId,
  Capability,
  ProviderMirror,
  ProviderProject,
  Scope,
  ScopeId,
  Task,
  TaskId,
} from "@colony/domain";
import { GitLabProviderAdapter } from "@colony/provider-gitlab";
import { buildApp as buildApiApp } from "../apps/api/src/app.js";
import { buildApp as buildWebhookApp } from "../apps/webhook-dispatcher/src/app.js";
import {
  activities,
  initializeAgentRuntime,
} from "../apps/worker/src/activities.js";
import {
  scopeSupervisorWorkflow,
  supervisorWorkflowId,
} from "@colony/workflows";

loadDotenv({ quiet: true });

const stamp = Date.now().toString(36);
const taskQueue =
  process.env["COLONY_E2E_TASK_QUEUE"] ?? `colony-real-flow-${stamp}`;
process.env["TEMPORAL_TASK_QUEUE"] = taskQueue;
process.env["GITLAB_WEBHOOK_SECRET"] ||= `local-real-flow-${stamp}`;
resetEnvCache();

const cfg = loadEnv();
const human = (process.env["COLONY_E2E_ACTOR"] ?? "human:op-1") as ActorId;
const keepGroup = truthy(process.env["COLONY_E2E_KEEP_GROUP"]);
const timeoutMinutes = Number(process.env["COLONY_E2E_TIMEOUT_MINUTES"] ?? 75);
const timeoutMs = timeoutMinutes * 60_000;
const pollMs = Number(process.env["COLONY_E2E_POLL_MS"] ?? 15_000);
const gitlabBaseUrl = mustEnv("GITLAB_BASE_URL").replace(/\/+$/, "");
const gitlabToken = mustEnv("GITLAB_TOKEN");
const webhookSecret = cfg.GITLAB_WEBHOOK_SECRET;
const scopeId = `col-e2e${stamp}` as ScopeId;
const groupPath = `colony-real-flow-${stamp}`;
const projectPath = "echopress";
const workflowId = supervisorWorkflowId(scopeId);

if (
  cfg.AGENT_RUNTIME === "fake" ||
  (!cfg.AGENT_RUNTIME && !cfg.COLONY_CONFIG_PATH)
) {
  throw new Error(
    "real E2E requires AGENT_RUNTIME=pi or COLONY_CONFIG_PATH pointing at a live runtime config",
  );
}

const pool = createPool({
  connectionString: cfg.DATABASE_URL,
  role: "colony_writer",
});
const repo = new TaskGraphRepository(pool);
const policy = new PolicyRepository(pool);
const providerProjects = new ProviderProjectRepository(pool);
const idempotency = new IdempotencyRepository(pool);
const adapter = new GitLabProviderAdapter({
  baseUrl: gitlabBaseUrl,
  token: gitlabToken,
});
const api = buildApiApp({
  taskGraph: {
    repo,
    policyRepo: policy,
    idempotencyRepo: idempotency,
    providerProjects,
    providerAdapter: adapter,
  },
  providerAdmin: {
    repo,
    providerProjects,
    policyRepo: policy,
    adapter,
  },
});
const webhook = buildWebhookApp();

let cleanupGroupId: string | undefined;

try {
  await ensureLocalOperatorPolicy();
  await initializeAgentRuntime();

  phase(`creating disposable GitLab project ${groupPath}/${projectPath}`);
  const group = await adapter.groups.create({
    name: `Colony Real Flow ${stamp}`,
    path: groupPath,
    visibility: "private",
  });
  cleanupGroupId = group.id;

  const providerProject = await adapter.projects.create({
    name: projectPath,
    path: projectPath,
    namespace: group.id,
    visibility: "private",
    default_branch: "main",
  });
  await adapter.commits.create(
    { id: providerProject.id, path: providerProject.path },
    {
      branch: "main",
      message: "chore: seed EchoPress base",
      actions: [
        {
          action: "create",
          file_path: "README.md",
          content: [
            "# EchoPress",
            "",
            "A small install-free Node.js web app seed for Colony to finish.",
            "",
          ].join("\n"),
        },
        {
          action: "create",
          file_path: "package.json",
          content: JSON.stringify(
            {
              name: "echopress",
              version: "0.0.0",
              type: "module",
              scripts: {
                start: "node server.js",
                test: "node --test --test-timeout=10000 --test-force-exit",
              },
            },
            null,
            2,
          ),
        },
        {
          action: "create",
          file_path: ".gitignore",
          content: "node_modules/\ncoverage/\n.DS_Store\n",
        },
      ],
    },
  );

  phase("registering provider project through API");
  const registered = await apiJson<{ project: ProviderProject }>(
    "/admin/provider/projects",
    {
      method: "POST",
      body: {
        provider: "gitlab",
        provider_id: providerProject.id,
        path: providerProject.path,
      },
    },
  );
  await ensureBotIdentity(registered.project);

  phase(`creating scope ${scopeId} through API`);
  await apiJson<Scope>("/scopes", {
    method: "POST",
    idempotencyKey: `scope-${scopeId}`,
    body: {
      id: scopeId,
      title: "Build EchoPress local posting app",
      description: [
        "Build a small but real Node.js web app in this repository.",
        "",
        "End state:",
        "- Keep the stack install-free: plain Node.js built-ins, static HTML, vanilla CSS, and vanilla JS.",
        "- Add `server.js` that exports `requestHandler(req, res)` and `createServer()` and only listens when run directly.",
        "- Serve `public/index.html`, `public/styles.css`, and `public/app.js`.",
        "- The browser UI should provide a posting composer, seeded posts, and client-side add-post behavior.",
        "- Add `test/server.test.js` using Node's built-in test runner and local HTTP requests against `createServer()`.",
        "- Keep `npm test` dependency-free and make sure it exits cleanly.",
        "- Update README with run and test commands.",
        "",
        "Decompose into exactly one implementation task. Do not split this scope into multiple tasks.",
      ].join("\n"),
      provider_targets: [
        { provider_project_id: registered.project.id, role: "primary" },
      ],
      provider_mirror: { provider_project_id: registered.project.id },
    },
  });

  const connectionOptions = {
    address: cfg.TEMPORAL_ADDRESS,
    tls:
      cfg.TEMPORAL_TLS_SERVER_NAME !== undefined
        ? { serverNameOverride: cfg.TEMPORAL_TLS_SERVER_NAME }
        : cfg.TEMPORAL_TLS,
  };
  const connection = await Connection.connect(connectionOptions);
  const nativeConnection = await NativeConnection.connect(connectionOptions);
  const temporal = new TemporalClient({
    connection,
    namespace: cfg.TEMPORAL_NAMESPACE,
  });
  const worker = await Worker.create({
    connection: nativeConnection,
    namespace: cfg.TEMPORAL_NAMESPACE,
    taskQueue,
    workflowsPath: resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "apps",
      "worker",
      "src",
      "workflows.ts",
    ),
    activities,
  });

  phase(`starting embedded worker on ${taskQueue}`);
  try {
    await worker.runUntil(async () => {
      phase("requesting decomposition through API");
      await apiJson(`/scopes/${scopeId}/decomposition-request`, {
        method: "POST",
        idempotencyKey: `decompose-${scopeId}`,
        body: {
          provider_targets: [
            { provider_project_id: registered.project.id, role: "primary" },
          ],
          reason: "local real-flow e2e",
        },
      });

      const proposal = await waitForReviewedProposal();
      await approveDecompositionViaWebhook(registered.project);
      const humanApproved = await waitForProposalStatus("human_approved");

      phase("committing approved DAG through API");
      const liveScope = await getScope();
      const commitResult = await apiJson<{
        scope: Scope;
        tasks: Task[];
        dependencies: unknown[];
      }>(
        `/scopes/${scopeId}/decomposition-proposals/${humanApproved.id}/commit`,
        {
          method: "POST",
          idempotencyKey: `commit-${scopeId}-${humanApproved.id}`,
          body: {
            expected_scope_state_version: liveScope.state_version,
            envelope_hash: proposal.envelope_hash,
            reason: "local real-flow DAG commit",
          },
        },
      );
      phase(
        `DAG committed: ${commitResult.tasks.length} task(s), ${commitResult.dependencies.length} dependency row(s)`,
      );

      await apiJson(`/scopes/${scopeId}/decomposition-request`, {
        method: "POST",
        idempotencyKey: `drive-after-commit-${scopeId}`,
        body: {
          provider_targets: [
            { provider_project_id: registered.project.id, role: "primary" },
          ],
          reason: "local real-flow drive after DAG commit",
        },
      });

      await driveTasksWithWebhooks(registered.project);
      await closeScopeThroughApi();
      await logWorkflowHistory(temporal);
      await terminateWorkflowIfRunning(temporal, "local real-flow complete");
    });
  } finally {
    await nativeConnection.close();
    await connection.close();
  }

  const finalScope = await getScope();
  phase(`complete: scope=${finalScope.id} state=${finalScope.state}`);
  phase(`${gitlabBaseUrl}/${registered.project.path}`);
} finally {
  if (cleanupGroupId && !keepGroup) {
    await adapter.groups.delete(cleanupGroupId).catch(() => {});
  } else if (cleanupGroupId) {
    phase(`keeping GitLab group ${groupPath}`);
  }
  await pool.end();
}

async function ensureLocalOperatorPolicy(): Promise<void> {
  const capabilities: Capability[] = [
    "graph.read",
    "graph.write",
    "policy.override",
    "provider.admin.bootstrap",
  ];
  await policy.grantCapabilitiesForActor({
    actor: human,
    role: "human",
    capabilities,
    granted_by: human,
  });
}

async function ensureBotIdentity(project: ProviderProject): Promise<void> {
  const identity = await adapter.identity();
  await policy
    .upsertProviderIdentity({
      actor: "bot:engine" as ActorId,
      provider: "gitlab",
      provider_user_id: identity.user_id,
      provider_username: identity.username,
      role: "developer",
      is_bot: true,
      allowed_namespaces: [project.path],
    })
    .catch((err) => {
      if (!isUniqueViolation(err)) throw err;
    });
}

async function approveDecompositionViaWebhook(
  project: ProviderProject,
): Promise<void> {
  const sync = await apiJson<{
    scope: { mirrors: ProviderMirror[] };
  }>(`/scopes/${scopeId}/provider-sync`);
  const mirror = sync.scope.mirrors[0];
  if (!mirror) throw new Error("scope mirror missing before /approve");
  const issueIid = providerLocalId(mirror.provider_id);
  phase(`posting /approve to scope issue via webhook (${mirror.provider_id})`);
  await webhookJson("Note Hook", {
    object_kind: "note",
    actor: human,
    object_attributes: {
      id: Number(`${Date.now()}`.slice(-9)),
      note: "/approve",
      noteable_type: "Issue",
      issue_iid: Number(issueIid),
      created_at: new Date().toISOString(),
      url: `${gitlabBaseUrl}/${project.path}/-/issues/${issueIid}#note_e2e`,
    },
    user: { username: "local-operator" },
    project: {
      id: project.provider_id,
      path_with_namespace: project.path,
    },
  });
}

async function driveTasksWithWebhooks(project: ProviderProject): Promise<void> {
  const approved = new Set<string>();
  const nudgedAt = new Map<string, number>();
  const started = Date.now();
  let lastLine = "";

  while (Date.now() - started < timeoutMs) {
    const tasks = await listTasks();
    if (tasks.length === 0) {
      await sleep(pollMs);
      continue;
    }

    const line = tasks
      .map(
        (task) =>
          `${task.id}:${task.state}:${reviewResultOf(task) ?? "no-review"}`,
      )
      .join(" ");
    if (line !== lastLine) {
      phase(`tasks ${line}`);
      lastLine = line;
    }

    const failed = tasks.find((task) =>
      ["failed", "blocked", "conflict", "canceled"].includes(task.state),
    );
    if (failed) {
      throw new Error(`task ${failed.id} reached ${failed.state}`);
    }

    if (tasks.every((task) => task.state === "closed")) return;

    for (const task of tasks) {
      const mrMirror = await latestMirror(task.id, "mr_pr");
      const reviewResult = reviewResultOf(task);
      if (
        mrMirror &&
        task.state === "review_requested" &&
        reviewResult === "approved" &&
        !approved.has(task.id)
      ) {
        const headSha = await mrHeadSha(project, mrMirror);
        phase(`posting approval + green pipeline for ${task.id}`);
        await sendApprovalWebhook(project, task, mrMirror, headSha);
        await sendPipelineWebhook(project, task, mrMirror, headSha);
        approved.add(task.id);
        nudgedAt.set(task.id, Date.now());
      } else if (
        mrMirror &&
        task.state === "merge_ready" &&
        approved.has(task.id)
      ) {
        const last = nudgedAt.get(task.id) ?? 0;
        if (Date.now() - last > 20_000) {
          const headSha = await mrHeadSha(project, mrMirror);
          phase(`nudging merge gate for ${task.id} via pipeline webhook`);
          await sendPipelineWebhook(project, task, mrMirror, headSha);
          nudgedAt.set(task.id, Date.now());
        }
      }
    }

    await sleep(pollMs);
  }
  throw new Error(
    `timed out waiting for tasks to close after ${timeoutMinutes}m`,
  );
}

async function closeScopeThroughApi(): Promise<void> {
  const readiness = await apiJson<{
    readiness: {
      ready: boolean;
      reasons: string[];
      open_task_ids: string[];
    };
  }>(`/scopes/${scopeId}/close-readiness`);
  if (!readiness.readiness.ready) {
    throw new Error(
      `scope not close-ready: ${JSON.stringify(readiness.readiness)}`,
    );
  }

  for (const state of [
    "scope_review_requested",
    "scope_review_approved",
    "closed",
  ] as const) {
    const scope = await getScope();
    phase(`transitioning scope to ${state} through API`);
    await apiJson<Scope>(`/scopes/${scopeId}/state`, {
      method: "POST",
      idempotencyKey: `scope-${scopeId}-${state}`,
      body: {
        expected_state_version: scope.state_version,
        state,
        reason: "local real-flow scope close",
      },
    });
  }
}

async function sendApprovalWebhook(
  project: ProviderProject,
  task: Task,
  mrMirror: ProviderMirror,
  headSha: string,
): Promise<void> {
  const iid = providerLocalId(mrMirror.provider_id);
  await webhookJson("Merge request approvals Hook", {
    object_kind: "merge_request",
    actor: human,
    object_attributes: {
      id: Number(iid),
      iid: Number(iid),
      sha: headSha,
      updated_at: new Date().toISOString(),
    },
    user: { username: "local-operator" },
    project: {
      id: project.provider_id,
      path_with_namespace: project.path,
    },
    task_id: task.id,
  });
}

async function sendPipelineWebhook(
  project: ProviderProject,
  task: Task,
  mrMirror: ProviderMirror,
  headSha: string,
): Promise<void> {
  const iid = providerLocalId(mrMirror.provider_id);
  await webhookJson("Pipeline Hook", {
    object_kind: "pipeline",
    actor: "svc:gitlab",
    object_attributes: {
      id: Number(`${Date.now()}`.slice(-9)),
      status: "success",
      sha: headSha,
      updated_at: new Date().toISOString(),
    },
    merge_request: {
      id: Number(iid),
      iid: Number(iid),
    },
    project: {
      id: project.provider_id,
      path_with_namespace: project.path,
    },
    task_id: task.id,
  });
}

async function mrHeadSha(
  project: ProviderProject,
  mrMirror: ProviderMirror,
): Promise<string> {
  const mr = await adapter.mergeRequests.get(
    { id: project.provider_id, path: project.path },
    mrMirror.provider_id,
  );
  const fromProvider = mr.head_commit_sha;
  if (fromProvider) return fromProvider;
  if (mrMirror.source_version) {
    const decoded = JSON.parse(mrMirror.source_version) as {
      readonly head_commit_sha?: string;
    };
    if (decoded.head_commit_sha) return decoded.head_commit_sha;
  }
  throw new Error(`MR ${mrMirror.provider_id} is missing head sha`);
}

async function waitForReviewedProposal(): Promise<{
  readonly id: string;
  readonly envelope_hash: string;
  readonly status: string;
}> {
  return waitForProposalStatus("review_approved");
}

async function waitForProposalStatus(status: string): Promise<{
  readonly id: string;
  readonly envelope_hash: string;
  readonly status: string;
}> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const { proposals } = await apiJson<{ proposals: unknown[] }>(
      `/scopes/${scopeId}/decomposition-proposals`,
    );
    const proposal = proposals[0] as
      | {
          readonly id: string;
          readonly envelope_hash: string;
          readonly status: string;
        }
      | undefined;
    const line = proposal
      ? `proposal ${proposal.id}:${proposal.status}`
      : "proposal none";
    if (line !== last) {
      phase(line);
      last = line;
    }
    if (proposal?.status === status) return proposal;
    if (proposal?.status === "changes_requested") {
      throw new Error("decomposition returned changes_requested");
    }
    await sleep(pollMs);
  }
  throw new Error(`timed out waiting for proposal status ${status}`);
}

async function getScope(): Promise<Scope> {
  return apiJson<Scope>(`/scopes/${scopeId}`);
}

async function listTasks(): Promise<Task[]> {
  const { items } = await apiJson<{ items: Task[] }>(
    `/scopes/${scopeId}/tasks`,
  );
  return items;
}

async function latestMirror(
  colonyId: TaskId,
  entityKind: "mr_pr",
): Promise<ProviderMirror | undefined> {
  const mirrors = await providerProjects.listMirrorsForColony({
    colony_id: colonyId,
    entity_kind: entityKind,
  });
  return mirrors[0];
}

async function apiJson<T>(
  path: string,
  args: {
    readonly method?: string;
    readonly body?: unknown;
    readonly idempotencyKey?: string;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "X-Actor-Id": human,
  };
  if (args.body !== undefined) headers["Content-Type"] = "application/json";
  if (args.idempotencyKey) headers["Idempotency-Key"] = args.idempotencyKey;
  const res = await api.request(`http://colony.local${path}`, {
    method: args.method ?? "GET",
    headers,
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  });
  return decodeResponse<T>(res, `API ${args.method ?? "GET"} ${path}`);
}

async function webhookJson(
  event: string,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  const eventUuid = `evt-${stamp}-${event.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  const res = await webhook.request("http://colony.local/webhook/gitlab", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gitlab-Token": webhookSecret,
      "X-Gitlab-Event": event,
      "X-Gitlab-Event-UUID": eventUuid,
    },
    body: JSON.stringify({ event_id: eventUuid, ...body }),
  });
  await decodeResponse<unknown>(res, `webhook ${event}`);
}

async function decodeResponse<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${label} failed ${res.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

async function logWorkflowHistory(temporal: TemporalClient): Promise<void> {
  const handle = temporal.workflow.getHandle(workflowId);
  const description = await handle.describe();
  const history = await handle.fetchHistory();
  const events = history.events ?? [];
  const scheduled = events.filter(
    (event) => event.activityTaskScheduledEventAttributes,
  ).length;
  const completed = events.filter(
    (event) => event.activityTaskCompletedEventAttributes,
  ).length;
  const failed = events.filter(
    (event) => event.activityTaskFailedEventAttributes,
  ).length;
  phase(
    `workflow status=${description.status.name} events=${events.length} activities_scheduled=${scheduled} activities_completed=${completed} activities_failed=${failed}`,
  );
}

async function terminateWorkflowIfRunning(
  temporal: TemporalClient,
  reason: string,
): Promise<void> {
  const handle = temporal.workflow.getHandle(workflowId);
  const description = await handle.describe();
  if (description.status.name !== "RUNNING") return;
  await handle.terminate(reason).catch((err) => {
    console.warn(`[real-flow] failed to terminate workflow: ${String(err)}`);
  });
}

function reviewResultOf(task: Task): string | undefined {
  const result = task.last_code_review_envelope?.["result"];
  return typeof result === "string" ? result : undefined;
}

function providerLocalId(id: string): string {
  const index = id.lastIndexOf(":");
  return index === -1 ? id : id.slice(index + 1);
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isUniqueViolation(err: unknown): err is { readonly code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "23505"
  );
}

function phase(message: string): void {
  console.log(`[real-flow] ${message}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
