import { describe, expect, it } from "bun:test";
import { ArchitectDecompositionV2 } from "./v2.js";

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
