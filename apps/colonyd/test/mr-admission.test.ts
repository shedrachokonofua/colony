import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ColonyConfig } from "@colony/config";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import {
  createLocalArtifactStore,
  Store,
  type Scope,
  type Task,
} from "@colony/core";
import {
  FakeProviderAdapter,
  type ProviderMergeRequest,
} from "@colony/provider";
import type { ColonydContext } from "../src/context.js";
import {
  getCurrentMrTask,
  hasActiveRepositoryMergeGate,
} from "../src/runs/mr-admission.js";
import { abortRun, awaitPendingRuns } from "../src/runs/registry.js";
import { runReview } from "../src/runs/review.js";
import { tick } from "../src/tick.js";
import { runMergeGate } from "../src/runs/merge-gate.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
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
  summary: "one review task",
  requirements: [{ id: "R1", text: "review", tasks: [0] }],
  journey: [{ after_task: 0, working_state: "review" }],
  acceptance: [{ description: "ok", command: "true" }],
  tasks: [
    {
      title: "review task",
      spec: "review the change",
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
  readonly scope: Scope;
  readonly task: Task;
  readonly mr: ProviderMergeRequest;
  readonly draining: { value: boolean };
}

async function harness(
  options: { readonly approvals?: "auto" | "manual" } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-mr-admission-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  const provider = new FakeProviderAdapter();
  const repo = await provider.repos.create({ name: "repo", path: "fake/repo" });
  await provider.branches.create({ id: repo.id, path: repo.path }, "main", SHA);
  await provider.branches.create(
    { id: repo.id, path: repo.path },
    "colony/review-task",
    SHA,
  );
  const mr = await provider.mergeRequests.open(
    { id: repo.id, path: repo.path },
    {
      title: "review task",
      description: "review",
      source_branch: "colony/review-task",
      target_branch: "main",
    },
  );
  const scope = store.createScope({
    goal: "review admission",
    title: "review admission",
    approvals: options.approvals ?? "auto",
    provider_repo_id: repo.id,
    provider_repo_path: repo.path,
  });
  store.setScopeStatus(scope.id, "planning", "test");
  const [created] = store.materializePlan(scope.id, PLAN, "test");
  if (!created) throw new Error("fixture task missing");
  store.transitionTask(created.id, created.state_version, "running", "test", {
    branch: "colony/review-task",
  });
  const running = store.getTask(created.id)!;
  store.transitionTask(running.id, running.state_version, "mr_open", "test", {
    mr_iid: mr.iid,
  });
  const task = store.getTask(created.id)!;
  const reviewer = new FakeAgentRuntimeAdapter({
    envelopeForRun: (packet) => ({
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "The change is correct and the reviewed implementation satisfies the task specification end to end.",
      findings: [],
      inspected: [
        { file: "src/change.ts", note: "Checked the complete change." },
      ],
      head_sha: packet.head_sha,
    }),
  });
  const config = {
    reviewMode: "required",
    hitlMode: "yolo",
    forAgent: () => ({
      role: "reviewer",
      providerKey: "fake_llm",
      api: "openai-completions",
      model: { id: "review-model", name: "review-model" },
      fallbackModels: [],
      auth: { kind: "api_key", apiKey: "fake-key" },
      ceilings: { timeoutMs: 60_000, maxTurns: 20 },
    }),
    modelParallelLimit: () => null,
  } as unknown as ColonyConfig;
  const artifacts = mkdtempSync(
    join(tmpdir(), "colonyd-mr-admission-artifacts-"),
  );
  dirs.push(artifacts);
  const draining = { value: false };
  const ctx: ColonydContext = {
    store,
    provider,
    config,
    agents: {
      runtime: "fake",
      architect: new FakeAgentRuntimeAdapter(),
      developer: new FakeAgentRuntimeAdapter(),
      reviewer,
    },
    artifacts: createLocalArtifactStore(artifacts),
    logger: { info() {}, warn() {}, error() {} },
    env: {
      gitlabBaseUrl: "https://gitlab.example.com",
      gitlabToken: "fallback-token",
      webhookSecret: "",
      singleToken: true,
      maxConcurrent: 4,
      maxAttempts: 3,
      oidcIssuer: "",
      oidcClientId: "colony",
      oidcRequiredRole: "",
      traceUiBaseUrl: "",
      consoleBaseUrl: "",
    },
    draining: { isDraining: () => draining.value },
    validateExecutor: async () => ({ passed: true, results: [] }),
    requestTick() {},
  };
  return { ctx, store, provider, scope, task, mr, draining };
}

async function deferSecondProviderGet(
  provider: FakeProviderAdapter,
): Promise<{ readonly started: Promise<void>; readonly release: () => void }> {
  const original = provider.mergeRequests.get.bind(provider.mergeRequests);
  let calls = 0;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  provider.mergeRequests.get = async (repo, id) => {
    const mr = await original(repo, id);
    calls += 1;
    if (calls === 2) {
      start();
      await deferred;
    }
    return mr;
  };
  return { started, release };
}

describe("MR-derived dispatch admission", () => {
  it("does not admit review or merge when pipeline lookup is unavailable", async () => {
    const h = await harness();
    h.provider.pipelines.getStatus = async () => {
      throw new Error("pipeline provider HTTP 503");
    };
    await tick(h.ctx);
    await awaitPendingRuns();
    expect(h.store.getTask(h.task.id)?.state).toBe("mr_open");
    expect(h.store.runsForTask(h.task.id)).toEqual([]);
    const mr = await h.provider.mergeRequests.get(
      { id: h.scope.provider_repo_id },
      h.mr.id,
    );
    expect(mr.state).toBe("opened");
  });

  it("waits for a fresh head to register CI but permits confirmed pipeline absence afterward", async () => {
    const h = await harness();
    const pushed = h.store.startRun({
      scope_id: h.scope.id,
      task_id: h.task.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    h.store.finishRun(pushed.id, "succeeded", { head_sha: SHA });
    h.provider.pipelines.getStatus = async () => {
      throw Object.assign(new Error("no pipeline for this SHA"), {
        status: 404,
        body: "pipeline_not_found",
      });
    };
    const ctx = { ...h.ctx, gateExecutor: async () => null };
    await tick(ctx);
    await awaitPendingRuns();
    expect(
      h.store.runsForTask(h.task.id).filter((run) => run.kind === "review"),
    ).toEqual([]);
    h.store.db
      .prepare("UPDATE runs SET finished_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 240_000).toISOString(), pushed.id);
    await tick(ctx);
    await awaitPendingRuns();
    await tick(ctx);
    await awaitPendingRuns();
    const mr = await h.provider.mergeRequests.get(
      { id: h.scope.provider_repo_id },
      h.mr.id,
    );
    expect(mr.state).toBe("merged");
  });

  it("reconciles an unconfirmed merge only after the provider confirms the gated head", async () => {
    const h = await harness();
    await runReview(h.ctx, h.scope, h.task, SHA);
    const originalGet = h.provider.mergeRequests.get.bind(
      h.provider.mergeRequests,
    );
    const originalMerge = h.provider.mergeRequests.merge.bind(
      h.provider.mergeRequests,
    );
    let mergeAttempted = false;
    h.provider.mergeRequests.merge = async (repo, id, options) => {
      await originalMerge(repo, id, options);
      mergeAttempted = true;
      throw new Error("merge response HTTP 502");
    };
    h.provider.mergeRequests.get = async (repo, id) => {
      if (mergeAttempted) throw new Error("confirmation HTTP 503");
      return originalGet(repo, id);
    };
    const ctx = { ...h.ctx, gateExecutor: async () => null };
    await runMergeGate(ctx, h.scope, h.task, SHA);
    expect(h.store.getTask(h.task.id)?.state).toBe("mr_open");

    h.provider.mergeRequests.get = async (repo, id) => ({
      ...(await originalGet(repo, id)),
      head_commit_sha: OTHER_SHA,
    });
    await tick(ctx);
    await awaitPendingRuns();
    expect(h.store.getTask(h.task.id)?.state).toBe("mr_open");

    h.provider.mergeRequests.get = originalGet;
    await tick(ctx);
    await awaitPendingRuns();
    expect(h.store.getTask(h.task.id)?.state).toBe("merged");
    expect(
      h.store.runsForTask(h.task.id).filter((run) => run.kind === "implement"),
    ).toEqual([]);
  });

  it("retries an expired gate without sending code back to an implementer", async () => {
    const h = await harness();
    await runReview(h.ctx, h.scope, h.task, SHA);
    const expired = h.store.startRun({
      scope_id: h.scope.id,
      task_id: h.task.id,
      kind: "merge_gate",
      lease_ttl_ms: 60_000,
    });
    h.store.db
      .prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", expired.id);
    const ctx = { ...h.ctx, gateExecutor: async () => null };
    await tick(ctx);
    await awaitPendingRuns();
    expect(h.store.getRun(expired.id)?.status).toBe("failed");
    expect(h.store.getTask(h.task.id)?.state).toBe("mr_open");
    expect(h.store.getTask(h.task.id)?.attempt).toBe(h.task.attempt);
    expect(
      h.store.runsForTask(h.task.id).filter((run) => run.kind === "implement"),
    ).toEqual([]);
    expect(
      h.store.runsForTask(h.task.id).filter((run) => run.kind === "merge_gate"),
    ).toHaveLength(1);

    h.store.db
      .prepare("UPDATE runs SET finished_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 120_000).toISOString(), expired.id);
    await tick(ctx);
    await awaitPendingRuns();
    const mr = await h.provider.mergeRequests.get(
      { id: h.scope.provider_repo_id },
      h.mr.id,
    );
    expect(mr.state).toBe("merged");
    expect(
      h.store.runsForTask(h.task.id).filter((run) => run.kind === "implement"),
    ).toEqual([]);
    expect(
      h.store
        .runsForTask(h.task.id)
        .filter((run) => run.kind === "merge_gate")
        .map((run) => run.status),
    ).toEqual(["failed", "succeeded"]);
  });

  it("rejects a direct review call after the task version changes", async () => {
    const h = await harness();
    const stale = h.store.getTask(h.task.id)!;
    h.store.transitionTask(stale.id, stale.state_version, "blocked", "test", {
      blocked_reason: "operator hold",
    });

    await runReview(h.ctx, h.scope, stale, SHA);

    expect(h.store.runsForTask(stale.id)).toHaveLength(0);
    expect(
      await h.provider.accessTokens!.list({ id: h.scope.provider_repo_id }),
    ).toHaveLength(0);
  });

  for (const scenario of [
    {
      name: "blocked task",
      mutate: (h: Harness) => {
        const current = h.store.getTask(h.task.id)!;
        h.store.transitionTask(
          current.id,
          current.state_version,
          "blocked",
          "test",
          {
            blocked_reason: "operator hold",
          },
        );
      },
    },
    {
      name: "paused scope",
      mutate: (h: Harness) => {
        h.store.setScopeStatus(h.scope.id, "paused", "test");
      },
    },
    {
      name: "draining process",
      mutate: (h: Harness) => {
        h.draining.value = true;
      },
    },
  ]) {
    it(`does not dispatch from a stale provider reply when ${scenario.name}`, async () => {
      const h = await harness();
      const deferred = await deferSecondProviderGet(h.provider);
      const tickPromise = tick(h.ctx);
      await deferred.started;
      scenario.mutate(h);
      deferred.release();
      await tickPromise;
      await awaitPendingRuns();

      expect(h.store.runsForTask(h.task.id)).toHaveLength(0);
      expect(h.store.getTask(h.task.id)!.state).toBe(
        scenario.name === "blocked task" ? "blocked" : "mr_open",
      );
    });
  }

  it("rejects a stale pipeline reply after the task returns to mr_open at a new version", async () => {
    const h = await harness();
    const original = h.provider.pipelines.getStatus.bind(h.provider.pipelines);
    let started!: () => void;
    let release!: () => void;
    const checking = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.provider.pipelines.getStatus = async (...args) => {
      started();
      await deferred;
      const pipeline = await original(...args);
      return { ...pipeline, status: "failed", commit_sha: SHA };
    };
    const ticking = tick(h.ctx);
    await checking;
    let current = h.task;
    for (const state of ["blocked", "queued", "running", "mr_open"] as const) {
      current = h.store.transitionTask(
        current.id,
        current.state_version,
        state,
        "test",
      );
    }
    release();
    await ticking;
    await awaitPendingRuns();
    expect(h.store.runsForTask(h.task.id)).toHaveLength(0);
    expect(h.store.getTask(h.task.id)).toMatchObject({
      state: "mr_open",
      state_version: current.state_version,
    });
  });

  it("repairs a failed current-head pipeline once, preserving feedback and revoking approval", async () => {
    const h = await harness({ approvals: "manual" });
    h.store.setTaskFeedback(h.task.id, "operator context");
    h.store.approveMerge(h.task.id, SHA);
    const pipelineId = "pipeline-failed-current-head";
    h.provider.pipelines.getStatus = async (_repo, _id) => ({
      id: pipelineId,
      status: "failed",
      commit_sha: SHA,
      metadata: {
        provider: "fake",
        id: pipelineId,
        web_url: `https://fake.provider/${pipelineId}`,
      },
    });

    await tick(h.ctx);
    await awaitPendingRuns();

    let task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("queued");
    expect(task.attempt).toBe(1);
    expect(task.next_retry_at).toBeTruthy();
    expect(task.merge_approved_sha).toBeNull();
    expect(task.human_feedback).toContain("operator context");
    expect(task.human_feedback).toContain(pipelineId);
    expect(task.human_feedback).toContain(SHA);
    expect(task.human_feedback).toContain(
      `https://fake.provider/${pipelineId}`,
    );
    const pipelineAudit = h.store
      .listAudit({ task_id: h.task.id, limit: 1000 })
      .events.find((row) => row.action === "gate.pipeline_failed");
    expect(pipelineAudit).toBeTruthy();
    expect(JSON.parse(pipelineAudit!.detail_json)).toMatchObject({
      pipeline_id: pipelineId,
      pipeline_status: "failed",
      pipeline_commit_sha: SHA,
      pipeline_url: `https://fake.provider/${pipelineId}`,
      head_sha: SHA,
      attempt: 1,
      outcome: "retry",
    });
    expect(
      h.store
        .runsForTask(h.task.id)
        .filter((run) =>
          ["review", "merge_gate", "implement"].includes(run.kind),
        ),
    ).toHaveLength(0);

    await tick(h.ctx);
    await awaitPendingRuns();
    task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("queued");
    expect(task.attempt).toBe(1);
    expect(h.store.runsForTask(h.task.id)).toHaveLength(0);
  });

  it.each(["implement", "review", "merge_gate"] as const)(
    "does not repair beside an active %s run",
    async (kind) => {
      const h = await harness();
      const live = h.store.startRun({
        scope_id: h.scope.id,
        task_id: h.task.id,
        kind,
        lease_ttl_ms: 60_000,
      });
      h.provider.pipelines.getStatus = async (_repo, id) => ({
        id,
        status: "failed",
        commit_sha: SHA,
        metadata: { provider: "fake", id },
      });

      await tick(h.ctx);
      await awaitPendingRuns();

      const task = h.store.getTask(h.task.id)!;
      expect(task.state).toBe("mr_open");
      expect(task.attempt).toBe(0);
      expect(h.store.getRun(live.id)?.status).toBe("running");
      expect(h.store.runsForTask(h.task.id)).toHaveLength(1);
    },
  );

  it("waits for a lagging provider head before repairing failed CI", async () => {
    const h = await harness();
    const pushed = h.store.startRun({
      scope_id: h.scope.id,
      task_id: h.task.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    h.store.finishRun(pushed.id, "succeeded", { head_sha: OTHER_SHA });
    h.provider.pipelines.getStatus = async (_repo, id) => ({
      id,
      status: "failed",
      commit_sha: SHA,
      metadata: { provider: "fake", id },
    });

    await tick(h.ctx);
    await awaitPendingRuns();

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("mr_open");
    expect(task.attempt).toBe(0);
    expect(task.human_feedback).toBeNull();
    expect(h.store.runsForTask(h.task.id)).toHaveLength(1);
  });

  it("blocks a failed-pipeline repair at the existing attempt limit", async () => {
    const h = await harness();
    let current = h.store.getTask(h.task.id)!;
    current = h.store.transitionTask(
      current.id,
      current.state_version,
      "queued",
      "test",
      { attempt: 2, next_retry_at: null },
    );
    current = h.store.transitionTask(
      current.id,
      current.state_version,
      "running",
      "test",
    );
    h.store.transitionTask(
      current.id,
      current.state_version,
      "mr_open",
      "test",
    );
    h.provider.pipelines.getStatus = async (_repo, id) => ({
      id,
      status: "failed",
      commit_sha: SHA,
      metadata: { provider: "fake", id },
    });

    await tick(h.ctx);
    await awaitPendingRuns();

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("blocked");
    expect(task.attempt).toBe(2);
    expect(task.blocked_reason).toContain("retries exhausted");
    expect(h.store.runsForTask(h.task.id)).toHaveLength(0);
    const pipelineAudit = h.store
      .listAudit({ task_id: h.task.id, limit: 1000 })
      .events.find((row) => row.action === "gate.pipeline_failed");
    expect(pipelineAudit).toBeTruthy();
    expect(JSON.parse(pipelineAudit!.detail_json)).toMatchObject({
      pipeline_status: "failed",
      pipeline_commit_sha: SHA,
      head_sha: SHA,
      outcome: "blocked",
    });
  });

  it.each(["pending", "running", "canceled", "unknown"] as const)(
    "does not repair or consume an attempt for a %s pipeline",
    async (status) => {
      const h = await harness();
      h.provider.pipelines.getStatus = async (_repo, id) => ({
        id,
        status,
        commit_sha: SHA,
        metadata: { provider: "fake", id },
      });

      await tick(h.ctx);
      await awaitPendingRuns();

      const task = h.store.getTask(h.task.id)!;
      expect(task.state).toBe("mr_open");
      expect(task.attempt).toBe(0);
      expect(task.human_feedback).toBeNull();
      expect(h.store.runsForTask(h.task.id)).toHaveLength(0);
    },
  );

  it("ignores a failed pipeline whose commit does not match the MR head", async () => {
    const h = await harness({ approvals: "manual" });
    h.store.setTaskFeedback(h.task.id, "operator context");
    h.store.approveMerge(h.task.id, SHA);
    h.provider.pipelines.getStatus = async (_repo, id) => ({
      id,
      status: "failed",
      commit_sha: OTHER_SHA,
      metadata: { provider: "fake", id },
    });

    await tick(h.ctx);
    await awaitPendingRuns();

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("mr_open");
    expect(task.attempt).toBe(0);
    expect(task.human_feedback).toBe("operator context");
    expect(task.merge_approved_sha).toBe(SHA);
    expect(h.store.runsForTask(h.task.id)).toHaveLength(0);
  });

  it("does not mutate after a failed pipeline reply races with a paused scope", async () => {
    const h = await harness({ approvals: "manual" });
    h.store.setTaskFeedback(h.task.id, "operator context");
    h.store.approveMerge(h.task.id, SHA);
    let started!: () => void;
    let release!: () => void;
    const checking = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.provider.pipelines.getStatus = async (_repo, id) => {
      started();
      await deferred;
      return {
        id,
        status: "failed",
        commit_sha: SHA,
        metadata: { provider: "fake", id },
      };
    };

    const ticking = tick(h.ctx);
    await checking;
    h.store.setScopeStatus(h.scope.id, "paused", "test");
    release();
    await ticking;
    await awaitPendingRuns();

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("mr_open");
    expect(task.attempt).toBe(0);
    expect(task.human_feedback).toBe("operator context");
    expect(task.merge_approved_sha).toBe(SHA);
    expect(h.store.runsForTask(h.task.id)).toHaveLength(0);
  });

  it("continues dispatching valid current work after provider facts settle", async () => {
    const h = await harness();
    await tick(h.ctx);
    await awaitPendingRuns();

    const runs = h.store.runsForTask(h.task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.kind).toBe("review");
    expect(runs[0]?.status).toBe("succeeded");
  });

  it("observes current merge approval even when the task state version is unchanged", async () => {
    const h = await harness();
    h.store.approveMerge(h.task.id, SHA);
    expect(getCurrentMrTask(h.ctx, h.scope, h.task)?.merge_approved_sha).toBe(
      SHA,
    );
  });

  it("serializes merge gates by provider repository, not by scope", async () => {
    const h = await harness();
    const sameRepository = h.store.createScope({
      goal: "same repository",
      title: "same repository",
      provider_repo_id: h.scope.provider_repo_id,
      provider_repo_path: h.scope.provider_repo_path,
    });
    const otherRepository = h.store.createScope({
      goal: "other repository",
      title: "other repository",
      provider_repo_id: "other-repository",
      provider_repo_path: "other/repository",
    });
    h.store.startRun({
      scope_id: h.scope.id,
      kind: "merge_gate",
      lease_ttl_ms: 60_000,
    });

    expect(hasActiveRepositoryMergeGate(h.ctx, sameRepository)).toBe(true);
    expect(hasActiveRepositoryMergeGate(h.ctx, otherRepository)).toBe(false);
  });

  it("rejects a direct gate dispatch for a task blocked after capture", async () => {
    const h = await harness();
    h.store.transitionTask(h.task.id, h.task.state_version, "blocked", "test");
    await runMergeGate(h.ctx, h.scope, h.task, SHA);
    expect(h.store.runsForTask(h.task.id)).toHaveLength(0);
  });

  it("revokes merge authority when the scope pauses during the final provider read", async () => {
    const h = await harness();
    const get = h.provider.mergeRequests.get.bind(h.provider.mergeRequests);
    h.provider.mergeRequests.get = async (...args) => {
      const mr = await get(...args);
      h.store.setScopeStatus(h.scope.id, "paused", "test");
      return mr;
    };
    await runMergeGate(
      { ...h.ctx, gateExecutor: async () => null },
      h.scope,
      h.task,
      SHA,
    );
    expect((await get({ id: h.scope.provider_repo_id }, h.mr.id)).state).toBe(
      "opened",
    );
    expect(h.store.runsForTask(h.task.id)[0]?.status).toBe("canceled");
    expect(h.store.getTask(h.task.id)).toMatchObject({
      state: "mr_open",
      attempt: h.task.attempt,
    });
  });

  it("lets an admitted gate complete during graceful drain", async () => {
    const h = await harness();
    await runMergeGate(
      {
        ...h.ctx,
        gateExecutor: async () => {
          h.draining.value = true;
          return null;
        },
      },
      h.scope,
      h.task,
      SHA,
    );
    const mr = await h.provider.mergeRequests.get(
      { id: h.scope.provider_repo_id },
      h.mr.id,
    );
    expect(mr.state).toBe("merged");
    expect(h.store.runsForTask(h.task.id)[0]?.status).toBe("succeeded");
  });

  it.each(["response", "ambiguous"] as const)(
    "retains a confirmed merge when cancellation races its %s",
    async (outcome) => {
      const h = await harness();
      const merge = h.provider.mergeRequests.merge.bind(
        h.provider.mergeRequests,
      );
      h.provider.mergeRequests.merge = async (...args) => {
        const result = await merge(...args);
        const run = h.store
          .runsForTask(h.task.id)
          .find((run) => run.kind === "merge_gate")!;
        await abortRun(run.id);
        if (outcome === "ambiguous")
          throw new Error("response lost after merge");
        return result;
      };
      await runMergeGate(
        { ...h.ctx, gateExecutor: async () => null },
        h.scope,
        h.task,
        SHA,
      );
      expect(h.store.runsForTask(h.task.id)[0]?.status).toBe("succeeded");
      expect(h.store.getTask(h.task.id)?.attempt).toBe(h.task.attempt);
    },
  );
});
