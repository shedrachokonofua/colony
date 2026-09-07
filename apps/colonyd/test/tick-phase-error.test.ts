import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ColonyConfig } from "@colony/config";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import { createLocalArtifactStore, Store } from "@colony/core";
import { FakeProviderAdapter } from "@colony/provider";
import type { ColonydContext } from "../src/context.js";
import { awaitPendingRuns, trackRun } from "../src/runs/registry.js";
import { tick } from "../src/tick.js";

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await awaitPendingRuns();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(): { ctx: ColonydContext; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-tick-error-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  const config = {
    reviewMode: "off",
    hitlMode: "yolo",
    forAgent: () => ({
      role: "developer",
      providerKey: "fake_llm",
      api: "openai-completions",
      model: { id: "dev-model", name: "dev-model" },
      fallbackModels: [],
      auth: { kind: "api_key", apiKey: "fake-key" },
      ceilings: { timeoutMs: 60_000, maxTurns: 20 },
    }),
    modelParallelLimit: () => null,
  } as unknown as ColonyConfig;
  const artifacts = mkdtempSync(
    join(tmpdir(), "colonyd-tick-error-artifacts-"),
  );
  dirs.push(artifacts);
  return {
    store,
    ctx: {
      store,
      provider: new FakeProviderAdapter(),
      config,
      agents: {
        runtime: "fake",
        architect: new FakeAgentRuntimeAdapter(),
        developer: new FakeAgentRuntimeAdapter(),
        reviewer: new FakeAgentRuntimeAdapter(),
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
    },
  };
}

/** A `running` implement row with no in-process handler: nobody owns it. */
function seedUnownedRun(store: Store): string {
  const scope = store.createScope({
    goal: "tick error scope",
    title: "tick error scope",
    provider_repo_id: "repo-1",
    provider_repo_path: "so/tick-error",
    default_branch: "main",
  });
  store.setScopeStatus(scope.id, "planning", "test");
  store.setScopeStatus(scope.id, "active", "test");
  return store.startRun({
    scope_id: scope.id,
    kind: "implement",
    lease_ttl_ms: 30 * 60_000,
    model_id: "dev-model",
  }).id;
}

/** Make the first tick phase throw. Only listScopes breaks, so the sweep
 *  that follows (activeRuns/finishRun/audit) still works. */
function breakFirstPhase(store: Store): void {
  let calls = 0;
  const original = store.listScopes.bind(store);
  store.listScopes = () => {
    calls += 1;
    if (calls === 1) throw new Error("scope list exploded");
    return original();
  };
}

describe("tick phase errors", () => {
  it("fails an unowned running run with the colonyd tick_error fault", async () => {
    const { ctx, store } = harness();
    const runId = seedUnownedRun(store);
    breakFirstPhase(store);

    await tick(ctx);

    const run = store.getRun(runId)!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("tick_error");
    expect(JSON.parse(run.fault_json!)).toMatchObject({
      layer: "colonyd",
      code: "tick_error",
    });
  });

  it("leaves a run a live handler still owns alone", async () => {
    const { ctx, store } = harness();
    const runId = seedUnownedRun(store);
    // A tracked run has an owner that will record its own outcome; the tick
    // must not pre-empt it. Settled in a finally so the afterEach drain does
    // not wait on a handler that is deliberately still in flight.
    const { promise, resolve } = Promise.withResolvers<void>();
    trackRun(runId, promise, () => {});
    breakFirstPhase(store);

    try {
      await tick(ctx);
      expect(store.getRun(runId)!.status).toBe("running");
    } finally {
      resolve();
    }
  });
});
