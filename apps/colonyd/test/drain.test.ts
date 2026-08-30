import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ColonyConfig } from "@colony/config";
import { createLocalArtifactStore, Store } from "@colony/core";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import { FakeProviderAdapter } from "@colony/provider";
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import type { ColonydContext } from "../src/context.js";
import { createDrainController, type DrainDeps } from "../src/drain.js";
import { buildApp } from "../src/http.js";
import { awaitPendingRuns } from "../src/runs/registry.js";
import { tick } from "../src/tick.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Drain controller (virtual clock — never waits real milliseconds)
// ---------------------------------------------------------------------------

interface VirtualDeps extends DrainDeps {
  /** Virtual clock reading, for assertions. */
  readonly time: () => number;
  /** Batches passed to abortAll, for exactly-once assertions. */
  readonly abortedBatches: (readonly string[])[];
}

/**
 * Virtual-clock deps. Each sleep advances `pollMs` of virtual time; the
 * `settlePerPoll` hook decides whether runs leave the registry (default:
 * one run settles per poll, mimicking the registry draining).
 */
function virtualDeps(
  init: { readonly ids?: string[]; readonly timeoutMs?: number } = {},
): VirtualDeps & { readonly settlePerPoll: (on: boolean) => void } {
  const ids = [...(init.ids ?? [])];
  const abortedBatches: (readonly string[])[] = [];
  let clock = 0;
  let settleRuns = true;
  const deps: VirtualDeps & { settlePerPoll(on: boolean): void } = {
    now: () => clock,
    time: () => clock,
    sleep: async () => {
      clock += deps.pollMs;
      if (settleRuns) ids.shift();
    },
    pollMs: 10,
    timeoutMs: init.timeoutMs ?? 100,
    activeRunIds: () => [...ids],
    abortAll: async (batch) => {
      abortedBatches.push([...batch]);
      ids.splice(0);
    },
    awaitSettled: async () => {},
    abortedBatches,
    settlePerPoll(on) {
      settleRuns = on;
    },
  };
  return deps;
}

const PLAN: ArchitectDecompositionV2 = {
  kind: "architect_decomposition",
  summary: "one task",
  acceptance: [{ description: "ok", command: "true" }],
  tasks: [{ title: "t", spec: "s", depends_on: [] }],
};

/** Store seeded with a planning scope carrying a queued task. */
function seededStore(): { store: Store; taskId: string } {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-drain-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  const scope = store.createScope({
    goal: "drain gate",
    provider_repo_id: "1",
    provider_repo_path: "fake/repo",
  });
  store.setScopeStatus(scope.id, "planning", "svc:colonyd");
  const [task] = store.materializePlan(scope.id, PLAN, "svc:colonyd");
  return { store, taskId: task.id };
}

/** Offline colonyd context over fakes; every dispatch settles instantly. */
async function offlineCtx(
  store: Store,
  isDraining: () => boolean,
): Promise<ColonydContext> {
  const config = {
    agentRuntime: "fake",
    sandbox: { engine: "in-process", kubernetes: {} },
    hitlMode: "yolo",
    reviewMode: "off",
    artifacts: { kind: "local", local: { dir: "data/artifacts" } },
    oauthProviderKeys: [],
    forAgent: () => ({
      role: "developer",
      providerKey: "fake_llm",
      api: "openai-completions",
      model: { id: "fake-model", name: "fake-model" },
      fallbackModels: [],
      auth: { kind: "api_key", apiKey: "fake-key" },
      ceilings: { timeoutMs: 60_000, maxTurns: 400 },
    }),
  } as unknown as ColonyConfig;
  const agents = new FakeAgentRuntimeAdapter({
    envelopeForRun: (packet, environment) =>
      environment.role === "architect"
        ? PLAN
        : {
            kind: "implementer_completion",
            status: "complete",
            summary: "done",
            branch: `colony/${String(packet.task_id)}`,
            head_sha: "a".repeat(40),
            commands: [{ cmd: "true", exit_code: 0 }],
          },
  });
  const provider = new FakeProviderAdapter();
  const repo = await provider.repos.create({
    name: "repo",
    path: "fake/repo",
  });
  await provider.branches.create(
    { id: repo.id, path: "fake/repo" },
    "main",
    "m".repeat(40),
  );
  const artifactsDir = mkdtempSync(join(tmpdir(), "colonyd-drain-art-"));
  dirs.push(artifactsDir);
  return {
    store,
    provider,
    config,
    agents: { runtime: "fake", architect: agents, developer: agents },
    artifacts: createLocalArtifactStore(join(artifactsDir, "out")),
    logger: { info() {}, warn() {}, error() {} },
    env: {
      gitlabBaseUrl: "https://gitlab.example.com",
      gitlabToken: "fallback-token",
      webhookSecret: "",
      singleToken: true,
      maxConcurrent: 2,
      maxAttempts: 3,
      oidcIssuer: "",
      oidcClientId: "colony",
      oidcRequiredRole: "",
      traceUiBaseUrl: "",
    },
    requestTick() {},
    validateExecutor: async () => ({
      results: [
        {
          index: 0,
          description: "ok",
          command: "true",
          exit_code: 0,
          tail: [],
        },
      ],
      passed: true,
    }),
    draining: { isDraining },
  };
}

