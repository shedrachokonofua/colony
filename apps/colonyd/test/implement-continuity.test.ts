import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  FakeAgentRuntimeAdapter,
  type AgentRunEnvironment,
  type AgentRunMetadata,
  type AgentRuntimePacket,
} from "@colony/agent-runtime";
import {
  createLocalArtifactStore,
  Store,
  type Run,
  type Scope,
  type Task,
} from "@colony/core";
import type { ColonyConfig } from "@colony/config";
import { FakeProviderAdapter, type ProviderRepoRef } from "@colony/provider";
import type { ImplementerCompletionV2 } from "@colony/schemas";
import type { ImplementPacket } from "../src/runs/packets.js";
import type { ColonydContext } from "../src/context.js";
import { runImplement } from "../src/runs/implement.js";

const ACTOR = "test:continuity";
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

interface Harness {
  store: Store;
  provider: FakeProviderAdapter;
  repo: ProviderRepoRef;
  scope: Scope;
  task: Task;
  runtime: CapturingRuntime;
  ctx: ColonydContext;
}

function isImplementPacket(
  packet: AgentRuntimePacket,
): packet is AgentRuntimePacket & ImplementPacket {
  return packet.kind === "implement_task";
}
class CapturingRuntime extends FakeAgentRuntimeAdapter {
  readonly packets: ImplementPacket[] = [];

  constructor(
    provider: FakeProviderAdapter,
    repo: ProviderRepoRef,
    completionHead = SHA_C,
  ) {
    super({
      envelopeForRun: (packet) => {
        const branch = String((packet.repo as Record<string, unknown>).branch);
        void provider.branches.create(repo, branch, completionHead);
        return {
          kind: "implementer_completion",
          status: "complete",
          summary: "Implemented the durable task requirements.",
          branch,
          head_sha: completionHead,
          commands: [{ cmd: "bun test", exit_code: 0 }],
        } satisfies ImplementerCompletionV2;
      },
    });
  }

  override startRun(
    packet: AgentRuntimePacket,
    environment: AgentRunEnvironment,
  ): Promise<AgentRunMetadata> {
    if (!isImplementPacket(packet)) {
      throw new Error("continuity fixture captured a non-implement packet");
    }
    this.packets.push(packet);
    return super.startRun(packet, environment);
  }
}

function capturedPacket(runtime: CapturingRuntime): ImplementPacket {
  const packet = runtime.packets[0];
  if (!packet) throw new Error("implement runtime did not capture a packet");
  return packet;
}

function testConfig(): ColonyConfig {
  const developer = {
    role: "developer" as const,
    providerKey: "fake",
    api: "openai-completions" as const,
    model: { id: "fake-model", name: "fake-model" },
    fallbackModels: [],
    auth: { kind: "api_key" as const, apiKey: "fake" },
    ceilings: { timeoutMs: 60_000, maxTurns: 5 },
  };
  return {
    agentRuntime: "fake",
    sandbox: {
      engine: "in-process",
      kubernetes: {
        namespace: "colony-sandboxes",
        image: "fake",
      },
    },
    hitlMode: "yolo",
    reviewMode: "off",
    artifacts: { kind: "local", local: { dir: "data/artifacts" } },
    sessionsDir: "data/sessions",
    notifications: { enabled: false },
    oauthProviderKeys: [],
    forAgent: () => developer,
    modelParallelLimit: () => null,
    getProvider: () => null,
  } as ColonyConfig;
}

function context(
  store: Store,
  provider: FakeProviderAdapter,
  runtime: CapturingRuntime,
): ColonydContext {
  return {
    store,
    provider,
    config: testConfig(),
    agents: {
      runtime: "fake",
      architect: runtime,
      developer: runtime,
    },
    logger: { info() {}, warn() {}, error() {} },
    artifacts: createLocalArtifactStore(
      (() => {
        const dir = mkdtempSync(
          join(tmpdir(), "colonyd-continuity-artifacts-"),
        );
        dirs.push(dir);
        return dir;
      })(),
    ),
    env: {
      gitlabBaseUrl: "file:///definitely-missing",
      gitlabToken: "",
      webhookSecret: "",
      singleToken: false,
      maxConcurrent: 1,
      maxAttempts: 3,
      oidcIssuer: "",
      oidcClientId: "colony",
      oidcRequiredRole: "",
      traceUiBaseUrl: "",
      consoleBaseUrl: "",
    },
    draining: { isDraining: () => false },
    requestTick() {},
  };
}

