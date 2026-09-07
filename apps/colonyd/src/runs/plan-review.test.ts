import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ColonyConfig } from "@colony/config";
import { FakeAgentRuntimeAdapter } from "@colony/agent-runtime";
import { createLocalArtifactStore, Store, type Fault } from "@colony/core";
import { FakeProviderAdapter } from "@colony/provider";
import type { ColonydContext } from "../context.js";
import { awaitPendingRuns } from "./registry.js";
import {
  planHash,
  runPlanReview,
  timedOutPlanReviewModelIds,
} from "./plan-review.js";

const PLAN = {
  kind: "architect_decomposition" as const,
  summary: "one task",
  requirements: [{ id: "R1", text: "req", tasks: [0] }],
  journey: [{ after_task: 0, working_state: "state" }],
  acceptance: [{ description: "ok", command: "true" }],
  tasks: [
    {
      title: "t",
      spec: "do t",
      depends_on: [],
      files: ["src/a.ts"],
      evidence: ["true"],
    },
  ],
};

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await awaitPendingRuns();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  readonly ctx: ColonydContext;
  readonly store: Store;
  readonly scopeId: string;
  readonly architectRunId: string;
}

function fixture(
  /** What the plan-review runner returns instead of a verdict. */
  failure: { readonly reason: string; readonly fault?: Fault } | undefined,
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "plan-review-timeout-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  const provider = new FakeProviderAdapter();
  const scope = store.createScope({
    goal: "plan review timeout",
    title: "plan review timeout",
    provider_repo_id: "repo-1",
    provider_repo_path: "so/plan-review",
  });
  store.setScopeStatus(scope.id, "planning", "test");
  store.setScopePlan(scope.id, JSON.stringify(PLAN));
  const architect = store.startRun({
    scope_id: scope.id,
    kind: "architect",
    lease_ttl_ms: 60_000,
  });
  const planReviewer = new FakeAgentRuntimeAdapter({
    failureForRun: () => failure,
  });
  const artifacts = mkdtempSync(join(tmpdir(), "plan-review-artifacts-"));
  dirs.push(artifacts);
  return {
    store,
    scopeId: scope.id,
    architectRunId: architect.id,
    ctx: {
      store,
      provider,
      config: {
        forAgent: () => ({
          role: "plan_reviewer",
          providerKey: "fake_llm",
          api: "openai-completions",
          model: { id: "model-a", name: "model-a" },
          fallbackModels: [],
          auth: { kind: "api_key", apiKey: "fake-key" },
          ceilings: { timeoutMs: 60_000, maxTurns: 20 },
        }),
        modelParallelLimit: () => null,
      } as unknown as ColonyConfig,
      agents: {
        runtime: "fake",
        architect: new FakeAgentRuntimeAdapter(),
        developer: new FakeAgentRuntimeAdapter(),
        reviewer: new FakeAgentRuntimeAdapter(),
        planReviewer,
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

/** The ids the tick would exclude from redispatch at this plan. */
function exclusions(f: Fixture): readonly string[] {
  return timedOutPlanReviewModelIds(
    f.ctx,
    f.scopeId,
    JSON.stringify(PLAN),
    f.architectRunId,
  );
}

describe("plan review timeout exclusion", () => {
  it("excludes the model whose wall timeout carried a timeout fault", async () => {
    const f = fixture({
      reason: "wall_timeout",
      fault: { layer: "model", code: "wall_timeout" },
    });
    await runPlanReview(f.ctx, f.store.getScope(f.scopeId)!, PLAN, 1);

    expect(exclusions(f)).toEqual(["model-a"]);
  });

  it("keeps the exclusion when the runner forwards the fault", async () => {
    // The regression this pins: the startRun-failed path used to drop
    // metadata.fault, so a wall timeout stored only its reason, the
    // exclusion list came back empty, and the same model was redispatched
    // instead of falling back. Production always pairs this reason with a
    // fault (pi-runner-common.ts); the producer must not lose it.
    const f = fixture({
      reason: "wall_timeout",
      fault: { layer: "model", code: "wall_timeout" },
    });
    await runPlanReview(f.ctx, f.store.getScope(f.scopeId)!, PLAN, 1);

    const run = f.store
      .runsForScope(f.scopeId)
      .find((r) => r.kind === "plan_review")!;
    expect(run.error).toBe("wall_timeout");
    expect(exclusions(f)).toEqual(["model-a"]);
  });

  it("leaves a genuinely faultless failure unexcluded", async () => {
    // A runner result with no fault at all is unclassified, not a timeout:
    // it must not exclude the model, and it must audit run.fault_unknown.
    const f = fixture({ reason: "wall_timeout" });
    await runPlanReview(f.ctx, f.store.getScope(f.scopeId)!, PLAN, 1);

    expect(exclusions(f)).toEqual([]);
    const audit = f.store
      .listAudit({ scope_id: f.scopeId, limit: 100 })
      .events.map((row) => row.action);
    expect(audit).toContain("run.fault_unknown");
  });

  it("does not exclude a model that failed without a timeout", async () => {
    const f = fixture({
      reason: "boom",
      fault: { layer: "sandbox", code: "workspace_lost" },
    });
    await runPlanReview(f.ctx, f.store.getScope(f.scopeId)!, PLAN, 1);

    expect(exclusions(f)).toEqual([]);
  });

  it("stores a fault the consumer can read back", async () => {
    const f = fixture({
      reason: "wall_timeout",
      fault: { layer: "model", code: "wall_timeout" },
    });
    await runPlanReview(f.ctx, f.store.getScope(f.scopeId)!, PLAN, 1);

    const run = f.store
      .runsForScope(f.scopeId)
      .find((r) => r.kind === "plan_review")!;
    expect(JSON.parse(run.fault_json!)).toMatchObject({
      layer: "model",
      code: "wall_timeout",
    });
    expect(JSON.parse(run.evidence_json!).plan_hash).toBe(
      planHash(JSON.stringify(PLAN)),
    );
  });
});
