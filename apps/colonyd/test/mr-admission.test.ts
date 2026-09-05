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

async function harness(): Promise<Harness> {
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
      return original(...args);
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
