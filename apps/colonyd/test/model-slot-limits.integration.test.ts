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
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import { boot, type ColonydHandle } from "../src/main.js";
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
let handle: ColonydHandle;

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

/** Reboot the daemon against another config, same fake provider. */
async function reboot(configPath: string): Promise<void> {
  await handle?.shutdown();
  handle = await bootFresh(configPath);
}

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await awaitPendingRuns();
  }
}

/**
 * An active scope with one queued task. Planning is materialized directly so
 * the tick under test starts from a clean slate: no architect run of our own
 * competes for the slot the scenario asserts on.
 */
function activeScopeWithTask(goal: string): {
  readonly scopeId: string;
  readonly taskId: string;
} {
  const scope = handle.ctx.store.createScope({
    goal,
    provider_repo_id: repoId,
    provider_repo_path: "so/fake-slots",
  });
  handle.ctx.store.audit(ACTOR, "scope.created", { scope_id: scope.id });
  handle.ctx.store.setScopeStatus(scope.id, "planning", SERVICE_ACTOR);
  const tasks = handle.ctx.store.materializePlan(scope.id, PLAN, SERVICE_ACTOR);
  return { scopeId: scope.id, taskId: tasks[0]!.id };
}

/**
 * Drive one task to `mr_open`: `queued -> running -> mr_open` takes two
 * ticks (dispatch, then the run's own transitions), and an approval-gated
 * merge never fires while review is required.
 */
async function driveToMrOpen(taskId: string): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if (handle.ctx.store.getTask(taskId)!.state === "mr_open") return;
    await handle.tick();
    await settle();
  }
  throw new Error(`task ${taskId} never reached mr_open`);
}

function totalImplementerCalls(): number {
  return [...script.implementerCalls.values()].reduce((a, b) => a + b, 0);
}

/** The single implement run holding a slot. */
function theRunningImplement() {
  const runs = handle.ctx.store.activeRuns("implement");
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "colonyd-model-slots-"));
});

afterAll(async () => {
  await handle?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle?.shutdown();
  script.implementerCalls.clear();
  script.reviewerCalls = 0;
  provider = new FakeProviderAdapter();
  const repo = await provider.repos.create({
    name: "fake-slots",
    path: "so/fake-slots",
  });
  repoId = repo.id;
  handle = await bootFresh(writeConfig("no-limits.yaml"));
});

describe("per-model dispatch slots", () => {
  it("caps concurrent implement runs and hands the freed slot to the waiter", async () => {
    await reboot(writeConfig("capped.yaml", { developerLimit: 1 }));

    const first = activeScopeWithTask("cap A");
    const second = activeScopeWithTask("cap B");

    await handle.tick();
    expect(totalImplementerCalls()).toBe(1);

    const dispatched = theRunningImplement();
    const waiterId =
      dispatched.task_id === first.taskId ? second.taskId : first.taskId;

    // The deferred task is untouched: deferral is not a failure.
    const waiter = handle.ctx.store.getTask(waiterId)!;
    expect(waiter.state).toBe("queued");
    expect(waiter.attempt).toBe(0);
    expect(waiter.next_retry_at).toBeNull();

    // Finish the first run: the freed slot goes to the waiter. (The same
    // two ready tasks dispatch together when no cap is set — case 4.)
    await settle();
    expect(handle.ctx.store.getTask(dispatched.task_id!)!.state).toBe(
      "mr_open",
    );
    await handle.tick();
    expect(totalImplementerCalls()).toBe(2);
    expect(handle.ctx.store.getTask(waiterId)!.state).toBe("running");
    await settle();
  }, 30_000);

  it("frees a capped slot as soon as the run falls back to another model", async () => {
    await reboot(writeConfig("capped.yaml", { developerLimit: 1 }));

    const first = activeScopeWithTask("fallback A");
    const second = activeScopeWithTask("fallback B");

    await handle.tick();
    expect(totalImplementerCalls()).toBe(1);
    const dispatched = theRunningImplement();
    expect(dispatched.model_id).toBe("model-a");
    const waiterId =
      dispatched.task_id === first.taskId ? second.taskId : first.taskId;

    // pi_model_fallback sink rewrite: the run no longer holds model-a's slot.
    handle.ctx.store.setRunModel(dispatched.id, "model-b");

    // Same tick — the waiter does not wait for the run to finish.
    await handle.tick();
    expect(totalImplementerCalls()).toBe(2);
    expect(handle.ctx.store.getTask(waiterId)!.state).toBe("running");
    await settle();
  }, 30_000);

  it("gates review dispatch on the reviewer model's own slot", async () => {
    await reboot(
      writeConfig("review.yaml", {
        developerLimit: 1,
        reviewerLimit: 1,
        reviewRequired: true,
      }),
    );

    // Host task at mr_open; a review run we never let finish holds
    // model-b's only slot for the rest of the scenario.
    const host = activeScopeWithTask("review host");
    await driveToMrOpen(host.taskId);
    const inFlight = handle.ctx.store.startRun({
      scope_id: host.scopeId,
      task_id: host.taskId,
      kind: "review",
      base_sha: SHA_A,
      lease_ttl_ms: 30 * 60_000,
      model_id: "model-b",
    });
    expect(handle.ctx.store.activeRunCountByModel("model-b")).toBe(1);

    // A second task at mr_open whose review is due, plus a ready implement
    // task on model-a (whose cap freed when the last implement run landed).
    const underReview = activeScopeWithTask("review A");
    await driveToMrOpen(underReview.taskId);
    const ready = activeScopeWithTask("review B");

    // One tick: the implement run dispatches, the review run does not —
    // model-b is saturated by the host's in-flight review.
    await handle.tick();
    expect(handle.ctx.store.getTask(ready.taskId)!.state).toBe("running");
    expect(script.reviewerCalls).toBe(0);
    expect(
      handle.ctx.store
        .runsForTask(underReview.taskId)
        .filter((run) => run.kind === "review"),
    ).toHaveLength(0);

    // Free model-b: the next tick dispatches the deferred review.
    handle.ctx.store.finishRun(inFlight.id, "succeeded", {
      evidence_json: JSON.stringify({ verdict: "approve", head_sha: SHA_A }),
    });
    expect(handle.ctx.store.activeRunCountByModel("model-b")).toBe(0);

    await handle.tick();
    const reviews = handle.ctx.store
      .runsForTask(underReview.taskId)
      .filter((run) => run.kind === "review");
    expect(reviews).toHaveLength(1);
    await settle();
    expect(script.reviewerCalls).toBe(1);
    expect(handle.ctx.store.getRun(reviews[0]!.id)!.status).toBe(
      "succeeded",
    );
  }, 30_000);

  it("dispatches every ready task when no model cap is configured", async () => {
    await reboot(writeConfig("no-limits.yaml"));

    activeScopeWithTask("uncapped A");
    activeScopeWithTask("uncapped B");

    await handle.tick();
    expect(totalImplementerCalls()).toBe(2);
    expect(handle.ctx.store.activeRuns("implement")).toHaveLength(2);
    await settle();
  }, 30_000);
});
