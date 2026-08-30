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
import { FakeProviderAdapter } from "@colony/provider";
import type { Run } from "@colony/core";
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import { boot, type ColonydHandle } from "../src/main.js";
import type { ColonydContext } from "../src/context.js";
import { SERVICE_ACTOR } from "../src/context.js";
import { awaitPendingRuns } from "../src/runs/registry.js";
import type { GateFailure } from "../src/runs/merge-gate.js";
import type { ValidateResult } from "../src/runs/validate.js";

const ACTOR = "human:op-1";
const SHA_A = "a".repeat(40);

const PLAN: ArchitectDecompositionV2 = {
  kind: "architect_decomposition",
  summary: "Single-task decomposition.",
  acceptance: [{ description: "fake goal holds", command: "true" }],
  tasks: [{ title: "Task A", spec: "Do A.", depends_on: [] }],
};

let dir: string;
let provider: FakeProviderAdapter;
let repoId: string;
/** Every daemon booted here, shut down after the last case. */
const bootedHandles: ColonydHandle[] = [];

/** Scripted fake runtime state shared with the scenarios. */
const script = {
  /** task id -> implementer run invocations observed */
  implementerCalls: new Map<string, number>(),
  reviewerCalls: 0,
};

function fakeAgents(): FakeAgentRuntimeAdapter {
  return new FakeAgentRuntimeAdapter({
    envelopeForRun: (
      packet: AgentRuntimePacket,
      environment: AgentRunEnvironment,
    ) => {
      if (environment.role === "architect") return PLAN;
      if (environment.role === "reviewer") {
        script.reviewerCalls += 1;
        return {
          kind: "reviewer_verdict",
          verdict: "approve",
          summary: "Looks good.",
          findings: [],
          head_sha: SHA_A,
        };
      }
      const taskId = String(packet.task_id);
      script.implementerCalls.set(
        taskId,
        (script.implementerCalls.get(taskId) ?? 0) + 1,
      );
      const branch = `colony/${taskId}`;
      // The fake provider needs the branch to exist so envelope fact
      // verification (branch head == head_sha) passes.
      void provider.branches.create({ id: repoId }, branch, SHA_A);
      return {
        kind: "implementer_completion",
        status: "complete",
        summary: `Implemented ${taskId}.`,
        branch,
        head_sha: SHA_A,
        commands: [{ cmd: "npm test", exit_code: 0 }],
      };
    },
  });
}

/**
 * One fake provider carrying two models; a limit caps concurrent RUNNING runs
 * on that model. Omitting a limit leaves the model unlimited.
 */
function writeConfig(
  name: string,
  options: {
    readonly developerLimit?: number;
    readonly reviewerLimit?: number;
    readonly reviewRequired?: boolean;
  } = {},
): string {
  const model = (id: string, limit: number | undefined): string[] => [
    `      - id: ${id}`,
    `        name: ${id}`,
    ...(limit === undefined ? [] : [`        max_parallel_runs: ${limit}`]),
  ];
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      "agent_runtime: fake",
      "allow_literal_keys: true",
      "hitl:",
      "  mode: yolo",
      ...(options.reviewRequired ? ["review:", "  mode: required"] : []),
      "providers:",
      "  fake_llm:",
      "    api: openai-completions",
      "    base_url: http://localhost:9/v1",
      "    auth:",
      "      kind: api_key",
      "      value: fake-key",
      "    models:",
      ...model("model-a", options.developerLimit),
      ...model("model-b", options.reviewerLimit),
      "agents:",
      "  architect:",
      "    provider: fake_llm",
      "    model: model-a",
      "  developer:",
      "    provider: fake_llm",
      "    model: model-a",
      ...(options.reviewRequired
        ? ["  reviewer:", "    provider: fake_llm", "    model: model-b"]
        : []),
    ].join("\n"),
    "utf8",
  );
  return path;
}

async function bootFresh(configPath: string): Promise<ColonydHandle> {
  const booted = await bootConfigured(configPath);
  bootedHandles.push(booted);
  return booted;
}

