import { describe, expect, it } from "bun:test";
import {
  buildSpecBlindDimensionPrompt,
  buildSpecConformanceDimensionPrompt,
  planReviewDimensions,
} from "./pi-runner-common.js";

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
  it("keeps the spec out of the spec-blind dimension and in the spec-conformance one", () => {
    expect(conformancePrompt).toContain(CANARY);
    expect(blindPrompt).not.toContain(CANARY);
    // Not just the canary: no part of the spec body leaks in.
    expect(blindPrompt).not.toContain("rate limiter");
  });

  it("emits dimensions that satisfy the envelope guards", () => {
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
});
