import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { resetEnvCache } from "@colony/config";
import {
  FakeAgentRuntimeAdapter,
  type AgentRunEnvironment,
  type AgentRuntimePacket,
} from "@colony/agent-runtime";
import type { AuditRow } from "@colony/core";
import { FakeProviderAdapter } from "@colony/provider";
import { boot, type ColonydHandle } from "../src/main.js";
import { awaitPendingRuns } from "../src/runs/registry.js";
import { buildApp } from "../src/http.js";
import type { GateFailure } from "../src/runs/merge-gate.js";
import type { ValidateExecutor } from "../src/runs/validate.js";

const ACTOR = "human:op-1";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

let dir: string;
let provider: FakeProviderAdapter;
let repoId: string;
let handle: ColonydHandle;
let configPath: string;
let reviewConfigPath: string;

/** Scripted fake runtime state shared with the scenarios. */
const script = {
  /** task id -> number of remaining forced implementer failures */
  implementerFailures: new Map<string, number>(),
  /** task id -> implementer run invocations observed */
  implementerCalls: new Map<string, number>(),
  gateFailOnceFor: undefined as string | undefined,
  gateCalls: new Map<string, number>(),
  reviewerCalls: 0,
  reviewerRejectFirst: false,
  reviewerAlwaysReject: false,
  distinctShas: false,
  singleTask: false,
  validateFail: false,
};

function fakeAgents(): FakeAgentRuntimeAdapter {
  return new FakeAgentRuntimeAdapter({
    envelopeForRun: (
      packet: AgentRuntimePacket,
      environment: AgentRunEnvironment,
    ) => {
      if (environment.role === "architect") {
        if (script.singleTask) {
          return {
            kind: "architect_decomposition",
            summary: "Single-task decomposition.",
            acceptance: [{ description: "fake goal holds", command: "true" }],
            tasks: [{ title: "Task A", spec: "Do A.", depends_on: [] }],
          };
        }
        return {
          kind: "architect_decomposition",
          summary: "Two-task decomposition: A then B.",
          acceptance: [{ description: "fake goal holds", command: "true" }],
          tasks: [
            { title: "Task A", spec: "Do A.", depends_on: [] },
            { title: "Task B", spec: "Do B.", depends_on: [0] },
          ],
        };
      }
      if (environment.role === "reviewer") {
        const headSha =
          typeof packet.head_sha === "string" ? packet.head_sha : SHA_A;
        script.reviewerCalls += 1;
        if (
          script.reviewerAlwaysReject ||
          (script.reviewerRejectFirst && script.reviewerCalls === 1)
        ) {
          return {
            kind: "reviewer_verdict",
            verdict: "request_changes",
            summary: "Need changes.",
            findings: [
              {
                severity: "major",
                file: "index.js",
                note: "version endpoint missing",
              },
            ],
            head_sha: headSha,
          };
        }
        return {
          kind: "reviewer_verdict",
          verdict: "approve",
          summary: "Looks good.",
          findings: [],
          head_sha: headSha,
        };
      }
      const taskId = String(packet.task_id);
      const remaining = script.implementerFailures.get(taskId) ?? 0;
      if (remaining > 0) {
        script.implementerFailures.set(taskId, remaining - 1);
        throw new Error("simulated implementer failure");
      }
      const calls = (script.implementerCalls.get(taskId) ?? 0) + 1;
      script.implementerCalls.set(taskId, calls);
      const headSha = script.distinctShas
        ? (
            (taskId.endsWith(".1") ? "a" : "b") +
            String(calls).padStart(2, "0") +
            "0".repeat(37)
          ).slice(0, 40)
        : taskId.endsWith(".1")
          ? SHA_A
          : SHA_B;
      const branch = `colony/${taskId}`;
      // The fake provider needs the branch to exist so envelope fact
      // verification (branch head == head_sha) passes.
      void provider.branches.create({ id: repoId }, branch, headSha);
      return {
        kind: "implementer_completion",
        status: "complete",
        summary: `Implemented ${taskId}.`,
        branch,
        head_sha: headSha,
        commands: [{ cmd: "npm test", exit_code: 0 }],
      };
    },
  });
}

