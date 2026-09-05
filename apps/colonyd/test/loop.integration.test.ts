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
import type { AuditRow } from "@colony/core";
import { registerInMemorySpanExporter } from "@colony/observability";
import { FakeProviderAdapter } from "@colony/provider";
import { boot, type ColonydHandle } from "../src/main.js";
import { awaitPendingRuns, trackRun } from "../src/runs/registry.js";
import { buildApp } from "../src/http.js";
import type { GateFailure } from "../src/runs/merge-gate.js";
import type { ValidateExecutor } from "../src/runs/validate.js";

const ACTOR = "human:op-1";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

let dir: string;
let provider: FakeProviderAdapter;
let repoId: string;
let handle: ColonydHandle;
let configPath: string;
let reviewConfigPath: string;

/** Scripted fake runtime state shared with the scenarios. */
const script = {
  /** task id -> number of remaining forced implementer failures */
  implementerFailures: new Map<string, number>(),
  /** task id -> implementer run invocations observed */
  implementerCalls: new Map<string, number>(),
  gateFailOnceFor: undefined as string | undefined,
  gateCalls: new Map<string, number>(),
  reviewerCalls: 0,
  /** Error the reviewer adapter raises instead of returning a verdict. */
  reviewerError: undefined as string | undefined,
  reviewerRejectFirst: false,
  reviewerAlwaysReject: false,
  planReviewRejectFirst: false,
  planReviewCalls: 0,
  distinctShas: false,
  singleTask: false,
  validateFail: false,
  /** The first validation never runs (sandbox provision failure). */
  validateInfraFailOnce: false,
  reviewerAdvancesHead: false,
};

