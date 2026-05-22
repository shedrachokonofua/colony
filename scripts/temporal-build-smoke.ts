#!/usr/bin/env -S tsx
// Minimal live Temporal dogfood run.
//
// This script only seeds a disposable GitLab project + one ready Colony task,
// starts scopeSupervisorWorkflow, and watches the task. The worker owns the
// plan/develop/review loop through Temporal.

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as TemporalClient, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  PolicyRepository,
  ProviderProjectRepository,
  TaskGraphRepository,
  createPool,
} from "@colony/db";
import { env as loadEnv } from "@colony/config";
import { type ActorId, type ScopeId, type TaskId } from "@colony/domain";
import { GitLabProviderAdapter } from "@colony/provider-gitlab";
import {
  scopeSupervisorWorkflow,
  supervisorWorkflowId,
} from "@colony/workflows";
import {
  activities,
  initializeAgentRuntime,
} from "../apps/worker/src/activities.js";

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  quiet: true,
});

const cfg = loadEnv();
const gitlabBaseUrl = mustEnv("GITLAB_BASE_URL");
const gitlabToken = mustEnv("GITLAB_TOKEN");
const stamp = Date.now().toString(36);
const scopeId = `col-tb${stamp}` as ScopeId;
const taskId = `${scopeId}.1` as TaskId;
const groupPath = `colony-temporal-build-${stamp}`;
const projectPath = "echopress";
const taskQueue =
  process.env["COLONY_TEMPORAL_BUILD_TASK_QUEUE"] ??
  `colony-temporal-build-${stamp}`;
const keepGroup = ["1", "true", "yes"].includes(
  process.env["COLONY_TEMPORAL_BUILD_KEEP_GROUP"]?.toLowerCase() ?? "",
);
const supervisor = "svc:supervisor" as ActorId;
const developer = "bot:engine" as ActorId;
let cleanupGroupId: string | undefined;

const pool = createPool({
  connectionString: cfg.DATABASE_URL,
  role: "colony_writer",
});
const repo = new TaskGraphRepository(pool);
const providerProjects = new ProviderProjectRepository(pool);
const policy = new PolicyRepository(pool);
const adapter = new GitLabProviderAdapter({
  baseUrl: gitlabBaseUrl,
  token: gitlabToken,
});

