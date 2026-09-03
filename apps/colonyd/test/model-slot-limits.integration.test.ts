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
import type { ColonydContext } from "../src/context.js";
import { SERVICE_ACTOR } from "../src/context.js";
import { SANDBOX_QUOTA_EXHAUSTED } from "@colony/sandbox";
import { awaitPendingRuns } from "../src/runs/registry.js";
import type { GateFailure } from "../src/runs/merge-gate.js";
import type { ValidateResult } from "../src/runs/validate.js";

const ACTOR = "human:op-1";
const SHA_A = "a".repeat(40);
/** COLONYD_MAX_ATTEMPTS set by the harness: the attempt/review budget. */
const MAX_ATTEMPTS = 3;

const PLAN: ArchitectDecompositionV2 = {
  kind: "architect_decomposition",
  summary: "Single-task decomposition.",
  requirements: [{ id: "R1", text: "fake goal holds", tasks: [0] }],
  journey: [{ after_task: 0, working_state: "fake goal holds" }],
  acceptance: [{ description: "fake goal holds", command: "true" }],
  tasks: [
    {
      title: "Task A",
      spec: "Do A.",
      depends_on: [],
      files: ["src/a.ts"],
      evidence: ["true"],
    },
  ],
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
  /** Error the developer adapter raises instead of returning an envelope. */
  implementerError: undefined as string | undefined,
  /** Error the reviewer adapter raises instead of returning a verdict. */
  reviewerError: undefined as string | undefined,
  /** Error the architect adapter raises instead of returning a plan. */
  architectError: undefined as string | undefined,
};

function fakeAgents(): FakeAgentRuntimeAdapter {
  return new FakeAgentRuntimeAdapter({
    envelopeForRun: (
      packet: AgentRuntimePacket,
      environment: AgentRunEnvironment,
    ) => {
      if (environment.role === "architect") {
        if (script.architectError !== undefined) {
          throw new Error(script.architectError);
        }
        return PLAN;
      }
      if (environment.role === "reviewer") {
        script.reviewerCalls += 1;
        if (script.reviewerError !== undefined) {
          throw new Error(script.reviewerError);
        }
        return {
          kind: "reviewer_verdict",
          verdict: "approve",
          summary:
            "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
          findings: [],
          inspected: [
            { file: "src/main.ts", note: "checked against the task spec" },
          ],
          head_sha: SHA_A,
        };
      }
      const taskId = String(packet.task_id);
      script.implementerCalls.set(
        taskId,
        (script.implementerCalls.get(taskId) ?? 0) + 1,
      );
      if (script.implementerError !== undefined) {
        throw new Error(script.implementerError);
      }
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
    readonly developerFallback?: boolean;
    readonly developerFallbackLimit?: number;
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
      ...model(
        "model-b",
        options.developerFallbackLimit ?? options.reviewerLimit,
      ),
      "agents:",
      "  architect:",
      "    provider: fake_llm",
      "    model: model-a",
      "  developer:",
      "    provider: fake_llm",
      "    model: model-a",
      ...(options.developerFallback ? ["    fallback_models: [model-b]"] : []),
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
  const booted = await boot({
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
            failures: [],
          },
        ],
      }),
    headless: true,
  });
  bootedHandles.push(booted);
  return booted;
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
  /** A `draft` scope: the next planning tick dispatches its architect run. */
  draftScope(goal: string): string;
  /** A `validating` scope: the next tick dispatches its validate run. */
  validatingScope(goal: string): string;
  totalImplementerCalls(): number;
  store: ColonydContext["store"];
}> {
  const booted = await bootFresh(configPath);
  const store = booted.ctx.store;
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 4; round += 1) {
      await awaitPendingRuns();
    }
  };

  const createScope = (goal: string): string => {
    const scope = store.createScope({
      goal,
      title: goal,
      provider_repo_id: repoId,
      provider_repo_path: "so/fake-slots",
    });
    store.audit(ACTOR, "scope.created", { scope_id: scope.id });
    return scope.id;
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
    const scopeId = createScope(goal);
    store.setScopeStatus(scopeId, "planning", SERVICE_ACTOR);
    const tasks = store.materializePlan(scopeId, PLAN, SERVICE_ACTOR);
    return { scopeId, taskId: tasks[0]!.id };
  };

  const driveToMrOpen = async (taskId: string): Promise<void> => {
    for (let i = 0; i < 10; i += 1) {
      if (store.getTask(taskId)!.state === "mr_open") return;
      await booted.tick();
      await settle();
    }
    throw new Error(`task ${taskId} never reached mr_open`);
  };

  const draftScope = createScope;

  /*
   * A validating scope: its only task is merged, so the tick that closes the
   * scope hands it to the validate phase on the following tick.
   */
  const validatingScope = (goal: string): string => {
    const { scopeId, taskId } = activeScopeWithTask(goal);
    const queued = store.getTask(taskId)!;
    store.transitionTask(queued.id, queued.state_version, "merged", ACTOR);
    return scopeId;
  };

  return {
    settle,
    tick: () => booted.tick(),
    activeScopeWithTask,
    driveToMrOpen,
    draftScope,
    validatingScope,
    totalImplementerCalls: () =>
      [...script.implementerCalls.values()].reduce((a, b) => a + b, 0),
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
  script.implementerError = undefined;
  script.reviewerError = undefined;
  script.architectError = undefined;
  provider = new FakeProviderAdapter();
  const repo = await provider.repos.create({
    name: "fake-slots",
    path: "so/fake-slots",
  });
  repoId = repo.id;
});