function fakeAgents(): FakeAgentRuntimeAdapter {
  return new FakeAgentRuntimeAdapter({
    envelopeForRun: (
      packet: AgentRuntimePacket,
      environment: AgentRunEnvironment,
    ) => {
      if (environment.role === "architect") {
        if (script.singleTask) {
          return {
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
        }
        const revised =
          ("plan_feedback" in packet &&
            typeof packet.plan_feedback === "string") ||
          ("plan_directives" in packet &&
            typeof packet.plan_directives === "string");
        return {
          kind: "architect_decomposition",
          summary: revised
            ? "Revised two-task decomposition: A then B."
            : "Two-task decomposition: A then B.",
          requirements: [{ id: "R1", text: "fake goal holds", tasks: [0, 1] }],
          journey: [
            { after_task: 0, working_state: "A holds" },
            { after_task: 1, working_state: "fake goal holds" },
          ],
          acceptance: [{ description: "fake goal holds", command: "true" }],
          tasks: [
            {
              title: "Task A",
              spec: "Do A.",
              depends_on: [],
              files: ["src/a.ts"],
              evidence: ["true"],
            },
            {
              title: "Task B",
              spec: "Do B.",
              depends_on: [0],
              files: ["src/b.ts"],
              evidence: ["true"],
            },
          ],
        };
      }
      if (environment.role === "plan_reviewer") {
        script.planReviewCalls += 1;
        if (script.planReviewRejectFirst && script.planReviewCalls === 1) {
          return {
            kind: "plan_review_verdict",
            verdict: "request_changes",
            summary: "Task B's evidence does not prove B.",
            findings: [
              { severity: "major", task: 1, note: "evidence must exercise B" },
            ],
            inspected: [],
          };
        }
        return {
          kind: "plan_review_verdict",
          verdict: "approve",
          summary:
            "Approved: every task lands alone, the evidence commands prove each one, and the journey reaches the goal.",
          findings: [],
          inspected: [{ file: "src/a.ts", note: "checked against the plan" }],
        };
      }
      if (environment.role === "reviewer") {
        const headSha =
          typeof packet.head_sha === "string" ? packet.head_sha : SHA_A;
        script.reviewerCalls += 1;
        if (script.reviewerError !== undefined) {
          throw new Error(script.reviewerError);
        }
        if (
          script.reviewerAlwaysReject ||
          (script.reviewerRejectFirst && script.reviewerCalls === 1)
        ) {
          return {
            kind: "reviewer_verdict",
            verdict: "request_changes",
            summary: "Need changes.",
            findings: [
              {
                severity: "major",
                file: "index.js",
                note: "version endpoint missing",
              },
            ],
            head_sha: headSha,
          };
        }
        if (script.reviewerAdvancesHead && script.reviewerCalls === 1) {
          // Simulate an implement retry pushing to the MR branch mid-review:
          // the reviewer honestly reviews the branch's new head, not the
          // dispatched one.
          const branch = `colony/${String(packet.task_id)}`;
          const newSha = "c".repeat(40);
          void provider.branches.create({ id: repoId }, branch, newSha);
          return {
            kind: "reviewer_verdict",
            verdict: "approve",
            summary:
              "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
            findings: [],
            inspected: [
              { file: "src/main.ts", note: "checked against the task spec" },
            ],
            head_sha: newSha,
          };
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
          head_sha: headSha,
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
      const headSha = script.distinctShas
        ? (
            (taskId.endsWith(".1") ? "a" : "b") +
            String(calls).padStart(2, "0") +
            "0".repeat(37)
          ).slice(0, 40)
        : taskId.endsWith(".1")
          ? SHA_A
          : SHA_B;
      const branch = `colony/${taskId}`;
      // The fake provider needs the branch to exist so envelope fact
      // verification (branch head == head_sha) passes.
      void provider.branches.create({ id: repoId }, branch, headSha);
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

function syncMrHead(adapter: FakeProviderAdapter): void {
  const origGet = adapter.mergeRequests.get.bind(adapter.mergeRequests);
  adapter.mergeRequests.get = async (repo, id) => {
    const mr = await origGet(repo, id);
    if (!mr.source_branch) return mr;
    const head = await adapter.commits.get(repo, mr.source_branch);
    return { ...mr, head_commit_sha: head.sha };
  };
}

function fakeValidateExecutor(): ValidateExecutor {
  return async () => {
    if (script.validateInfraFailOnce) {
      script.validateInfraFailOnce = false;
      return {
        passed: false,
        results: [],
        error: "workspace_provision_failed: etcdserver: request timed out",
      };
    }
    if (script.validateFail) {
      return {
        passed: false,
        results: [
          {
            index: 0,
            description: "fake",
            command: "false",
            exit_code: 1,
            tail: ["boom"],
            failures: [],
          },
        ],
      };
    }
    return {
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
    };
  };
}

async function bootHeadless(
  dbPath: string,
  options: { reviewRequired?: boolean; planReview?: boolean } = {},
): Promise<ColonydHandle> {
  process.env["NODE_ENV"] = "test";
  process.env["AGENT_RUNTIME"] = "fake";
  process.env["GITLAB_TOKEN"] = "";
  process.env["GITLAB_WEBHOOK_SECRET"] = "";
  process.env["COLONYD_DB_PATH"] = dbPath;
  process.env["COLONYD_MAX_ATTEMPTS"] = "3";
  process.env["COLONYD_MAX_CONCURRENT"] = "1";
  process.env["COLONY_CONFIG_PATH"] = options.reviewRequired
    ? reviewConfigPath
    : configPath;
  resetEnvCache();
  if (options.reviewRequired) syncMrHead(provider);
  return boot({
    provider,
    agents: {
      runtime: "fake",
      architect: fakeAgents(),
      developer: fakeAgents(),
      ...(options.reviewRequired ? { reviewer: fakeAgents() } : {}),
      // Production wires the plan reviewer whenever a reviewer exists;
      // tests opt in so tick-counting scenarios keep their shape.
      ...(options.planReview ? { planReviewer: fakeAgents() } : {}),
    },
    gateExecutor: gateExecutor(),
    validateExecutor: fakeValidateExecutor(),
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
  reviewConfigPath = join(dir, "colony-review.yaml");
  writeFileSync(
    reviewConfigPath,
    [
      "agent_runtime: fake",
      "allow_literal_keys: true",
      "hitl:",
      "  mode: yolo",
      "review:",
      "  mode: required",
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
      "  reviewer:",
      "    provider: fake_llm",
      "    model: fake-model",
    ].join("\n"),
    "utf8",
  );
});

afterAll(async () => {
  // The last handle booted by a scenario still owns process-wide telemetry and
  // a tick interval; leaving it running leaks both into other test files.
  await handle?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each scenario boots its own colonyd; retire the previous one first so its
  // telemetry registration and tick interval do not outlive the test.
  await handle?.shutdown();
  script.implementerFailures.clear();
  script.implementerCalls.clear();
  script.gateFailOnceFor = undefined;
  script.gateCalls.clear();
  script.reviewerCalls = 0;
  script.reviewerError = undefined;
  script.reviewerRejectFirst = false;
  script.reviewerAlwaysReject = false;
  script.planReviewRejectFirst = false;
  script.planReviewCalls = 0;
  script.distinctShas = false;
  script.singleTask = false;
  script.validateFail = false;
  script.validateInfraFailOnce = false;
  script.reviewerAdvancesHead = false;
  provider = new FakeProviderAdapter();
  const repo = await provider.repos.create({
    name: "fake-e2e",
    path: "so/fake-e2e",
  });
  repoId = repo.id;
  handle = await bootHeadless(
    join(dir, `case-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
  );
});

async function createScope(goal: string): Promise<string> {
  const scope = handle.ctx.store.createScope({
    goal,
    title: goal,
    provider_repo_id: repoId,
    provider_repo_path: "so/fake-e2e",
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
  it("plan review: request_changes replans with the findings, approve materializes", async () => {
    await handle.shutdown();
    handle = await bootHeadless(join(dir, `plan-review-${Date.now()}.db`), {
      reviewRequired: true,
      planReview: true,
    });
    script.planReviewRejectFirst = true;
    const scopeId = await createScope("plan review loop");
    const store = handle.ctx.store;
    await tickAndSettle(); // draft -> planning; architect proposes
    expect(store.getScope(scopeId)!.plan_json).not.toBeNull();
    await tickAndSettle(); // plan review 1 -> request_changes -> replan
    let scope = store.getScope(scopeId)!;
    expect(scope.status).toBe("planning");
    expect(scope.plan_json).toBeNull();
    expect(scope.plan_feedback).toContain(
      "Plan review round 1: request_changes",
    );
    expect(scope.plan_feedback).toContain(
      "[major] task 1: evidence must exercise B",
    );
    expect(store.listTasks(scopeId)).toHaveLength(0);
    await tickAndSettle(); // architect re-runs with the findings
    scope = store.getScope(scopeId)!;
    expect(scope.plan_json).not.toBeNull();
    expect(scope.plan_feedback).toBeNull();
    // plan review 2 -> approve -> materialize (review dispatch and the
    // materialization are separate ticks; converge, bounded).
    for (let i = 0; i < 6; i += 1) {
      await tickAndSettle();
      if (store.getScope(scopeId)!.status === "active") break;
    }
    scope = store.getScope(scopeId)!;
    expect(scope.status).toBe("active");
    expect(store.listTasks(scopeId).length).toBeGreaterThan(0);
    const reviews = store
      .runsForScope(scopeId)
      .filter((r) => r.kind === "plan_review");
    expect(reviews).toHaveLength(2);
    expect(reviews.every((r) => r.status === "succeeded")).toBe(true);
    const actions = store
      .listAudit({ scope_id: scopeId, limit: 1000 })
      .events.map((row) => row.action);
    expect(actions.filter((a) => a === "scope.plan_reviewed")).toHaveLength(2);
    expect(actions).toContain("scope.plan_rejected");
    // The materialized spec carries the plan's grounding.
    const task = store.listTasks(scopeId)[0]!;
    expect(task.spec).toContain("## Files");
    expect(task.spec).toContain("## Evidence");
  }, 30_000);

  it("plan review: ten rejections block the scope", async () => {
    await handle.shutdown();
    handle = await bootHeadless(join(dir, `plan-review-cap-${Date.now()}.db`), {
      reviewRequired: true,
      planReview: true,
    });
    // Every review rejects: the knob rejects the first call only, so keep
    // resetting the counter before each review.
    const scopeId = await createScope("plan review cap");
    const store = handle.ctx.store;
    // Every review rejects (the knob rejects call 1; the counter resets
    // once the plan is cleared). Each round: propose, review, reject.
    script.planReviewRejectFirst = true;
    const rejectedCount = () =>
      store
        .listAudit({ scope_id: scopeId, limit: 1000 })
        .events.filter((row) => row.action === "scope.plan_rejected").length;
    let rejections = 0;
    for (let tick = 0; tick < 80 && rejections < 9; tick += 1) {
      script.planReviewCalls = 0;
      await tickAndSettle();
      rejections = rejectedCount();
    }
    expect(rejections).toBe(9);
    // Nine consecutive rejections stay under the cap: still planning,
    // not blocked.
    expect(store.getScope(scopeId)!.status).toBe("planning");
    for (let tick = 0; tick < 80 && rejections < 10; tick += 1) {
      script.planReviewCalls = 0;
      await tickAndSettle();
      rejections = rejectedCount();
    }
    expect(rejections).toBe(10);
    // The next proposal meets the cap: blocked, not reviewed.
    for (let tick = 0; tick < 11; tick += 1) {
      await tickAndSettle();
      if (store.getScope(scopeId)!.status === "blocked") break;
    }
    const scope = store.getScope(scopeId)!;
    expect(scope.status).toBe("blocked");
    expect(scope.blocked_reason).toBe(
      "plan review rejected 10 consecutive times",
    );
    expect(rejectedCount()).toBe(10);
    // The block keeps the latest revised plan for the operator.
    expect(scope.plan_json).not.toBeNull();

    const app = buildApp(handle.ctx);

    // Let's test non-cap block precondition:
    const uncapScopeId = await createScope("uncap scope");
    store.setScopeStatus(uncapScopeId, "planning", ACTOR);
    store.setScopeStatus(uncapScopeId, "blocked", ACTOR, {
      blocked_reason: "architect retries exhausted: boom",
    });
    const failCap1 = await app.request(
      `/scopes/${uncapScopeId}/plan-review-continue`,
      {
        method: "POST",
        headers: { "X-Actor-Id": ACTOR },
      },
    );
    expect(failCap1.status).toBe(409);
    const failCap2 = await app.request(
      `/scopes/${uncapScopeId}/plan-review-approve`,
      {
        method: "POST",
        headers: { "X-Actor-Id": ACTOR },
      },
    );
    expect(failCap2.status).toBe(409);
    const failCap3 = await app.request(
      `/scopes/${uncapScopeId}/plan-review-replan`,
      {
        method: "POST",
        headers: { "X-Actor-Id": ACTOR, "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "fix it" }),
      },
    );
    expect(failCap3.status).toBe(409);

    // Calling continue on an unblocked scope fails
    const notBlockedScopeId = await createScope("not blocked scope");
    const failNotBlocked = await app.request(
      `/scopes/${notBlockedScopeId}/plan-review-continue`,
      {
        method: "POST",
        headers: { "X-Actor-Id": ACTOR },
      },
    );
    expect(failNotBlocked.status).toBe(409);

    // Generic unblock still routes planning/active/validating for non-cap blocks:
    // (uncapScopeId has no tasks, so it routes to planning)
    const genericUnblock = await app.request(
      `/scopes/${uncapScopeId}/unblock`,
      {
        method: "POST",
        headers: { "X-Actor-Id": ACTOR },
      },
    );
    expect(genericUnblock.status).toBe(200);
    expect(store.getScope(uncapScopeId)!.status).toBe("planning");

    // Legacy reason 5 accepted for continue
    const legacyScopeId = await createScope("legacy 5 scope");
    store.setScopeStatus(legacyScopeId, "planning", ACTOR);
    store.setScopePlan(legacyScopeId, scope.plan_json!);
    store.setScopeStatus(legacyScopeId, "blocked", ACTOR, {
      blocked_reason: "plan review rejected 5 consecutive times",
    });
    const legacyRes = await app.request(
      `/scopes/${legacyScopeId}/plan-review-continue`,
      {
        method: "POST",
        headers: { "X-Actor-Id": ACTOR },
      },
    );
    expect(legacyRes.status).toBe(200);
    expect(store.getScope(legacyScopeId)!.status).toBe("planning");
    const legacyAudits = store.listAudit({
      scope_id: legacyScopeId,
      limit: 10,
    }).events;
    expect(
      legacyAudits.some((a) => {
        const d = JSON.parse(a.detail_json) as { rounds?: number } | null;
        return a.action === "scope.plan_review_continued" && d?.rounds === 5;
      }),
    ).toBe(true);

    // Test Escape Action (1): plan-review-continue
    // scopeId is currently blocked at 10.
    const continueRes = await app.request(
      `/scopes/${scopeId}/plan-review-continue`,
      {
        method: "POST",
        headers: { "X-Actor-Id": ACTOR },
      },
    );
    expect(continueRes.status).toBe(200);
    expect(store.getScope(scopeId)!.status).toBe("planning");
    // plan_json retained so tick can review
    expect(store.getScope(scopeId)!.plan_json).not.toBeNull();
    // Epoch reset: the historical 10 rejections no longer count, so the
    // tick reviews the retained plan instead of re-blocking on arrival.
    const reviewsBeforeContinue = store
      .runsForScope(scopeId)
      .filter((r) => r.kind === "plan_review").length;
    script.planReviewCalls = 0;
    script.planReviewRejectFirst = false;
    await tickAndSettle();
    const afterContinue = store.getScope(scopeId)!;
    expect(afterContinue.status).not.toBe("blocked");
    expect(
      store.runsForScope(scopeId).filter((r) => r.kind === "plan_review")
        .length,
    ).toBeGreaterThan(reviewsBeforeContinue);

    // Test Escape Action (3): plan-review-replan
    // First let's put scopeId back into blocked state at 10
    store.setScopeStatus(scopeId, "blocked", ACTOR, {
      blocked_reason: "plan review rejected 10 consecutive times",
      plan_json: scope.plan_json,
    });
    // Feedback empty -> 400
    const replanEmpty = await app.request(
      `/scopes/${scopeId}/plan-review-replan`,
      {
        method: "POST",
        headers: { "X-Actor-Id": ACTOR, "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "" }),
      },
    );
    expect(replanEmpty.status).toBe(400);

    const replanRes = await app.request(
      `/scopes/${scopeId}/plan-review-replan`,
      {
        method: "POST",
        headers: { "X-Actor-Id": ACTOR, "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "replan please" }),
      },
    );
    expect(replanRes.status).toBe(200);
    expect(store.getScope(scopeId)!.status).toBe("planning");
    // The operator's feedback is durable across every later planning epoch.
    expect(store.getScope(scopeId)!.plan_json).toBeNull();
    const replanAudits = store.listAudit({
      scope_id: scopeId,
      limit: 10,
    }).events;
    expect(
      replanAudits.some((a) => {
        const d = JSON.parse(a.detail_json) as { feedback?: string } | null;
        return (
          a.action === "plan.replan_requested" &&
          d?.feedback === "replan please"
        );
      }),
    ).toBe(true);
    expect(
      replanAudits.some((a) => {
        const d = JSON.parse(a.detail_json) as { rounds?: number } | null;
        return a.action === "scope.plan_review_replanned" && d?.rounds === 10;
      }),
    ).toBe(true);
    // Epoch reset: the cleared plan goes back to the architect carrying the
    // operator's feedback and the historical rejections do not re-block.
    script.planReviewCalls = 0;
    script.planReviewRejectFirst = false;
    await tickAndSettle();
    const afterReplan = store.getScope(scopeId)!;
    expect(afterReplan.status).toBe("planning");
    expect(afterReplan.blocked_reason).toBeNull();
    expect(afterReplan.plan_feedback).toBeNull();
    expect(afterReplan.plan_directives).toContain("replan please");

    // Test Escape Action (2): plan-review-approve
    store.setScopePlan(scopeId, scope.plan_json!);
    store.setScopeStatus(scopeId, "blocked", ACTOR, {
      blocked_reason: "plan review rejected 10 consecutive times",
    });
    const approveRes = await app.request(
      `/scopes/${scopeId}/plan-review-approve`,
      {
        method: "POST",
        headers: { "X-Actor-Id": ACTOR },
      },
    );
    expect(approveRes.status).toBe(200);
    expect(store.getScope(scopeId)!.status).toBe("active");
    expect(store.listTasks(scopeId).length).toBeGreaterThan(0);
    const approveAudits = store.listAudit({
      scope_id: scopeId,
      limit: 10,
    }).events;
    expect(
      approveAudits.some((a) => {
        const d = JSON.parse(a.detail_json) as { rounds?: number } | null;
        return a.action === "scope.plan_review_approved" && d?.rounds === 10;
      }),
    ).toBe(true);

    // Test Abandon on blocked scope. Drain the replan tick first: an
    // architect run still in flight would race the synthetic block below.
    await settle();
    const abandonScopeId = await createScope("abandon cap scope");
    store.setScopeStatus(abandonScopeId, "planning", ACTOR);
    store.setScopeStatus(abandonScopeId, "blocked", ACTOR, {
      blocked_reason: "plan review rejected 10 consecutive times",
      plan_json: scope.plan_json,
    });
    const abandonRes = await app.request(`/scopes/${abandonScopeId}/abandon`, {
      method: "POST",
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(abandonRes.status).toBe(200);
    expect(store.getScope(abandonScopeId)!.status).toBe("abandoned");
  }, 60_000);

  it("happy path: scope draft->planning->active->done; A merges before B dispatches", async () => {
    const scopeId = await createScope("fake happy path");

    await driveToDone(scopeId);

    const scope = handle.ctx.store.getScope(scopeId)!;
    expect(scope.status).toBe("done");

    // Validate run succeeded: scope passed through validating -> done.
    const validateRuns = handle.ctx.store
      .runsForScope(scopeId)
      .filter((r) => r.kind === "validate");
    expect(validateRuns.length).toBeGreaterThanOrEqual(1);
    const passedRun = validateRuns.find((r) => r.status === "succeeded");
    expect(passedRun).toBeTruthy();
    const passedEvidence = JSON.parse(passedRun!.evidence_json!) as {
      passed: boolean;
    };
    expect(passedEvidence.passed).toBe(true);
    const validatedAudit = handle.ctx.store
      .listAudit({ scope_id: scopeId, limit: 1000 })
      .events.filter((row) => row.action === "scope.validated");
    expect(validatedAudit.length).toBeGreaterThanOrEqual(1);

    const tasks = handle.ctx.store.listTasks(scopeId);
    expect(tasks).toHaveLength(2);
    const [taskA, taskB] = tasks;
    expect(taskA!.state).toBe("merged");
    expect(taskB!.state).toBe("merged");

    // A merged before B ever dispatched: audit row order proves it.
    const firstRunningB = handle.ctx.store
      .listAudit({ task_id: taskB!.id, limit: 1000 })
      .events.find(
        (row) =>
          row.action === "task.transition" && transitionTo(row) === "running",
      );
    const mergedA = handle.ctx.store
      .listAudit({ task_id: taskA!.id, limit: 1000 })
      .events.find(
        (row) =>
          row.action === "task.transition" && transitionTo(row) === "merged",
      );
    expect(firstRunningB && mergedA).toBeTruthy();
    expect(firstRunningB!.id).toBeGreaterThan(mergedA!.id);

    // Audit contains task.transition rows for every hop of both tasks.
    for (const task of tasks) {
      const hops = handle.ctx.store
        .listAudit({ task_id: task.id, limit: 1000 })
        .events.filter((row) => row.action === "task.transition")
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
        { id: repoId },
        `${repoId}:${task.mr_iid}`,
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

    // B depends on A and is still `queued`: nothing in the scope can run, so
    // the scope must say so instead of reading `active` forever
    // (col-c8f58a57, 2026-09-02: blocked .3, queued .4 behind it, scope
    // `active` for nine hours).
    const b = handle.ctx.store.getTask(`${scopeId}.2`)!;
    expect(b.state).toBe("queued");
    await tickAndSettle();
    const scope = handle.ctx.store.getScope(scopeId)!;
    expect(scope.status).toBe("blocked");
    expect(scope.blocked_reason).toBe(`no runnable tasks; blocked: ${taskAId}`);
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
      .events.filter((row) => row.action === "mr.opened");
    expect(auditMrOpened).toHaveLength(1);
  }, 30_000);

  it("treats a timed-out merge response as success when the MR confirms the merge", async () => {
    const scopeId = await createScope("ambiguous merge response");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; dispatch A -> mr_open

    const originalMerge = provider.mergeRequests.merge.bind(
      provider.mergeRequests,
    );
    provider.mergeRequests.merge = async (repo, id, input) => {
      await originalMerge(repo, id, input);
      throw new Error(
        "GitLab PUT /projects/1/merge_requests/1/merge timed out",
      );
    };

    await tickAndSettle(); // gate merges, observes the timeout outcome
    await tickAndSettle(); // provider fact advances mr_open -> merged

    const taskA = handle.ctx.store
      .listTasks(scopeId)
      .find((task) => task.id.endsWith(".1"))!;
    expect(taskA.state).toBe("merged");
    expect(taskA.attempt).toBe(0);
    const gate = handle.ctx.store
      .runsForTask(taskA.id)
      .find((run) => run.kind === "merge_gate");
    expect(gate?.status).toBe("succeeded");
    expect(JSON.parse(gate!.evidence_json!)).toMatchObject({
      reason: "merge_observed_after_error",
      head_sha: SHA_A,
    });
  }, 30_000);

  it("holds mr_open on a transient merge refusal and merges on the re-gate", async () => {
    // GitLab answers 405 while a head's pipeline is still registering or its
    // mergeability is being rechecked. The code is approved and unchanged,
    // so requeueing an implement is waste: col-e3021988.11 spent two extra
    // implement runs on an approved MR that way (2026-09-03).
    const scopeId = await createScope("transient merge refusal");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; dispatch A -> mr_open

    const originalMerge = provider.mergeRequests.merge.bind(
      provider.mergeRequests,
    );
    let refusals = 0;
    provider.mergeRequests.merge = async (repo, id, input) => {
      if (refusals === 0) {
        refusals += 1;
        return {
          ...(await provider.mergeRequests.get(repo, id)),
          merged: false,
          reason: "merge_http_405",
        };
      }
      return originalMerge(repo, id, input);
    };

    await tickAndSettle(); // gate runs, refused -> task HELD mr_open
    const taskA = handle.ctx.store
      .listTasks(scopeId)
      .find((task) => task.id.endsWith(".1"))!;
    let a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("mr_open");
    expect(a.attempt).toBe(0);
    const refused = handle.ctx.store
      .runsForTask(taskA.id)
      .filter((run) => run.kind === "merge_gate");
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0]!.evidence_json!)).toMatchObject({
      reason: "merge_refused:merge_http_405",
      head_sha: SHA_A,
    });
    expect(
      handle.ctx.store
        .listAudit({ task_id: taskA.id, limit: 1000 })
        .events.filter((row) => row.action === "gate.regate_pending"),
    ).toHaveLength(1);

    // Inside the re-gate backoff nothing is dispatched.
    await tickAndSettle();
    expect(
      handle.ctx.store
        .runsForTask(taskA.id)
        .filter((run) => run.kind === "merge_gate"),
    ).toHaveLength(1);
    expect(
      handle.ctx.store
        .runsForTask(taskA.id)
        .filter((run) => run.kind === "implement"),
    ).toHaveLength(1);

    // Backoff elapsed: the same head is re-gated and merges; no new implement.
    handle.ctx.store.db
      .prepare(`UPDATE runs SET finished_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 120_000).toISOString(), refused[0]!.id);
    await tickAndSettle(); // re-gate merges
    await tickAndSettle(); // provider fact advances mr_open -> merged
    a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("merged");
    expect(a.attempt).toBe(0);
    expect(
      handle.ctx.store
        .runsForTask(taskA.id)
        .filter((run) => run.kind === "implement"),
    ).toHaveLength(1);
  }, 30_000);

  it("reconciles a queued task whose merge completed before a legacy timeout failure", async () => {
    const scopeId = await createScope("legacy ambiguous merge response");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; dispatch A -> mr_open

    let taskA = handle.ctx.store
      .listTasks(scopeId)
      .find((task) => task.id.endsWith(".1"))!;
    await provider.mergeRequests.merge(
      { id: repoId },
      `${repoId}:${taskA.mr_iid}`,
      { sha: SHA_A },
    );
    const gate = handle.ctx.store.startRun({
      scope_id: scopeId,
      task_id: taskA.id,
      kind: "merge_gate",
      lease_ttl_ms: 30 * 60_000,
      base_sha: SHA_A,
    });
    handle.ctx.store.finishRun(gate.id, "failed", {
      evidence_json: JSON.stringify({
        reason: "workspace_failed",
        error: "GitLab PUT /projects/1/merge_requests/1/merge timed out",
        head_sha: SHA_A,
      }),
    });
    handle.ctx.store.transitionTask(
      taskA.id,
      taskA.state_version,
      "queued",
      "svc:colonyd",
      {
        attempt: 1,
        next_retry_at: new Date(Date.now() + 60_000).toISOString(),
      },
    );

    await tickAndSettle();

    taskA = handle.ctx.store.getTask(taskA.id)!;
    expect(taskA.state).toBe("merged");
    expect(
      handle.ctx.store
        .listAudit({ task_id: taskA.id, limit: 100 })
        .events.some((row) => row.action === "gate.merge_timeout_reconciled"),
    ).toBe(true);
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
    const minted = await provider.accessTokens.mint(
      { id: repoId, path: "so/fake-e2e" },
      {
        name: `colony-task-${taskA.id}`,
        scopes: ["api", "write_repository"],
        access_level: 30,
        expires_at: "2099-01-01",
      },
    );
    // Do not persist token_id: SIGKILL between GitLab mint and setRunToken.
    expect(provider.listAccessTokens().map((t) => t.id)).toContain(minted.id);
    storeA.transitionTask(taskA.id, a.state_version, "running", "svc:colonyd");
    const runsBefore = storeA.runsForTask(taskA.id).length;
    const versionBefore = storeA.getTask(taskA.id)!.state_version;
    await handle.shutdown();

    // Boot a fresh colonyd on the same file; orphans are reaped on open.
    handle = await bootHeadless(dbPath);
    await tickAndSettle();

    a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("queued");
    // process_restart is an infrastructure failure: the task requeues but
    // does NOT consume an attempt (only agent-caused failures do).
    expect(a.attempt).toBe(0);
    // Exactly one transition out of running (state_version bumped once).
    expect(a.state_version).toBe(versionBefore + 1);
    // The expired run failed; no new implement run was minted.
    const expired = handle.ctx.store.getRun(liveRun.id)!;
    expect(expired.status).toBe("failed");
    expect(expired.error).toBe("process_restart");
    expect(handle.ctx.store.runsForTask(taskA.id)).toHaveLength(runsBefore);
    expect(provider.listAccessTokens().map((t) => t.id)).not.toContain(
      minted.id,
    );
  }, 30_000);

  it("review loop: request_changes requeues with findings then approve merges on one MR", async () => {
    await handle.shutdown();
    handle = await bootHeadless(join(dir, `review-loop-${Date.now()}.db`), {
      reviewRequired: true,
    });
    script.reviewerRejectFirst = true;
    script.distinctShas = true;

    const scopeId = await createScope("review loop");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; dispatch A -> mr_open
    const taskA = handle.ctx.store
      .listTasks(scopeId)
      .find((t) => t.id.endsWith(".1"))!;
    expect(taskA.state).toBe("mr_open");

    await tickAndSettle(); // review request_changes -> queued
    let a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("queued");
    expect(a.attempt).toBe(1);
    const changes = handle.ctx.store
      .listAudit({ task_id: taskA.id, limit: 1000 })
      .events.filter((row) => row.action === "review.changes_requested");
    expect(changes).toHaveLength(1);

    handle.ctx.store.clearRetryDelay(taskA.id);
    await driveToDone(scopeId, 40);

    a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("merged");
    expect(a.attempt).toBe(1);
    const scope = handle.ctx.store.getScope(scopeId)!;
    expect(scope.status).toBe("done");

    const audit = handle.ctx.store
      .listAudit({ task_id: taskA.id, limit: 1000 })
      .events.slice()
      .sort((x, y) => x.id - y.id)
      .map((row) => row.action);
    const requested = audit.indexOf("review.changes_requested");
    const approved = audit.indexOf("review.approved");
    expect(requested).toBeGreaterThanOrEqual(0);
    expect(approved).toBeGreaterThan(requested);
    expect(audit.filter((action) => action === "mr.opened")).toHaveLength(1);
    expect(audit.filter((action) => action === "mr.reused")).toHaveLength(1);
  }, 30_000);

  it("review repair cannot return to mr_open at the rejected head", async () => {
    await handle.shutdown();
    handle = await bootHeadless(
      join(dir, `review-no-change-${Date.now()}.db`),
      {
        reviewRequired: true,
      },
    );
    script.singleTask = true;
    script.reviewerRejectFirst = true;
    script.distinctShas = false;

    const scopeId = await createScope("review repair no change");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // implement -> mr_open
    const task = handle.ctx.store.listTasks(scopeId)[0]!;
    await tickAndSettle(); // review rejects SHA_A -> queued
    handle.ctx.store.clearRetryDelay(task.id);
    await tickAndSettle(); // fake repair submits SHA_A again

    const current = handle.ctx.store.getTask(task.id)!;
    expect(current.state).not.toBe("mr_open");
    const implementRuns = handle.ctx.store
      .runsForTask(task.id)
      .filter((run) => run.kind === "implement");
    expect(implementRuns.at(-1)).toMatchObject({
      status: "failed",
      error: "repair_no_change",
    });
    const reused = handle.ctx.store
      .listAudit({ task_id: task.id, limit: 1000 })
      .events.filter((row) => row.action === "mr.reused");
    expect(reused).toHaveLength(0);
  }, 30_000);

  it("no review starts on a provider MR head that lags the implementer's push", async () => {
    // col-66b8a6c8.6, 2026-09-02: GitLab reported the previous head for a
    // tick after the push; the review ran on it and its verdict was dead
    // at the gate. Stale facts fail closed, like missing ones.
    await handle.shutdown();
    handle = await bootHeadless(join(dir, `stale-head-${Date.now()}.db`), {
      reviewRequired: true,
    });
    script.singleTask = true;
    script.distinctShas = true;
    // The provider lags: while `lagging`, it reports a head one behind.
    let lagging = false;
    const origGet = provider.mergeRequests.get.bind(provider.mergeRequests);
    provider.mergeRequests.get = async (repo, id) => {
      const mr = await origGet(repo, id);
      return lagging ? { ...mr, head_commit_sha: "0".repeat(40) } : mr;
    };

    const scopeId = await createScope("stale head");
    const taskId = `${scopeId}.1`;
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; implement -> mr_open
    const store = handle.ctx.store;
    expect(store.getTask(taskId)!.state).toBe("mr_open");
    const pushed = store
      .runsForTask(taskId)
      .filter((r) => r.kind === "implement")
      .at(-1)!.head_sha!;

    lagging = true;
    await tickAndSettle(); // provider lagging: no review may start
    await tickAndSettle();
    const staleReviews = store
      .runsForTask(taskId)
      .filter((r) => r.kind === "review");
    expect(staleReviews).toHaveLength(0);

    lagging = false;
    await driveToDone(scopeId, 40); // provider caught up: review + merge
    const reviews = store
      .runsForTask(taskId)
      .filter((r) => r.kind === "review");
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    for (const review of reviews) {
      const evidence = JSON.parse(review.evidence_json ?? "{}") as {
        head_sha?: string;
      };
      expect(evidence.head_sha).toBe(pushed);
    }
    expect(store.getTask(taskId)!.state).toBe("merged");
  }, 30_000);

  it("review verdict at a newer head is accepted when it matches the MR's current head", async () => {
    await handle.shutdown();
    handle = await bootHeadless(join(dir, `head-advance-${Date.now()}.db`), {
      reviewRequired: true,
    });
    script.singleTask = true;
    script.reviewerAdvancesHead = true;

    const scopeId = await createScope("head advance");
    await driveToDone(scopeId, 40);

    expect(handle.ctx.store.getScope(scopeId)!.status).toBe("done");
    const taskId = `${scopeId}.1`;
    expect(handle.ctx.store.getTask(taskId)!.state).toBe("merged");

    // Exactly one review ran, succeeded, and its evidence names the sha the
    // reviewer actually inspected - not the dispatched one.
    const reviews = handle.ctx.store
      .runsForTask(taskId)
      .filter((r) => r.kind === "review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("succeeded");
    const evidence = JSON.parse(reviews[0]!.evidence_json!) as {
      head_sha: string;
    };
    expect(evidence.head_sha).toBe("c".repeat(40));

    const advanced = handle.ctx.store
      .listAudit({ task_id: taskId, limit: 1000 })
      .events.filter((row) => row.action === "review.head_advanced");
    expect(advanced).toHaveLength(1);
  }, 30_000);

  it("conflicted MR requeues for landing instead of dispatching review or gate", async () => {
    script.singleTask = true;
    let conflicted = true;
    const orig = provider.mergeRequests.get.bind(provider.mergeRequests);
    provider.mergeRequests.get = async (repo, id) => ({
      ...(await orig(repo, id)),
      ...(conflicted ? { has_conflicts: true } : {}),
    });

    const scopeId = await createScope("conflicted mr");
    const taskId = `${scopeId}.1`;
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; implement -> mr_open
    await tickAndSettle(); // conflict observed -> requeue

    let task = handle.ctx.store.getTask(taskId)!;
    expect(task.state).toBe("queued");
    expect(task.attempt).toBe(1);
    expect(script.gateCalls.get(taskId) ?? 0).toBe(0);
    const conflictAudits = handle.ctx.store
      .listAudit({ task_id: taskId, limit: 1000 })
      .events.filter((row) => row.action === "mr.conflicted");
    expect(conflictAudits).toHaveLength(1);

    // Conflict resolved (the retry rebases); the loop completes normally.
    conflicted = false;
    handle.ctx.store.clearRetryDelay(taskId);
    await driveToDone(scopeId, 40);
    expect(handle.ctx.store.getTask(taskId)!.state).toBe("merged");
  }, 30_000);

  it("conflicted MR stops a review in flight before requeueing", async () => {
    // col-c8f58a57.3, 2026-09-01: the review started on a head, the tick
    // then saw the MR conflicted and requeued the task - dispatching an
    // implementer beside the reviewer it never stopped.
    script.singleTask = true;
    const orig = provider.mergeRequests.get.bind(provider.mergeRequests);
    provider.mergeRequests.get = async (repo, id) => ({
      ...(await orig(repo, id)),
      has_conflicts: true,
    });
    const scopeId = await createScope("conflicted under review");
    const taskId = `${scopeId}.1`;
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; implement -> mr_open
    const store = handle.ctx.store;
    expect(store.getTask(taskId)!.state).toBe("mr_open");

    // A review is live on the conflicted head.
    const review = store.startRun({
      scope_id: scopeId,
      task_id: taskId,
      kind: "review",
      lease_ttl_ms: 60_000,
    });
    let aborted = false;
    let settleReview!: () => void;
    const execution = new Promise<void>((resolve) => {
      settleReview = resolve;
    });
    trackRun(review.id, execution, () => {
      aborted = true;
      store.finishRun(review.id, "canceled", { error: "aborted" });
      settleReview();
    });

    await tickAndSettle(); // conflict observed -> stop review -> requeue
    expect(aborted).toBe(true);
    expect(store.getRun(review.id)!.status).toBe("canceled");
    expect(store.getTask(taskId)!.state).toBe("queued");
  }, 30_000);

  it("pause aborts live runs, parks the scope for the tick, and resume picks up where it left off", async () => {
    script.singleTask = true;
    const scopeId = await createScope("pause me");
    const taskId = `${scopeId}.1`;
    await tickAndSettle(); // draft -> planning
    // Put A in `running` with a run we control, as if an implementer were live.
    const store = handle.ctx.store;
    await tickAndSettle(); // planning -> active; implement -> mr_open (fake)
    // Rewind A to a live implement so pause has something to stop.
    const taskA = store.getTask(taskId)!;
    expect(taskA.state).toBe("mr_open");
    store.transitionTask(taskA.id, taskA.state_version, "queued", ACTOR, {
      attempt: 0,
      next_retry_at: null,
    });
    const requeued = store.getTask(taskId)!;
    store.transitionTask(requeued.id, requeued.state_version, "running", ACTOR);
    const live = store.startRun({
      scope_id: scopeId,
      task_id: taskId,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    let aborted = false;
    let settle!: () => void;
    const execution = new Promise<void>((resolve) => {
      settle = resolve;
    });
    trackRun(live.id, execution, () => {
      aborted = true;
      store.finishRun(live.id, "canceled", { error: "aborted" });
      settle();
    });

    const app = buildApp(handle.ctx);
    const paused = await app.request(`/scopes/${scopeId}/pause`, {
      method: "POST",
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(paused.status).toBe(200);
    expect(aborted).toBe(true);
    expect(store.getRun(live.id)!.status).toBe("canceled");
    expect(store.getTask(taskId)!.state).toBe("queued");
    const scope = store.getScope(scopeId)!;
    expect(scope.status).toBe("paused");
    expect(scope.paused_from).toBe("active");

    // The tick leaves a paused scope alone: no dispatch, no closure.
    const implementsBefore = store
      .runsForTask(taskId)
      .filter((r) => r.kind === "implement").length;
    await tickAndSettle();
    await tickAndSettle();
    expect(store.getScope(scopeId)!.status).toBe("paused");
    expect(
      store.runsForTask(taskId).filter((r) => r.kind === "implement"),
    ).toHaveLength(implementsBefore);

    // Pausing again conflicts; resume returns to active and work continues.
    const again = await app.request(`/scopes/${scopeId}/pause`, {
      method: "POST",
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(again.status).toBe(409);
    const resumed = await app.request(`/scopes/${scopeId}/resume`, {
      method: "POST",
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(resumed.status).toBe(200);
    expect(store.getScope(scopeId)!.status).toBe("active");
    expect(store.getScope(scopeId)!.paused_from).toBeNull();
    await driveToDone(scopeId);
    expect(store.getScope(scopeId)!.status).toBe("done");
  }, 30_000);

  it("pausing a blocked scope keeps its reason and resumes to blocked", async () => {
    const scopeId = await createScope("blocked pause");
    const store = handle.ctx.store;
    store.setScopeStatus(scopeId, "planning", ACTOR);
    store.setScopeStatus(scopeId, "blocked", ACTOR, {
      blocked_reason: "architect retries exhausted: x",
    });
    const app = buildApp(handle.ctx);
    const paused = await app.request(`/scopes/${scopeId}/pause`, {
      method: "POST",
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(paused.status).toBe(200);
    const scope = store.getScope(scopeId)!;
    expect(scope.status).toBe("paused");
    expect(scope.paused_from).toBe("blocked");
    expect(scope.blocked_reason).toBe("architect retries exhausted: x");
    const resumed = await app.request(`/scopes/${scopeId}/resume`, {
      method: "POST",
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(resumed.status).toBe(200);
    const back = store.getScope(scopeId)!;
    expect(back.status).toBe("blocked");
    expect(back.blocked_reason).toBe("architect retries exhausted: x");
  }, 30_000);

  it("an implement run whose head equals the base is a no-op: task merged, no MR", async () => {
    // col-7064acc1.5 (2026-09-03): the operator had already landed the fix on
    // main, the implementer verified and changed nothing, colonyd opened a
    // zero-diff MR, GitLab called it unmergeable, and the conflict path
    // requeued a second implement run 15 s later.
    script.singleTask = true;
    const scopeId = await createScope("already landed");
    // The default branch head equals what the implementer will report.
    await provider.branches.create({ id: repoId }, "main", SHA_A);
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // dispatch A -> no-op
    const task = handle.ctx.store.listTasks(scopeId)[0]!;
    expect(task.state).toBe("merged");
    expect(task.mr_iid).toBeNull();
    const runs = handle.ctx.store
      .runsForTask(task.id)
      .filter((r) => r.kind === "implement");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");
    const actions = handle.ctx.store
      .listAudit({ task_id: task.id, limit: 100 })
      .events.map((row) => row.action);
    expect(actions).toContain("mr.skipped_noop");
    expect(actions).not.toContain("mr.opened");
    // A second tick must not dispatch again.
    await tickAndSettle();
    expect(
      handle.ctx.store
        .runsForTask(task.id)
        .filter((r) => r.kind === "implement"),
    ).toHaveLength(1);
  }, 30_000);

  it("review rejection cap: ten consecutive request_changes block the task and scope", async () => {
    await handle.shutdown();
    handle = await bootHeadless(join(dir, `review-cap-${Date.now()}.db`), {
      reviewRequired: true,
    });
    script.reviewerAlwaysReject = true;
    script.distinctShas = true;
    script.singleTask = true;

    const scopeId = await createScope("review cap");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // dispatch A -> mr_open
    const taskA = handle.ctx.store.listTasks(scopeId)[0]!;
    expect(taskA.state).toBe("mr_open");

    // Rounds 1..9: every rejection requeues with attempt+1 and no block.
    for (let round = 1; round <= 9; round += 1) {
      await tickAndSettle(); // review N -> queued attempt N
      const t = handle.ctx.store.getTask(taskA.id)!;
      expect(t.state).toBe("queued");
      expect(t.attempt).toBe(round);
      handle.ctx.store.clearRetryDelay(taskA.id);
      await tickAndSettle(); // implement N+1 -> mr_open
      expect(handle.ctx.store.getTask(taskA.id)!.state).toBe("mr_open");
    }
    await tickAndSettle(); // review 10 -> blocked
    await tickAndSettle(); // closeScopes

    const a = handle.ctx.store.getTask(taskA.id)!;
    expect(a.state).toBe("blocked");
    expect(a.blocked_reason).toBe("review rejected 10 consecutive times");
    const scope = handle.ctx.store.getScope(scopeId)!;
    expect(scope.status).toBe("blocked");
  }, 60_000);

  it("infra-failed architect runs never spend the scope's attempt budget", async () => {
    const scopeId = await createScope("infra architect");
    // Three infra-classified architect corpses recorded before any tick.
    for (let i = 0; i < 3; i += 1) {
      const run = handle.ctx.store.startRun({
        id: crypto.randomUUID(),
        scope_id: scopeId,
        task_id: null,
        kind: "architect",
        lease_ttl_ms: 60_000,
      });
      handle.ctx.store.finishRun(run.id, "failed", {
        error: "workspace_lost",
      });
    }
    handle.ctx.store.setScopeStatus(scopeId, "planning", ACTOR);

    await driveToDone(scopeId);
    // A blocked scope here would mean the corpses were counted; instead the
    // architect planned and the loop ran to completion.
    expect(handle.ctx.store.getScope(scopeId)!.status).toBe("done");
  }, 30_000);

  it("infra-failed review runs never block the task and a fourth review still dispatches", async () => {
    await handle.shutdown();
    handle = await bootHeadless(join(dir, `review-infra-${Date.now()}.db`), {
      reviewRequired: true,
    });
    script.singleTask = true;

    const scopeId = await createScope("infra review");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; implement -> mr_open
    const task = handle.ctx.store.listTasks(scopeId)[0]!;
    expect(task.state).toBe("mr_open");

    script.reviewerError = "502 status code (no body)";
    for (let i = 0; i < 3; i += 1) {
      await tickAndSettle(); // infra-failed review
      const current = handle.ctx.store.getTask(task.id)!;
      expect(current.state).toBe("mr_open");
      expect(current.state).not.toBe("blocked");
    }

    const failedReviews = handle.ctx.store
      .runsForTask(task.id)
      .filter((r) => r.kind === "review" && r.status === "failed");
    expect(failedReviews).toHaveLength(3);
    for (const run of failedReviews) {
      expect(run.error).toBe("502 status code (no body)");
    }

    // The gateway recovers: the fourth review dispatches and approves. The
    // task may already have moved on to gate/merge, but it never blocked.
    script.reviewerError = undefined;
    await tickAndSettle();
    expect(script.reviewerCalls).toBeGreaterThanOrEqual(4);
    expect(handle.ctx.store.getTask(task.id)!.state).not.toBe("blocked");
  }, 30_000);

  it("timeout_without_envelope review failures still block the task", async () => {
    await handle.shutdown();
    handle = await bootHeadless(join(dir, `review-timeout-${Date.now()}.db`), {
      reviewRequired: true,
    });
    script.singleTask = true;

    const scopeId = await createScope("timeout review");
    await tickAndSettle(); // draft -> planning
    await tickAndSettle(); // planning -> active; implement -> mr_open
    const task = handle.ctx.store.listTasks(scopeId)[0]!;
    expect(task.state).toBe("mr_open");

    script.reviewerError = "timeout_without_envelope";
    for (let i = 0; i < 3; i += 1) {
      await tickAndSettle(); // review failure the reviewer is accountable for
    }
    await tickAndSettle(); // closeScopes

    const blocked = handle.ctx.store.getTask(task.id)!;
    expect(blocked.state).toBe("blocked");
    expect(blocked.blocked_reason).toBe(
      `review failed 3 consecutive times at ${SHA_A}`,
    );
    script.reviewerError = undefined;
  }, 30_000);

  it("POST /scopes/:id/unblock returns an architect-exhausted scope to planning", async () => {
    const scopeId = await createScope("unblock scope");
    handle.ctx.store.setScopeStatus(scopeId, "planning", ACTOR);
    // Three agent-fault architect failures on the ledger: the real shape of
    // an exhausted scope. Counting them forever re-blocked col-1e4f99fd on
    // the tick after every unblock without running anything (2026-09-02);
    // the budget must restart at the operator's unblock.
    for (let i = 0; i < 3; i += 1) {
      const run = handle.ctx.store.startRun({
        scope_id: scopeId,
        task_id: null,
        kind: "architect",
        lease_ttl_ms: 60_000,
      });
      handle.ctx.store.finishRun(run.id, "failed", {
        error: "finalize_no_submission",
      });
    }
    handle.ctx.store.setScopeStatus(scopeId, "blocked", ACTOR, {
      reason: "architect retries exhausted: finalize_no_submission",
    });

    const app = buildApp(handle.ctx);
    const res = await app.request(`/scopes/${scopeId}/unblock`, {
      method: "POST",
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(res.status).toBe(200);
    expect(handle.ctx.store.getScope(scopeId)!.status).toBe("planning");

    // Unblocking a non-blocked scope conflicts.
    const again = await app.request(`/scopes/${scopeId}/unblock`, {
      method: "POST",
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(again.status).toBe(409);

    // The freed scope plans and completes.
    await driveToDone(scopeId);
    expect(handle.ctx.store.getScope(scopeId)!.status).toBe("done");
  }, 30_000);

  it("a second unblock restarts the architect budget from the LATEST unblock", async () => {
    // The audit window comes back oldest-first; counting from the first
    // unblock ever recorded re-blocked col-1ee0d633 and col-fa9f6385 on the
    // tick after their second unblock, without running anything (2026-09-03).
    const scopeId = await createScope("unblock twice");
    handle.ctx.store.setScopeStatus(scopeId, "planning", ACTOR);
    const app = buildApp(handle.ctx);
    const exhaust = () => {
      for (let i = 0; i < 3; i += 1) {
        const run = handle.ctx.store.startRun({
          scope_id: scopeId,
          task_id: null,
          kind: "architect",
          lease_ttl_ms: 60_000,
        });
        handle.ctx.store.finishRun(run.id, "failed", {
          error: "timeout_without_envelope",
        });
      }
      handle.ctx.store.setScopeStatus(scopeId, "blocked", ACTOR, {
        reason: "architect retries exhausted: timeout_without_envelope",
      });
    };
    const unblock = async () => {
      const res = await app.request(`/scopes/${scopeId}/unblock`, {
        method: "POST",
        headers: { "X-Actor-Id": ACTOR },
      });
      expect(res.status).toBe(200);
    };

    exhaust();
    await unblock();
    exhaust(); // three more failures after the first unblock
    await unblock();

    // One tick: the scope must dispatch an architect, not re-block.
    await tickAndSettle();
    const scope = handle.ctx.store.getScope(scopeId)!;
    expect(scope.status).not.toBe("blocked");
    expect(
      handle.ctx.store
        .runsForScope(scopeId)
        .filter((r) => r.kind === "architect" && r.status !== "failed").length,
    ).toBeGreaterThan(0);
  }, 30_000);

  it("a validation that never ran is re-run, not handed to an architect", async () => {
    // col-7064acc1 (2026-09-03): an etcd stall failed the sandbox create;
    // the scope spent an extension round asking an architect to diagnose a
    // verdict that did not exist.
    const scopeId = await createScope("infra validate");
    script.validateInfraFailOnce = true;
    for (let i = 0; i < 25; i += 1) {
      await tickAndSettle();
      const validates = handle.ctx.store
        .runsForScope(scopeId)
        .filter((r) => r.kind === "validate");
      if (validates.length > 0 && validates[0]!.status !== "running") break;
    }
    const first = handle.ctx.store
      .runsForScope(scopeId)
      .filter((r) => r.kind === "validate");
    expect(first).toHaveLength(1);
    expect(first[0]!.status).toBe("failed");
    expect(first[0]!.error).toMatch(/workspace_provision_failed/);
    await tickAndSettle(); // validate 2: runs for real and passes
    const runs = handle.ctx.store.runsForScope(scopeId);
    expect(
      runs.filter(
        (r) => r.kind === "architect" && r.started_at > first[0]!.started_at,
      ),
    ).toHaveLength(0);
    expect(runs.filter((r) => r.kind === "validate")).toHaveLength(2);
    expect(handle.ctx.store.getScope(scopeId)!.status).toBe("done");
  }, 30_000);

  it("validation failure parks the scope then revalidate rescues it", async () => {
    script.validateFail = true;
    const scopeId = await createScope("validation failure");

    // Drive until the scope reaches `validating` (all tasks merged/terminal)
    // and the validation run has executed (and failed).
    for (let i = 0; i < 25; i += 1) {
      await tickAndSettle();
      const scope = handle.ctx.store.getScope(scopeId);
      if (!scope) continue;
      const validateRuns = handle.ctx.store
        .runsForScope(scopeId)
        .filter((r) => r.kind === "validate");
      if (validateRuns.length > 0) break;
    }

    const scope = handle.ctx.store.getScope(scopeId)!;
    // The scope stays `validating` on failure — no auto-retry.
    expect(scope.status).toBe("validating");

    // A failed validate run exists.
    const failedRun = handle.ctx.store
      .runsForScope(scopeId)
      .find((r) => r.kind === "validate" && r.status === "failed");
    expect(failedRun).toBeTruthy();
    const failedEvidence = JSON.parse(failedRun!.evidence_json!) as {
      passed: boolean;
    };
    expect(failedEvidence.passed).toBe(false);

    // Audit records the failure.
    const failedAudit = handle.ctx.store
      .listAudit({ scope_id: scopeId, limit: 1000 })
      .events.filter((row) => row.action === "scope.validation_failed");
    expect(failedAudit.length).toBeGreaterThanOrEqual(1);

    // Flip the fake to pass, then revalidate via the HTTP endpoint.
    script.validateFail = false;
    const app = buildApp(handle.ctx);
    const res = await app.request(`/scopes/${scopeId}/revalidate`, {
      method: "POST",
      headers: { "X-Actor-Id": ACTOR },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("validating");
    const revalidateAudit = handle.ctx.store
      .listAudit({ scope_id: scopeId, limit: 1000 })
      .events.filter((row) => row.action === "scope.revalidate_requested");
    expect(revalidateAudit.length).toBeGreaterThanOrEqual(1);

    // Settle the re-triggered validation run.
    await settle();

    // Second validate run succeeded; scope is now `done`.
    const scopeAfter = handle.ctx.store.getScope(scopeId)!;
    expect(scopeAfter.status).toBe("done");
    const succeededRuns = handle.ctx.store
      .runsForScope(scopeId)
      .filter((r) => r.kind === "validate" && r.status === "succeeded");
    expect(succeededRuns.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("a restart-killed validation replan is retried, and agent-failed replans block the scope", async () => {
    // col-3a0319cc, 2026-09-01: validate failed, the replanning architect
    // died to a restart, and the scope sat seven hours - nothing retried
    // the architect, nothing blocked the scope.
    script.validateFail = true;
    const scopeId = await createScope("stalled replan");
    for (let i = 0; i < 25; i += 1) {
      await tickAndSettle();
      if (
        handle.ctx.store
          .runsForScope(scopeId)
          .some((r) => r.kind === "validate" && r.status === "failed")
      )
        break;
    }
    const store = handle.ctx.store;
    expect(store.getScope(scopeId)!.status).toBe("validating");
    const architectsBefore = store
      .runsForScope(scopeId)
      .filter((r) => r.kind === "architect").length;

    // Simulate the replan the restart killed: a failed architect row that
    // started after the failed validate.
    const dead = store.startRun({
      scope_id: scopeId,
      task_id: null,
      kind: "architect",
      lease_ttl_ms: 60_000,
    });
    store.finishRun(dead.id, "failed", { error: "process_restart" });

    await tickAndSettle();
    const architectsAfter = store
      .runsForScope(scopeId)
      .filter((r) => r.kind === "architect").length;
    // Infra death is free: a fresh replan was dispatched.
    expect(architectsAfter).toBeGreaterThan(architectsBefore + 1);
    expect(store.getScope(scopeId)!.status).not.toBe("blocked");

    // Three agent-caused replan failures after the validate: block, loudly.
    for (let i = 0; i < 3; i += 1) {
      const run = store.startRun({
        scope_id: scopeId,
        task_id: null,
        kind: "architect",
        lease_ttl_ms: 60_000,
      });
      store.finishRun(run.id, "failed", { error: "finalize_no_submission" });
    }
    // The retried replan may still be settling into a fresh (failing)
    // validate; give the loop a few ticks to reach the budget check.
    for (let i = 0; i < 5; i += 1) {
      await tickAndSettle();
      if (store.getScope(scopeId)!.status === "blocked") break;
    }
    const blocked = store.getScope(scopeId)!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked_reason).toMatch(
      /^validation replan failed [34] times/,
    );
  }, 30_000);

  it("every run kind's colony.run span carries the run row id", async () => {
    const seam = registerInMemorySpanExporter();
    try {
      const scopeId = await createScope("span ids across run kinds");
      await driveToDone(scopeId);
      const scope = handle.ctx.store.getScope(scopeId)!;
      expect(scope.status).toBe("done");

      // architect + implement + merge_gate all ran to reach done.
      const runs = handle.ctx.store.runsForScope(scopeId);
      const runKinds = runs.map((r) => r.kind);
      expect(runKinds).toContain("architect");
      expect(runKinds).toContain("implement");
      expect(runKinds).toContain("merge_gate");

      // One colony.run span per run row, keyed by the id minted into the
      // runs row - not a second uuid minted when the span started.
      const runSpans = seam.exporter
        .getFinishedSpans()
        .filter(
          (span) =>
            span.name === "colony.run" &&
            span.attributes["colony.scope_id"] === scopeId,
        );
      const spanRunIds = runSpans.map(
        (span) => span.attributes["colony.run_id"],
      );
      expect(spanRunIds).toHaveLength(runs.length);
      for (const run of runs) {
        expect(spanRunIds).toContain(run.id);
      }
    } finally {
      await seam.shutdown();
    }
  });
});
