import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import {
  ProviderProjectRepository,
  TaskGraphRepository,
  createPool,
  type Pool,
} from "@colony/db";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import {
  GitLabProviderAdapter,
  GitLabProviderError,
} from "@colony/provider-gitlab";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import { createDeveloperRun } from "./developer-run.js";

const TEST_URL = process.env.COLONY_TEST_DATABASE_URL;
const GITLAB_BASE_URL = process.env.GITLAB_BASE_URL;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const liveEnabled = Boolean(TEST_URL && GITLAB_BASE_URL && GITLAB_TOKEN);

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

/**
 * COL-2.9 acceptance: a real Developer run pushes a branch and opens an MR
 * against a real home-lab GitLab project, and the supervisor moves the
 * task `claimed -> in_progress -> review_requested`. The agent layer is the
 * `FakeAgentRuntimeAdapter` (the pi-coding-agent integration ships behind a
 * deployer-supplied adapter), so the test simulates the agent's branch push
 * via GitLab's commits API and then asserts the supervisor's MR-open path
 * end-to-end.
 *
 * Skips unless both `COLONY_TEST_DATABASE_URL` and the GitLab credentials
 * are present.
 */
describe.runIf(liveEnabled)("createDeveloperRun live", () => {
  let pool: Pool;
  let pgClient: Client;
  let adapter: GitLabProviderAdapter;
  let groupId: string | null = null;
  const stamp = Date.now();
  const groupPath = `colony-it-dev-${stamp}`;
  const featureBranch = `colony/col-itdv${stamp.toString(36)}.1`;

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
    adapter = new GitLabProviderAdapter({
      baseUrl: GITLAB_BASE_URL!,
      token: GITLAB_TOKEN!,
    });
  }, 120_000);

  afterAll(async () => {
    if (groupId) {
      await adapter?.groups.delete(groupId).catch(() => {});
    }
    await pool?.end();
    await pgClient?.end();
  });

  it("drives claimed -> in_progress -> review_requested with a real GitLab MR", async () => {
    const repo = new TaskGraphRepository(pool);
    const providerProjects = new ProviderProjectRepository(pool);

    // 1. Provision a throwaway GitLab group + project and seed a default
    //    branch with one commit so the feature branch has a base ref.
    const group = await adapter.groups.create({
      name: `Colony Dev IT ${stamp}`,
      path: groupPath,
      visibility: "private",
    });
    groupId = group.id;
    const project = await adapter.projects.create({
      name: "csv-export",
      path: "csv-export",
      namespace: group.id,
      visibility: "private",
      default_branch: "main",
    });
    await rawCommit({
      baseUrl: GITLAB_BASE_URL!,
      token: GITLAB_TOKEN!,
      projectId: project.id,
      branch: "main",
      message: "chore: initial commit",
      actions: [
        { action: "create", file_path: "README.md", content: "# csv-export" },
      ],
    });

    // 2. Simulate the developer agent pushing a branch with one commit.
    //    In production this happens inside the prepared sandbox via `git
    //    push` using a Tool Gateway-brokered credential; for the live
    //    test we push via the API so we don't take a hard dependency on
    //    a real pi-coding-agent.
    await adapter.branches.create(
      { id: project.id, path: project.path },
      featureBranch,
      "main",
    );
    await rawCommit({
      baseUrl: GITLAB_BASE_URL!,
      token: GITLAB_TOKEN!,
      projectId: project.id,
      branch: featureBranch,
      message: "feat: csv export",
      actions: [
        {
          action: "create",
          file_path: "src/csv.ts",
          content: "export const csv = '';\n",
        },
      ],
    });

    // 3. Seed Colony's view of the world: provider project, scope, task,
    //    and the issue mirror that the supervisor activity expects.
    const dbProject = await providerProjects.upsertProject({
      provider: adapter.provider,
      provider_id: project.id,
      path: project.path,
      default_branch: "main",
      visibility: "private",
    });
    const scope_id = `col-itdv${stamp.toString(36)}` as ScopeId;
    const task_id = `${scope_id}.1` as TaskId;
    const issue = await adapter.issues.create(
      { id: project.id, path: project.path },
      {
        title: "Add CSV export",
        description: "Live IT task",
        labels: ["agent:developer"],
      },
    );
    await repo.createScope(
      {
        id: scope_id,
        title: "CSV export scope",
        description: "Live IT scope",
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
      provider_project_id: dbProject.id,
      role: "primary",
    });
    await providerProjects.linkTaskTarget({
      task_id,
      provider_project_id: dbProject.id,
      role: "primary",
    });
    await providerProjects.upsertMirror({
      colony_id: task_id,
      entity_kind: "task",
      provider: adapter.provider,
      provider_id: issue.id,
      provider_project_id: dbProject.id,
      provider_project_path: project.path,
    });

    const claimed = await repo.claimTask(
      task.id,
      "bot:engine" as ActorId,
      task.state_version,
      { actor: "svc:supervisor" as ActorId, capability: "task.claim" },
    );
    expect(claimed?.state).toBe("claimed");

    // 4. Run the developer flow against real GitLab + real DB. The agent
    //    runtime is the FakeAgentRuntimeAdapter which produces a
    //    deterministic completion envelope referencing the packet's
    //    freshness.
    const startDeveloperRun = createDeveloperRun({
      repo,
      providerProjects,
      providerAdapter: adapter,
      agentRuntime: new FakeAgentRuntimeAdapter(),
    });
    const result = await startDeveloperRun({
      task_id,
      assignee: "bot:engine",
    });

    expect(result.started).toBe(true);
    if (!result.started) throw new Error("flow did not start");
    expect(result.envelope_status).toBe("succeeded");
    expect(result.final_state).toBe("review_requested");
    expect(result.mr?.source_branch).toBe(featureBranch);
    expect(result.mr?.target_branch).toBe("main");
    expect(result.mr?.url).toMatch(/merge_requests/);
    const taskAfterRun = await repo.getTask(task_id);
    expect(taskAfterRun?.agent_token_id).toBeTruthy();
    expect(taskAfterRun?.agent_token_project_id).toBe(project.id);
    expect(taskAfterRun?.agent_token_revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(
      rawApi({
        baseUrl: GITLAB_BASE_URL!,
        token: GITLAB_TOKEN!,
        path: `/projects/${encodeURIComponent(project.id)}/access_tokens/${encodeURIComponent(
          taskAfterRun?.agent_token_id ?? "",
        )}`,
      }),
    ).rejects.toThrow(/-> 404:/);

    // 5. The MR must exist in real GitLab and must round-trip through
    //    `provider_mirrors`. Fetch raw to avoid mutating the live MR.
    if (!result.mr) throw new Error("missing mr");
    const mrIid = result.mr.id.split(":")[1];
    const mrLookup = await rawApi<{
      readonly state: string;
      readonly source_branch: string;
    }>({
      baseUrl: GITLAB_BASE_URL!,
      token: GITLAB_TOKEN!,
      path: `/projects/${encodeURIComponent(project.id)}/merge_requests/${mrIid}`,
    });
    expect(mrLookup.state).toBe("opened");
    expect(mrLookup.source_branch).toBe(featureBranch);

    const mirrors = await providerProjects.listMirrorsForColony({
      colony_id: task_id,
      entity_kind: "mr_pr",
    });
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]?.provider_id).toBe(result.mr.id);

    // 6. Audit trail must include the MR-open record stamped with the
    //    envelope hash.
    const audit = await repo.listAuditForScope(scope_id, {
      task_id,
      limit: 100,
    });
    expect(audit.some((a) => a.action === "provider.mr.opened")).toBe(true);

    const finalTask = await repo.getTask(task_id);
    expect(finalTask?.state).toBe("review_requested");
  }, 240_000);
});

interface RawCommitArgs {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly branch: string;
  readonly message: string;
  readonly actions: ReadonlyArray<{
    readonly action: "create" | "update" | "delete";
    readonly file_path: string;
    readonly content?: string;
  }>;
}

async function rawCommit(args: RawCommitArgs): Promise<{ id: string }> {
  return rawApi<{ id: string }>({
    baseUrl: args.baseUrl,
    token: args.token,
    method: "POST",
    path: `/projects/${encodeURIComponent(args.projectId)}/repository/commits`,
    body: {
      branch: args.branch,
      commit_message: args.message,
      actions: args.actions,
    },
  });
}

async function rawApi<T>(args: {
  readonly baseUrl: string;
  readonly token: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}): Promise<T> {
  const res = await fetch(`${args.baseUrl}/api/v4${args.path}`, {
    method: args.method ?? "GET",
    headers: {
      "PRIVATE-TOKEN": args.token,
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