/**
 * A quota refusal is a scheduling condition, not a failure: the task must
 * come back with its attempt budget and its eligibility untouched.
 */
describe("namespace quota deferral", () => {
  it("requeues a quota-refused task with its attempt untouched and no backoff", async () => {
    const h = await harness(writeConfig("no-limits.yaml"));
    const { taskId } = h.activeScopeWithTask("quota refused");

    // The engine never got its sandbox: the namespace ResourceQuota refused
    // the CR, so the run fails fast carrying the marker.
    script.implementerError = `${SANDBOX_QUOTA_EXHAUSTED}: request did not admit (namespace colony-sandboxes)`;

    await h.tick();
    await h.settle();
    const failed = h.store
      .runsForTask(taskId)
      .find((run) => run.kind === "implement")!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain(SANDBOX_QUOTA_EXHAUSTED);

    // No backoff means the very next tick both requeues and redispatches:
    // the task never sits still waiting for capacity to return.
    script.implementerError = undefined;
    await h.tick();
    const task = h.store.getTask(taskId)!;
    expect(task.attempt).toBe(0);
    expect(task.next_retry_at).toBeNull();
    expect(script.implementerCalls.get(taskId)).toBe(2);

    // The requeue still happened: it is in the audit trail even though the
    // same tick handed the task straight back to the developer.
    const requeued = h.store
      .listAudit({ task_id: taskId, limit: 1000 })
      .events.some((row) => {
        const detail = JSON.parse(row.detail_json) as {
          from?: string;
          to?: string;
        };
        return (
          row.action === "task.transition" &&
          detail.from === "running" &&
          detail.to === "queued"
        );
      });
    expect(requeued).toBe(true);
    await h.settle();
  }, 30_000);

  it("still charges an attempt for a failure that is not a quota refusal", async () => {
    const h = await harness(writeConfig("no-limits.yaml"));
    const { taskId } = h.activeScopeWithTask("agent failure");

    script.implementerError = "envelope invalid";

    await h.tick();
    await h.settle();
    await h.tick();
    const task = h.store.getTask(taskId)!;
    expect(task.state).toBe("queued");
    expect(task.attempt).toBe(1);
    expect(task.next_retry_at).toBeTruthy();
    await h.settle();
  }, 30_000);

  // The k8s engine is shared by every role, so a saturated cluster refuses
  // architect and review runs too — and both keep their own failure budget.
  it("never exhausts the architect budget on quota refusals", async () => {
    const h = await harness(writeConfig("no-limits.yaml"));
    const scopeId = h.draftScope("refused planning");
    script.architectError = `${SANDBOX_QUOTA_EXHAUSTED}: request did not admit (namespace colony-sandboxes)`;

    // More refusals than the budget allows: three non-quota failures would
    // have blocked the scope by now.
    for (let i = 0; i < MAX_ATTEMPTS + 1; i += 1) {
      await h.tick();
      await h.settle();
    }

    expect(h.store.getScope(scopeId)!.status).toBe("planning");
    expect(h.store.getScope(scopeId)!.blocked_reason).toBeNull();
  }, 30_000);

  it("never blocks an mr_open task on quota-refused review runs", async () => {
    const h = await harness(
      writeConfig("review.yaml", { reviewRequired: true }),
    );
    const { taskId } = h.activeScopeWithTask("refused review");
    await h.driveToMrOpen(taskId);
    script.reviewerError = `${SANDBOX_QUOTA_EXHAUSTED}: request did not admit (namespace colony-sandboxes)`;

    // More refusals than the review budget allows: three real review
    // failures would have blocked the task by now.
    for (let i = 0; i < MAX_ATTEMPTS + 1; i += 1) {
      await h.tick();
      await h.settle();
    }

    expect(h.store.getTask(taskId)!.state).toBe("mr_open");
    // Clearing the refusal lets the review through: the task was deferred,
    // never condemned.
    script.reviewerError = undefined;
    await h.tick();
    await h.settle();
    expect(script.reviewerCalls).toBeGreaterThan(0);
    expect(h.store.getTask(taskId)!.state).toBe("mr_open");
  }, 30_000);
});