function gateExecutor(): (input: {
  taskBranch: string;
}) => Promise<GateFailure | null> {
  return async (input) => {
    const taskId = input.taskBranch.replace(/^colony\//, "");
    const calls = (script.gateCalls.get(taskId) ?? 0) + 1;
    script.gateCalls.set(taskId, calls);
    if (script.gateFailOnceFor === taskId && calls === 1) {
      return {
        reason: "command_failed",
        commands: [{ cmd: "npm test", exit_code: 1, tail: ["boom"] }],
      };
    }
    return null;
  };
}

function syncMrHead(adapter: FakeProviderAdapter): void {
  const origGet = adapter.mergeRequests.get.bind(adapter.mergeRequests);
  adapter.mergeRequests.get = async (repo, id) => {
    const mr = await origGet(repo, id);
    if (!mr.source_branch) return mr;
    const head = await adapter.commits.get(repo, mr.source_branch);
    return { ...mr, head_commit_sha: head.sha };
  };
}

function fakeValidateExecutor(): ValidateExecutor {
  return async () => {
    if (script.validateFail) {
      return {
        passed: false,
        results: [
          {
            index: 0,
            description: "fake",
            command: "false",
            exit_code: 1,
            tail: ["boom"],
          },
        ],
      };
    }
    return {
      passed: true,
      results: [
        {
          index: 0,
          description: "fake",
          command: "true",
          exit_code: 0,
          tail: [],
        },
      ],
    };
  };
}

async function bootHeadless(
  dbPath: string,
  options: { reviewRequired?: boolean } = {},
): Promise<ColonydHandle> {
  process.env["NODE_ENV"] = "test";
  process.env["AGENT_RUNTIME"] = "fake";
  process.env["GITLAB_TOKEN"] = "";
  process.env["GITLAB_WEBHOOK_SECRET"] = "";
  process.env["COLONYD_DB_PATH"] = dbPath;
  process.env["COLONYD_MAX_ATTEMPTS"] = "3";
  process.env["COLONYD_MAX_CONCURRENT"] = "1";
  process.env["COLONY_CONFIG_PATH"] = options.reviewRequired
    ? reviewConfigPath
    : configPath;
  resetEnvCache();
  if (options.reviewRequired) syncMrHead(provider);
  return boot({
    provider,
    agents: {
      runtime: "fake",
      architect: fakeAgents(),
      developer: fakeAgents(),
      ...(options.reviewRequired ? { reviewer: fakeAgents() } : {}),
    },
    gateExecutor: gateExecutor(),
    validateExecutor: fakeValidateExecutor(),
    headless: true,
  });
}

async function settle(): Promise<void> {
  // Runs are fired with `void`; drain them repeatedly so follow-up tracked
  // runs (gate after implement, etc.) also settle.
  for (let round = 0; round < 4; round += 1) {
    await awaitPendingRuns();
  }
}

async function tickAndSettle(): Promise<void> {
  await handle.tick();
  await settle();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "colonyd-e2e-"));
  configPath = join(dir, "colony.yaml");
  writeFileSync(
    configPath,
    [
      "agent_runtime: fake",
      "allow_literal_keys: true",
      "hitl:",
      "  mode: yolo",
      "providers:",
      "  fake_llm:",
      "    api: openai-completions",
      "    base_url: http://localhost:9/v1",
      "    auth:",
      "      kind: api_key",
      "      value: fake-key",
      "    models:",
      "      - id: fake-model",
      "        name: fake-model",
      "agents:",
      "  architect:",
      "    provider: fake_llm",
      "    model: fake-model",
      "  developer:",
      "    provider: fake_llm",
      "    model: fake-model",
    ].join("\n"),
    "utf8",
  );
  reviewConfigPath = join(dir, "colony-review.yaml");
  writeFileSync(
    reviewConfigPath,
    [
      "agent_runtime: fake",
      "allow_literal_keys: true",
      "hitl:",
      "  mode: yolo",
      "review:",
      "  mode: required",
      "providers:",
      "  fake_llm:",
      "    api: openai-completions",
      "    base_url: http://localhost:9/v1",
      "    auth:",
      "      kind: api_key",
      "      value: fake-key",
      "    models:",
      "      - id: fake-model",
      "        name: fake-model",
      "agents:",
      "  architect:",
      "    provider: fake_llm",
      "    model: fake-model",
      "  developer:",
      "    provider: fake_llm",
      "    model: fake-model",
      "  reviewer:",
      "    provider: fake_llm",
      "    model: fake-model",
    ].join("\n"),
    "utf8",
  );
});

