import { describe, expect, it } from "bun:test";
import {
  buildAdversaryPrompt,
  buildReviewerFinalizerPrompt,
  buildReviewerSystemPrompt,
  buildSpecBlindDimensionPrompt,
  buildSpecConformanceDimensionPrompt,
  createReviewerSubmitTool,
  planReviewDimensions,
} from "./pi-runner-common.js";

/**
 * The reviewer used to read the whole diff alone in one pass: every verdict
 * was a single lens over the change, and every lens had read the spec, so
 * nothing in the review could contradict the spec's framing. These tests
 * pin the coordinator that replaced it.
 */

/**
 * A string that exists only in the task spec. If it reaches a spec-blind
 * dimension prompt, that dimension is not blind.
 */
const CANARY = "CANARY-SPEC-REQUIREMENT-9f3a2b";

const SPEC = `Add a rate limiter to the API. ${CANARY} must hold.`;
const ANATOMY = [
  "- cluster: input validation",
  "- removed guard: \`if (!user.isAdmin) throw\` (git log -S: 'fix: block non-admin reads')",
  "- changed export: \`createRouter\` — 3 call sites outside the diff",
].join("\n");

function dimension(
  name: string,
  overrides: { spec_blind?: boolean; target_files?: string[] } = {},
) {
  return {
    name,
    spec_blind: overrides.spec_blind ?? true,
    target_files: overrides.target_files ?? ["src/api.ts", "src/limit.ts"],
  };
}

const blindPrompt = buildSpecBlindDimensionPrompt({
  name: "defect-scan",
  spec: SPEC,
  target_files: ["src/api.ts", "src/limit.ts"],
  context_files: ["src/context.ts"],
  anatomy: ANATOMY,
});

const conformancePrompt = buildSpecConformanceDimensionPrompt({
  name: "spec-conformance",
  spec: SPEC,
  target_files: ["src/api.ts"],
  anatomy: ANATOMY,
});

