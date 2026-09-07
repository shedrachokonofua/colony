import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ColonyConfig } from "@colony/config";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import { createLocalArtifactStore, Store, type Task } from "@colony/core";
import { FakeProviderAdapter } from "@colony/provider";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";
import { awaitPendingRuns } from "../src/runs/registry.js";
import { tick } from "../src/tick.js";

const HEAD = "a".repeat(40);
const PIPELINE_URL = "https://ci.example/fake/repo/-/pipelines/4242";

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PLAN = {
  kind: "architect_decomposition" as const,
  summary: "one delivery task",
  requirements: [{ id: "R1", text: "deliver", tasks: [0] }],
  journey: [{ after_task: 0, working_state: "delivered" }],
  acceptance: [{ description: "ok", command: "true" }],
  tasks: [
    {
      title: "delivery task",
      spec: "deliver the change",
      depends_on: [],
      files: ["src/change.ts"],
      evidence: ["true"],
    },
  ],
};

interface Harness {
  readonly ctx: ColonydContext;
  readonly store: Store;
  readonly provider: FakeProviderAdapter;
  readonly task: Task;
  readonly scopeId: string;
  readonly project: string;
}

/**
 * A project with one mr_open task whose implement run succeeded at HEAD.
 * `pipelines.getStatus` throws by default: the read endpoints must answer
 * from persisted facts alone, so any provider I/O on the read path fails
 * the assertions instead of papering over it.
 */
async function harness(
  options: { readonly providerThrows?: boolean } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-delivery-status-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  const provider = new FakeProviderAdapter();
  if (options.providerThrows ?? true) {
    provider.pipelines.getStatus = async () => {
      throw new Error("read paths must not call the provider");
    };
  }
  // A real provider MR so the scheduler's tick can poll it and reach its
  // pipeline gate; the read endpoints never touch the provider.
  const repo = await provider.repos.create({
    name: "delivery",
    path: "so/delivery",
  });
  await provider.branches.create(
    { id: repo.id, path: repo.path },
    "main",
    "b".repeat(40),
  );
  await provider.branches.create(
    { id: repo.id, path: repo.path },
    "colony/delivery-task",
    HEAD,
  );
  const mr = await provider.mergeRequests.open(
    { id: repo.id, path: repo.path },
    {
      title: "delivery task MR",
      description: "delivery",
      source_branch: "colony/delivery-task",
      target_branch: "main",
    },
  );
  const project = "wave";
  const scope = store.createScope({
    goal: "delivery status",
    title: "delivery status",
    approvals: "auto",
    provider_repo_id: repo.id,
    provider_repo_path: repo.path,
    project,
  });
  store.setScopeStatus(scope.id, "planning", "svc:test");
  const [created] = store.materializePlan(scope.id, PLAN, "svc:test");
  if (!created) throw new Error("fixture task missing");
  store.transitionTask(
    created.id,
    created.state_version,
    "running",
    "svc:test",
    {
      branch: "colony/delivery-task",
    },
  );
  const running = store.getTask(created.id)!;
  store.transitionTask(
    running.id,
    running.state_version,
    "mr_open",
    "svc:test",
    {
      mr_iid: mr.iid,
    },
  );
  const pushed = store.startRun({
    scope_id: scope.id,
    task_id: created.id,
    kind: "implement",
    lease_ttl_ms: 60_000,
  });
  store.finishRun(pushed.id, "succeeded", { head_sha: HEAD });
  const task = store.getTask(created.id)!;

  const config = {
    reviewMode: "required",
    hitlMode: "yolo",
    forAgent: () => ({
      role: "implementer",
      providerKey: "fake_llm",
      api: "openai-completions",
      model: { id: "test-model", name: "test-model" },
      fallbackModels: [],
      auth: { kind: "api_key", apiKey: "fake-key" },
      ceilings: { timeoutMs: 60_000, maxTurns: 20 },
    }),
    modelParallelLimit: () => null,
  } as unknown as ColonyConfig;

  const artifacts = mkdtempSync(
    join(tmpdir(), "colonyd-delivery-status-artifacts-"),
  );
  dirs.push(artifacts);
  const ctx: ColonydContext = {
    store,
    provider,
    config,
    agents: {
      runtime: "fake",
      architect: new FakeAgentRuntimeAdapter(),
      developer: new FakeAgentRuntimeAdapter(),
      reviewer: new FakeAgentRuntimeAdapter(),
    },
    artifacts: createLocalArtifactStore(artifacts),
    logger: { info() {}, warn() {}, error() {} },
    env: {
      gitlabBaseUrl: "https://gitlab.example.com",
      gitlabToken: "fake-token",
      webhookSecret: "",
      singleToken: true,
      maxConcurrent: 4,
      maxAttempts: 3,
      resumeLeaseTtlMs: 900_000,
      oidcIssuer: "",
      oidcClientId: "colony",
      oidcRequiredRole: "",
      traceUiBaseUrl: "",
      consoleBaseUrl: "",
    },
    draining: { isDraining: () => false },
    validateExecutor: async () => ({ passed: true, results: [] }),
    requestTick() {},
  };
  return { ctx, store, provider, task, scopeId: String(scope.id), project };
}