afterAll(async () => {
  // The last handle booted by a scenario still owns process-wide telemetry and
  // a tick interval; leaving it running leaks both into other test files.
  await handle?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each scenario boots its own colonyd; retire the previous one first so its
  // telemetry registration and tick interval do not outlive the test.
  await handle?.shutdown();
  script.implementerFailures.clear();
  script.implementerCalls.clear();
  script.gateFailOnceFor = undefined;
  script.gateCalls.clear();
  script.reviewerCalls = 0;
  script.reviewerRejectFirst = false;
  script.reviewerAlwaysReject = false;
  script.distinctShas = false;
  script.singleTask = false;
  script.validateFail = false;
  provider = new FakeProviderAdapter();
  const repo = await provider.repos.create({
    name: "fake-e2e",
    path: "so/fake-e2e",
  });
  repoId = repo.id;
  handle = await bootHeadless(
    join(dir, `case-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
  );
});

async function createScope(goal: string): Promise<string> {
  const scope = handle.ctx.store.createScope({
    goal,
    provider_repo_id: repoId,
    provider_repo_path: "so/fake-e2e",
  });
  handle.ctx.store.audit(ACTOR, "scope.created", { scope_id: scope.id });
  return scope.id;
}

/** Narrow an audit row's transition target state without unchecked casts. */
function transitionTo(row: AuditRow): string | undefined {
  const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
  return typeof detail.to === "string" ? detail.to : undefined;
}

async function driveToDone(scopeId: string, maxTicks = 20): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    await tickAndSettle();
    const scope = handle.ctx.store.getScope(scopeId);
    if (scope && (scope.status === "done" || scope.status === "blocked"))
      return;
  }
}

describe("colonyd fake end-to-end loop", () => {
  it("happy path: scope draft->planning->active->done; A merges before B dispatches", async () => {
    const scopeId = await createScope("fake happy path");

    await driveToDone(scopeId);

    const scope = handle.ctx.store.getScope(scopeId)!;
    expect(scope.status).toBe("done");

    // Validate run succeeded: scope passed through validating -> done.
    const validateRuns = handle.ctx.store
      .runsForScope(scopeId)
      .filter((r) => r.kind === "validate");
    expect(validateRuns.length).toBeGreaterThanOrEqual(1);
    const passedRun = validateRuns.find((r) => r.status === "succeeded");
    expect(passedRun).toBeTruthy();
    const passedEvidence = JSON.parse(passedRun!.evidence_json!) as {
      passed: boolean;
    };
    expect(passedEvidence.passed).toBe(true);
    const validatedAudit = handle.ctx.store
      .listAudit({ scope_id: scopeId, limit: 1000 })
      .filter((row) => row.action === "scope.validated");
    expect(validatedAudit.length).toBeGreaterThanOrEqual(1);

    const tasks = handle.ctx.store.listTasks(scopeId);
    expect(tasks).toHaveLength(2);
    const [taskA, taskB] = tasks;
    expect(taskA!.state).toBe("merged");
    expect(taskB!.state).toBe("merged");

    // A merged before B ever dispatched: audit row order proves it.
    const firstRunningB = handle.ctx.store
      .listAudit({ task_id: taskB!.id, limit: 1000 })
      .find(
        (row) =>
          row.action === "task.transition" && transitionTo(row) === "running",
      );
    const mergedA = handle.ctx.store
      .listAudit({ task_id: taskA!.id, limit: 1000 })
      .find(
        (row) =>
          row.action === "task.transition" && transitionTo(row) === "merged",
      );
    expect(firstRunningB && mergedA).toBeTruthy();
    expect(firstRunningB!.id).toBeGreaterThan(mergedA!.id);

    // Audit contains task.transition rows for every hop of both tasks.
    for (const task of tasks) {
      const hops = handle.ctx.store
        .listAudit({ task_id: task.id, limit: 1000 })
        .filter((row) => row.action === "task.transition")
        .sort((x, y) => x.id - y.id)
        .map((row) => {
          const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
          return { from: String(detail.from), to: String(detail.to) };
        });
      const chain = hops.map((h) => `${h.from}->${h.to}`);
      expect(chain).toEqual([
        "queued->running",
        "running->mr_open",
        "mr_open->merged",
      ]);
    }

    // Both MRs exist and are merged in the fake provider.
    for (const task of tasks) {
      const mr = await provider.mergeRequests.get(
        { id: repoId },
        `${repoId}:${task.mr_iid}`,
      );
      expect(mr.state).toBe("merged");
    }
  }, 30_000);

  it("retry: failed runs requeue with backoff; third consecutive failure blocks", async () => {
    const scopeId = await createScope("retry path");
    const taskAId = `${scopeId}.1`;
    // Script A's implementer runs to fail BEFORE any dispatch tick runs.
    script.implementerFailures.set(taskAId, 99);

    await tickAndSettle(); // draft -> planning (architect run)
    await tickAndSettle(); // planning -> active; dispatch A (fails)
    await tickAndSettle(); // reconcile failed run -> queued attempt=1
    let a = handle.ctx.store.getTask(taskAId)!;
    expect(a.state).toBe("queued");
    expect(a.attempt).toBe(1);
    expect(a.next_retry_at).toBeTruthy();
    const delayMs = new Date(a.next_retry_at!).getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(5_000);
    expect(delayMs).toBeLessThanOrEqual(11_000);

    // Failure #2: clear backoff, redispatch (fails), then reconcile requeues.
    handle.ctx.store.clearRetryDelay(taskAId);
    await tickAndSettle();
    await tickAndSettle();
    a = handle.ctx.store.getTask(taskAId)!;
    expect(a.state).toBe("queued");
    expect(a.attempt).toBe(2);

    // Failure #3 -> blocked (maxAttempts=3)
    handle.ctx.store.clearRetryDelay(taskAId);
    await tickAndSettle();
    await tickAndSettle();
    a = handle.ctx.store.getTask(taskAId)!;
    expect(a.state).toBe("blocked");
    expect(a.blocked_reason).toMatch(/retries exhausted/);
  }, 30_000);

  it("gate fail: requeued with evidence, then merged on the second pass", async () => {
    const scopeId = await createScope("gate fail path");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; dispatch A -> mr_open
    const taskA = handle.ctx.store
      .listTasks(scopeId)
      .find((t) => t.id.endsWith(".1"))!;
    expect(taskA.state).toBe("mr_open");

    // Fail A's first gate attempt only.
    script.gateFailOnceFor = taskA.id;

    await tickAndSettle(); // gate runs, fails -> task requeued with evidence
    let a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("queued");
    expect(a.attempt).toBe(1);
    const failedGate = handle.ctx.store
      .runsForTask(taskA.id)
      .find((r) => r.kind === "merge_gate" && r.status === "failed")!;
    const evidence = JSON.parse(failedGate.evidence_json!) as Record<
      string,
      unknown
    >;
    expect(evidence.reason).toBe("command_failed");

    // Clear backoff, rerun: implement succeeds (MR reused), gate passes,
    // merge happens, task reaches merged.
    handle.ctx.store.clearRetryDelay(taskA.id);
    await driveToDone(scopeId);

    a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("merged");
    const passedGate = handle.ctx.store
      .runsForTask(taskA.id)
      .find((r) => r.kind === "merge_gate" && r.status === "succeeded");
    expect(passedGate).toBeTruthy();
    // No duplicate MRs were opened for the task.
    const auditMrOpened = handle.ctx.store
      .listAudit({ task_id: taskA.id, limit: 1000 })
      .filter((row) => row.action === "mr.opened");
    expect(auditMrOpened).toHaveLength(1);
  }, 30_000);

  it("treats a timed-out merge response as success when the MR confirms the merge", async () => {
    const scopeId = await createScope("ambiguous merge response");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; dispatch A -> mr_open

    const originalMerge = provider.mergeRequests.merge.bind(
      provider.mergeRequests,
    );
    provider.mergeRequests.merge = async (repo, id, input) => {
      await originalMerge(repo, id, input);
      throw new Error(
        "GitLab PUT /projects/1/merge_requests/1/merge timed out",
      );
    };

    await tickAndSettle(); // gate merges, observes the timeout outcome
    await tickAndSettle(); // provider fact advances mr_open -> merged

    const taskA = handle.ctx.store
      .listTasks(scopeId)
      .find((task) => task.id.endsWith(".1"))!;
    expect(taskA.state).toBe("merged");
    expect(taskA.attempt).toBe(0);
    const gate = handle.ctx.store
      .runsForTask(taskA.id)
      .find((run) => run.kind === "merge_gate");
    expect(gate?.status).toBe("succeeded");
    expect(JSON.parse(gate!.evidence_json!)).toMatchObject({
      reason: "merge_observed_after_error",
      head_sha: SHA_A,
    });
  }, 30_000);

  it("reconciles a queued task whose merge completed before a legacy timeout failure", async () => {
    const scopeId = await createScope("legacy ambiguous merge response");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; dispatch A -> mr_open

    let taskA = handle.ctx.store
      .listTasks(scopeId)
      .find((task) => task.id.endsWith(".1"))!;
    await provider.mergeRequests.merge(
      { id: repoId },
      `${repoId}:${taskA.mr_iid}`,
      { sha: SHA_A },
    );
    const gate = handle.ctx.store.startRun({
      scope_id: scopeId,
      task_id: taskA.id,
      kind: "merge_gate",
      lease_ttl_ms: 30 * 60_000,
      base_sha: SHA_A,
    });
    handle.ctx.store.finishRun(gate.id, "failed", {
      evidence_json: JSON.stringify({
        reason: "workspace_failed",
        error: "GitLab PUT /projects/1/merge_requests/1/merge timed out",
        head_sha: SHA_A,
      }),
    });
    handle.ctx.store.transitionTask(
      taskA.id,
      taskA.state_version,
      "queued",
      "svc:colonyd",
      {
        attempt: 1,
        next_retry_at: new Date(Date.now() + 60_000).toISOString(),
      },
    );

    await tickAndSettle();

    taskA = handle.ctx.store.getTask(taskA.id)!;
    expect(taskA.state).toBe("merged");
    expect(
      handle.ctx.store
        .listAudit({ task_id: taskA.id, limit: 100 })
        .some((row) => row.action === "gate.merge_timeout_reconciled"),
    ).toBe(true);
  }, 30_000);

  it("restart: dead lease expires once; task requeues exactly once without duplicate runs", async () => {
    // Retarget this case at a stable DB path before creating any state: the
    // scenario closes the store mid-run and boots a fresh colonyd on the
    // same file.
    await handle.shutdown();
    const dbPath = join(dir, "restart-case.db");
    handle = await bootHeadless(dbPath);
    const scopeId = await createScope("restart path");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; dispatch A -> mr_open

    // Rewind task A to running with a still-valid lease, simulating a crash
    // mid-run: close the store while the run row is still 'running'.
    const storeA = handle.ctx.store;
    const taskA = storeA.listTasks(scopeId).find((t) => t.id.endsWith(".1"))!;
    storeA.transitionTask(
      taskA.id,
      taskA.state_version,
      "blocked",
      "svc:colonyd",
      {
        blocked_reason: "temp",
      },
    );
    let a = storeA.getTask(taskA.id)!;
    storeA.transitionTask(taskA.id, a.state_version, "queued", "svc:colonyd", {
      attempt: 0,
      next_retry_at: null,
    });
    a = storeA.getTask(taskA.id)!;
    const liveRun = storeA.startRun({
      scope_id: scopeId,
      task_id: taskA.id,
      kind: "implement",
      // Live lease: boot must still reap it as an orphan of the previous
      // process rather than waiting out the TTL.
      lease_ttl_ms: 30 * 60_000,
    });
    const minted = await provider.accessTokens.mint(
      { id: repoId, path: "so/fake-e2e" },
      {
        name: `colony-task-${taskA.id}`,
        scopes: ["api", "write_repository"],
        access_level: 30,
        expires_at: "2099-01-01",
      },
    );
    // Do not persist token_id: SIGKILL between GitLab mint and setRunToken.
    expect(provider.listAccessTokens().map((t) => t.id)).toContain(minted.id);
    storeA.transitionTask(taskA.id, a.state_version, "running", "svc:colonyd");
    const runsBefore = storeA.runsForTask(taskA.id).length;
    const versionBefore = storeA.getTask(taskA.id)!.state_version;
    await handle.shutdown();

    // Boot a fresh colonyd on the same file; orphans are reaped on open.
    handle = await bootHeadless(dbPath);
    await tickAndSettle();

    a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("queued");
    // process_restart is an infrastructure failure: the task requeues but
    // does NOT consume an attempt (only agent-caused failures do).
    expect(a.attempt).toBe(0);
    // Exactly one transition out of running (state_version bumped once).
    expect(a.state_version).toBe(versionBefore + 1);
    // The expired run failed; no new implement run was minted.
    const expired = handle.ctx.store.getRun(liveRun.id)!;
    expect(expired.status).toBe("failed");
    expect(expired.error).toBe("process_restart");
    expect(handle.ctx.store.runsForTask(taskA.id)).toHaveLength(runsBefore);
    expect(provider.listAccessTokens().map((t) => t.id)).not.toContain(
      minted.id,
    );
  }, 30_000);

  it("review loop: request_changes requeues with findings then approve merges on one MR", async () => {
    await handle.shutdown();
    handle = await bootHeadless(join(dir, `review-loop-${Date.now()}.db`), {
      reviewRequired: true,
    });
    script.reviewerRejectFirst = true;
    script.distinctShas = true;

    const scopeId = await createScope("review loop");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; dispatch A -> mr_open
    const taskA = handle.ctx.store
      .listTasks(scopeId)
      .find((t) => t.id.endsWith(".1"))!;
    expect(taskA.state).toBe("mr_open");

    await tickAndSettle(); // review request_changes -> queued
    let a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("queued");
    expect(a.attempt).toBe(1);
    const changes = handle.ctx.store
      .listAudit({ task_id: taskA.id, limit: 1000 })
      .filter((row) => row.action === "review.changes_requested");
    expect(changes).toHaveLength(1);

    handle.ctx.store.clearRetryDelay(taskA.id);
    await driveToDone(scopeId, 40);

    a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("merged");
    expect(a.attempt).toBe(1);
    const scope = handle.ctx.store.getScope(scopeId)!;
    expect(scope.status).toBe("done");

    const audit = handle.ctx.store
      .listAudit({ task_id: taskA.id, limit: 1000 })
      .slice()
      .sort((x, y) => x.id - y.id)
      .map((row) => row.action);
    const requested = audit.indexOf("review.changes_requested");
    const approved = audit.indexOf("review.approved");
    expect(requested).toBeGreaterThanOrEqual(0);
    expect(approved).toBeGreaterThan(requested);
    expect(audit.filter((action) => action === "mr.opened")).toHaveLength(1);
    expect(audit.filter((action) => action === "mr.reused")).toHaveLength(1);
  }, 30_000);

  it("review rejection cap: three consecutive request_changes blocks the task and scope", async () => {
    await handle.shutdown();
    handle = await bootHeadless(join(dir, `review-cap-${Date.now()}.db`), {
      reviewRequired: true,
    });
    script.reviewerAlwaysReject = true;
    script.distinctShas = true;
    script.singleTask = true;

    const scopeId = await createScope("review cap");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // dispatch A -> mr_open
    const taskA = handle.ctx.store.listTasks(scopeId)[0]!;
    expect(taskA.state).toBe("mr_open");

    await tickAndSettle(); // review 1 -> queued attempt 1
    expect(handle.ctx.store.getTask(taskA.id)!.state).toBe("queued");
    handle.ctx.store.clearRetryDelay(taskA.id);
    await tickAndSettle(); // implement 2 -> mr_open
    await tickAndSettle(); // review 2 -> queued attempt 2
    expect(handle.ctx.store.getTask(taskA.id)!.attempt).toBe(2);
    handle.ctx.store.clearRetryDelay(taskA.id);
    await tickAndSettle(); // implement 3 -> mr_open
    await tickAndSettle(); // review 3 -> blocked
    await tickAndSettle(); // closeScopes

    const a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("blocked");
    expect(a.blocked_reason).toBe("review rejected 3 consecutive times");
    const scope = handle.ctx.store.getScope(scopeId)!;
    expect(scope.status).toBe("blocked");
  }, 30_000);

  it("validation failure parks the scope then revalidate rescues it", async () => {
    script.validateFail = true;
    const scopeId = await createScope("validation failure");

    // Drive until the scope reaches `validating` (all tasks merged/terminal)
    // and the validation run has executed (and failed).
    for (let i = 0; i < 25; i += 1) {
      await tickAndSettle();
      const scope = handle.ctx.store.getScope(scopeId);
      if (!scope) continue;
      const validateRuns = handle.ctx.store
        .runsForScope(scopeId)
        .filter((r) => r.kind === "validate");
      if (validateRuns.length > 0) break;
    }

    const scope = handle.ctx.store.getScope(scopeId)!;
    // The scope stays `validating` on failure — no auto-retry.
    expect(scope.status).toBe("validating");

    // A failed validate run exists.
    const failedRun = handle.ctx.store
      .runsForScope(scopeId)
      .find((r) => r.kind === "validate" && r.status === "failed");
    expect(failedRun).toBeTruthy();
    const failedEvidence = JSON.parse(failedRun!.evidence_json!) as {
      passed: boolean;
    };
    expect(failedEvidence.passed).toBe(false);

    // Audit records the failure.
    const failedAudit = handle.ctx.store
      .listAudit({ scope_id: scopeId, limit: 1000 })
      .filter((row) => row.action === "scope.validation_failed");
    expect(failedAudit.length).toBeGreaterThanOrEqual(1);

    // Flip the fake to pass, then revalidate via the HTTP endpoint.
    script.validateFail = false;
    const app = buildApp(handle.ctx);
    const res = await app.request(`/scopes/${scopeId}/revalidate`, {
      method: "POST",
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("validating");
    const revalidateAudit = handle.ctx.store
      .listAudit({ scope_id: scopeId, limit: 1000 })
      .filter((row) => row.action === "scope.revalidate_requested");
    expect(revalidateAudit.length).toBeGreaterThanOrEqual(1);

    // Settle the re-triggered validation run.
    await settle();

    // Second validate run succeeded; scope is now `done`.
    const scopeAfter = handle.ctx.store.getScope(scopeId)!;
    expect(scopeAfter.status).toBe("done");
    const succeededRuns = handle.ctx.store
      .runsForScope(scopeId)
      .filter((r) => r.kind === "validate" && r.status === "succeeded");
    expect(succeededRuns.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
