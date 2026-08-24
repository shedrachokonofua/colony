import { describe, expect, it } from "bun:test";
import type { ScopeId, TaskId } from "@colony/domain";
import {
  DEFAULT_IMPLEMENTER_BUDGET_MS,
  buildTaskCostModel,
  predictTaskCost,
} from "./task-cost.js";
import type { Run } from "./store.js";

// No real *.db ships in the repo: these fixtures mirror the runs table
// schema (packages/core/src/schema.sql) as `Run` objects, the same rows
// `SELECT * FROM runs` hands to buildTaskCostModel.
let seq = 0;
function runFixture(
  overrides: Partial<Run> & Pick<Run, "kind" | "status">,
): Run {
  seq += 1;
  return {
    id: `run-${seq}`,
    scope_id: "col-00000001" as ScopeId,
    task_id: null,
    lease_expires_at: "2026-01-01T01:00:00.000Z",
    base_sha: null,
    head_sha: null,
    workspace_path: null,
    envelope_json: null,
    evidence_json: null,
    token_id: null,
    model_id: null,
    trace_id: null,
    error: null,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: null,
    ...overrides,
  };
}

const TASK_ID = "col-00000001.1" as TaskId;
const HEAD_SHA = "a".repeat(40);

/** Succeeded gate row whose evidence lists `n` changed files. */
function gateRow(
  taskId: TaskId | null,
  nFiles: number,
  reason = "merge_accepted",
): Run {
  return runFixture({
    kind: "merge_gate",
    status: "succeeded",
    task_id: taskId,
    evidence_json: JSON.stringify({
      reason,
      head_sha: HEAD_SHA,
      ...(reason === "merge_accepted"
        ? {
            files_changed: Array.from({ length: nFiles }, (_, i) => `f${i}.ts`),
          }
        : {}),
    }),
  });
}

/** Succeeded implement row spanning `minutes` of session wall clock. */
function implementRow(
  taskId: TaskId | null,
  minutes: number,
  finishedAt = "2026-01-01T01:00:00.000Z",
): Run {
  return runFixture({
    kind: "implement",
    status: "succeeded",
    task_id: taskId,
    started_at: new Date(
      Date.parse(finishedAt) - minutes * 60_000,
    ).toISOString(),
    finished_at: finishedAt,
  });
}

describe("buildTaskCostModel", () => {
  it("joins a succeeded gate's file list to the implement run's wall clock", () => {
    // 30 min session across a 3-file change: 1_800_000 / 3.
    const model = buildTaskCostModel([
      implementRow(TASK_ID, 30),
      gateRow(TASK_ID, 3),
    ]);
    expect(model.version).toBe("v1");
    expect(model.sample_size).toBe(1);
    expect(model.ms_per_file).toBe(600_000);
  });

  it("yields no sample from either half alone", () => {
    const gateOnly = buildTaskCostModel([gateRow(TASK_ID, 3)]);
    expect(gateOnly.sample_size).toBe(0);
    expect(gateOnly.ms_per_file).toBe(0);

    const implementOnly = buildTaskCostModel([implementRow(TASK_ID, 30)]);
    expect(implementOnly.sample_size).toBe(0);
    expect(implementOnly.ms_per_file).toBe(0);
  });

  it("ignores gate evidence lacking files_changed", () => {
    const model = buildTaskCostModel([
      runFixture({
        kind: "merge_gate",
        status: "succeeded",
        task_id: TASK_ID,
        evidence_json: JSON.stringify({
          reason: "merge_accepted",
          head_sha: HEAD_SHA,
        }),
      }),
      implementRow(TASK_ID, 30),
    ]);
    expect(model.sample_size).toBe(0);
    expect(model.ms_per_file).toBe(0);
  });

  it("counts one sample per succeeded implement attempt of a task", () => {
    // Two attempts (20 and 40 min) against one 3-file change set:
    // median of [400_000, 800_000] is their mean.
    const model = buildTaskCostModel([
      implementRow(TASK_ID, 20, "2026-01-01T01:00:00.000Z"),
      implementRow(TASK_ID, 40, "2026-01-02T01:00:00.000Z"),
      gateRow(TASK_ID, 3),
    ]);
    expect(model.sample_size).toBe(2);
    expect(model.ms_per_file).toBe(600_000);
  });

  it("drops failed runs, scope-level rows, and non-positive durations", () => {
    const model = buildTaskCostModel([
      runFixture({ kind: "implement", status: "failed", task_id: TASK_ID }),
      runFixture({ kind: "merge_gate", status: "failed", task_id: TASK_ID }),
      // architect runs carry no task_id even when succeeded.
      runFixture({ kind: "architect", status: "succeeded" }),
      // Same wall clock start and finish: no usable duration.
      implementRow(TASK_ID, 0),
      gateRow(TASK_ID, 3),
    ]);
    expect(model.sample_size).toBe(0);
  });

  it("predicts zero on an empty database", () => {
    const model = buildTaskCostModel([]);
    expect(model.sample_size).toBe(0);
    expect(model.ms_per_file).toBe(0);
  });
});

describe("predictTaskCost", () => {
  it("never flags with a zero-history model", () => {
    const empty = buildTaskCostModel([]);
    const prediction = predictTaskCost(empty, ["a.ts", "b.ts"], 900_000);
    expect(prediction.predicted_ms).toBe(0);
    expect(prediction.flagged).toBe(false);
    expect(prediction.model_version).toBe("v1");
    expect(prediction.budget_ms).toBe(900_000);
  });

  it("is monotonic: more files never predicts less", () => {
    const model = buildTaskCostModel([
      implementRow(TASK_ID, 30),
      gateRow(TASK_ID, 3),
    ]);
    let previous = -1;
    for (let n = 0; n <= 10; n += 1) {
      const prediction = predictTaskCost(
        model,
        Array.from({ length: n }, (_, i) => `f${i}.ts`),
        10_000_000,
      );
      expect(prediction.predicted_ms).toBeGreaterThanOrEqual(previous);
      expect(prediction.files_touched).toBe(n);
      previous = prediction.predicted_ms;
    }
  });

  it("flags exactly when the prediction exceeds the budget", () => {
    // Model: 300_000 ms per file (15 min across 3 files). Three files
    // predict exactly the developer-ceiling budget — equal, never flags;
    // the strict inequality only trips past it.
    const model = buildTaskCostModel([
      implementRow(TASK_ID, 15),
      gateRow(TASK_ID, 3),
    ]);
    expect(model.ms_per_file).toBe(300_000);
    const at = predictTaskCost(
      model,
      ["a.ts", "b.ts", "c.ts"],
      DEFAULT_IMPLEMENTER_BUDGET_MS,
    );
    expect(at.predicted_ms).toBe(DEFAULT_IMPLEMENTER_BUDGET_MS);
    expect(at.flagged).toBe(false);
    const over = predictTaskCost(
      model,
      ["a.ts", "b.ts", "c.ts", "d.ts"],
      DEFAULT_IMPLEMENTER_BUDGET_MS,
    );
    expect(over.predicted_ms).toBeGreaterThan(DEFAULT_IMPLEMENTER_BUDGET_MS);
    expect(over.flagged).toBe(true);
  });

  it("deduplicates the input list into inputs.files", () => {
    const prediction = predictTaskCost(
      buildTaskCostModel([]),
      ["src/a.ts", "src/b.ts", "src/a.ts"],
      900_000,
    );
    expect(prediction.inputs.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(prediction.files_touched).toBe(2);
  });
});