/** The task's persisted pipeline observation at HEAD. */
function observePipeline(
  store: Store,
  taskId: string,
  status: "pending" | "running" | "success" | "failed" | "canceled",
): void {
  store.upsertPipelineObservation({
    task_id: taskId,
    head_sha: HEAD,
    status,
    pipeline_id: "4242",
    web_url: PIPELINE_URL,
    observed_at: new Date().toISOString(),
  });
}

const ACTOR = { headers: { "X-Actor-Id": "human:op-1" } };

async function getJson(
  app: ReturnType<typeof buildApp>,
  path: string,
): Promise<Record<string, unknown>> {
  const res = await app.request(path, ACTOR);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /tasks/:id delivery_status", () => {
  it("derives ci_failed from the persisted observation, with its pipeline URL", async () => {
    const h = await harness();
    observePipeline(h.store, String(h.task.id), "failed");
    const body = await getJson(buildApp(h.ctx), `/tasks/${h.task.id}`);
    const status = body.delivery_status as {
      stage: string;
      evidence: { url?: string }[];
    };
    expect(status.stage).toBe("ci_failed");
    expect(status.evidence.some((entry) => entry.url === PIPELINE_URL)).toBe(
      true,
    );
  });

  it("waits for the first review when review is required", async () => {
    const h = await harness();
    const body = await getJson(buildApp(h.ctx), `/tasks/${h.task.id}`);
    // reviewMode=required and no review run yet: the scheduler is about to
    // dispatch one, so the stage is awaiting_review, never ready_to_merge.
    expect((body.delivery_status as { stage: string }).stage).toBe(
      "awaiting_review",
    );
  });

  it("ignores an observation recorded at a different head", async () => {
    const h = await harness();
    h.store.upsertPipelineObservation({
      task_id: String(h.task.id),
      head_sha: "b".repeat(40),
      status: "failed",
      pipeline_id: "1",
      web_url: PIPELINE_URL,
      observed_at: new Date().toISOString(),
    });
    const body = await getJson(buildApp(h.ctx), `/tasks/${h.task.id}`);
    expect((body.delivery_status as { stage: string }).stage).not.toBe(
      "ci_failed",
    );
  });
});

describe("GET /scopes/:id delivery_by_task", () => {
  it("carries a delivery status for every task in the scope", async () => {
    const h = await harness();
    observePipeline(h.store, String(h.task.id), "failed");
    const body = await getJson(buildApp(h.ctx), `/scopes/${h.scopeId}`);
    const byTask = body.delivery_by_task as Record<string, { stage: string }>;
    expect(Object.keys(byTask)).toContain(String(h.task.id));
    expect(byTask[String(h.task.id)]!.stage).toBe("ci_failed");
  });
});

describe("GET /projects/:name/running delivery_status", () => {
  it("joins each row with its derived status", async () => {
    const h = await harness();
    observePipeline(h.store, String(h.task.id), "failed");
    const res = await buildApp(h.ctx).request(
      `/projects/${h.project}/running`,
      ACTOR,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as {
      task_id: string;
      delivery_status: { stage: string };
    }[];
    const row = rows.find((entry) => entry.task_id === String(h.task.id));
    expect(row?.delivery_status.stage).toBe("ci_failed");
  });
});

describe("read paths perform no provider I/O", () => {
  it("answers all three endpoints with a provider whose pipelines throw", async () => {
    const h = await harness();
    observePipeline(h.store, String(h.task.id), "failed");
    const app = buildApp(h.ctx);
    const taskBody = await getJson(app, `/tasks/${h.task.id}`);
    const scopeBody = await getJson(app, `/scopes/${h.scopeId}`);
    const running = await app.request(`/projects/${h.project}/running`, ACTOR);
    expect(running.status).toBe(200);
    expect((taskBody.delivery_status as { stage: string }).stage).toBe(
      "ci_failed",
    );
    expect(
      (scopeBody.delivery_by_task as Record<string, { stage: string }>)[
        String(h.task.id)
      ]!.stage,
    ).toBe("ci_failed");
  });
});

describe("scheduler pipeline observation writer", () => {
  it("records the pipeline status for the current head on every tick", async () => {
    const h = await harness({ providerThrows: false });
    h.provider.setPipelineStatusForSha(HEAD, "running");
    await tick(h.ctx);
    await awaitPendingRuns();
    const observation = h.store.getPipelineObservation(String(h.task.id));
    expect(observation?.head_sha).toBe(HEAD);
    expect(observation?.status).toBe("running");
    expect(observation?.web_url).toBeTruthy();
  });

  it("leaves the prior observation intact when getStatus throws", async () => {
    const h = await harness({ providerThrows: false });
    observePipeline(h.store, String(h.task.id), "failed");
    const before = h.store.getPipelineObservation(String(h.task.id));
    // A provider outage during a tick must not rewrite the last known fact.
    h.provider.pipelines.getStatus = async () => {
      throw new Error("provider unreachable");
    };
    await tick(h.ctx);
    await awaitPendingRuns();
    const after = h.store.getPipelineObservation(String(h.task.id));
    expect(after).toEqual(before);
    const status = await getJson(buildApp(h.ctx), `/tasks/${h.task.id}`);
    expect((status.delivery_status as { stage: string }).stage).toBe(
      "ci_failed",
    );
  });
});