try {
  await initializeAgentRuntime();

  console.log(`[temporal-build] creating GitLab group ${groupPath}`);
  const group = await adapter.groups.create({
    name: `Colony Temporal Build ${stamp}`,
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
      commit_message: "chore: seed opspulse scaffold",
      actions: [
        {
          action: "create",
          file_path: "README.md",
          content: [
            "# EchoPress",
            "",
            "A tiny Node.js app scaffold. Colony should add the HTTP server,",
            "static page, local smoke test, and usage docs.",
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
  });

  const project = await providerProjects.upsertProject({
    provider: "gitlab",
    provider_id: projectInfo.id,
    path: projectInfo.path,
    default_branch: projectInfo.default_branch,
    visibility: projectInfo.visibility,
  });

  const identity = await adapter.identity();
  await policy
    .upsertProviderIdentity({
      actor: developer,
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

  console.log(`[temporal-build] seeding active scope ${scopeId}`);
  await repo.createScope(
    {
      id: scopeId,
      title: "Build EchoPress static posting app",
      description:
        "Use Temporal to drive Colony through a single implementation task that creates a tiny fixed-stack Node.js app.",
      state: "active",
    },
    {
      actor: supervisor,
      capability: "graph.write",
      reason: "temporal_build_smoke",
    },
  );
  await providerProjects.linkScopeTarget({
    scope_id: scopeId,
    provider_project_id: project.id,
    role: "primary",
  });
  const task = await repo.createTask(
    {
      id: taskId,
      scope_id: scopeId,
      title: "Implement EchoPress tiny posting app",
      description: [
        "Implement a deliberately small Node.js web app in this repo.",
        "",
        "Expected behavior:",
        "- Keep the stack to a root npm package, plain Node.js, static HTML, vanilla CSS, and vanilla JavaScript.",
        "- Add `server.js` using Node's built-in `http` module; it must serve `public/index.html`, `public/styles.css`, and `public/app.js`.",
        "- Make `server.js` testable: export `requestHandler(req, res)` and `createServer()`, and only call `listen` when `server.js` is executed directly.",
        "- Do not export or reuse a singleton server from `server.js`; each test should create its own server with `createServer()` and close it.",
        "- The first page should render a small EchoPress posting surface with a composer, a list of seeded posts, and no external assets.",
        "- Add `test/server.test.js` using Node's built-in test runner and local HTTP requests against `createServer()`.",
        "- Keep the package `test` script as `node --test --test-timeout=10000 --test-force-exit` so a leaked handle cannot hang the agent.",
        "- Tests must close the server they create and must not leave a process running after `npm test`.",
        "- Update README with install-free run and test commands.",
        "- `npm test` must pass locally without downloading packages.",
      ].join("\n"),
      acceptance_criteria: [
        "`server.js` exports `requestHandler` and `createServer`, uses only Node built-ins, and is importable without opening a port.",
        "`public/index.html`, `public/styles.css`, and `public/app.js` implement the posting UI.",
        "The page includes a composer, seeded posts, and client-side add-post behavior.",
        "`test/server.test.js` verifies the server returns HTML, CSS, and JavaScript assets and exits cleanly.",
        "`npm test` passes using Node's built-in test runner.",
        "README documents `npm start` and `npm test`.",
      ],
      non_goals: [
        "Do not add React, Vite, Playwright, Puppeteer, TypeScript, databases, auth, or external services.",
        "Do not add package dependencies or a build step.",
        "Do not download browser binaries or call external APIs.",
      ],
      state: "ready",
    },
    {
      actor: supervisor,
      capability: "graph.write",
      reason: "temporal_build_smoke",
    },
  );
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
      labels: ["colony:task", "state:ready", `scope:${scopeId}`],
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
  const workflowId = supervisorWorkflowId(scopeId);
  console.log(
    `[temporal-build] starting embedded worker + workflow ${workflowId} on queue ${taskQueue}`,
  );
  try {
    await worker.runUntil(async () => {
      const handle = await temporal.workflow.start(scopeSupervisorWorkflow, {
        workflowId,
        taskQueue,
        args: [scopeId],
      });
      try {
        await monitorBuild(project.path);
      } finally {
        await terminateIfRunning(handle, "Temporal build smoke finished");
        await logWorkflowHistory(handle);
      }
    });
  } finally {
    await nativeConnection.close();
    await connection.close();
  }
} finally {
  if (cleanupGroupId && !keepGroup) {
    await adapter.groups.delete(cleanupGroupId).catch(() => {});
  } else if (cleanupGroupId) {
    console.log(`[temporal-build] keeping GitLab group ${groupPath}`);
  }
  await pool.end();
}

async function logWorkflowHistory(
  handle: Awaited<ReturnType<TemporalClient["workflow"]["start"]>>,
): Promise<void> {
  const description = await handle.describe();
  const history = await handle.fetchHistory();
  const events = history.events ?? [];
  const scheduledActivities = events.filter(
    (event) => event.activityTaskScheduledEventAttributes,
  ).length;
  const failedActivities = events.filter(
    (event) => event.activityTaskFailedEventAttributes,
  ).length;
  const completedActivities = events.filter(
    (event) => event.activityTaskCompletedEventAttributes,
  ).length;
  console.log(
    [
      "[temporal-build] workflow history:",
      `status=${description.status.name}`,
      `events=${events.length}`,
      `activities_scheduled=${scheduledActivities}`,
      `activities_completed=${completedActivities}`,
      `activities_failed=${failedActivities}`,
    ].join(" "),
  );
}

async function terminateIfRunning(
  handle: Awaited<ReturnType<TemporalClient["workflow"]["start"]>>,
  reason: string,
): Promise<void> {
  const description = await handle.describe();
  if (description.status.name !== "RUNNING") return;
  await handle.terminate(reason).catch((err) => {
    console.warn(
      `[temporal-build] failed to terminate workflow after smoke run: ${String(err)}`,
    );
  });
}

async function monitorBuild(projectPathWithNamespace: string): Promise<void> {
  const started = Date.now();
  let lastLine = "";
  while (Date.now() - started < 45 * 60_000) {
    const task = await repo.getTask(taskId);
    const mrMirror = (
      await providerProjects.listMirrorsForColony({
        colony_id: taskId,
        entity_kind: "mr_pr",
      })
    )[0];
    const codeReviewResult = reviewResultOf(task?.last_code_review_envelope);
    const line = [
      `state=${task?.state ?? "missing"}`,
      `plan=${task?.developer_plan_hash ? "yes" : "no"}`,
      `plan_review=${task?.plan_review_result ?? "none"}`,
      `mr=${mrMirror?.provider_id ?? "none"}`,
      `code_review=${codeReviewResult ?? "none"}`,
    ].join(" ");
    if (line !== lastLine) {
      console.log(`[temporal-build] ${line}`);
      lastLine = line;
    }
    if (mrMirror && codeReviewResult === "approved") {
      console.log(`[temporal-build] review completed for ${taskId}`);
      console.log(
        `[temporal-build] project: ${gitlabBaseUrl.replace(/\/+$/, "")}/${projectPathWithNamespace}`,
      );
      console.log(
        `[temporal-build] MR: ${gitlabBaseUrl.replace(/\/+$/, "")}/${projectPathWithNamespace}/-/merge_requests/${providerLocalId(
          mrMirror.provider_id,
        )}`,
      );
      return;
    }
    if (
      mrMirror &&
      codeReviewResult !== undefined &&
      codeReviewResult !== "approved"
    ) {
      throw new Error(
        `Temporal build review did not approve ${taskId}: ${codeReviewResult}`,
      );
    }
    if (task?.state === "review_requested" && mrMirror) {
      console.log(`[temporal-build] developer opened MR for ${taskId}`);
      console.log(
        `[temporal-build] MR: ${gitlabBaseUrl.replace(/\/+$/, "")}/${projectPathWithNamespace}/-/merge_requests/${providerLocalId(
          mrMirror.provider_id,
        )}`,
      );
    }
    await sleep(15_000);
  }
  throw new Error(`timed out waiting for Temporal build ${taskId}`);
}

async function rawApi<T = unknown>(args: {
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}): Promise<T> {
  const response = await fetch(`${gitlabBaseUrl}/api/v4${args.path}`, {
    method: args.method ?? "GET",
    headers: {
      "PRIVATE-TOKEN": gitlabToken,
      "Content-Type": "application/json",
    },
    body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitLab ${args.method ?? "GET"} ${args.path} failed ${response.status}: ${text}`,
    );
  }
  return text ? (JSON.parse(text) as T) : (null as T);
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

function providerLocalId(id: string): string {
  const index = id.lastIndexOf(":");
  return index === -1 ? id : id.slice(index + 1);
}

function reviewResultOf(
  envelope: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const result = envelope?.["result"];
  return typeof result === "string" ? result : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
