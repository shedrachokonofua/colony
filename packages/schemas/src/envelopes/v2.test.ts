import { describe, expect, it } from "vitest";
import { ArchitectDecompositionV2 } from "./v2.js";

function validDecomposition() {
  return {
    kind: "architect_decomposition",
    summary: "a plan",
    acceptance: [{ description: "goal holds", command: "true" }],
    tasks: [{ title: "A", spec: "do A", depends_on: [] }],
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
