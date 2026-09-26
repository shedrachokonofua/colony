/**
 * Operator spec amendments must not race live runs. Before this delivery
 * loop existed, a task amended mid-run (col-d6ca6aa2.2) stayed invisible to
 * the running implementer, which submitted work built on the superseded
 * spec and lost a full review round to a rejection that was true by
 * construction. Three paths must hold:
 *
 *  1. a running implementer is steered onto the amendment and keeps running;
 *  2. when the runtime cannot steer, the run is aborted and the task is
 *     requeued WITHOUT spending an attempt (infra-retry), so the next run
 *     starts from the amended spec;
 *  3. an in-flight review is aborted and the tick dispatches a fresh review
 *     against the amended spec.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ColonyConfig } from "@colony/config";
import {
  FakeAgentRuntimeAdapter,
  type AgentRunEnvironment,
  type AgentRunMetadata,
  type AgentRuntimePacket,
  type FakeAgentRuntimeOptions,
} from "@colony/agent-runtime";
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
import { buildApp } from "../src/http.js";
import {
  awaitPendingRuns,
  abortRunsAndWait,
  activeTrackedRunIds,
} from "../src/runs/registry.js";
import { tick } from "../src/tick.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

const AMENDMENT =
  "Operator amendment: Kestra intake, Bento over Dapr. This supersedes every Dapr, KEDA and shared chart requirement in this task.";

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(async () => {
  // Settle whatever the test left in flight (stalled runs abort to a
  // canceled result), then release every store handle.
  await abortRunsAndWait(activeTrackedRunIds());
  await awaitPendingRuns();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PLAN = {
  kind: "architect_decomposition" as const,
  summary: "spec amendment task",
  requirements: [{ id: "R1", text: "req", tasks: [0] }],
  journey: [{ after_task: 0, working_state: "state" }],
  acceptance: [{ description: "test", command: "true" }],
  tasks: [
    {
      title: "amend me",
      spec: "land the intake on the original stack",
      depends_on: [],
      files: ["src/code.ts"],
      evidence: ["true"],
    },
  ],
};

/**
 * Fake runtime whose runs stay in flight at `startRun` until their gate is
 * released or they are canceled — these paths need a run that is genuinely
 * live, not one that finished on the dispatch tick. Mirrors the e2e
 * boundary's stall gates, keyed per run so canceling one run never unstalls
 * the next.
 */
class StallingAgentRuntimeAdapter extends FakeAgentRuntimeAdapter {
  /** Packets the stalled role received, in dispatch order. */
  readonly packets: AgentRuntimePacket[] = [];
  /** Resolves when the stalled role's first run reaches the runtime. */
  readonly started = Promise.withResolvers<void>();

  readonly #gates = new Map<string, () => void>();
  #released = false;

  constructor(
    private readonly stallRole: "developer" | "reviewer",
    options: FakeAgentRuntimeOptions = {},
  ) {
    super(options);
  }

  override async startRun(
    packet: AgentRuntimePacket,
    runEnvironment: AgentRunEnvironment,
  ): Promise<AgentRunMetadata> {
    if (runEnvironment.role === this.stallRole) {
      this.packets.push(packet);
      this.started.resolve();
      if (!this.#released) {
        const gate = Promise.withResolvers<void>();
        this.#gates.set(
          runEnvironment.runId ?? `anon-${this.packets.length}`,
          gate.resolve,
        );
        await gate.promise;
      }
    }
    return super.startRun(packet, runEnvironment);
  }

  override async cancelRun(runId: string): Promise<AgentRunMetadata | null> {
    this.#gates.get(runId)?.();
    this.#gates.delete(runId);
    return super.cancelRun(runId);
  }

  /**
   * Let stalled runs continue to their envelopes. With a run id, that run
   * only; without one, every stalled run and any that starts later.
   */
  release(runId?: string): void {
    if (runId) {
      this.#gates.get(runId)?.();
      this.#gates.delete(runId);
      return;
    }
    this.#released = true;
    for (const release of this.#gates.values()) release();
    this.#gates.clear();
  }
}

interface Harness {
  readonly ctx: ColonydContext;
  readonly store: Store;
  readonly provider: FakeProviderAdapter;
  readonly scope: Scope;
  readonly task: Task;
  readonly developer: StallingAgentRuntimeAdapter;
  readonly reviewer: StallingAgentRuntimeAdapter;
}

function implementPacketBody(packet: AgentRuntimePacket): string {
  return String((packet as { body?: unknown }).body ?? "");
}

