import { describe, expect, it } from "vitest";
import { isReReviewEligible, evaluateMrGate } from "./gate-evaluation.js";

describe("re-review eligibility", () => {
  it("does not trigger while the current-head pipeline is failing", () => {
    expect(
      isReReviewEligible({
        missing: ["reviewer", "human"],
        head_commit_sha: "head-1",
        pipeline_status: "failed",
        pipeline_commit_sha: "head-1",
      }),
    ).toBe(false);
  });
});

describe("evaluateMrGate pipeline selection", () => {
  const gate = {
    id: "gate-1",
    required_approvals: ["reviewer", "human"],
  } as unknown as Parameters<typeof evaluateMrGate>[0]["gate"];

  // Regression: a task accumulates one pipeline mirror per pipeline id. The
  // gate used to read an arbitrary row, so a branch whose head had since gone
  // green kept being evaluated against an older failed run and could never
  // open. Only the pipeline recorded for the current head may decide the gate.
  it("blocks when the pipeline at the current head failed", () => {
    const result = evaluateMrGate({
      gate,
      head_commit_sha: "head-2",
      approvals: [],
      pipeline_status: "failed",
      pipeline_commit_sha: "head-2",
    } as unknown as Parameters<typeof evaluateMrGate>[0]);
    expect(result.open).toBe(false);
    expect(result.reasons.join(" ")).toContain("pipeline");
  });

  it("does not treat a green pipeline from an older commit as current", () => {
    const result = evaluateMrGate({
      gate,
      head_commit_sha: "head-2",
      approvals: [],
      pipeline_status: "success",
      pipeline_commit_sha: "head-1",
    } as unknown as Parameters<typeof evaluateMrGate>[0]);
    expect(result.open).toBe(false);
    expect(result.reasons.join(" ")).toContain("head-1");
  });
});
