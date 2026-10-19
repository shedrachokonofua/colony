import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Task } from "@colony/core";
import { SERVICE_ACTOR } from "../src/context.js";
import { nextReviewRound } from "../src/runs/review-loop.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const OPERATOR = "human:op-1";

function reviewedTwice(): { store: Store; task: Task } {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-epoch-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  const scope = store.createScope({
    goal: "goal",
    title: "goal",
    approvals: "auto",
    provider_repo_id: "1",
    provider_repo_path: "so/colony",
  });
  store.setScopeStatus(scope.id, "planning", "svc:test");
  const [task] = store.materializePlan(
    scope.id,
    {
      kind: "architect_decomposition",
      summary: "one",
      requirements: [{ id: "R1", text: "goal", tasks: [0] }],
      journey: [{ after_task: 0, working_state: "goal" }],
      acceptance: [{ description: "goal", command: "true" }],
      tasks: [
        {
          title: "t",
          spec: "spec",
          depends_on: [],
          files: ["src/t.ts"],
          evidence: ["true"],
        },
      ],
    },
    "svc:test",
  );
  for (let round = 1; round <= 2; round += 1) {
    move(store, task!.id, "running");
    move(store, task!.id, "mr_open", SERVICE_ACTOR, {
      mr_iid: 11,
      branch: "colony/t",
    });
    const run = store.startRun({
      scope_id: scope.id,
      task_id: task!.id,
      kind: "review",
      lease_ttl_ms: 60_000,
    });
    store.finishRun(run.id, "succeeded", {
      evidence_json: JSON.stringify({
        verdict: "request_changes",
        round,
        findings: [],
        open_findings: [],
      }),
    });
    move(store, task!.id, "queued");
  }
  return { store, task: store.getTask(task!.id)! };
}

function move(
  store: Store,
  taskId: string,
  to: Task["state"],
  actor = SERVICE_ACTOR,
  patch: Record<string, unknown> = {},
): void {
  const current = store.getTask(taskId)!;
  store.transitionTask(
    taskId,
    current.state_version,
    to,
    actor,
    patch as never,
  );
}

// col-db8759e3 (2026-10-16/17): every operator answer to an implementer's
// question restarted the review epoch, so new majors could block again for
// two more reviews after each decision.
describe("review epoch across operator unblocks", () => {
  it("continues when the operator answers an implementer-side block", () => {
    const { store, task } = reviewedTwice();
    move(store, task.id, "running");
    move(store, task.id, "blocked", SERVICE_ACTOR, {
      blocked_reason: "needs an operator decision",
    });
    move(store, task.id, "queued", OPERATOR, {
      attempt: 0,
      next_retry_at: null,
    });

    const next = nextReviewRound(store, task.id);
    expect(next.round.round).toBe(3);
    expect(next.round.majors_block).toBe(false);
  });

  it("restarts when the operator unblocks a task the review loop parked", () => {
    const { store, task } = reviewedTwice();
    move(store, task.id, "running");
    move(store, task.id, "mr_open", SERVICE_ACTOR, {
      mr_iid: 11,
      branch: "colony/t",
    });
    move(store, task.id, "blocked", SERVICE_ACTOR, {
      blocked_reason: "code review stalled",
    });
    move(store, task.id, "queued", OPERATOR, {
      attempt: 0,
      next_retry_at: null,
    });

    const next = nextReviewRound(store, task.id);
    expect(next.round.round).toBe(3);
    expect(next.round.majors_block).toBe(true);
  });
});