async function createHarness(
  options: { steerForRun?: (runId: string, message: string) => void } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-spec-amendment-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  const provider = new FakeProviderAdapter();

  const repo = await provider.repos.create({
    name: "test-repo",
    path: "test/repo",
  });
  const repoRef = { id: repo.id, path: repo.path };
  await provider.branches.create(repoRef, "main", SHA_B);

  const scope = store.createScope({
    goal: "spec amendment goal",
    title: "spec amendment scope",
    approvals: "auto",
    provider_repo_id: repo.id,
    provider_repo_path: repo.path,
    default_branch: "main",
  });
  store.setScopeStatus(scope.id, "planning", "test");
  const [created] = store.materializePlan(scope.id, PLAN, "test");
  if (!created) throw new Error("task creation failed");

  // The runtime reports the MR head as the source-branch head, exactly as
  // GitLab does after a push.
  const get = provider.mergeRequests.get.bind(provider.mergeRequests);
  provider.mergeRequests.get = async (requestRepo, id) => {
    const current = await get(requestRepo, id);
    const head = (await provider.commits.get(repoRef, current.source_branch))
      .sha;
    return { ...current, head_commit_sha: head };
  };

  const fakeEnvelope = (
    packet: AgentRuntimePacket,
  ): Record<string, unknown> => {
    const branch = (packet as { repo: { branch: string } }).repo.branch;
    void provider.branches.create(repoRef, branch, SHA_C);
    return {
      kind: "implementer_completion",
      status: "complete",
      summary: "implemented the intake",
      branch,
      head_sha: SHA_C,
      commands: [{ cmd: "bun test", exit_code: 0 }],
    };
  };

  const developer = new StallingAgentRuntimeAdapter("developer", {
    envelopeForRun: fakeEnvelope,
    ...(options.steerForRun ? { steerForRun: options.steerForRun } : {}),
  });
  const reviewer = new StallingAgentRuntimeAdapter("reviewer");

  const config = {
    reviewMode: "required",
    hitlMode: "yolo",
    forAgent: (role: string) => ({
      role,
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
    join(tmpdir(), "colonyd-spec-amendment-artifacts-"),
  );
  dirs.push(artifacts);

  const ctx: ColonydContext = {
    store,
    provider,
    config,
    agents: {
      runtime: "fake",
      architect: new FakeAgentRuntimeAdapter(),
      developer,
      reviewer,
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
  } as unknown as ColonydContext;

  return { ctx, store, provider, scope, task: created, developer, reviewer };
}

/** Drive the task to `mr_open` with an open MR and a known branch head. */
async function openMr(h: Harness): Promise<ProviderMergeRequest> {
  const repoRef = {
    id: h.scope.provider_repo_id,
    path: h.scope.provider_repo_path,
  };
  const branch = `colony/${h.task.id}`;
  await h.provider.branches.create(repoRef, branch, SHA_A);
  const mr = await h.provider.mergeRequests.open(repoRef, {
    title: "amend me",
    description: "spec amendment fixture",
    source_branch: branch,
    target_branch: "main",
  });
  h.store.transitionTask(h.task.id, h.task.state_version, "running", "test", {
    branch,
  });
  const running = h.store.getTask(h.task.id)!;
  h.store.transitionTask(running.id, running.state_version, "mr_open", "test", {
    mr_iid: mr.iid,
  });
  return mr;
}

function clearBackoff(store: Store, taskId: string): void {
  store.db
    .prepare("UPDATE tasks SET next_retry_at = NULL WHERE id = ?")
    .run(taskId);
}

function auditActions(store: Store, taskId: string): string[] {
  return store
    .listAudit({ task_id: taskId, limit: 200 })
    .events.map((e) => e.action);
}

const actorHeaders = {
  "X-Actor-Id": "human:operator",
  "content-type": "application/json",
};

function amendSpec(h: Harness, feedback: string): Response | Promise<Response> {
  return buildApp(h.ctx).request(`/tasks/${h.task.id}/amend-spec`, {
    method: "POST",
    headers: actorHeaders,
    body: JSON.stringify({ feedback }),
  });
}

describe("spec amendment delivery to live runs", () => {
  it("steers a running implementer onto the amendment and keeps the run alive", async () => {
    const steers: { runId: string; message: string }[] = [];
    const h = await createHarness({
      steerForRun: (runId, message) => {
        steers.push({ runId, message });
      },
    });

    await tick(h.ctx);
    await h.developer.started;
    const [live] = h.store
      .runsForTask(h.task.id)
      .filter((run) => run.kind === "implement");
    expect(live?.status).toBe("running");

    const res = await amendSpec(h, AMENDMENT);
    expect(res.status).toBe(200);

    // The amendment reached the live run through the steering channel...
    expect(steers).toHaveLength(1);
    expect(steers[0]!.runId).toBe(live!.id);
    expect(steers[0]!.message).toContain("operator amended");
    expect(steers[0]!.message).toContain(AMENDMENT);
    expect(steers[0]!.message).toContain("supersedes");
    expect(steers[0]!.message).toContain("before you submit");

    // ...and nothing was aborted or requeued.
    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("running");
    expect(h.store.runsForTask(h.task.id)[0]!.status).toBe("running");
    const actions = auditActions(h.store, h.task.id);
    expect(actions).toContain("task.spec_amended");
    expect(actions).toContain("task.spec_amendment_delivered");
    expect(actions).not.toContain("task.spec_amendment_aborted");
    expect(actions).not.toContain("task.infra_retry");
    expect(
      h.store
        .listAudit({ run_id: live!.id, limit: 50 })
        .events.map((e) => e.action),
    ).toContain("task.spec_amendment_delivered");
  });

  it("aborts and requeues without spending an attempt when the run cannot be steered", async () => {
    // No steerForRun: the fake runtime reports steering unsupported.
    const h = await createHarness();

    await tick(h.ctx);
    await h.developer.started;
    const before = h.store.getTask(h.task.id)!;
    const [live] = h.store
      .runsForTask(h.task.id)
      .filter((run) => run.kind === "implement");
    expect(live?.status).toBe("running");

    const res = await amendSpec(h, AMENDMENT);
    expect(res.status).toBe(200);

    // The stale run is dead and the task requeued through the infra-retry
    // path: attempt count untouched, so the amendment costs no budget.
    const [aborted] = h.store
      .runsForTask(h.task.id)
      .filter((run) => run.kind === "implement");
    expect(aborted!.status).toBe("canceled");
    const after = h.store.getTask(h.task.id)!;
    expect(after.state).toBe("queued");
    expect(after.attempt).toBe(before.attempt);
    const actions = auditActions(h.store, h.task.id);
    expect(actions).toContain("task.spec_amendment_aborted");
    expect(actions).toContain("task.infra_retry");
    expect(actions).not.toContain("task.spec_amendment_delivered");

    // The next run starts from the amended spec.
    clearBackoff(h.store, h.task.id);
    await tick(h.ctx);
    h.developer.release();
    await awaitPendingRuns();
    const implementRuns = h.store
      .runsForTask(h.task.id)
      .filter((run) => run.kind === "implement");
    expect(implementRuns).toHaveLength(2);
    expect(h.developer.packets).toHaveLength(2);
    const body = implementPacketBody(h.developer.packets[1]!);
    expect(body).toContain("Spec amendment (operator, authoritative)");
    expect(body).toContain(AMENDMENT);
  });

  it("falls back to abort and requeue when the steering channel itself fails", async () => {
    const h = await createHarness({
      steerForRun: () => {
        throw new Error("steer channel broken");
      },
    });

    await tick(h.ctx);
    await h.developer.started;
    const before = h.store.getTask(h.task.id)!;

    const res = await amendSpec(h, AMENDMENT);
    expect(res.status).toBe(200);

    const [aborted] = h.store
      .runsForTask(h.task.id)
      .filter((run) => run.kind === "implement");
    expect(aborted!.status).toBe("canceled");
    const after = h.store.getTask(h.task.id)!;
    expect(after.state).toBe("queued");
    expect(after.attempt).toBe(before.attempt);
    const abortAudit = h.store
      .listAudit({ task_id: h.task.id, limit: 200 })
      .events.find((e) => e.action === "task.spec_amendment_aborted");
    expect(JSON.parse(abortAudit!.detail_json)).toEqual({ reason: "failed" });
  });

  it("aborts an in-flight review so the tick reviews the amended spec", async () => {
    const h = await createHarness();
    await openMr(h);

    await tick(h.ctx);
    await h.reviewer.started;
    const [firstReview] = h.store
      .runsForTask(h.task.id)
      .filter((run) => run.kind === "review");
    expect(firstReview?.status).toBe("running");

    const res = await amendSpec(h, AMENDMENT);
    expect(res.status).toBe(200);

    // The stale verdict is dead; the task stays in place for the review
    // redispatch instead of being requeued at the implementer.
    const [canceled] = h.store
      .runsForTask(h.task.id)
      .filter((run) => run.kind === "review");
    expect(canceled!.status).toBe("canceled");
    expect(h.store.getTask(h.task.id)!.state).toBe("mr_open");
    const actions = auditActions(h.store, h.task.id);
    expect(actions).toContain("task.spec_amendment_review_aborted");
    expect(actions).not.toContain("task.infra_retry");

    // The tick dispatches a fresh review against the amended spec.
    await tick(h.ctx);
    const reviews = h.store
      .runsForTask(h.task.id)
      .filter((run) => run.kind === "review");
    expect(reviews).toHaveLength(2);
    expect(reviews[1]!.status).toBe("running");
    h.reviewer.release();
    await awaitPendingRuns();
    expect(h.reviewer.packets).toHaveLength(2);
    const body = implementPacketBody(h.reviewer.packets[1]!);
    expect(body).toContain("Spec amendment (operator, authoritative)");
    expect(body).toContain(AMENDMENT);
  });
});
