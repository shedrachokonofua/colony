import { createHash } from "node:crypto";
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
import { awaitPendingRuns, trackRun } from "../src/runs/registry.js";
import { tick } from "../src/tick.js";
import { runMergeGate } from "../src/runs/merge-gate.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);

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
  summary: "test task",
  requirements: [{ id: "R1", text: "req", tasks: [0] }],
  journey: [{ after_task: 0, working_state: "state" }],
  acceptance: [{ description: "test", command: "true" }],
  tasks: [
    {
      title: "repair task",
      spec: "resolve the conflict and land the task",
      depends_on: [],
      files: ["src/code.ts"],
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
  readonly developer: FakeAgentRuntimeAdapter;
}

/** The implement packet fields these assertions read. */
interface ImplementPacketShape {
  readonly repo: { readonly branch: string };
  readonly repair?: { readonly intent?: Record<string, unknown> };
  readonly body: string;
}

interface HarnessOptions {
  readonly headSha?: string;
  readonly branch?: string;
  readonly conflicted?: boolean;
  readonly detailedMergeStatus?: string;
  readonly targetHeadSha?: string;
  readonly developerCompletion?: {
    readonly head_sha?: string;
    readonly status?: "complete" | "blocked";
    readonly blocked_reason?: string;
    readonly throwError?: string;
  };
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const head = options.headSha ?? SHA_A;
  const branch = options.branch ?? "colony/repair-task";
  const conflicted = options.conflicted ?? true;
  const dir = mkdtempSync(join(tmpdir(), "colonyd-repair-conflict-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  const provider = new FakeProviderAdapter();

  const repo = await provider.repos.create({
    name: "test-repo",
    path: "test/repo",
  });
  const repoRef = { id: repo.id, path: repo.path };
  await provider.branches.create(
    repoRef,
    "main",
    options.targetHeadSha ?? SHA_B,
  );
  await provider.branches.create(repoRef, branch, head);

  const mr = await provider.mergeRequests.open(repoRef, {
    title: "repair task MR",
    description: "testing conflict repair",
    source_branch: branch,
    target_branch: "main",
  });
  const get = provider.mergeRequests.get.bind(provider.mergeRequests);
  provider.mergeRequests.get = async (requestRepo, id) => {
    const current = await get(requestRepo, id);
    // The provider reports the MR head as its branch head: a repair push
    // moves it, exactly as GitLab does.
    const head = (await provider.commits.get(repoRef, current.source_branch))
      .sha;
    if (!conflicted || current.state !== "opened") {
      return { ...current, head_commit_sha: head };
    }
    return {
      ...current,
      head_commit_sha: head,
      has_conflicts: true,
      detailed_merge_status:
        options.detailedMergeStatus ?? "mergeable_broken_status",
    };
  };

  const scope = store.createScope({
    goal: "repair conflict goal",
    title: "repair conflict scope",
    approvals: "auto",
    provider_repo_id: repo.id,
    provider_repo_path: repo.path,
    default_branch: "main",
  });
  store.setScopeStatus(scope.id, "planning", "test");
  const [created] = store.materializePlan(scope.id, PLAN, "test");
  if (!created) throw new Error("task creation failed");

  store.transitionTask(created.id, created.state_version, "running", "test", {
    branch,
  });
  const running = store.getTask(created.id)!;
  store.transitionTask(running.id, running.state_version, "mr_open", "test", {
    mr_iid: mr.iid,
  });
  const task = store.getTask(created.id)!;

  const developer = new FakeAgentRuntimeAdapter({
    envelopeForRun: (packet) => {
      if (options.developerCompletion?.throwError) {
        throw new Error(options.developerCompletion.throwError);
      }
      const completionHead = options.developerCompletion?.head_sha ?? SHA_C;
      const { repo: packetRepo } = packet as unknown as ImplementPacketShape;
      void provider.branches.create(repoRef, packetRepo.branch, completionHead);
      return {
        kind: "implementer_completion",
        status: options.developerCompletion?.status ?? "complete",
        blocked_reason: options.developerCompletion?.blocked_reason,
        summary: "Rebased onto the target branch",
        branch: packetRepo.branch,
        head_sha: completionHead,
        commands: [{ cmd: "bun test", exit_code: 0 }],
      };
    },
  });

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
    join(tmpdir(), "colonyd-repair-conflict-artifacts-"),
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
  } as unknown as ColonydContext;

  return { ctx, store, provider, scope, task, mr, developer };
}

function conflictFingerprint(
  taskId: string,
  sourceSha: string,
  targetSha: string,
): string {
  return createHash("sha256")
    .update(`${taskId}|merge_conflict|${sourceSha}|${targetSha}`)
    .digest("hex");
}

function gateFingerprint(
  taskId: string,
  sourceSha: string,
  criterion: string,
): string {
  return createHash("sha256")
    .update(`${taskId}|merge_gate_failure|${sourceSha}|${criterion}`)
    .digest("hex");
}

function clearBackoff(store: Store, taskId: string): void {
  store.db
    .prepare("UPDATE tasks SET next_retry_at = NULL WHERE id = ?")
    .run(taskId);
}

/** Put a requeued task back in mr_open so a second gate can observe it. */
function resetToMrOpen(store: Store, taskId: string): void {
  const queued = store.getTask(taskId)!;
  const running = store.transitionTask(
    queued.id,
    queued.state_version,
    "running",
    "test",
  );
  store.transitionTask(running.id, running.state_version, "mr_open", "test", {
    mr_iid: queued.mr_iid,
  });
}

function auditActions(store: Store, taskId: string): string[] {
  return store
    .listAudit({ task_id: taskId, limit: 200 })
    .events.map((e) => e.action);
}

describe("merge conflict repair dispatch", () => {
  it("conflicted MR dispatches exactly one intent and requeues the task", async () => {
    const h = await createHarness();

    await tick(h.ctx);
    await awaitPendingRuns();

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.trigger_kind).toBe("merge_conflict");
    expect(intents[0]!.fingerprint).toBe(
      conflictFingerprint(h.task.id, SHA_A, SHA_B),
    );

    const trigger = JSON.parse(intents[0]!.trigger_json);
    expect(trigger.kind).toBe("merge_conflict");
    expect(trigger.source_head_sha).toBe(SHA_A);
    expect(trigger.target_head_sha).toBe(SHA_B);
    expect(trigger.evidence.join("\n")).toContain("mergeable_broken_status");

    const actions = auditActions(h.store, h.task.id);
    expect(actions).toContain("mr.conflicted");
    expect(actions).toContain("gate.repair_dispatched");

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("queued");
    expect(task.attempt).toBe(1);
  });

  it("conflicted MR records the conflicted file list when the provider exposes it", async () => {
    const h = await createHarness();
    h.provider.mergeRequests.diff = async () => [
      { new_path: "src/code.ts", old_path: "src/code.ts" },
      { new_path: "src/other.ts", old_path: "src/other.ts" },
    ];

    await tick(h.ctx);
    await awaitPendingRuns();

    const [intent] = h.store.listRepairIntents(h.task.id);
    const trigger = JSON.parse(intent!.trigger_json);
    expect(trigger.evidence.join("\n")).toContain("conflicted files:");
    expect(trigger.evidence.join("\n")).toContain("src/code.ts");
  });

  it("repeated ticks keep one intent and one requeue", async () => {
    const h = await createHarness();

    await tick(h.ctx);
    await awaitPendingRuns();
    const first = h.store.listRepairIntents(h.task.id);
    expect(first).toHaveLength(1);

    await tick(h.ctx);
    await awaitPendingRuns();
    await tick(h.ctx);
    await awaitPendingRuns();

    const after = h.store.listRepairIntents(h.task.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.fingerprint).toBe(first[0]!.fingerprint);
    expect(h.store.getTask(h.task.id)!.attempt).toBe(1);
  });

  it("a restart after the claim does not duplicate the repair", async () => {
    const h = await createHarness();
    const fingerprint = conflictFingerprint(h.task.id, SHA_A, SHA_B);
    const prior = h.store.startRun({
      scope_id: h.scope.id,
      task_id: h.task.id,
      kind: "implement",
      lease_ttl_ms: 10_000,
    });
    h.store.finishRun(prior.id, "failed", { error: "prior run" });
    h.store.claimRepairIntent({
      fingerprint,
      task_id: h.task.id,
      trigger_kind: "merge_conflict",
      trigger_json: JSON.stringify({
        kind: "merge_conflict",
        source_head_sha: SHA_A,
        target_head_sha: SHA_B,
        evidence: ["prior"],
      }),
    });
    h.store.setRepairIntentRunId(fingerprint, prior.id);

    await tick(h.ctx);
    await awaitPendingRuns();

    // A bound run means dispatch already happened: no transition, no new row.
    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(1);
    expect(h.store.getTask(h.task.id)!.state).toBe("mr_open");
    expect(auditActions(h.store, h.task.id)).not.toContain(
      "gate.repair_reconciled",
    );
  });

  it("crash window self-heals: claim without run_id requeues and aborts a live review", async () => {
    const h = await createHarness();
    const fingerprint = conflictFingerprint(h.task.id, SHA_A, SHA_B);
    h.store.claimRepairIntent({
      fingerprint,
      task_id: h.task.id,
      trigger_kind: "merge_conflict",
      trigger_json: JSON.stringify({
        kind: "merge_conflict",
        source_head_sha: SHA_A,
        target_head_sha: SHA_B,
        evidence: ["crash"],
      }),
    });

    const liveReview = h.store.startRun({
      scope_id: h.scope.id,
      task_id: h.task.id,
      kind: "review",
      lease_ttl_ms: 60_000,
    });
    let settleReview!: () => void;
    const reviewExecution = new Promise<void>((resolve) => {
      settleReview = resolve;
    });
    trackRun(liveReview.id, reviewExecution, () => {
      h.store.finishRun(liveReview.id, "canceled", { error: "aborted" });
      settleReview();
    });

    await tick(h.ctx);
    await awaitPendingRuns();

    expect(h.store.getRun(liveReview.id)?.status).toBe("canceled");
    expect(h.store.getTask(h.task.id)!.state).toBe("queued");
    expect(auditActions(h.store, h.task.id)).toContain(
      "gate.repair_reconciled",
    );

    // The reconciled requeue starts exactly one implement run and binds it.
    clearBackoff(h.store, h.task.id);
    await tick(h.ctx);
    await awaitPendingRuns();

    expect(h.store.getRepairIntent(fingerprint)!.run_id).toBeTruthy();
    const runs = h.store
      .runsForTask(h.task.id)
      .filter((r) => r.kind === "implement");
    expect(runs).toHaveLength(1);
  });

  it("a resolved intent claims nothing on a still-conflicted head", async () => {
    const h = await createHarness();
    const fingerprint = conflictFingerprint(h.task.id, SHA_A, SHA_B);
    h.store.claimRepairIntent({
      fingerprint,
      task_id: h.task.id,
      trigger_kind: "merge_conflict",
      trigger_json: JSON.stringify({
        kind: "merge_conflict",
        source_head_sha: SHA_A,
        target_head_sha: SHA_B,
        evidence: ["resolved"],
      }),
    });
    h.store.resolveRepairIntent(fingerprint, SHA_C);

    await tick(h.ctx);
    await awaitPendingRuns();

    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(1);
    expect(h.store.getTask(h.task.id)!.state).toBe("mr_open");
  });

  it("a moved source head is a new fingerprint eligible once", async () => {
    const h = await createHarness({ headSha: SHA_A });

    await tick(h.ctx);
    await awaitPendingRuns();
    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(1);

    // The repair pushes a new head; the MR still conflicts at that head.
    clearBackoff(h.store, h.task.id);
    await tick(h.ctx);
    await awaitPendingRuns();

    const afterRepair = h.store.listRepairIntents(h.task.id);
    expect(afterRepair[0]!.resolved_head_sha).toBe(SHA_C);
    expect(h.store.getTask(h.task.id)!.state).toBe("mr_open");

    await tick(h.ctx);
    await awaitPendingRuns();

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(2);
    expect(intents.map((i) => i.fingerprint)).toContain(
      conflictFingerprint(h.task.id, SHA_C, SHA_B),
    );
  });

  it("a moved target head is a new fingerprint eligible once", async () => {
    const h = await createHarness({ targetHeadSha: SHA_B });

    await tick(h.ctx);
    await awaitPendingRuns();
    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(1);

    // Back to mr_open at the same head so the tick observes the conflict again.
    resetToMrOpen(h.store, h.task.id);
    await h.provider.branches.create(
      { id: h.scope.provider_repo_id, path: h.scope.provider_repo_path },
      "main",
      SHA_D,
    );
    await tick(h.ctx);
    await awaitPendingRuns();

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(2);
    expect(intents.map((i) => i.fingerprint)).toContain(
      conflictFingerprint(h.task.id, SHA_A, SHA_D),
    );
  });

  it("an unreachable default-branch head claims nothing and audits provider.unreachable", async () => {
    const h = await createHarness();
    const get = h.provider.commits.get.bind(h.provider.commits);
    h.provider.commits.get = async (repo, ref) => {
      if (ref === "main")
        throw new Error("GitLab GET /commits: 503 Service Unavailable");
      return get(repo, ref);
    };

    await tick(h.ctx);
    await awaitPendingRuns();

    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(0);
    expect(h.store.getTask(h.task.id)!.state).toBe("mr_open");
    const unreachable = h.store
      .listAudit({ task_id: h.task.id })
      .events.find(
        (e) =>
          e.action === "provider.unreachable" &&
          e.detail_json.includes("conflict_target_head"),
      );
    expect(unreachable).toBeTruthy();
    expect(unreachable!.detail_json).toContain("503");
  });

  it("an active implement run defers the dispatch", async () => {
    const h = await createHarness();
    h.store.startRun({
      scope_id: h.scope.id,
      task_id: h.task.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });

    await tick(h.ctx);
    await awaitPendingRuns();

    // Claimed (evidence is complete), but no requeue beside a live run.
    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(1);
    expect(h.store.getTask(h.task.id)!.state).toBe("mr_open");
  });

  it("a repair pushing a new head resolves the intent and returns to mr_open", async () => {
    const h = await createHarness({ developerCompletion: { head_sha: SHA_C } });

    await tick(h.ctx);
    await awaitPendingRuns();
    clearBackoff(h.store, h.task.id);
    await tick(h.ctx);
    await awaitPendingRuns();

    const [intent] = h.store.listRepairIntents(h.task.id);
    expect(intent!.resolved_head_sha).toBe(SHA_C);
    expect(h.store.getTask(h.task.id)!.state).toBe("mr_open");
  });

  it("a failed repair blocks with an actionable reason", async () => {
    const h = await createHarness({
      developerCompletion: { throwError: "deterministic failure" },
    });

    await tick(h.ctx);
    await awaitPendingRuns();
    clearBackoff(h.store, h.task.id);
    await tick(h.ctx);
    await awaitPendingRuns();

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("blocked");
    expect(task.blocked_reason).toContain("merge_conflict repair");
    expect(task.blocked_reason).toContain(SHA_A);
    expect(task.blocked_reason).toContain("deterministic failure");
  });

  it("a repair that pushes no new head blocks with repair_no_change", async () => {
    const h = await createHarness({
      developerCompletion: { head_sha: SHA_A },
    });

    await tick(h.ctx);
    await awaitPendingRuns();
    clearBackoff(h.store, h.task.id);
    await tick(h.ctx);
    await awaitPendingRuns();

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("blocked");
    expect(task.blocked_reason).toContain("repair_no_change");
    expect(task.blocked_reason).toContain("merge_conflict repair");
  });

  it("a provider head that lags the push claims nothing", async () => {
    const h = await createHarness();
    // The implementer pushed SHA_C; the provider still reports SHA_A on the
    // MR. Rebasing that stale head would mint an intent nobody can resolve.
    const pushed = h.store.startRun({
      scope_id: h.scope.id,
      task_id: h.task.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    h.store.finishRun(pushed.id, "succeeded", { head_sha: SHA_C });

    await tick(h.ctx);
    await awaitPendingRuns();

    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(0);
    expect(h.store.getTask(h.task.id)!.state).toBe("mr_open");
    expect(h.store.getTask(h.task.id)!.attempt).toBe(0);
    expect(auditActions(h.store, h.task.id)).not.toContain(
      "gate.repair_dispatched",
    );
  });

  it("a non-conflicted MR claims nothing", async () => {
    const h = await createHarness({ conflicted: false });

    await tick(h.ctx);
    await awaitPendingRuns();

    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(0);
    expect(h.store.getTask(h.task.id)!.state).toBe("mr_open");
  });
});

describe("merge gate command failure repair dispatch", () => {
  async function gateFailure(
    h: Harness,
    commands: readonly {
      readonly cmd: string;
      readonly exit_code: number;
      readonly tail: readonly string[];
    }[],
  ): Promise<void> {
    (h.ctx as unknown as { gateExecutor: unknown }).gateExecutor =
      async () => ({
        reason: "command_failed",
        commands,
      });
    await runMergeGate(h.ctx, h.scope, h.store.getTask(h.task.id)!, SHA_A);
  }

  it("command_failed claims exactly one intent per (task, source, criterion)", async () => {
    const h = await createHarness({ conflicted: false });
    await gateFailure(h, [
      { cmd: "bun run typecheck", exit_code: 1, tail: ["error TS2345"] },
    ]);

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.trigger_kind).toBe("merge_gate_failure");
    expect(intents[0]!.fingerprint).toBe(
      gateFingerprint(h.task.id, SHA_A, "bun run typecheck"),
    );
    const trigger = JSON.parse(intents[0]!.trigger_json);
    expect(trigger.kind).toBe("merge_gate_failure");
    expect(trigger.source_head_sha).toBe(SHA_A);
    expect(trigger.evidence.join("\n")).toContain("bun run typecheck");
    expect(trigger.evidence.join("\n")).toContain("error TS2345");

    expect(auditActions(h.store, h.task.id)).toContain(
      "gate.repair_dispatched",
    );
    expect(h.store.getTask(h.task.id)!.state).toBe("queued");
  });

  it("repeating the same failing command claims nothing new and still requeues", async () => {
    const h = await createHarness({ conflicted: false });
    const commands = [{ cmd: "bun test", exit_code: 1, tail: ["expected 1"] }];

    await gateFailure(h, commands);
    const firstAttempt = h.store.getTask(h.task.id)!.attempt;

    // Re-enter mr_open at the same head and fail with the same command.
    resetToMrOpen(h.store, h.task.id);
    await gateFailure(h, commands);

    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(1);
    expect(h.store.getTask(h.task.id)!.state).toBe("queued");
    expect(h.store.getTask(h.task.id)!.attempt).toBe(firstAttempt + 1);
  });

  it("a different failing command is a new fingerprint", async () => {
    const h = await createHarness({ conflicted: false });
    await gateFailure(h, [{ cmd: "bun test", exit_code: 1, tail: ["fail"] }]);
    resetToMrOpen(h.store, h.task.id);
    await gateFailure(h, [
      { cmd: "bun run lint", exit_code: 1, tail: ["lint error"] },
    ]);

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(2);
    expect(intents.map((i) => i.fingerprint)).toEqual(
      expect.arrayContaining([
        gateFingerprint(h.task.id, SHA_A, "bun test"),
        gateFingerprint(h.task.id, SHA_A, "bun run lint"),
      ]),
    );
  });

  it("the gate failure cap still blocks and claims on the way", async () => {
    const h = await createHarness({ conflicted: false });
    for (let index = 0; index < 2; index += 1) {
      const prior = h.store.startRun({
        scope_id: h.scope.id,
        task_id: h.task.id,
        kind: "merge_gate",
        lease_ttl_ms: 60_000,
        base_sha: SHA_A,
      });
      h.store.finishRun(prior.id, "failed", {
        error: "bun test failed",
        evidence_json: JSON.stringify({
          reason: "command_failed",
          error: "bun test failed",
          head_sha: SHA_A,
        }),
      });
    }
    await gateFailure(h, [{ cmd: "bun test", exit_code: 1, tail: ["fail"] }]);

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("blocked");
    expect(task.blocked_reason).toContain("gate failed");
    // The caps win over the intent: the claim records the failure but no
    // repair is dispatched and no repair_dispatched audit is written.
    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(1);
    expect(auditActions(h.store, h.task.id)).not.toContain(
      "gate.repair_dispatched",
    );
  });

  it("a gate merge_conflict reason claims no intent here", async () => {
    const h = await createHarness({ conflicted: false });
    (h.ctx as unknown as { gateExecutor: unknown }).gateExecutor =
      async () => ({
        reason: "merge_conflict",
        files: ["src/code.ts"],
      });
    await runMergeGate(h.ctx, h.scope, h.store.getTask(h.task.id)!, SHA_A);

    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(0);
  });

  it("a transient merge refusal claims no intent and holds for re-gate", async () => {
    const h = await createHarness({ conflicted: false });
    // A passing gate: the refusal happens at the merge API, after it.
    (h.ctx as unknown as { gateExecutor: unknown }).gateExecutor = async () =>
      null;
    h.provider.mergeRequests.merge = async () =>
      ({
        id: h.mr.id,
        iid: h.mr.iid,
        state: "opened",
        merged: false,
        reason: "merge_http_409",
        metadata: h.mr.metadata,
      }) as ProviderMergeRequest;
    await runMergeGate(h.ctx, h.scope, h.store.getTask(h.task.id)!, SHA_A);

    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(0);
    expect(h.store.getTask(h.task.id)!.state).toBe("mr_open");
    expect(auditActions(h.store, h.task.id)).toContain("gate.regate_pending");
  });

  it("a workspace failure claims no intent", async () => {
    const h = await createHarness({ conflicted: false });
    (h.ctx as unknown as { gateExecutor: unknown }).gateExecutor =
      async () => ({
        reason: "workspace_failed",
        detail: "workspace provisioning failed",
      });
    await runMergeGate(h.ctx, h.scope, h.store.getTask(h.task.id)!, SHA_A);

    expect(h.store.listRepairIntents(h.task.id)).toHaveLength(0);
    expect(h.store.getTask(h.task.id)!.state).toBe("mr_open");
  });
});

describe("repair packet evidence", () => {
  it("the implement run packet carries the conflict intent with source and target", async () => {
    const h = await createHarness({ developerCompletion: { head_sha: SHA_C } });
    const packets: unknown[] = [];
    (
      h.developer as unknown as {
        options: { envelopeForRun: (packet: unknown) => unknown };
      }
    ).options.envelopeForRun = (packet: unknown) => {
      packets.push(packet);
      void h.provider.branches.create(
        { id: h.scope.provider_repo_id, path: h.scope.provider_repo_path },
        "colony/repair-task",
        SHA_C,
      );
      return {
        kind: "implementer_completion",
        status: "complete",
        summary: "Rebased onto the target branch",
        branch: "colony/repair-task",
        head_sha: SHA_C,
        commands: [{ cmd: "bun test", exit_code: 0 }],
      };
    };

    await tick(h.ctx);
    await awaitPendingRuns();
    clearBackoff(h.store, h.task.id);
    await tick(h.ctx);
    await awaitPendingRuns();

    expect(packets.length).toBeGreaterThan(0);
    const packet = packets.at(-1) as unknown as ImplementPacketShape;
    expect(packet.repair?.intent?.kind).toBe("merge_conflict");
    expect(packet.repair?.intent?.source_head_sha).toBe(SHA_A);
    expect(packet.repair?.intent?.target_head_sha).toBe(SHA_B);
    expect(packet.body).toContain("## Repair intent — MERGE CONFLICT");
    expect(packet.body).toContain("Trigger: `merge_conflict`");
    expect(packet.body).toContain(SHA_A);
    expect(packet.body).toContain(SHA_B);
    expect(packet.body).toContain("mergeable_broken_status");
  });

  it("run.start audits the conflict intent evidence", async () => {
    const h = await createHarness({ developerCompletion: { head_sha: SHA_C } });

    await tick(h.ctx);
    await awaitPendingRuns();
    clearBackoff(h.store, h.task.id);
    await tick(h.ctx);
    await awaitPendingRuns();

    const started = h.store
      .listAudit({ task_id: h.task.id, limit: 200 })
      .events.filter((e) => e.action === "run.start");
    const withIntent = started.find((e) =>
      e.detail_json.includes("repair_intent"),
    );
    expect(withIntent).toBeTruthy();
    const detail = JSON.parse(withIntent!.detail_json) as {
      repair_intent: {
        fingerprint: string;
        kind: string;
        source_head_sha: string;
        evidence: string[];
      };
    };
    expect(detail.repair_intent.kind).toBe("merge_conflict");
    expect(detail.repair_intent.source_head_sha).toBe(SHA_A);
    expect(detail.repair_intent.fingerprint).toBe(
      conflictFingerprint(h.task.id, SHA_A, SHA_B),
    );
    expect(detail.repair_intent.evidence.length).toBeGreaterThan(0);
  });

  it("the gate failure packet section names the failing command and its tail", async () => {
    const h = await createHarness({ conflicted: false });
    await runMergeGate(h.ctx, h.scope, h.store.getTask(h.task.id)!, SHA_A);
    const packets: unknown[] = [];
    (
      h.developer as unknown as {
        options: { envelopeForRun: (packet: unknown) => unknown };
      }
    ).options.envelopeForRun = (packet: unknown) => {
      packets.push(packet);
      void h.provider.branches.create(
        { id: h.scope.provider_repo_id, path: h.scope.provider_repo_path },
        "colony/repair-task",
        SHA_C,
      );
      return {
        kind: "implementer_completion",
        status: "complete",
        summary: "Fixed the failing gate command",
        branch: "colony/repair-task",
        head_sha: SHA_C,
        commands: [{ cmd: "bun test", exit_code: 0 }],
      };
    };
    (h.ctx as unknown as { gateExecutor: unknown }).gateExecutor =
      async () => ({
        reason: "command_failed",
        commands: [
          { cmd: "bun run typecheck", exit_code: 1, tail: ["error TS2345"] },
        ],
      });
    await runMergeGate(h.ctx, h.scope, h.store.getTask(h.task.id)!, SHA_A);

    clearBackoff(h.store, h.task.id);
    await tick(h.ctx);
    await awaitPendingRuns();

    const packet = packets.at(-1) as unknown as ImplementPacketShape;
    expect(packet.repair?.intent?.kind).toBe("merge_gate_failure");
    expect(packet.repair?.intent?.source_head_sha).toBe(SHA_A);
    expect(packet.body).toContain("## Repair intent — MERGE GATE FAILURE");
    expect(packet.body).toContain("bun run typecheck");
    expect(packet.body).toContain("error TS2345");
  });
});
