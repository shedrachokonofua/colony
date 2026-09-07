import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeAgentRuntimeAdapter,
  type AgentRunEnvironment,
  type AgentRuntimePacket,
} from "@colony/agent-runtime";
import { FakeProviderAdapter } from "@colony/provider";
import { Store, createLocalArtifactStore } from "@colony/core";
import { tick } from "../src/tick.js";
import { awaitPendingRuns } from "../src/runs/registry.js";
import type { ColonydContext } from "../src/context.js";
import type { ColonyConfig } from "@colony/config";
import type { ArchitectDecompositionV2 } from "@colony/schemas";

const SHA_BASE = "0".repeat(40);
const SHA_MAIN = "f".repeat(40);

const PLAN: ArchitectDecompositionV2 = {
  kind: "architect_decomposition",
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

describe("CI repair loop integration", () => {
  let dirs: string[];
  let store: Store;
  let provider: FakeProviderAdapter;
  let ctx: ColonydContext;
  let pushCounter = 0;

  let repo: { id: string; path: string };

  beforeEach(async () => {
    dirs = [];
    const dir = mkdtempSync(join(tmpdir(), "colony-ci-repair-loop-"));
    dirs.push(dir);
    store = new Store(join(dir, "colonyd.db"));
    provider = new FakeProviderAdapter();
    pushCounter = 0;
    repo = await provider.repos.create({
      name: "test-repo",
      path: "test/repo-1",
    });

    const runtime = new FakeAgentRuntimeAdapter({
      envelopeForRun: (
        _packet: AgentRuntimePacket,
        _env: AgentRunEnvironment,
      ) => {
        pushCounter += 1;
        const newSha = pushCounter.toString(16).padStart(40, "a");
        void provider.branches.create(
          { id: repo.id, path: repo.path },
          "colony/task-repair-loop",
          newSha,
        );
        return {
          kind: "implementer_completion",
          status: "complete",
          summary: `repair attempt ${pushCounter} pushing ${newSha}`,
          branch: "colony/task-repair-loop",
          head_sha: newSha,
          commands: [{ cmd: "bun test", exit_code: 0 }],
        };
      },
    });

    const artifacts = mkdtempSync(join(tmpdir(), "colonyd-ci-loop-artifacts-"));
    dirs.push(artifacts);

    ctx = {
      store,
      provider,
      config: {
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
      } as unknown as ColonyConfig,
      artifacts: createLocalArtifactStore(artifacts),
      logger: { info() {}, warn() {}, error() {} },
      agents: {
        runtime: "fake",
        architect: runtime,
        developer: runtime,
        reviewer: runtime,
      },
      draining: { isDraining: () => false },
      env: {
        gitlabBaseUrl: "https://gitlab.example.com",
        gitlabToken: "token",
        webhookSecret: "secret",
        singleToken: false,
        maxConcurrent: 10,
        maxAttempts: 3,
        resumeLeaseTtlMs: 60_000,
        oidcIssuer: "",
        oidcClientId: "",
        oidcRequiredRole: "",
        traceUiBaseUrl: "",
        consoleBaseUrl: "",
      },
      requestTick: () => {},
    };
  });

  afterEach(() => {
    store.close();
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds consecutive CI repairs at maxAttempts and never starts a run after blocking", async () => {
    await provider.branches.create(
      { id: repo.id, path: repo.path },
      "main",
      SHA_MAIN,
    );
    await provider.branches.create(
      { id: repo.id, path: repo.path },
      "colony/task-repair-loop",
      SHA_BASE,
    );

    const mr = await provider.mergeRequests.open(
      { id: repo.id, path: repo.path },
      {
        title: "repair loop MR",
        description: "testing bounded CI repairs",
        source_branch: "colony/task-repair-loop",
        target_branch: "main",
      },
    );

    const scope = store.createScope({
      goal: "test bounded CI repairs",
      title: "repair loop scope",
      approvals: "auto",
      provider_repo_id: repo.id,
      provider_repo_path: repo.path,
      default_branch: "main",
    });

    store.setScopeStatus(scope.id, "planning", "test");
    const [created] = store.materializePlan(scope.id, PLAN, "test");
    if (!created) throw new Error("task creation failed");

    store.transitionTask(created.id, created.state_version, "running", "test", {
      branch: "colony/task-repair-loop",
    });
    const running = store.getTask(created.id)!;
    store.transitionTask(running.id, running.state_version, "mr_open", "test", {
      mr_iid: mr.iid,
    });
    const task = store.getTask(created.id)!;

    // CI pipelines fail for any head pushed
    provider.pipelines.getStatus = async (_repo, sha) => ({
      id: `pipe-${sha}`,
      status: "failed",
      commit_sha: sha,
      metadata: { provider: "fake", id: `pipe-${sha}` },
    });

    // Drive ticks until the task reaches blocked
    const maxTicks = 20;
    let ticksRun = 0;
    while (ticksRun < maxTicks) {
      ticksRun += 1;
      // Fast-forward backoff so queued tasks execute immediately
      store.db
        .prepare("UPDATE tasks SET next_retry_at = NULL WHERE id = ?")
        .run(task.id);

      await tick(ctx);
      await awaitPendingRuns();

      const current = store.getTask(task.id)!;
      if (current.state === "mr_open" && current.branch) {
        const branchHead = (
          await provider.commits.get(
            { id: repo.id, path: repo.path },
            current.branch,
          )
        ).sha;
        (
          provider as unknown as { replaceMr(id: string, mr: unknown): void }
        ).replaceMr(`${repo.id}:${mr.iid}`, {
          ...mr,
          head_commit_sha: branchHead,
        });
      }

      if (current.state === "blocked") {
        break;
      }
    }

    const finalTask = store.getTask(task.id)!;
    expect(finalTask.state).toBe("blocked");
    expect(finalTask.blocked_reason).toContain(
      "ci_failure repair attempts exhausted",
    );
    expect(finalTask.blocked_reason).toContain(
      `(${ctx.env.maxAttempts}/${ctx.env.maxAttempts})`,
    );

    const runsCountAtBlock = store.runsForTask(task.id).length;
    // Verify at least one run happened
    expect(runsCountAtBlock).toBeGreaterThan(0);

    // Run additional ticks to verify no further run starts after blocking
    for (let i = 0; i < 3; i++) {
      await tick(ctx);
      await awaitPendingRuns();
    }

    const runsCountAfter = store.runsForTask(task.id).length;
    expect(runsCountAfter).toBe(runsCountAtBlock);

    const audits = store.listAudit({ task_id: task.id }).events;
    expect(
      audits.some(
        (e) =>
          e.action === "gate.pipeline_blocked" &&
          JSON.parse(e.detail_json).outcome === "blocked",
      ),
    ).toBe(true);
  });
});
