import { describe, expect, it } from "vitest";
import { isReReviewEligible } from "./gate-evaluation.js";

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
