import { describe, expect, it } from "bun:test";
import { createReviewerSubmitTool } from "./pi-runner-common.js";

const HEAD = "a".repeat(40);

describe("reviewer submit tool", () => {
  // 123 of 123 approvals in one 48h window (2026-09-02) carried zero findings
  // and a summary under 80 chars: the schema permitted "LGTM". An approve is a
  // claim about the diff and must name what it rests on.
  it("refuses an approve with nothing inspected or a one-line summary", async () => {
    let captured: unknown;
    const tool = createReviewerSubmitTool((value) => {
      captured = value;
    });
    await expect(
      tool.execute(
        "t1",
        {
          kind: "reviewer_verdict",
          verdict: "approve",
          summary: "LGTM",
          findings: [],
          inspected: [],
          head_sha: HEAD,
        },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(/approve requires at least one inspected file/);
    await expect(
      tool.execute(
        "t2",
        {
          kind: "reviewer_verdict",
          verdict: "approve",
          summary: "Looks good.",
          findings: [],
          inspected: [{ file: "src/main.ts", note: "matches the spec" }],
          head_sha: HEAD,
        },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(/substantive summary/);
    expect(captured).toBeUndefined();
  });

  it("accepts a substantive approve and a request_changes with findings", async () => {
    const seen: unknown[] = [];
    const tool = createReviewerSubmitTool((value) => {
      seen.push(value);
    });
    await tool.execute(
      "t3",
      {
        kind: "reviewer_verdict",
        verdict: "approve",
        summary:
          "The endpoint returns the build SHA as JSON and the acceptance test asserts on it; error branches are covered.",
        findings: [],
        inspected: [
          { file: "src/http.ts", note: "route shape matches the spec" },
          { file: "test/version.test.ts", note: "asserts the JSON body" },
        ],
        head_sha: HEAD,
      },
      undefined,
      undefined,
      undefined as never,
    );
    await tool.execute(
      "t4",
      {
        kind: "reviewer_verdict",
        verdict: "request_changes",
        summary: "Missing test.",
        findings: [{ severity: "major", note: "no test for the 404 branch" }],
        head_sha: HEAD,
      },
      undefined,
      undefined,
      undefined as never,
    );
    expect(seen).toHaveLength(2);
    expect((seen[0] as { inspected: unknown[] }).inspected).toHaveLength(2);
    // request_changes does not require inspection - findings are the evidence.
    expect((seen[1] as { inspected: unknown[] }).inspected).toEqual([]);
  });
});
