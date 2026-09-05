import { describe, expect, it } from "bun:test";
import type { AgentRuntimeRole } from "./adapter.js";
import { RunSteering, packetObjective } from "./run-steering.js";

function steering(overrides: {
  role?: AgentRuntimeRole;
  runTimeoutMs?: number;
  clock?: { ms: number };
}) {
  const clock = overrides.clock ?? { ms: 0 };
  return {
    clock,
    run: new RunSteering({
      role: overrides.role ?? "developer",
      runTimeoutMs: overrides.runTimeoutMs ?? 60 * 60_000,
      branch: "colony/col-1.2",
      now: () => clock.ms,
    }),
  };
}

function drift(run: RunSteering, calls: number): void {
  for (let index = 0; index < calls; index += 1) run.observeToolCall("read");
}

describe("RunSteering drift nudge", () => {
  it("stays silent until the run has spent 12 calls without changing anything", () => {
    const { run } = steering({});
    drift(run, 11);
    expect(run.takeDriftNudge()).toBeNull();
    run.observeToolCall("grep");
    const nudge = run.takeDriftNudge();
    expect(nudge).toContain("<system-reminder>");
    expect(nudge).toMatch(/plan/i);
    expect(nudge).toMatch(/same turn/i);
  });

  it("escalates the developer reminder to a pushed checkpoint", () => {
    const { run } = steering({});
    drift(run, 12);
    run.takeDriftNudge();
    drift(run, 12);
    const nudge = run.takeDriftNudge();
    expect(nudge).toMatch(/git push\s+origin\s+colony\/col-1\.2/);
    expect(nudge).toMatch(/work branch/i);
  });

  it("resets the drift counter when a file is written", () => {
    const { run } = steering({});
    drift(run, 11);
    run.observeToolCall("write");
    drift(run, 11);
    expect(run.takeDriftNudge()).toBeNull();
  });

  it("counts a git push in a bash command as progress and reports it", () => {
    const { run } = steering({});
    drift(run, 12);
    run.takeDriftNudge();
    run.observeToolCall("bash", { command: "git push origin colony/col-1.2" });
    drift(run, 12);
    expect(run.takeDriftNudge()).toMatch(/push/i);
  });

  it("caps nudges at two per run", () => {
    const { run } = steering({});
    for (const _ of [1, 2]) {
      drift(run, 12);
      expect(run.takeDriftNudge()).not.toBeNull();
    }
    drift(run, 24);
    expect(run.takeDriftNudge()).toBeNull();
  });
});

describe("RunSteering role-aware guidance", () => {
  it("keeps non-developer steering read-only and submission-focused", () => {
    for (const [role, submitTool] of [
      ["architect", "the submission tool for the current planning stage"],
      ["reviewer", "submit_reviewer_verdict"],
      ["plan_reviewer", "submit_plan_review_verdict"],
    ] as const) {
      const { run } = steering({ role });
      drift(run, 12);
      const firstNudge = run.takeDriftNudge();
      drift(run, 12);
      const secondNudge = run.takeDriftNudge();
      run.observeToolCall("bash", { command: "git status" }, true);
      run.observeToolCall("bash", { command: "git status" }, true);
      const repeatNudge = run.takeRepeatFailureNudge();
      const continuation = run.takeContinuationSteer(
        "inspect the current state",
      );
      const budget = run.budgetBlock();
      const guidance = [
        firstNudge,
        secondNudge,
        repeatNudge,
        continuation,
        budget,
      ].join("\n");
      expect(guidance).toContain(submitTool);
      expect(guidance).toMatch(/read-only/i);
      const actionableGuidance = guidance
        .split("\n")
        .filter((line) => !/^\s*(?:do not|don't|never)\b/i.test(line))
        .join("\n");
      expect(actionableGuidance).not.toMatch(/\b(?:write|edit|commit|push)\b/i);
      expect(guidance).not.toMatch(
        /nothing is on .*branch|only work that survives|not pushed.*lost/i,
      );
    }
  });
});

describe("RunSteering continuation steer", () => {
  it("restates the objective, clock, push state, and completion rule", () => {
    const { run, clock } = steering({ runTimeoutMs: 60 * 60_000 });
    clock.ms = 20 * 60_000;
    const steer = run.takeContinuationSteer("col-1.2: wire the console");
    expect(steer).toContain("col-1.2: wire the console");
    expect(steer).toContain("Elapsed: 20 min of 60 min budget");
    expect(steer).toMatch(/pushed.*commit|commit.*pushed/i);
    expect(steer).toMatch(/smaller.*spec|subset.*spec/i);
  });

  it("caps continuations at three per run", () => {
    const { run } = steering({});
    for (const _ of [1, 2, 3]) {
      expect(run.takeContinuationSteer("goal")).not.toBeNull();
    }
    expect(run.takeContinuationSteer("goal")).toBeNull();
  });

  it("refuses to re-steer when the remaining budget cannot fund work", () => {
    const { run, clock } = steering({ runTimeoutMs: 30 * 60_000 });
    clock.ms = 29 * 60_000 + 30_000;
    expect(run.takeContinuationSteer("goal")).toBeNull();
  });
});

describe("RunSteering budget block", () => {
  it("states the wall clock and developer checkpoint guidance", () => {
    const { run } = steering({ runTimeoutMs: 45 * 60_000 });
    const budget = run.budgetBlock();
    expect(budget).toContain("aborted after 45 minutes");
    expect(budget).toMatch(/push/i);
  });
});

describe("packetObjective", () => {
  it("labels the goal with the task id", () => {
    expect(
      packetObjective({ task_id: "col-1.2", goal: "wire the console" }),
    ).toBe("col-1.2: wire the console");
  });

  it("falls back to the packet spec when no goal is present", () => {
    expect(packetObjective({ task_id: "col-1.2" })).toBe(
      "col-1.2: complete the task specified in this run's packet",
    );
  });
});

describe("repeated-failure nudge", () => {
  it("stays silent until the same bash command fails twice verbatim", () => {
    const steering = new RunSteering({
      role: "developer",
      runTimeoutMs: 60_000,
    });
    steering.observeToolCall("bash", { command: "npm ci" }, true);
    expect(steering.takeRepeatFailureNudge()).toBeNull();
    // A different failure resets the streak.
    steering.observeToolCall("bash", { command: "npm test" }, true);
    expect(steering.takeRepeatFailureNudge()).toBeNull();
    // Same command failing twice in a row fires.
    steering.observeToolCall("bash", { command: "npm test" }, true);
    const nudge = steering.takeRepeatFailureNudge();
    expect(nudge).toContain("failed twice in a row");
    expect(nudge).toContain("timeout parameter");
  });

  it("a success breaks the streak and the nudge is capped per run", () => {
    const steering = new RunSteering({
      role: "developer",
      runTimeoutMs: 60_000,
    });
    steering.observeToolCall("bash", { command: "x" }, true);
    steering.observeToolCall("bash", { command: "x" }, false);
    steering.observeToolCall("bash", { command: "x" }, true);
    expect(steering.takeRepeatFailureNudge()).toBeNull();

    // Two full streaks consume the cap; the third stays silent.
    for (let streak = 0; streak < 3; streak += 1) {
      steering.observeToolCall("bash", { command: "y" }, true);
      steering.observeToolCall("bash", { command: "y" }, true);
      const nudge = steering.takeRepeatFailureNudge();
      if (streak < 2) expect(nudge).not.toBeNull();
      else expect(nudge).toBeNull();
    }
  });
});
