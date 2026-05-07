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
const projectPath = "opspulse";
const taskQueue =
  process.env["COLONY_TEMPORAL_BUILD_TASK_QUEUE"] ?? cfg.TEMPORAL_TASK_QUEUE;
const supervisor = "svc:supervisor" as ActorId;
const developer = "bot:engine" as ActorId;

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
  console.log(`[temporal-build] creating GitLab group ${groupPath}`);
  const group = await adapter.groups.create({
    name: `Colony Temporal Build ${stamp}`,
    path: groupPath,
    visibility: "private",
  });
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
            "# OpsPulse",
            "",
            "A tiny Node.js observability report scaffold. Colony should add",
            "the JSONL metrics parser, markdown report generator, CLI, tests,",
            "and usage docs.",
            "",
          ].join("\n"),
        },
        {
          action: "create",
          file_path: "package.json",
          content: JSON.stringify(
            {
              name: "opspulse",
              version: "0.0.0",
              type: "module",
              scripts: {
                test: "node --test",
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
      title: "Build OpsPulse JSONL metrics reporter",
      description:
        "Use Temporal to drive Colony through a single implementation task that creates a useful reporting CLI.",
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
      title: "Implement OpsPulse metrics report CLI",
      description: [
        "Implement a small Node.js observability reporting package in this repo.",
        "",
        "Expected behavior:",
        "- Export `parseEvents(input)`, `summarize(events)`, and `renderMarkdown(summary)` from `src/opspulse.js`.",
        "- Input is newline-delimited JSON. Each event has `service`, `route`, `status`, `latency_ms`, and optional ISO `timestamp`.",
        "- Group by service and compute request count, error count, error rate, p50 latency, p95 latency, and slowest route.",
        "- Render a markdown report with a summary table and a compact ASCII latency sparkline per service.",
        "- Add executable `bin/opspulse.js` that reads a JSONL file path argument or stdin and prints the markdown report.",
        "- Add sample data under `examples/events.jsonl`.",
        "- Add `node --test` coverage for parsing, percentile calculation, grouping, markdown output, CLI file input, and malformed JSON diagnostics.",
        "- Update README with library and CLI usage examples.",
        "- `npm test` must pass.",
      ].join("\n"),
      acceptance_criteria: [
        "`src/opspulse.js` exports parser, summarizer, and markdown renderer functions.",
        "`bin/opspulse.js` reads JSONL from a file path or stdin and prints markdown.",
        "Reports include request count, error rate, p50, p95, slowest route, and a per-service sparkline.",
        "Tests cover parser errors, percentile math, grouping, renderer output, and CLI execution.",
        "`npm test` passes using Node's built-in test runner.",
        "README documents library and CLI usage with sample JSONL.",
      ],
      non_goals: [
        "Do not add external runtime dependencies.",
        "Do not add a build step or TypeScript.",
        "Do not call external services.",
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

  const connection = await Connection.connect({
    address: cfg.TEMPORAL_ADDRESS,
    tls:
      cfg.TEMPORAL_TLS_SERVER_NAME !== undefined
        ? { serverNameOverride: cfg.TEMPORAL_TLS_SERVER_NAME }
        : cfg.TEMPORAL_TLS,
  });
  const temporal = new TemporalClient({
    connection,
    namespace: cfg.TEMPORAL_NAMESPACE,
  });
  const workflowId = supervisorWorkflowId(scopeId);
  console.log(
    `[temporal-build] starting workflow ${workflowId} on queue ${taskQueue}`,
  );
  await temporal.workflow.start(scopeSupervisorWorkflow, {
    workflowId,
    taskQueue,
    args: [scopeId],
  });
  await connection.close();

  await monitorBuild(project.path);
} finally {
  await pool.end();
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
    const line = [
      `state=${task?.state ?? "missing"}`,
      `plan=${task?.developer_plan_hash ? "yes" : "no"}`,
      `plan_review=${task?.plan_review_result ?? "none"}`,
      `mr=${mrMirror?.provider_id ?? "none"}`,
      `code_review=${task?.last_code_review_hash ? "yes" : "no"}`,
    ].join(" ");
    if (line !== lastLine) {
      console.log(`[temporal-build] ${line}`);
      lastLine = line;
    }
    if (mrMirror && task?.last_code_review_hash) {
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
