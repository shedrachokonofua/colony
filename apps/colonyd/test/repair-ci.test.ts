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
  sanitizeTrace,
  type ProviderMergeRequest,
} from "@colony/provider";
import type { ColonydContext } from "../src/context.js";
import { awaitPendingRuns, trackRun } from "../src/runs/registry.js";
import { tick } from "../src/tick.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

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
      spec: "repair CI when broken",
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
  readonly dirs: string[];
  readonly developer: FakeAgentRuntimeAdapter;
}

async function createHarness(
  options: {
    readonly headSha?: string;
    readonly branch?: string;
    readonly developerCompletion?: {
      readonly head_sha?: string;
      readonly status?: "complete" | "blocked";
      readonly blocked_reason?: string;
      readonly commands?: readonly {
        readonly cmd: string;
        readonly exit_code: number;
      }[];
      readonly throwError?: string;
    };
  } = {},
): Promise<Harness> {
  const head = options.headSha ?? SHA_A;
  const branch = options.branch ?? "colony/repair-task";
  const dir = mkdtempSync(join(tmpdir(), "colonyd-repair-ci-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  const provider = new FakeProviderAdapter();

  const repo = await provider.repos.create({
    name: "test-repo",
    path: "test/repo",
  });
  await provider.branches.create(
    { id: repo.id, path: repo.path },
    "main",
    SHA_B,
  );
  await provider.branches.create(
    { id: repo.id, path: repo.path },
    branch,
    head,
  );

  const mr = await provider.mergeRequests.open(
    { id: repo.id, path: repo.path },
    {
      title: "repair task MR",
      description: "testing repair",
      source_branch: branch,
      target_branch: "main",
    },
  );

  const scope = store.createScope({
    goal: "repair ci goal",
    title: "repair ci scope",
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
    envelopeForRun: () => {
      if (options.developerCompletion?.throwError) {
        throw new Error(options.developerCompletion.throwError);
      }
      const completionHead = options.developerCompletion?.head_sha ?? SHA_C;
      void provider.branches.create(
        { id: repo.id, path: repo.path },
        branch,
        completionHead,
      );
      return {
        kind: "implementer_completion",
        status: options.developerCompletion?.status ?? "complete",
        blocked_reason: options.developerCompletion?.blocked_reason,
        summary: "Repaired CI failure",
        branch,
        head_sha: completionHead,
        commands: options.developerCompletion?.commands ?? [
          { cmd: "bun test", exit_code: 0 },
        ],
      };
    },
  });

  const reviewer = new FakeAgentRuntimeAdapter({
    envelopeForRun: (packet) => ({
      kind: "reviewer_verdict",
      verdict: "approve",
      summary: "Approved",
      findings: [],
      inspected: [{ file: "src/code.ts", note: "ok" }],
      head_sha: packet.head_sha,
    }),
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

  const artifacts = mkdtempSync(join(tmpdir(), "colonyd-repair-ci-artifacts-"));
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

  return { ctx, store, provider, scope, task, mr, dirs, developer };
}

describe("CI failure repair dispatch (E2E & lifecycle)", () => {
  it("failed pipeline dispatches exactly one repair and claims intent", async () => {
    const h = await createHarness();
    h.provider.setPipelineStatusForSha(SHA_A, "failed");

    await tick(h.ctx);
    await awaitPendingRuns();

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.trigger_kind).toBe("ci_failure");

    const auditEvents = h.store
      .listAudit({ task_id: h.task.id, limit: 100 })
      .events.map((e) => e.action);
    expect(auditEvents).toContain("gate.pipeline_blocked");
    expect(auditEvents).toContain("gate.repair_dispatched");

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("queued");
    expect(task.attempt).toBe(1);

    // Fast-forward next_retry_at to now so dispatchImplementers picks it up
    h.store.db
      .prepare("UPDATE tasks SET next_retry_at = NULL WHERE id = ?")
      .run(h.task.id);

    await tick(h.ctx);
    await awaitPendingRuns();

    const updatedIntents = h.store.listRepairIntents(h.task.id);
    expect(updatedIntents[0]!.run_id).toBeTruthy();
  });

  it("canceled pipeline dispatches once", async () => {
    const h = await createHarness();
    h.provider.setPipelineStatusForSha(SHA_A, "canceled");

    await tick(h.ctx);
    await awaitPendingRuns();

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.trigger_kind).toBe("ci_failure");

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("queued");

    // Clear retry backoff and tick again to dispatch implementer
    h.store.db
      .prepare("UPDATE tasks SET next_retry_at = NULL WHERE id = ?")
      .run(h.task.id);

    await tick(h.ctx);
    await awaitPendingRuns();

    const updatedIntents = h.store.listRepairIntents(h.task.id);
    expect(updatedIntents[0]!.run_id).toBeTruthy();
  });

  it("repeated ticks do not duplicate the claim or run", async () => {
    const h = await createHarness();
    h.provider.setPipelineStatusForSha(SHA_A, "failed");

    await tick(h.ctx);
    await awaitPendingRuns();

    const firstIntents = h.store.listRepairIntents(h.task.id);
    expect(firstIntents).toHaveLength(1);

    // Second tick with the same head and status
    await tick(h.ctx);
    await awaitPendingRuns();

    const secondIntents = h.store.listRepairIntents(h.task.id);
    expect(secondIntents).toHaveLength(1);
    expect(secondIntents[0]!.fingerprint).toBe(firstIntents[0]!.fingerprint);
  });

  it("restart / fresh tick after claim does not duplicate", async () => {
    const h = await createHarness();
    h.provider.setPipelineStatusForSha(SHA_A, "failed");

    // Pre-insert claim with run_id already set (simulating past run)
    const fingerprint = createHash("sha256")
      .update(`${h.task.id}|ci_failure|${SHA_A}`)
      .digest("hex");

    const dummyRun = h.store.startRun({
      scope_id: h.scope.id,
      task_id: h.task.id,
      kind: "implement",
      lease_ttl_ms: 10_000,
    });
    h.store.finishRun(dummyRun.id, "failed", { error: "prior run" });

    h.store.claimRepairIntent({
      fingerprint,
      task_id: h.task.id,
      trigger_kind: "ci_failure",
      trigger_json: JSON.stringify({
        kind: "ci_failure",
        source_head_sha: SHA_A,
        evidence: [],
      }),
    });
    h.store.setRepairIntentRunId(fingerprint, dummyRun.id);

    await tick(h.ctx);
    await awaitPendingRuns();

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(1);
  });

  it("pending, running, and success pipelines dispatch nothing", async () => {
    for (const status of ["pending", "running", "success"] as const) {
      const h = await createHarness();
      h.provider.setPipelineStatusForSha(SHA_A, status);

      await tick(h.ctx);
      await awaitPendingRuns();

      const intents = h.store.listRepairIntents(h.task.id);
      expect(intents).toHaveLength(0);
    }
  });

  it("obsolete head dispatches nothing", async () => {
    const h = await createHarness({ headSha: SHA_A });
    h.provider.setPipelineStatusForSha(SHA_A, "failed");

    // Record a succeeded implement run with a newer head SHA_B
    const run = h.store.startRun({
      scope_id: h.scope.id,
      task_id: h.task.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    h.store.finishRun(run.id, "succeeded", { head_sha: SHA_B });

    await tick(h.ctx);
    await awaitPendingRuns();

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(0);
  });

  it("multi-failed-job pipeline yields ONE intent with merged evidence", async () => {
    const h = await createHarness();
    const pipelineId = "pipe-multi-fail";
    h.provider.pipelines.getStatus = async () => ({
      id: pipelineId,
      status: "failed",
      commit_sha: SHA_A,
      metadata: {
        provider: "fake",
        id: pipelineId,
        web_url: "https://pipe-multi",
      },
    });
    h.provider.pipelines.listJobs = async () => [
      {
        id: "j1",
        name: "test-unit",
        status: "failed",
        metadata: { provider: "fake", id: "j1" },
      },
      {
        id: "j2",
        name: "lint",
        status: "failed",
        metadata: { provider: "fake", id: "j2" },
      },
      {
        id: "j3",
        name: "build",
        status: "success",
        metadata: { provider: "fake", id: "j3" },
      },
    ];
    h.provider.pipelines.getTrace = async (_repo, jobId) => ({
      job: {
        id: jobId,
        name: jobId,
        status: "failed",
        metadata: { provider: "fake", id: jobId },
      },
      text: `Error in ${jobId}`,
    });

    await tick(h.ctx);
    await awaitPendingRuns();

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(1);
    const trigger = JSON.parse(intents[0]!.trigger_json);
    expect(trigger.evidence).toHaveLength(2);
    expect(trigger.evidence[0]).toContain("test-unit: Error in j1");
    expect(trigger.evidence[1]).toContain("lint: Error in j2");
    expect(trigger.provider.job_ids).toEqual(["j1", "j2"]);
  });

  it("crash reconciliation: claim present, run_id NULL, task mr_open with live review -> aborts review, transitions to queued, exactly one run starts", async () => {
    const h = await createHarness();
    h.provider.setPipelineStatusForSha(SHA_A, "failed");

    const fingerprint = createHash("sha256")
      .update(`${h.task.id}|ci_failure|${SHA_A}`)
      .digest("hex");

    // Claim exists but no run_id bound yet (e.g. colonyd crashed before queueing / run start)
    h.store.claimRepairIntent({
      fingerprint,
      task_id: h.task.id,
      trigger_kind: "ci_failure",
      trigger_json: JSON.stringify({
        kind: "ci_failure",
        source_head_sha: SHA_A,
        evidence: ["crash"],
      }),
    });

    // Start a live review run and track it
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

    // Tick should abort the live review, reconcile the null claim, and transition to queued
    await tick(h.ctx);
    await awaitPendingRuns();

    expect(h.store.getRun(liveReview.id)?.status).toBe("canceled");

    const queuedTask = h.store.getTask(h.task.id)!;
    expect(queuedTask.state).toBe("queued");

    // Clear backoff to dispatch the repair implementer run
    h.store.db
      .prepare("UPDATE tasks SET next_retry_at = NULL WHERE id = ?")
      .run(h.task.id);

    await tick(h.ctx);
    await awaitPendingRuns();

    const intent = h.store.getRepairIntent(fingerprint);
    expect(intent).toBeDefined();
    expect(intent!.run_id).toBeTruthy();

    const auditActions = h.store
      .listAudit({ task_id: h.task.id, limit: 100 })
      .events.map((e) => e.action);
    expect(auditActions).toContain("gate.repair_reconciled");
  });

  it("repair pushing a new head returns to mr_open and resolves intent", async () => {
    const h = await createHarness({
      headSha: SHA_A,
      developerCompletion: { head_sha: SHA_C },
    });
    h.provider.setPipelineStatusForSha(SHA_A, "failed");

    await tick(h.ctx);
    await awaitPendingRuns();

    // Fast-forward backoff to execute the repair implementer run
    h.store.db
      .prepare("UPDATE tasks SET next_retry_at = NULL WHERE id = ?")
      .run(h.task.id);

    await tick(h.ctx);
    await awaitPendingRuns();

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.resolved_head_sha).toBe(SHA_C);

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("mr_open");
  });

  it("failed repair run (non-infra) blocks the task", async () => {
    const h = await createHarness({
      headSha: SHA_A,
      developerCompletion: {
        throwError: "deterministic test failure",
      },
    });
    h.provider.setPipelineStatusForSha(SHA_A, "failed");

    await tick(h.ctx);
    await awaitPendingRuns();

    // Fast-forward backoff to execute the repair implementer run
    h.store.db
      .prepare("UPDATE tasks SET next_retry_at = NULL WHERE id = ?")
      .run(h.task.id);

    await tick(h.ctx);
    await awaitPendingRuns();

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("blocked");
    expect(task.blocked_reason).toContain("ci_failure repair");
    expect(task.blocked_reason).toContain(SHA_A);
  });

  it("repair claiming success with unchanged head blocks the task (repair_no_change)", async () => {
    const h = await createHarness({
      headSha: SHA_A,
      developerCompletion: {
        head_sha: SHA_A, // Same head!
      },
    });
    h.provider.setPipelineStatusForSha(SHA_A, "failed");

    await tick(h.ctx);
    await awaitPendingRuns();

    // Fast-forward backoff to execute the repair implementer run
    h.store.db
      .prepare("UPDATE tasks SET next_retry_at = NULL WHERE id = ?")
      .run(h.task.id);

    await tick(h.ctx);
    await awaitPendingRuns();

    const task = h.store.getTask(h.task.id)!;
    expect(task.state).toBe("blocked");
    expect(task.blocked_reason).toContain("repair_no_change");
    expect(task.blocked_reason).toContain(SHA_A);
  });

  it("traces are capped at 8 KiB / 200 lines with ANSI/control characters and secrets stripped", () => {
    const secret = "glpat-abcdef12345678901234 sk-abcdef12345678901234";
    const ansi = "\x1b[31mRed text\x1b[0m";
    const longText = Array.from(
      { length: 300 },
      (_, i) => `line ${i} ${secret} ${ansi}`,
    ).join("\n");

    const sanitized = sanitizeTrace(longText);

    // Line cap: at most 200 lines (trailing preserved)
    const lines = sanitized.split("\n");
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(lines[lines.length - 1]).toContain("line 299");

    // Byte cap: at most 8 KiB (8192 bytes)
    expect(Buffer.byteLength(sanitized, "utf8")).toBeLessThanOrEqual(8192);

    // ANSI stripped
    expect(sanitized).not.toContain("\x1b[31m");
    expect(sanitized).not.toContain("\x1b[0m");

    // Secrets redacted
    expect(sanitized).not.toContain("glpat-abcdef12345678901234");
    expect(sanitized).not.toContain("sk-abcdef12345678901234");
  });

  it("getTrace 429/timeout audits provider.unreachable and claims no intent", async () => {
    const h = await createHarness();
    h.provider.setPipelineStatusForSha(SHA_A, "failed");
    // Override getTrace to throw a 429 / transport error
    h.provider.pipelines.getTrace = async () => {
      const err = new Error(
        "GitLab GET /jobs/123/trace: 429 Too Many Requests",
      );
      (err as { status?: number }).status = 429;
      throw err;
    };

    await tick(h.ctx);
    await awaitPendingRuns();

    // No claim should be made for a transient provider blip
    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(0);

    // provider.unreachable audited with stage repair_evidence
    const audits = h.store.listAudit({ task_id: h.task.id }).events;
    const unreachable = audits.find((e) => e.action === "provider.unreachable");
    expect(unreachable).toBeTruthy();
    expect(unreachable!.detail_json).toContain("repair_evidence");
    expect(unreachable!.detail_json).toContain("429");
  });

  it("getTrace 404 yields a claimed intent with sanitized placeholder evidence", async () => {
    const h = await createHarness();
    h.provider.setPipelineStatusForSha(SHA_A, "failed");
    // Override getTrace to throw 404
    h.provider.pipelines.getTrace = async () => {
      const err = new Error("404 Not Found");
      (err as { status?: number }).status = 404;
      throw err;
    };

    await tick(h.ctx);
    await awaitPendingRuns();

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(1);
    const intentJson = JSON.parse(intents[0]!.trigger_json);
    expect(intentJson.evidence[0]).toContain("trace unavailable (not found)");
  });

  it("pipelineGate getStatus error audits provider.unreachable", async () => {
    const h = await createHarness();
    h.provider.pipelines.getStatus = async () => {
      const err = new Error("503 Service Unavailable");
      (err as { status?: number }).status = 503;
      throw err;
    };

    await tick(h.ctx);
    await awaitPendingRuns();

    const audits = h.store.listAudit({ task_id: h.task.id }).events;
    const unreachable = audits.find((e) => e.action === "provider.unreachable");
    expect(unreachable).toBeTruthy();
    expect(unreachable!.detail_json).toContain("pipeline_gate");
  });

  it("infra failure (process_restart / 429) retries repair and threads repair traces", async () => {
    let failFirstRun = true;
    const h = await createHarness({
      developerCompletion: {
        head_sha: SHA_B,
      },
    });
    h.provider.setPipelineStatusForSha(SHA_A, "failed");

    // Start with a failed pipeline to dispatch repair
    await tick(h.ctx);
    await awaitPendingRuns();

    const intents = h.store.listRepairIntents(h.task.id);
    expect(intents).toHaveLength(1);
    const fingerprint = intents[0]!.fingerprint;

    // Fast-forward backoff to execute the repair implementer run
    h.store.db
      .prepare("UPDATE tasks SET next_retry_at = NULL WHERE id = ?")
      .run(h.task.id);

    // Configure envelopeForRun to throw an infra failure on the first run
    const defaultEnv = {
      kind: "implementer_completion" as const,
      status: "complete" as const,
      summary: "Repaired CI failure",
      branch: "colony/repair-task",
      head_sha: SHA_B,
      commands: [{ cmd: "bun test", exit_code: 0 }],
    };
    (
      h.developer as unknown as { options: { envelopeForRun?: () => unknown } }
    ).options.envelopeForRun = () => {
      if (failFirstRun) {
        failFirstRun = false;
        throw new Error("process_restart");
      }
      void h.provider.branches.create(
        { id: h.scope.provider_repo_id, path: h.scope.provider_repo_path },
        "colony/repair-task",
        SHA_B,
      );
      return defaultEnv;
    };

    await tick(h.ctx);
    await awaitPendingRuns();

    // The task should be requeued via task.infra_retry (or expireLeases reconciler)
    await tick(h.ctx);
    await awaitPendingRuns();

    // Verify task is queued or running, not blocked
    const taskAfterInfra = h.store.getTask(h.task.id)!;
    expect(taskAfterInfra.state).not.toBe("blocked");

    // Repair intent should have run_id unbound
    const intentAfterInfra = h.store.getRepairIntent(fingerprint)!;
    expect(intentAfterInfra.resolved_head_sha).toBeNull();
    expect(intentAfterInfra.run_id).toBeNull();

    // Tick again to dispatch retry with repair intent re-bound
    h.store.db
      .prepare("UPDATE tasks SET next_retry_at = NULL WHERE id = ?")
      .run(h.task.id);
    await tick(h.ctx);
    await awaitPendingRuns();

    // After successful retry pushing SHA_B, intent should be resolved
    const finalIntent = h.store.getRepairIntent(fingerprint)!;
    expect(finalIntent.resolved_head_sha).toBe(SHA_B);
  });
});