async function bootConfigured(configPath: string): Promise<ColonydHandle> {
  process.env["NODE_ENV"] = "test";
  process.env["AGENT_RUNTIME"] = "fake";
  process.env["GITLAB_TOKEN"] = "";
  process.env["GITLAB_WEBHOOK_SECRET"] = "";
  process.env["COLONYD_DB_PATH"] = join(
    dir,
    `slots-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  // Room for several implement runs: the per-model cap is the only limit.
  process.env["COLONYD_MAX_CONCURRENT"] = "4";
  process.env["COLONYD_MAX_ATTEMPTS"] = "3";
  process.env["COLONY_CONFIG_PATH"] = configPath;
  resetEnvCache();
  return boot({
    provider,
    agents: {
      runtime: "fake",
      architect: fakeAgents(),
      developer: fakeAgents(),
      reviewer: fakeAgents(),
    },
    gateExecutor: (): Promise<GateFailure | null> => Promise.resolve(null),
    validateExecutor: (): Promise<ValidateResult> =>
      Promise.resolve({
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
      }),
    headless: true,
  });
}

/**
 * Boot a daemon against one config and return the whole scenario surface.
 * Each case gets its own config: `boot()` reads `COLONY_CONFIG_PATH` at call
 * time, so the case writes its YAML then boots against it.
 */
async function harness(configPath: string): Promise<{
  settle(): Promise<void>;
  tick(): Promise<void>;
  /** An active scope holding one queued task. */
  activeScopeWithTask(goal: string): {
    readonly scopeId: string;
    readonly taskId: string;
  };
  /** Drive one task to `mr_open`, settling every tick on the way. */
  driveToMrOpen(taskId: string): Promise<void>;
  totalImplementerCalls(): number;
  /** The single implement run holding a slot. */
  theRunningImplement(): Run;
  store: ColonydContext["store"];
}> {
  const booted = await bootFresh(configPath);
  const store = booted.ctx.store;
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 4; round += 1) {
      await awaitPendingRuns();
    }
  };

  /*
   * Planning is materialized directly so the tick under test starts from a
   * clean slate: no architect run of this scenario competes for the slot it
   * asserts on. (Architect and developer share the capped model here, so a
   * planning tick would otherwise consume the very slot under test.)
   */
  const activeScopeWithTask = (
    goal: string,
  ): { readonly scopeId: string; readonly taskId: string } => {
    const scope = store.createScope({
      goal,
      provider_repo_id: repoId,
      provider_repo_path: "so/fake-slots",
    });
    store.audit(ACTOR, "scope.created", { scope_id: scope.id });
    store.setScopeStatus(scope.id, "planning", SERVICE_ACTOR);
    const tasks = store.materializePlan(scope.id, PLAN, SERVICE_ACTOR);
    return { scopeId: scope.id, taskId: tasks[0]!.id };
  };

  const driveToMrOpen = async (taskId: string): Promise<void> => {
    for (let i = 0; i < 10; i += 1) {
      if (store.getTask(taskId)!.state === "mr_open") return;
      await booted.tick();
      await settle();
    }
    throw new Error(`task ${taskId} never reached mr_open`);
  };

  return {
    settle,
    tick: () => booted.tick(),
    activeScopeWithTask,
    driveToMrOpen,
    totalImplementerCalls: () =>
      [...script.implementerCalls.values()].reduce((a, b) => a + b, 0),
    theRunningImplement: () => {
      const runs = store.activeRuns("implement");
      expect(runs).toHaveLength(1);
      return runs[0]!;
    },
    store,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "colonyd-model-slots-"));
});

afterAll(async () => {
  for (const booted of bootedHandles) await booted.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each case boots its own colonyd; retire the previous ones first so their
  // telemetry registrations and tick intervals do not outlive the case.
  for (const booted of bootedHandles.splice(0)) await booted.shutdown();
  script.implementerCalls.clear();
  script.reviewerCalls = 0;
  provider = new FakeProviderAdapter();
  const repo = await provider.repos.create({
    name: "fake-slots",
    path: "so/fake-slots",
  });
  repoId = repo.id;
});

describe("per-model dispatch slots", () => {
  it("caps concurrent implement runs and hands the freed slot to the waiter", async () => {
    const h = await harness(writeConfig("capped.yaml", { developerLimit: 1 }));

    const first = h.activeScopeWithTask("cap A");
    const second = h.activeScopeWithTask("cap B");

    await h.tick();
    expect(h.totalImplementerCalls()).toBe(1);

    const dispatched = h.theRunningImplement();
    const waiterId =
      dispatched.task_id === first.taskId ? second.taskId : first.taskId;

    // The deferred task is untouched: deferral is not a failure.
    const waiter = h.store.getTask(waiterId)!;
    expect(waiter.state).toBe("queued");
    expect(waiter.attempt).toBe(0);
    expect(waiter.next_retry_at).toBeNull();

    // Finish the first run: the freed slot goes to the waiter. (The same two
    // ready tasks dispatch together when no cap is set — case 4.)
    await h.settle();
    expect(h.store.getTask(dispatched.task_id!)!.state).toBe("mr_open");
    await h.tick();
    expect(h.totalImplementerCalls()).toBe(2);
    expect(h.store.getTask(waiterId)!.state).toBe("running");
    await h.settle();
  }, 30_000);

  it("frees a capped slot as soon as the run falls back to another model", async () => {
    const h = await harness(writeConfig("capped.yaml", { developerLimit: 1 }));

    const first = h.activeScopeWithTask("fallback A");
    const second = h.activeScopeWithTask("fallback B");

    await h.tick();
    expect(h.totalImplementerCalls()).toBe(1);
    const dispatched = h.theRunningImplement();
    expect(dispatched.model_id).toBe("model-a");
    const waiterId =
      dispatched.task_id === first.taskId ? second.taskId : first.taskId;

    // pi_model_fallback sink rewrite: the run no longer holds model-a's slot.
    h.store.setRunModel(dispatched.id, "model-b");

    // Same tick — the waiter does not wait for the run to finish.
    await h.tick();
    expect(h.totalImplementerCalls()).toBe(2);
    expect(h.store.getTask(waiterId)!.state).toBe("running");
    await h.settle();
  }, 30_000);

  it("gates review dispatch on the reviewer model's own slot", async () => {
    const h = await harness(
      writeConfig("review.yaml", {
        developerLimit: 1,
        reviewerLimit: 1,
        reviewRequired: true,
      }),
    );

    // Host task at mr_open; a review run we never let finish holds model-b's
    // only slot for the rest of the scenario.
    const host = h.activeScopeWithTask("review host");
    await h.driveToMrOpen(host.taskId);
    const inFlight = h.store.startRun({
      scope_id: host.scopeId,
      task_id: host.taskId,
      kind: "review",
      base_sha: SHA_A,
      lease_ttl_ms: 30 * 60_000,
      model_id: "model-b",
    });
    expect(h.store.activeRunCountByModel("model-b")).toBe(1);

    // A second task at mr_open whose review is due, plus a ready implement
    // task on model-a (whose cap freed when the last implement run landed).
    const underReview = h.activeScopeWithTask("review A");
    await h.driveToMrOpen(underReview.taskId);
    const ready = h.activeScopeWithTask("review B");

    // One tick: the implement run dispatches, the review run does not —
    // model-b is saturated by the host's in-flight review.
    await h.tick();
    expect(h.store.getTask(ready.taskId)!.state).toBe("running");
    expect(script.reviewerCalls).toBe(0);
    expect(
      h.store
        .runsForTask(underReview.taskId)
        .filter((run) => run.kind === "review"),
    ).toHaveLength(0);

    // Free model-b: the next tick dispatches the deferred review.
    h.store.finishRun(inFlight.id, "succeeded", {
      evidence_json: JSON.stringify({ verdict: "approve", head_sha: SHA_A }),
    });
    expect(h.store.activeRunCountByModel("model-b")).toBe(0);

    await h.tick();
    const reviews = h.store
      .runsForTask(underReview.taskId)
      .filter((run) => run.kind === "review");
    expect(reviews).toHaveLength(1);
    await h.settle();
    expect(script.reviewerCalls).toBe(1);
    expect(h.store.getRun(reviews[0]!.id)!.status).toBe("succeeded");
  }, 30_000);

  it("dispatches every ready task when no model cap is configured", async () => {
    const h = await harness(writeConfig("no-limits.yaml"));

    h.activeScopeWithTask("uncapped A");
    h.activeScopeWithTask("uncapped B");

    await h.tick();
    expect(h.totalImplementerCalls()).toBe(2);
    expect(h.store.activeRuns("implement")).toHaveLength(2);
    await h.settle();
  }, 30_000);
});
