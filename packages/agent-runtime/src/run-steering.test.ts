import { describe, expect, it } from "vitest";
import { RunSteering, packetObjective } from "./run-steering.js";

function steering(overrides: {
  runTimeoutMs?: number;
  clock?: { ms: number };
}) {
  const clock = overrides.clock ?? { ms: 0 };
  return {
    clock,
    run: new RunSteering({
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
    expect(nudge).toContain("write the plan you will execute");
    expect(nudge).toContain("do not end your turn on the plan");
  });

  it("escalates the second reminder to a pushed checkpoint", () => {
    const { run } = steering({});
    drift(run, 12);
    run.takeDriftNudge();
    drift(run, 12);
    const nudge = run.takeDriftNudge();
    expect(nudge).toContain("git push origin colony/col-1.2");
    expect(nudge).toContain("Nothing is on the work branch yet");
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
    expect(run.takeDriftNudge()).toContain(
      "Your pushed commit is the only work that survives",
    );
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

describe("RunSteering continuation steer", () => {
  it("restates the objective, the clock, and whether anything is pushed", () => {
    const { run, clock } = steering({ runTimeoutMs: 60 * 60_000 });
    clock.ms = 20 * 60_000;
    const steer = run.takeContinuationSteer("col-1.2: wire the console");
    expect(steer).toContain("col-1.2: wire the console");
    expect(steer).toContain("Elapsed: 20 min of 60 min budget");
    expect(steer).toContain("Pushed a commit so far: no");
    expect(steer).toContain("NEVER redefine success as a smaller");
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
  it("states the wall clock the guard will enforce", () => {
    const { run } = steering({ runTimeoutMs: 45 * 60_000 });
    expect(run.budgetBlock()).toContain("aborted after 45 minutes");
    expect(run.budgetBlock()).toContain("not pushed when it ends is lost");
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