async function harness(
  options: {
    branch?: string | null;
    mrIid?: number | null;
    completionHead?: string;
  } = {},
): Promise<Harness> {
  const dbDir = mkdtempSync(join(tmpdir(), "colonyd-continuity-db-"));
  dirs.push(dbDir);
  const store = new Store(join(dbDir, "test.db"));
  stores.push(store);
  const provider = new FakeProviderAdapter();
  const repoInfo = await provider.repos.create({
    name: "continuity",
    path: "so/continuity",
  });
  const repo = { id: repoInfo.id, path: repoInfo.path };
  const scope = store.createScope({
    goal: "continuity goal",
    title: "continuity goal",
    provider_repo_id: repo.id,
    provider_repo_path: repo.path,
  });
  store.setScopeStatus(scope.id, "planning", ACTOR);
  const [task] = store.materializePlan(
    scope.id,
    {
      kind: "architect_decomposition",
      summary: "one task",
      requirements: [{ id: "R1", text: "continuity holds", tasks: [0] }],
      journey: [{ after_task: 0, working_state: "continuity holds" }],
      acceptance: [{ description: "continuity holds", command: "true" }],
      tasks: [
        {
          title: "Continuity task",
          spec: "Implement continuity.",
          depends_on: [],
          files: ["src/continuity.ts"],
          evidence: ["bun test"],
        },
      ],
    },
    ACTOR,
  );
  if (!task) throw new Error("materializePlan did not create a task");
  const updatedTask = store.transitionTask(
    task.id,
    task.state_version,
    "running",
    ACTOR,
    {
      branch: options.branch === undefined ? null : options.branch,
      mr_iid: options.mrIid === undefined ? null : options.mrIid,
    },
  );
  const runtime = new CapturingRuntime(
    provider,
    repo,
    options.completionHead ?? SHA_C,
  );
  const ctx = context(store, provider, runtime);
  return { store, provider, repo, scope, task: updatedTask, runtime, ctx };
}

function setRunTimes(
  store: Store,
  run: Run,
  started: string,
  finished = started,
): void {
  store.db
    .prepare("UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?")
    .run(started, finished, run.id);
}

function reviewRun(
  h: Harness,
  at: string,
  verdict: "request_changes" | "approve",
  headSha: string,
  note = "Review finding",
): Run {
  const run = h.store.startRun({
    scope_id: h.scope.id,
    task_id: h.task.id,
    kind: "review",
    lease_ttl_ms: 60_000,
    base_sha: headSha,
  });
  h.store.finishRun(run.id, "succeeded", {
    head_sha: headSha,
    evidence_json: JSON.stringify({
      verdict,
      head_sha: headSha,
      findings:
        verdict === "request_changes"
          ? [{ severity: "major", file: "src/continuity.ts", note }]
          : [],
    }),
  });
  const finished = h.store.getRun(run.id)!;
  setRunTimes(h.store, finished, at);
  return finished;
}

function gateRun(
  h: Harness,
  at: string,
  status: "succeeded" | "failed",
  headSha: string,
  reason: string,
): Run {
  const run = h.store.startRun({
    scope_id: h.scope.id,
    task_id: h.task.id,
    kind: "merge_gate",
    lease_ttl_ms: 60_000,
    base_sha: headSha,
  });
  h.store.finishRun(run.id, status, {
    head_sha: headSha,
    evidence_json: JSON.stringify({ reason, head_sha: headSha }),
    ...(status === "failed" ? { error: reason } : {}),
  });
  const finished = h.store.getRun(run.id)!;
  setRunTimes(h.store, finished, at);
  return finished;
}

