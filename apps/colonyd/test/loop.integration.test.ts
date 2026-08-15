import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import type { GateFailure } from "../src/runs/merge-gate.js";

const ACTOR = "human:op-1";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

let dir: string;
let provider: FakeProviderAdapter;
let projectId: string;
let handle: ColonydHandle;
let configPath: string;

/** Scripted fake runtime state shared with the scenarios. */
const script = {
  /** task id -> number of remaining forced implementer failures */
  implementerFailures: new Map<string, number>(),
  /** task id -> implementer run invocations observed */
  implementerCalls: new Map<string, number>(),
  gateFailOnceFor: undefined as string | undefined,
  gateCalls: new Map<string, number>(),
};

function fakeAgents(): FakeAgentRuntimeAdapter {
  return new FakeAgentRuntimeAdapter({
    envelopeForRun: (
      packet: AgentRuntimePacket,
      environment: AgentRunEnvironment,
    ) => {
      if (environment.role === "architect") {
        return {
          kind: "architect_decomposition",
          summary: "Two-task decomposition: A then B.",
          tasks: [
            { title: "Task A", spec: "Do A.", depends_on: [] },
            { title: "Task B", spec: "Do B.", depends_on: [0] },
          ],
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
      const headSha = taskId.endsWith(".1") ? SHA_A : SHA_B;
      const branch = `colony/${taskId}`;
      // The fake provider needs the branch to exist so envelope fact
      // verification (branch head == head_sha) passes.
      void provider.branches.create({ id: projectId }, branch, headSha);
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

async function bootHeadless(dbPath: string): Promise<ColonydHandle> {
  process.env["NODE_ENV"] = "test";
  process.env["AGENT_RUNTIME"] = "fake";
  process.env["GITLAB_TOKEN"] = "";
  process.env["GITLAB_WEBHOOK_SECRET"] = "";
  process.env["COLONYD_DB_PATH"] = dbPath;
  process.env["COLONYD_MAX_ATTEMPTS"] = "3";
  process.env["COLONYD_MAX_CONCURRENT"] = "1";
  process.env["COLONY_CONFIG_PATH"] = configPath;
  resetEnvCache();
  return boot({
    provider,
    agents: {
      runtime: "fake",
      architect: fakeAgents(),
      developer: fakeAgents(),
    },
    gateExecutor: gateExecutor(),
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
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  script.implementerFailures.clear();
  script.implementerCalls.clear();
  script.gateFailOnceFor = undefined;
  script.gateCalls.clear();
  provider = new FakeProviderAdapter();
  const project = await provider.projects.create({
    name: "fake-e2e",
    path: "so/fake-e2e",
  });
  projectId = project.id;
  handle = await bootHeadless(
    join(dir, `case-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
  );
});

async function createScope(goal: string): Promise<string> {
  const scope = handle.ctx.store.createScope({
    goal,
    provider_project_id: projectId,
    provider_project_path: "so/fake-e2e",
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
        { id: projectId },
        `${projectId}:${task.mr_iid}`,
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
    storeA.transitionTask(taskA.id, a.state_version, "running", "svc:colonyd");
    const runsBefore = storeA.runsForTask(taskA.id).length;
    const versionBefore = storeA.getTask(taskA.id)!.state_version;
    await handle.shutdown();

    // Boot a fresh colonyd on the same file; orphans are reaped on open.
    handle = await bootHeadless(dbPath);
    await tickAndSettle();

    a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("queued");
    expect(a.attempt).toBe(1);
    // Exactly one transition out of running (state_version bumped once).
    expect(a.state_version).toBe(versionBefore + 1);
    // The expired run failed; no new implement run was minted.
    const expired = handle.ctx.store.getRun(liveRun.id)!;
    expect(expired.status).toBe("failed");
    expect(expired.error).toBe("process_restart");
    expect(handle.ctx.store.runsForTask(taskA.id)).toHaveLength(runsBefore);
  }, 30_000);
});
