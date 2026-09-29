import { describe, expect, it } from "bun:test";
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import {
  changedGoalInputs,
  decidePlanLoop,
  goalInputs,
  MAX_PLAN_REVIEW_ROUNDS,
  parsePlanReviewBlockReason,
  PLAN_REVIEW_STALL_WINDOW,
  withReviewNotes,
  type PlanRejection,
} from "./plan-loop.js";

function rejection(
  blockers: number,
  blockedTasks: number[],
  operatorNotes: string[] = [],
): PlanRejection {
  return { runId: "run", round: 1, blockers, blockedTasks, operatorNotes };
}

function plan(
  tasks: { title: string; spec?: string; depends_on?: number[] }[],
): ArchitectDecompositionV2 {
  return {
    kind: "architect_decomposition",
    summary: "plan",
    requirements: [
      { id: "R1", text: "goal", tasks: tasks.map((_, index) => index) },
    ],
    journey: [{ after_task: tasks.length - 1, working_state: "goal" }],
    acceptance: [{ description: "goal", command: "true" }],
    tasks: tasks.map((task) => ({
      title: task.title,
      spec: task.spec ?? `Do ${task.title}.`,
      depends_on: task.depends_on ?? [],
      files: ["src/a.ts"],
      evidence: ["true"],
    })),
  };
}

describe("plan loop decision", () => {
  it("sends a rejection back while blockers fall and no task repeats", () => {
    expect(
      decidePlanLoop([
        rejection(5, [0]),
        rejection(4, [1]),
        rejection(3, [2]),
        rejection(2, [3]),
        rejection(1, [4]),
      ]),
    ).toEqual({ action: "revise" });
  });

  it("stops at once for a blocker only the operator can settle", () => {
    const decision = decidePlanLoop([
      rejection(
        2,
        [0],
        ["Decide who owns the shared ingress.", "Pick a queue."],
      ),
    ]);
    expect(decision).toEqual({
      action: "block",
      kind: "operator",
      reason:
        "plan review needs an operator decision after 1 rejection: Decide who owns the shared ingress. (+1 more)",
    });
  });

  it("stalls when the same task is blocked in every review of the window", () => {
    const window = Array.from({ length: PLAN_REVIEW_STALL_WINDOW }, (_, i) =>
      rejection(3 - (i % 2), [7, i]),
    );
    expect(
      decidePlanLoop(window, (task) =>
        task === 7 ? "Cut over the edge worker" : undefined,
      ),
    ).toEqual({
      action: "block",
      kind: "stalled",
      reason: `plan review stalled after ${PLAN_REVIEW_STALL_WINDOW} rejections: task 7 (Cut over the edge worker) has had a blocker in each of the last ${PLAN_REVIEW_STALL_WINDOW} reviews`,
    });
  });

  it("stalls when blockers do not fall across the window", () => {
    expect(
      decidePlanLoop([
        rejection(2, [0]),
        rejection(1, [1]),
        rejection(1, [2]),
        rejection(2, [3]),
      ]),
    ).toEqual({
      action: "block",
      kind: "stalled",
      reason:
        "plan review stalled after 4 rejections: blockers did not fall over the last 4 reviews (2, 1, 1, 2)",
    });
  });

  it("blocks at the hard ceiling a loop that never stalls", () => {
    const counts = [7, 7, 7, 6, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1];
    expect(counts).toHaveLength(MAX_PLAN_REVIEW_ROUNDS);
    const rejections = counts.map((count, i) => rejection(count, [i]));
    expect(decidePlanLoop(rejections.slice(0, -1))).toEqual({
      action: "revise",
    });
    expect(decidePlanLoop(rejections)).toEqual({
      action: "block",
      kind: "cap",
      reason: `plan review rejected ${MAX_PLAN_REVIEW_ROUNDS} consecutive times`,
    });
  });

  it("words every block so the escape endpoints recognise it", () => {
    const blocks = [
      decidePlanLoop([rejection(1, [], ["Decide."])]),
      decidePlanLoop([
        rejection(1, [0]),
        rejection(1, [0]),
        rejection(1, [0]),
        rejection(1, [0]),
      ]),
    ];
    for (const decision of blocks) {
      if (decision.action !== "block") throw new Error("expected a block");
      expect(parsePlanReviewBlockReason(decision.reason)?.kind).toBe(
        decision.kind,
      );
    }
    expect(
      parsePlanReviewBlockReason("plan review rejected 10 consecutive times"),
    ).toEqual({ kind: "cap", rejections: 10 });
    expect(
      parsePlanReviewBlockReason("architect retries exhausted: boom"),
    ).toBeNull();
  });
});

describe("approval notes", () => {
  it("attaches non-blocking findings to the tasks they name, plan-wide ones to every task", () => {
    const approved = withReviewNotes(
      plan([{ title: "A" }, { title: "B" }]),
      {
        kind: "plan_review_verdict",
        verdict: "approve",
        summary: "ok",
        findings: [
          { severity: "major", task: 1, note: "Assert B's exit code." },
          { severity: "minor", note: "Name states consistently." },
        ],
        inspected: [],
      },
      3,
    );
    const heading = "## Plan review findings to satisfy (round 3)";
    const [a, b] = approved.tasks.map((task) => task.spec);
    expect(a).toStartWith("Do A.\n\n");
    expect(a).toContain(heading);
    expect(a).toContain("- [minor] Name states consistently.");
    expect(a).not.toContain("Assert B's exit code.");
    expect(b).toContain(heading);
    expect(b).toContain("- [major] Assert B's exit code.");
    expect(b).toContain("- [minor] Name states consistently.");
  });
});

describe("goal inputs", () => {
  it("names the inputs that changed; unknown inputs compare equal", () => {
    const before = goalInputs(
      { goal: "Ship it", plan_directives: "" },
      { context_doc: "Background" },
      [{ filename: "brief.md", content: "one" }],
    );
    const after = goalInputs(
      { goal: "Ship it", plan_directives: "Use Kestra." },
      { context_doc: "Background" },
      [{ filename: "brief.md", content: "two" }],
    );
    expect(changedGoalInputs(before, after)).toEqual([
      "operator planning directives",
      "project reference files",
    ]);
    expect(changedGoalInputs(null, after)).toEqual([]);
  });
});