describe("reviewer coordinator prompt", () => {
  it("(a) names the four phases in order", () => {
    const prompt = buildReviewerSystemPrompt();
    const order = [1, 2, 3, 4].map((n) => prompt.indexOf(`## Phase ${n} —`));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    const sorted = [...order].sort((x, y) => x - y);
    expect(order).toEqual(sorted);
    expect(prompt).toContain("ANATOMY");
    expect(prompt).toContain("PLAN DIMENSIONS");
    expect(prompt).toContain("DELEGATE DIMENSIONS");
    expect(prompt).toContain("DELEGATE THE ADVERSARY");
  });

  it("(b) keeps the spec out of the spec-blind dimension and in the spec-conformance one", () => {
    expect(conformancePrompt).toContain(CANARY);
    expect(blindPrompt).not.toContain(CANARY);
    // Not just the canary: no part of the spec body leaks in.
    expect(blindPrompt).not.toContain("rate limiter");
    expect(blindPrompt).toContain("WITHOUT the task spec");
  });

  it("(c) clamps more than 6 dimensions and instructs exactly one adversary", () => {
    const planned = planReviewDimensions({
      spec: SPEC,
      anatomy: ANATOMY,
      dimensions: Array.from({ length: 9 }, (_, i) => dimension(`d${i}`)),
    });
    expect(planned.audit).toHaveLength(6);
    expect(planned.prompts).toHaveLength(6);

    const prompt = buildReviewerSystemPrompt();
    expect(prompt).toContain("Issue exactly ONE adversary `task` call");
    expect(prompt.match(/Issue exactly ONE adversary/g)).toHaveLength(1);
    expect(prompt).toContain("More than 6 dimensions is a planning failure");
    expect(prompt).toContain("clamp to the 6 highest-risk ones");
  });

  it("(c) emits dimensions that satisfy the envelope guards", () => {
    // 2..6 entries, at least one spec_blind.
    for (const count of [2, 3, 6, 9]) {
      const planned = planReviewDimensions({
        spec: SPEC,
        anatomy: ANATOMY,
        dimensions: Array.from({ length: count }, (_, i) => dimension(`d${i}`)),
      });
      expect(planned.audit.length).toBeGreaterThanOrEqual(2);
      expect(planned.audit.length).toBeLessThanOrEqual(6);
      expect(planned.audit.some((d) => d.spec_blind)).toBe(true);
      // Exactly one spec-aware lens, whichever the caller marked.
      expect(planned.audit.filter((d) => !d.spec_blind)).toHaveLength(1);
    }
    // A caller that marked nothing spec-aware still gets one conformance
    // lens plus spec-blind ones.
    const allAware = planReviewDimensions({
      spec: SPEC,
      anatomy: ANATOMY,
      dimensions: [
        dimension("a", { spec_blind: false }),
        dimension("b", { spec_blind: false }),
      ],
    });
    expect(allAware.audit.filter((d) => !d.spec_blind)).toHaveLength(1);
    expect(allAware.audit.filter((d) => d.spec_blind)).toHaveLength(1);
  });

  it("(d) forbids nested delegation and confines subagents to their files", () => {
    const prompt = buildReviewerSystemPrompt();
    expect(prompt).toContain("no nesting, no sub-delegation");
    expect(prompt).toContain("reads ONLY its target and context files");
    expect(blindPrompt).toContain("You do not delegate");
    expect(blindPrompt).toContain("Read ONLY these files");
  });

  it("(e) mandates the WHY checks in the spec-blind dimension prompt itself", () => {
    // Removed-guard regression check.
    expect(blindPrompt).toContain("git log -S");
    expect(blindPrompt).toContain("regression");
    // Tests as contracts: would a plausible bug fail them, and weakened /
    // renamed / pinned tests.
    expect(blindPrompt).toContain("plausible bug");
    expect(blindPrompt).toContain("weakened");
    expect(blindPrompt).toContain("renamed");
    expect(blindPrompt).toContain("pinned");
    // Error, edge, and concurrency paths.
    expect(blindPrompt).toContain("Error, edge, and concurrency");
    // Secrets and persisted error text.
    expect(blindPrompt).toContain("Secrets and persisted error text");
  });

  it("(f) states the precedence rule, drops the old escape hatch, and delegates the reading", () => {
    const prompt = buildReviewerSystemPrompt();
    expect(prompt).toContain("spec contradicts repository guarantee");
    expect(prompt).not.toContain("unless the spec explicitly demanded it");
    // The coordinator does not review the diff for findings itself: every
    // finding comes from a subagent and it only synthesizes.
    expect(prompt).toContain("You do NOT read the diff for findings yourself");
    expect(prompt).toContain(
      "All finding work belongs to the dimension subagents",
    );
    expect(prompt).not.toContain("Hunt systematically");
  });

  it("(g) names the task tool as the only delegation mechanism", () => {
    const prompt = buildReviewerSystemPrompt();
    expect(prompt).toContain("`task`");
    expect(prompt).toContain("your ONLY delegation tool");
  });
});

describe("reviewer completion contracts", () => {
  it("restates the dimension and challenged guards in the finalizer and submit tool", () => {
    const finalizer = buildReviewerFinalizerPrompt({ goal: "g" } as never);
    expect(finalizer).toContain("dimensions");
    expect(finalizer).toContain("2 to 6");
    expect(finalizer).toContain("spec_blind: true");
    expect(finalizer).toContain("challenged");
    expect(finalizer).toMatch(/reviewed MUST be >=/);

    const tool = createReviewerSubmitTool(() => {});
    expect(tool.description).toContain("2 to 6");
    expect(tool.description).toContain("spec_blind: true");
    expect(tool.description).toContain("challenged");
    expect(tool.description).toContain("reviewed >= the number of findings");
    // The tool name is part of the contract the steering test pins.
    expect(tool.name).toBe("submit_reviewer_verdict");
  });

  it("hands the adversary every candidate finding to falsify", () => {
    const adversary = buildAdversaryPrompt();
    expect(adversary).toContain("falsify");
    expect(adversary).toContain("SURVIVES");
    expect(adversary).toContain("ground no dimension covered");
    expect(adversary).toContain("REVIEWED:");
    expect(adversary).toContain("DROPPED:");
  });
});