describe("createDrainController", () => {
  it("resolves 'drained' immediately with zero active runs (never sleeps, never aborts)", async () => {
    const deps = virtualDeps();
    let sleeps = 0;
    const controller = createDrainController({
      ...deps,
      sleep: async (ms) => {
        sleeps += 1;
        await deps.sleep(ms);
      },
    });
    controller.beginDrain();
    expect(await controller.wait()).toBe("drained");
    expect(sleeps).toBe(0);
    expect(deps.abortedBatches).toEqual([]);
  });

  it("returns 'drained' when runs settle before the cap; abortAll never called", async () => {
    const deps = virtualDeps({ ids: ["run-1", "run-2", "run-3"] });
    const controller = createDrainController(deps);
    controller.beginDrain();
    // One run settles per poll; the registry empties before the cap (100).
    expect(await controller.wait()).toBe("drained");
    expect(deps.abortedBatches).toEqual([]);
  });

  it("returns 'aborted' at the cap, calling abortAll exactly once with the surviving ids", async () => {
    const deps = virtualDeps({ ids: ["run-a", "run-b"] });
    deps.settlePerPoll(false); // runs never settle
    const controller = createDrainController(deps);
    controller.beginDrain();
    expect(await controller.wait()).toBe("aborted");
    expect(deps.time()).toBe(100); // stopped at the cap, not beyond
    expect(deps.abortedBatches).toEqual([["run-a", "run-b"]]);
  });

  it("flips isDraining synchronously in beginDrain()", () => {
    const controller = createDrainController(virtualDeps());
    expect(controller.isDraining()).toBe(false);
    controller.beginDrain();
    expect(controller.isDraining()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tick dispatch gate while draining: observed through the run rows the real
// handlers create (the spec's dispatch-gate assertion, not timing).
// ---------------------------------------------------------------------------

describe("tick dispatch gate while draining", () => {
  it("dispatches queued implement work when not draining (baseline)", async () => {
    const { store, taskId } = seededStore();
    const ctx = await offlineCtx(store, () => false);
    await tick(ctx);
    await awaitPendingRuns();
    // The implement dispatch happened: a run row exists for the task.
    expect(store.getTask(taskId)!.state).toBe("running");
    expect(store.runsForTask(taskId).length).toBe(1);
  });

  it("no phase dispatches a new run while draining", async () => {
    const { store, taskId } = seededStore();
    const ctx = await offlineCtx(store, () => true);
    const before = store.db.prepare("SELECT COUNT(*) n FROM runs").get() as {
      n: number;
    };
    await tick(ctx);
    await awaitPendingRuns();
    // Task untouched, zero run rows created across every phase.
    expect(store.getTask(taskId)!.state).toBe("queued");
    expect(
      (store.db.prepare("SELECT COUNT(*) n FROM runs").get() as { n: number })
        .n,
    ).toBe(before.n);
  });
});

// ---------------------------------------------------------------------------
// /ready readiness endpoint
// ---------------------------------------------------------------------------

describe("GET /ready", () => {
  it("is 200 {ok:true} before drain and 503 {ok:false,draining:true} after; /health stays 200", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-drain-http-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const gate = { draining: false };
    const app = buildApp(await offlineCtx(store, () => gate.draining));

    const before = await app.request("/ready");
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ ok: true });

    const healthBefore = await app.request("/health");
    expect(healthBefore.status).toBe(200);
    expect(await healthBefore.json()).toEqual({ ok: true, service: "colonyd" });

    gate.draining = true; // beginDrain()

    const during = await app.request("/ready");
    expect(during.status).toBe(503);
    expect(await during.json()).toEqual({ ok: false, draining: true });

    const healthDuring = await app.request("/health");
    expect(healthDuring.status).toBe(200);
    expect(await healthDuring.json()).toEqual({ ok: true, service: "colonyd" });
  });
});