describe("per-model dispatch slots", () => {
  it("overflows a capped primary to the first fallback with capacity", async () => {
    const h = await harness(
      writeConfig("capped.yaml", {
        developerLimit: 1,
        developerFallback: true,
      }),
    );
    h.activeScopeWithTask("cap A");
    h.activeScopeWithTask("cap B");

    await h.tick();
    expect(h.totalImplementerCalls()).toBe(2);
    expect(h.store.activeRuns("implement")).toHaveLength(2);
    expect(h.store.activeRuns("implement").map((run) => run.model_id)).toEqual([
      "model-a",
      "model-b",
    ]);
    await h.settle();
  }, 30_000);

  it("defers when every model in the chain is capped", async () => {
    const h = await harness(
      writeConfig("all-capped.yaml", {
        developerLimit: 1,
        developerFallback: true,
        developerFallbackLimit: 1,
      }),
    );
    const primaryHolder = h.activeScopeWithTask("primary holder");
    const fallbackHolder = h.activeScopeWithTask("fallback holder");
    h.store.startRun({
      scope_id: primaryHolder.scopeId,
      task_id: primaryHolder.taskId,
      kind: "implement",
      lease_ttl_ms: 30 * 60_000,
      model_id: "model-a",
    });
    h.store.startRun({
      scope_id: fallbackHolder.scopeId,
      task_id: fallbackHolder.taskId,
      kind: "implement",
      lease_ttl_ms: 30 * 60_000,
      model_id: "model-b",
    });
    const waiter = h.activeScopeWithTask("all models capped");

    await h.tick();
    expect(h.totalImplementerCalls()).toBe(0);
    expect(h.store.runsForTask(waiter.taskId)).toHaveLength(0);
    const task = h.store.getTask(waiter.taskId)!;
    expect(task.state).toBe("queued");
    expect(task.attempt).toBe(0);
    expect(task.next_retry_at).toBeNull();
  }, 30_000);

  it("frees the primary slot when a run is rewritten to its fallback model", async () => {
    const h = await harness(
      writeConfig("capped-chain.yaml", {
        developerLimit: 1,
        developerFallback: true,
        developerFallbackLimit: 1,
      }),
    );
    const primaryHolder = h.activeScopeWithTask("primary holder");
    const fallbackHolder = h.activeScopeWithTask("fallback holder");
    for (const holder of [primaryHolder, fallbackHolder]) {
      const task = h.store.getTask(holder.taskId)!;
      h.store.transitionTask(
        task.id,
        task.state_version,
        "running",
        SERVICE_ACTOR,
      );
    }
    h.store.startRun({
      scope_id: primaryHolder.scopeId,
      task_id: primaryHolder.taskId,
      kind: "implement",
      lease_ttl_ms: 30 * 60_000,
      model_id: "model-a",
    });
    h.store.startRun({
      scope_id: fallbackHolder.scopeId,
      task_id: fallbackHolder.taskId,
      kind: "implement",
      lease_ttl_ms: 30 * 60_000,
      model_id: "model-b",
    });
    const waiter = h.activeScopeWithTask("fallback waiter");

    await h.tick();
    expect(h.totalImplementerCalls()).toBe(0);
    expect(h.store.getTask(waiter.taskId)!.state).toBe("queued");

    const primary = h.store
      .runsForScope(primaryHolder.scopeId)
      .find((run) => run.kind === "implement")!;
    // A pi_model_fallback sink rewrite moves the run off model-a, releasing
    // that model's slot even though the run remains active.
    h.store.setRunModel(primary.id, "model-b");
    await h.tick();
    expect(h.totalImplementerCalls()).toBe(1);
    const waiterRun = h.store
      .runsForTask(waiter.taskId)
      .find((run) => run.kind === "implement")!;
    expect(waiterRun.model_id).toBe("model-a");
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

  it("defers architect and validate dispatch, never the paths that spend no model slot", async () => {
    const h = await harness(writeConfig("capped.yaml", { developerLimit: 1 }));

    // Occupy model-a's only slot: architect and validate key off the same
    // model as the developer in this config.
    const holder = h.draftScope("holds model-a");
    h.store.startRun({
      scope_id: holder,
      kind: "architect",
      lease_ttl_ms: 30 * 60_000,
      model_id: "model-a",
    });
    expect(h.store.activeRunCountByModel("model-a")).toBe(1);

    const draft = h.draftScope("deferred planning");
    const validating = h.validatingScope("deferred validation");
    // A planning scope whose architect run already landed: the tick that
    // materializes the approved plan spends no model slot.
    const replanScope = h.draftScope("ready to materialize");
    const landed = h.store.startRun({
      scope_id: replanScope,
      kind: "architect",
      lease_ttl_ms: 30 * 60_000,
      model_id: "model-a",
    });
    h.store.finishRun(landed.id, "succeeded", {
      envelope_json: JSON.stringify(PLAN),
    });
    h.store.setScopeStatus(replanScope, "planning", SERVICE_ACTOR);
    h.store.setScopePlan(replanScope, JSON.stringify(PLAN));

    await h.tick();

    // Deferred: both model-backed dispatches wait for a free slot.
    expect(h.store.getScope(draft)!.status).toBe("draft");
    expect(
      h.store.runsForScope(draft).filter((run) => run.kind === "architect"),
    ).toHaveLength(0);
    expect(h.store.getScope(validating)!.status).toBe("validating");
    expect(
      h.store.runsForScope(validating).filter((run) => run.kind === "validate"),
    ).toHaveLength(0);

    // Not deferred: materializing an approved plan spends no model slot, so
    // a saturated model must not stall the pipeline behind it.
    expect(h.store.getScope(replanScope)!.status).toBe("active");
    expect(h.store.listTasks(replanScope)).toHaveLength(1);

    // Free the slot: both deferred dispatches go out on the next tick.
    const holding = h.store
      .runsForScope(holder)
      .find((run) => run.kind === "architect")!;
    h.store.finishRun(holding.id, "failed", { error: "fixture release" });
    // Retire the holder: it is still `draft`, so the planning phase would
    // hand it the slot the scenario just freed.
    h.store.setScopeStatus(holder, "abandoned", SERVICE_ACTOR);
    expect(h.store.activeRunCountByModel("model-a")).toBe(0);

    await h.tick();
    expect(
      h.store.runsForScope(draft).filter((run) => run.kind === "architect"),
    ).toHaveLength(1);
    expect(
      h.store.runsForScope(validating).filter((run) => run.kind === "validate"),
    ).toHaveLength(1);
    await h.settle();
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