async function prepareBranch(
  h: Harness,
  branch: string,
  headSha: string,
): Promise<void> {
  await h.provider.branches.create(h.repo, branch, headSha);
}

describe("runImplement continuity dispatch", () => {
  it("latest approval supersedes an earlier rejection for the same task", async () => {
    const h = await harness({ branch: "repair/approval" });
    await prepareBranch(h, "repair/approval", SHA_B);
    reviewRun(
      h,
      "2026-01-01T00:00:00.000Z",
      "request_changes",
      SHA_A,
      "old rejection",
    );
    reviewRun(h, "2026-01-02T00:00:00.000Z", "approve", SHA_B);

    await runImplement(h.ctx, h.scope, h.task);

    const packet = capturedPacket(h.runtime);
    expect(packet.execution_context.remote_head).toEqual({
      status: "known",
      value: SHA_B,
    });
    expect(packet.repair).toBeUndefined();
  });

  it("keeps an old-head rejection as history without enforcing the current-head repair guard", async () => {
    const h = await harness({ branch: "repair/old-head" });
    await prepareBranch(h, "repair/old-head", SHA_B);
    reviewRun(
      h,
      "2026-01-01T00:00:00.000Z",
      "request_changes",
      SHA_A,
      "only applies to old head",
    );

    await runImplement(h.ctx, h.scope, h.task);

    const packet = capturedPacket(h.runtime);
    expect(packet.repair).toBeUndefined();
    expect(packet.body).toContain("only applies to old head");
    expect(packet.body).not.toContain("Current review findings");
    expect(h.store.runsForTask(h.task.id).at(-1)?.status).toBe("succeeded");
  });

  it("enforces the repair guard when the rejection matches the current head", async () => {
    const h = await harness({
      branch: "repair/same-head",
      completionHead: SHA_B,
    });
    await prepareBranch(h, "repair/same-head", SHA_B);
    reviewRun(
      h,
      "2026-01-01T00:00:00.000Z",
      "request_changes",
      SHA_B,
      "must change current head",
    );

    await runImplement(h.ctx, h.scope, h.task);

    const packet = capturedPacket(h.runtime);
    expect(packet.repair).toEqual({ rejected_head_sha: SHA_B });
    expect(packet.body).toContain("Current review findings");
    expect(packet.body).toContain("must change current head");
    const currentRun = h.store.runsForTask(h.task.id).at(-1)!;
    expect(currentRun.status).toBe("failed");
    expect(currentRun.error).toBe("repair_no_change");
  });

  it("keeps an unchanged rejected head guarded when the remote head is unknown", async () => {
    const h = await harness({
      branch: "repair/unknown-head",
      completionHead: SHA_B,
    });
    await prepareBranch(h, "repair/unknown-head", SHA_B);
    reviewRun(
      h,
      "2026-01-01T00:00:00.000Z",
      "request_changes",
      SHA_B,
      "must change after transient lookup failure",
    );

    const originalCommitGet = h.provider.commits.get.bind(h.provider.commits);
    let taskBranchLookups = 0;
    h.provider.commits.get = async (repo, ref) => {
      if (ref === "repair/unknown-head" && taskBranchLookups++ === 0) {
        throw new Error("transient provider error");
      }
      return originalCommitGet(repo, ref);
    };

    await runImplement(h.ctx, h.scope, h.task);

    const packet = capturedPacket(h.runtime);
    expect(packet.execution_context.remote_head).toMatchObject({
      status: "unknown",
    });
    expect(packet.repair).toEqual({ rejected_head_sha: SHA_B });
    expect(packet.body).not.toContain("Current review findings");
    const currentRun = h.store.runsForTask(h.task.id).at(-1)!;
    expect(currentRun.status).toBe("failed");
    expect(currentRun.error).toBe("repair_no_change");
  });

  it("lets a newer successful gate supersede an older failure while retaining gate history", async () => {
    const h = await harness({ branch: "repair/gate-success" });
    await prepareBranch(h, "repair/gate-success", SHA_B);
    gateRun(h, "2026-01-01T00:00:00.000Z", "failed", SHA_A, "old gate failure");
    gateRun(
      h,
      "2026-01-02T00:00:00.000Z",
      "succeeded",
      SHA_B,
      "merge_accepted",
    );

    await runImplement(h.ctx, h.scope, h.task);

    const packet = capturedPacket(h.runtime);
    expect(packet.execution_context.pipeline).toEqual({
      status: "known",
      value: { status: "success" },
    });
    expect(packet.body).toContain("old gate failure");
    expect(packet.body).not.toContain("Current gate failure");
  });

  it("reports an unknown current pipeline instead of inferring a gate outcome", async () => {
    const h = await harness({ branch: "repair/gate-unknown" });
    await prepareBranch(h, "repair/gate-unknown", SHA_B);
    gateRun(
      h,
      "2026-01-01T00:00:00.000Z",
      "failed",
      SHA_B,
      "provider gate failed",
    );
    const original = h.provider.pipelines.getStatus.bind(h.provider.pipelines);
    h.provider.pipelines.getStatus = async (repo, id) => ({
      ...(await original(repo, id)),
      status: "unknown",
    });

    await runImplement(h.ctx, h.scope, h.task);

    const packet = capturedPacket(h.runtime);
    expect(packet.execution_context.pipeline.status).toBe("unknown");
    expect(packet.body).toContain("Current pipeline: UNKNOWN");
    expect(packet.body).toContain("Current gate failure");
    expect(packet.body).toContain("provider gate failed");
  });

  it("selects the previous interrupted attempt even when the current run is already a new running row", async () => {
    const h = await harness();
    const interrupted = h.store.startRun({
      scope_id: h.scope.id,
      task_id: h.task.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
      base_sha: SHA_A,
    });
    h.store.finishRun(interrupted.id, "failed", {
      error: "timeout_without_envelope",
      head_sha: SHA_A,
    });
    setRunTimes(
      h.store,
      h.store.getRun(interrupted.id)!,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:05:00.000Z",
    );

    await runImplement(h.ctx, h.scope, h.task);

    const packet = capturedPacket(h.runtime);
    expect(h.task.branch).toBeNull();
    expect(h.task.mr_iid).toBeNull();
    expect(packet.execution_context.mode).toBe("repair");
    expect(packet.body).toContain("previous attempt was cut off");
    expect(packet.body).toContain("interrupted");
    expect(packet.body).not.toContain("MR for this task already exists");
  });

  it("does not request a nonexistent task branch or pipeline for a fresh task", async () => {
    const h = await harness();
    const requestedRefs: string[] = [];
    const originalCommitGet = h.provider.commits.get.bind(h.provider.commits);
    h.provider.commits.get = async (repo, ref) => {
      requestedRefs.push(ref);
      return originalCommitGet(repo, ref);
    };
    let pipelineRequests = 0;
    const originalPipeline = h.provider.pipelines.getStatus.bind(
      h.provider.pipelines,
    );
    h.provider.pipelines.getStatus = async (repo, id) => {
      pipelineRequests += 1;
      return originalPipeline(repo, id);
    };

    await runImplement(h.ctx, h.scope, h.task);

    const packet = capturedPacket(h.runtime);
    expect(packet.execution_context).toMatchObject({
      mode: "fresh",
      remote_head: { status: "not_requested" },
      pipeline: { status: "not_requested" },
    });
    const taskBranch = `colony/${h.task.id}`;
    expect(requestedRefs[0]).toBe("main");
    // One task-branch read is expected after dispatch to verify the accepted
    // envelope; a fresh context builder must not read it before dispatch.
    expect(requestedRefs.filter((ref) => ref === taskBranch)).toHaveLength(1);
    expect(pipelineRequests).toBe(0);
  });
});
