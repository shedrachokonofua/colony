import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ColonyConfig } from "@colony/config";
import {
  FakeAgentRuntimeAdapter,
  type AgentRuntimePacket,
} from "@colony/agent-runtime";
import {
  createLocalArtifactStore,
  Store,
  type Scope,
  type Task,
} from "@colony/core";
import { FakeProviderAdapter } from "@colony/provider";
import { ReviewerVerdictV2 as reviewerVerdictV2Schema } from "@colony/schemas";
import type { ColonydContext } from "../src/context.js";
import { runReview } from "../src/runs/review.js";

const SHA = "a".repeat(40);
const LONG_SUMMARY =
  "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.";
const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function validDimensions() {
  return [
    {
      name: "spec-compliance",
      spec_blind: false,
      target_files: ["src/change.ts"],
      findings: 0,
    },
    {
      name: "defect-scan",
      spec_blind: true,
      target_files: ["src/change.ts"],
      findings: 0,
    },
  ];
}

function approveEnvelope(headSha: string, dimensions: unknown) {
  return {
    kind: "reviewer_verdict",
    verdict: "approve",
    summary: LONG_SUMMARY,
    findings: [],
    inspected: [
      { file: "src/change.ts", note: "Checked the complete change." },
    ],
    dimensions,
    challenged: { reviewed: 0, dropped: 0 },
    head_sha: headSha,
  };
}

function specContradictionEnvelope(headSha: string) {
  return {
    kind: "reviewer_verdict",
    verdict: "request_changes",
    summary: "The change contradicts the task spec and must be reworked.",
    findings: [
      {
        severity: "blocker",
        file: "src/change.ts",
        note: "Contradicts the task spec: the spec requires a paginated list, the diff returns the full table.",
      },
    ],
    inspected: [{ file: "src/change.ts", note: "Read against the task spec." }],
    dimensions: [
      {
        name: "spec-compliance",
        spec_blind: false,
        target_files: ["src/change.ts"],
        findings: 1,
      },
      {
        name: "defect-scan",
        spec_blind: true,
        target_files: ["src/change.ts"],
        findings: 0,
      },
    ],
    challenged: { reviewed: 2, dropped: 1 },
    head_sha: headSha,
  };
}

interface Harness {
  readonly ctx: ColonydContext;
  readonly store: Store;
  readonly task: Task;
}

