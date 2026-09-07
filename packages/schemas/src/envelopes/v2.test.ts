import { describe, expect, it } from "bun:test";
import {
  ArchitectDecompositionV2,
  RepairIntentV1,
  ReviewerVerdictV2,
} from "./v2.js";

function validDecomposition() {
  return {
    kind: "architect_decomposition",
    summary: "a plan",
    requirements: [{ id: "R1", text: "goal holds", tasks: [0] }],
    journey: [{ after_task: 0, working_state: "goal holds" }],
    acceptance: [{ description: "goal holds", command: "true" }],
    tasks: [
      {
        title: "A",
        spec: "do A",
        depends_on: [],
        files: ["src/a.ts"],
        evidence: ["true"],
      },
    ],
  };
}

describe("ArchitectDecompositionV2", () => {
  it("parses a decomposition with an acceptance array of at least one entry", () => {
    const parsed = ArchitectDecompositionV2.safeParse(validDecomposition());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.acceptance).toHaveLength(1);
    }
  });

  it("rejects a task no requirement delivers, and a journey that stops short", () => {
    const base = validDecomposition();
    const padded = ArchitectDecompositionV2.safeParse({
      ...base,
      tasks: [
        ...base.tasks,
        {
          title: "B",
          spec: "do B",
          depends_on: [0],
          files: ["src/b.ts"],
          evidence: ["true"],
        },
      ],
      journey: [{ after_task: 1, working_state: "goal holds" }],
    });
    expect(padded.success).toBe(false);
    if (!padded.success) {
      expect(padded.error.issues.map((i) => i.message).join(" ")).toContain(
        "task 1 delivers no requirement",
      );
    }
    const short = ArchitectDecompositionV2.safeParse({
      ...base,
      requirements: [{ id: "R1", text: "goal holds", tasks: [0, 1] }],
      tasks: [
        ...base.tasks,
        {
          title: "B",
          spec: "do B",
          depends_on: [0],
          files: ["src/b.ts"],
          evidence: ["true"],
        },
      ],
      journey: [{ after_task: 0, working_state: "A holds" }],
    });
    expect(short.success).toBe(false);
    if (!short.success) {
      expect(short.error.issues.map((i) => i.message).join(" ")).toContain(
        "journey must end at the last task",
      );
    }
  });

  it("rejects an empty acceptance array", () => {
    const parsed = ArchitectDecompositionV2.safeParse({
      ...validDecomposition(),
      acceptance: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a decomposition missing acceptance", () => {
    const { acceptance: _acceptance, ...rest } = validDecomposition();
    const parsed = ArchitectDecompositionV2.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  it("rejects an acceptance item missing description", () => {
    const parsed = ArchitectDecompositionV2.safeParse({
      ...validDecomposition(),
      acceptance: [{ command: "true" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an acceptance item missing command", () => {
    const parsed = ArchitectDecompositionV2.safeParse({
      ...validDecomposition(),
      acceptance: [{ description: "goal holds" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects extra keys on an acceptance item (strict)", () => {
    const parsed = ArchitectDecompositionV2.safeParse({
      ...validDecomposition(),
      acceptance: [
        { description: "goal holds", command: "true", extra: "nope" },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects extra keys on the envelope (strict)", () => {
    const parsed = ArchitectDecompositionV2.safeParse({
      ...validDecomposition(),
      extra: "nope",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("ReviewerVerdictV2", () => {
  const sha40 = "a".repeat(40);
  const longSummary =
    "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.";

  function validApprove() {
    return {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary: longSummary,
      findings: [],
      inspected: [{ file: "src/main.ts", note: "checked against the task spec" }],
      dimensions: [
        { name: "spec-compliance", spec_blind: false, target_files: ["src/main.ts"], findings: 0 },
        { name: "adversarial-defect-scan", spec_blind: true, target_files: ["src/main.ts"], findings: 0 },
      ],
      challenged: { reviewed: 2, dropped: 1 },
      head_sha: sha40,
    };
  }

  it("accepts a valid adversarial approve envelope", () => {
    expect(ReviewerVerdictV2.safeParse(validApprove()).success).toBe(true);
  });

  it("rejects an approve with no spec_blind dimension", () => {
    const parsed = ReviewerVerdictV2.safeParse({
      ...validApprove(),
      dimensions: [
        { name: "spec-compliance", spec_blind: false, target_files: ["src/main.ts"], findings: 0 },
        { name: "style", spec_blind: false, target_files: ["src/main.ts"], findings: 0 },
      ],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(" ")).toContain("spec_blind");
    }
  });

  it("rejects a verdict whose challenged.reviewed is below the findings total", () => {
    const parsed = ReviewerVerdictV2.safeParse({
      ...validApprove(),
      verdict: "request_changes",
      summary: "Missing test.",
      findings: [{ severity: "major", note: "no test for the 404 branch" }],
      challenged: { reviewed: 0, dropped: 0 },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(" ")).toContain("challenged.reviewed");
    }
  });
});

describe("RepairIntentV1", () => {
  const sha40 = "a".repeat(40);

  it("parses a CI-failure intent with provider metadata and evidence", () => {
    const parsed = RepairIntentV1.safeParse({
      kind: "ci_failure",
      source_head_sha: sha40,
      provider: {
        pipeline_id: "77",
        pipeline_url: "https://gitlab.test/p/-/pipelines/77",
        job_ids: ["901"],
        job_names: ["unit"],
        job_urls: ["https://gitlab.test/p/-/jobs/901"],
      },
      evidence: ["unit: FAIL src/a.test.ts"],
    });
    expect(parsed.success).toBe(true);
  });

  it("defaults evidence to empty and allows omitting provider metadata", () => {
    const parsed = RepairIntentV1.parse({
      kind: "merge_gate_failure",
      source_head_sha: sha40,
    });
    expect(parsed.evidence).toEqual([]);
    expect(parsed.provider).toBeUndefined();
  });

  it("rejects an unknown kind and a non-sha source head", () => {
    expect(
      RepairIntentV1.safeParse({
        kind: "pipeline_stalled",
        source_head_sha: sha40,
      }).success,
    ).toBe(false);
    expect(
      RepairIntentV1.safeParse({
        kind: "ci_failure",
        source_head_sha: "not-a-sha",
      }).success,
    ).toBe(false);
  });

  it("rejects extra keys (strict)", () => {
    expect(
      RepairIntentV1.safeParse({
        kind: "ci_failure",
        source_head_sha: sha40,
        raw_log: "huge log blob",
      }).success,
    ).toBe(false);
  });
});
