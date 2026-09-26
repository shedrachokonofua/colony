import { describe, expect, it } from "bun:test";
import {
  codeReviewRoundProblems,
  type CodeReviewRoundV1,
  type OpenReviewFindingV1,
  type ReviewerVerdictV2,
} from "@colony/schemas";
import {
  CODE_REVIEW_STALL_REVIEWS,
  decideReviewLoop,
  formatRejectionForRepair,
  MAX_CONSECUTIVE_REVIEW_REJECTIONS,
  openFindingsAfter,
} from "./review-loop.js";

function open(
  since_round: number,
  blocking = true,
  severity: "blocker" | "major" = "major",
): OpenReviewFindingV1 {
  return { severity, note: `raised in ${since_round}`, blocking, since_round };
}

function verdict(
  over: Partial<ReviewerVerdictV2> & Pick<ReviewerVerdictV2, "verdict">,
): ReviewerVerdictV2 {
  return {
    kind: "reviewer_verdict",
    summary: "s",
    findings: [],
    inspected: [],
    dimensions: [
      { name: "d", spec_blind: true, target_files: ["a.ts"], findings: 0 },
    ],
    challenged: { reviewed: 0, dropped: 0 },
    head_sha: "a".repeat(40),
    ...over,
  };
}

const lateRound: CodeReviewRoundV1 = {
  round: 3,
  majors_block: false,
  open_findings: [open(1), open(2, false)],
};

describe("code review round rules", () => {
  it("asks for a status on every finding the previous review left open", () => {
    expect(
      codeReviewRoundProblems(
        verdict({
          verdict: "approve",
          previous_findings: [{ finding: 1, status: "resolved" }],
        }),
        lateRound,
      ),
    ).toEqual(["no status for previous finding 2"]);
  });

  it("lets a late major approve, but not hold the change back alone", () => {
    const major = [{ severity: "major" as const, note: "late" }];
    const resolved = [
      { finding: 1, status: "resolved" as const },
      { finding: 2, status: "open" as const },
    ];
    expect(
      codeReviewRoundProblems(
        verdict({
          verdict: "request_changes",
          findings: major,
          previous_findings: resolved,
        }),
        lateRound,
      ),
    ).toHaveLength(1);
    expect(
      codeReviewRoundProblems(
        verdict({
          verdict: "approve",
          findings: major,
          previous_findings: resolved,
        }),
        lateRound,
      ),
    ).toEqual([]);
    // While majors block, the same major rejects.
    expect(
      codeReviewRoundProblems(
        verdict({ verdict: "request_changes", findings: major }),
        { round: 1, majors_block: true, open_findings: [] },
      ),
    ).toEqual([]);
  });

  it("keeps a blocking finding that still holds from being approved away", () => {
    const stillOpen = [
      { finding: 1, status: "open" as const },
      { finding: 2, status: "open" as const },
    ];
    expect(
      codeReviewRoundProblems(
        verdict({ verdict: "approve", previous_findings: stillOpen }),
        lateRound,
      ),
    ).toEqual([
      "approve cannot leave blocking previous finding 1 open; request_changes instead",
    ]);
    // A still-open blocking finding carries a rejection with no new finding.
    expect(
      codeReviewRoundProblems(
        verdict({ verdict: "request_changes", previous_findings: stillOpen }),
        lateRound,
      ),
    ).toEqual([]);
  });
});

describe("code review ledger", () => {
  it("carries what still holds, then adds new blockers and majors but no minors", () => {
    const after = openFindingsAfter(
      lateRound,
      verdict({
        verdict: "request_changes",
        findings: [
          { severity: "blocker", note: "b" },
          { severity: "major", note: "m" },
          { severity: "minor", note: "n" },
        ],
        previous_findings: [
          { finding: 1, status: "open" },
          { finding: 2, status: "resolved" },
        ],
      }),
    );
    expect(after.map((f) => [f.note, f.blocking, f.since_round])).toEqual([
      ["raised in 1", true, 1],
      ["b", true, 3],
      // Past the early reviews a new major is tracked, not blocking.
      ["m", false, 3],
    ]);
  });
});

describe("code review loop decision", () => {
  const base = {
    rejections: 1,
    round: 1,
    epochStart: 1,
    openFindings: [] as OpenReviewFindingV1[],
    operatorNotes: [] as string[],
  };

  it("stops at once for a blocker only the operator can settle", () => {
    const decision = decideReviewLoop({
      ...base,
      operatorNotes: ["Bind the shared relay queue.", "Grant the token."],
    });
    expect(decision).toEqual({
      action: "block",
      kind: "operator",
      reason:
        "code review needs an operator decision after 1 rejection: Bind the shared relay queue. (+1 more)",
    });
  });

  it("stalls when a blocking finding stays open for the stall window, counted within the epoch", () => {
    const stuck = { ...base, rejections: 3, round: 3, openFindings: [open(1)] };
    expect(decideReviewLoop(stuck)).toMatchObject({
      action: "block",
      kind: "stalled",
    });
    // One review short of the window: back to the implementer.
    expect(decideReviewLoop({ ...stuck, round: 2 })).toEqual({
      action: "requeue",
    });
    // A tracked (non-blocking) finding never stalls the loop.
    expect(
      decideReviewLoop({ ...stuck, openFindings: [open(1, false)] }),
    ).toEqual({ action: "requeue" });
    // After an operator reset at review 3, the same finding starts over.
    expect(
      decideReviewLoop({
        ...stuck,
        round: 3 + CODE_REVIEW_STALL_REVIEWS - 2,
        epochStart: 3,
      }),
    ).toEqual({ action: "requeue" });
  });

  it("caps consecutive rejections in an epoch", () => {
    expect(
      decideReviewLoop({
        ...base,
        rejections: MAX_CONSECUTIVE_REVIEW_REJECTIONS,
        round: MAX_CONSECUTIVE_REVIEW_REJECTIONS,
      }),
    ).toEqual({
      action: "block",
      kind: "cap",
      reason: `code review rejected ${MAX_CONSECUTIVE_REVIEW_REJECTIONS} consecutive times`,
    });
  });
});

describe("rejection as the implementer reads it", () => {
  it("separates blocking, tracked, and optional findings", () => {
    const text = formatRejectionForRepair(
      JSON.stringify({
        verdict: "request_changes",
        findings: [{ severity: "minor", note: "rename" }],
        open_findings: [
          { ...open(1), file: "a.ts", note: "crash on retry" },
          { ...open(3, false), note: "unbounded body" },
        ],
      }),
    )!;
    const blocking = text.indexOf("Blocking");
    const tracked = text.indexOf("Tracked, not blocking");
    const minor = text.indexOf("Minor - optional");
    expect(blocking).toBeGreaterThanOrEqual(0);
    expect(tracked).toBeGreaterThan(blocking);
    expect(minor).toBeGreaterThan(tracked);
    expect(text).toContain("- **major** `a.ts`: crash on retry");
  });

  it("renders a verdict recorded before the ledger as its findings", () => {
    expect(
      formatRejectionForRepair(
        JSON.stringify({
          verdict: "request_changes",
          findings: [{ severity: "major", file: "a.ts", note: "old" }],
        }),
      ),
    ).toBe("- **major** `a.ts`: old");
  });
});