async function harness(
  envelopeForRun: (packet: AgentRuntimePacket) => unknown,
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-verdict-dimensions-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  stores.push(store);
  const provider = new FakeProviderAdapter();
  const repo = await provider.repos.create({ name: "repo", path: "fake/repo" });
  await provider.branches.create({ id: repo.id, path: repo.path }, "main", SHA);
  await provider.branches.create(
    { id: repo.id, path: repo.path },
    "colony/review-task",
    SHA,
  );
  const mr = await provider.mergeRequests.open(
    { id: repo.id, path: repo.path },
    {
      title: "review task",
      description: "review",
      source_branch: "colony/review-task",
      target_branch: "main",
    },
  );
  const scope: Scope = store.createScope({
    goal: "verdict dimensions",
    title: "verdict dimensions",
    approvals: "auto",
    provider_repo_id: repo.id,
    provider_repo_path: repo.path,
  });
  store.setScopeStatus(scope.id, "planning", "test");
  const [created] = store.materializePlan(
    scope.id,
    {
      kind: "architect_decomposition",
      summary: "one review task",
      requirements: [{ id: "R1", text: "review", tasks: [0] }],
      journey: [{ after_task: 0, working_state: "review" }],
      acceptance: [{ description: "ok", command: "true" }],
      tasks: [
        {
          title: "review task",
          spec: "review the change",
          depends_on: [],
          files: ["src/change.ts"],
          evidence: ["true"],
        },
      ],
    },
    "test",
  );
  if (!created) throw new Error("fixture task missing");
  store.transitionTask(created.id, created.state_version, "running", "test", {
    branch: "colony/review-task",
  });
  const running = store.getTask(created.id)!;
  store.transitionTask(running.id, running.state_version, "mr_open", "test", {
    mr_iid: mr.iid,
  });
  const task = store.getTask(created.id)!;
  const reviewer = new FakeAgentRuntimeAdapter({ envelopeForRun });
  const config = {
    reviewMode: "required",
    hitlMode: "yolo",
    forAgent: () => ({
      role: "reviewer",
      providerKey: "fake_llm",
      api: "openai-completions",
      model: { id: "review-model", name: "review-model" },
      fallbackModels: [],
      auth: { kind: "api_key", apiKey: "fake-key" },
      ceilings: { timeoutMs: 60_000, maxTurns: 20 },
    }),
    modelParallelLimit: () => null,
  } as unknown as ColonyConfig;
  const artifacts = mkdtempSync(
    join(tmpdir(), "colonyd-verdict-dimensions-artifacts-"),
  );
  dirs.push(artifacts);
  const ctx: ColonydContext = {
    store,
    provider,
    config,
    agents: {
      runtime: "fake",
      architect: new FakeAgentRuntimeAdapter(),
      developer: new FakeAgentRuntimeAdapter(),
      reviewer,
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
  };
  return { ctx, store, task };
}

function latestReviewRun(h: Harness) {
  const runs = h.store
    .runsForTask(h.task.id)
    .filter((run) => run.kind === "review");
  const run = runs.at(-1);
  if (!run) throw new Error("review run missing");
  return run;
}

describe("reviewer verdict dimensions", () => {
  it("rejects an approve with no spec_blind dimension", async () => {
    const envelope = approveEnvelope(SHA, [
      {
        name: "spec-compliance",
        spec_blind: false,
        target_files: ["src/change.ts"],
        findings: 0,
      },
      {
        name: "style",
        spec_blind: false,
        target_files: ["src/change.ts"],
        findings: 0,
      },
    ]);
    const parsed = reviewerVerdictV2Schema.safeParse(envelope);
    expect(parsed.success).toBe(false);

    const h = await harness(() => envelope);
    await runReview(h.ctx, await scopeOf(h), h.task, SHA);
    const run = latestReviewRun(h);
    expect(run.status).toBe("failed");
    expect(h.store.getTask(h.task.id)?.state).toBe("mr_open");
  });

  it("rejects a verdict whose challenged.reviewed is below the findings total", async () => {
    const envelope = {
      ...specContradictionEnvelope(SHA),
      findings: [
        {
          severity: "major",
          file: "src/change.ts",
          note: "First finding without coverage.",
        },
        {
          severity: "major",
          file: "src/change.ts",
          note: "Second finding without coverage.",
        },
      ],
      challenged: { reviewed: 1, dropped: 0 },
    };
    const parsed = reviewerVerdictV2Schema.safeParse(envelope);
    expect(parsed.success).toBe(false);

    const h = await harness(() => envelope);
    await runReview(h.ctx, await scopeOf(h), h.task, SHA);
    const run = latestReviewRun(h);
    expect(run.status).toBe("failed");
    expect(h.store.getTask(h.task.id)?.state).toBe("mr_open");
  });

  it("persists a spec-contradiction request_changes and reconciles to queued", async () => {
    const envelope = specContradictionEnvelope(SHA);
    expect(reviewerVerdictV2Schema.safeParse(envelope).success).toBe(true);

    const h = await harness(() => envelope);
    const scope = await scopeOf(h);
    await runReview(h.ctx, scope, h.task, SHA);

    const run = latestReviewRun(h);
    expect(run.status).toBe("succeeded");
    const evidence = JSON.parse(run.evidence_json ?? "{}") as {
      verdict?: string;
      dimensions?: unknown;
      challenged?: unknown;
      findings?: unknown[];
    };
    expect(evidence.verdict).toBe("request_changes");
    expect(evidence.dimensions).toEqual(envelope.dimensions);
    expect(evidence.challenged).toEqual(envelope.challenged);
    expect(evidence.findings).toEqual(envelope.findings);

    const changes = h.store
      .listAudit({ task_id: h.task.id, limit: 1000 })
      .events.filter((row) => row.action === "review.changes_requested");
    expect(changes).toHaveLength(1);
    const detail = JSON.parse(changes[0]!.detail_json) as {
      dimensions?: unknown;
      challenged?: unknown;
    };
    expect(detail.dimensions).toEqual(envelope.dimensions);
    expect(detail.challenged).toEqual(envelope.challenged);

    expect(h.store.getTask(h.task.id)?.state).toBe("queued");
  });

  it("persists dimensions and challenged on approve", async () => {
    const envelope = approveEnvelope(SHA, validDimensions());
    expect(reviewerVerdictV2Schema.safeParse(envelope).success).toBe(true);

    const h = await harness(() => envelope);
    const scope = await scopeOf(h);
    await runReview(h.ctx, scope, h.task, SHA);

    const run = latestReviewRun(h);
    expect(run.status).toBe("succeeded");
    const evidence = JSON.parse(run.evidence_json ?? "{}") as {
      verdict?: string;
      dimensions?: unknown;
      challenged?: unknown;
    };
    expect(evidence.verdict).toBe("approve");
    expect(evidence.dimensions).toEqual(envelope.dimensions);
    expect(evidence.challenged).toEqual(envelope.challenged);

    const approvals = h.store
      .listAudit({ task_id: h.task.id, limit: 1000 })
      .events.filter((row) => row.action === "review.approved");
    expect(approvals).toHaveLength(1);
    const detail = JSON.parse(approvals[0]!.detail_json) as {
      dimensions?: unknown;
      challenged?: unknown;
    };
    expect(detail.dimensions).toEqual(envelope.dimensions);
    expect(detail.challenged).toEqual(envelope.challenged);
  });
});

async function scopeOf(h: Harness): Promise<Scope> {
  const task = h.store.getTask(h.task.id)!;
  return h.store.getScope(task.scope_id)!;
}
