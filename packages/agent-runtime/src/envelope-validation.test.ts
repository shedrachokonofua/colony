import { describe, expect, it } from "bun:test";

import type { ArchitectDecompositionV2 } from "@colony/schemas";

import { validateDecompositionEnvelope } from "./envelope-validation.js";

function envelopeWithTasks(
  tasks: Array<
    Partial<ArchitectDecompositionV2["tasks"][number]> & {
      title: string;
      spec: string;
    }
  >,
): ArchitectDecompositionV2 {
  // The zod schema defaults depends_on to []; mirror that here so test
  // envelopes match post-parse shape.
  return {
    kind: "architect_decomposition",
    summary: "Scope summary.",
    acceptance: [{ description: "Suite passes.", command: "npm test" }],
    tasks: tasks.map((task) => ({ depends_on: [], ...task })),
  };
}

const quietSpec = "Wire the exporter so the CLI prints the totals table.";

describe("validateDecompositionEnvelope", () => {
  it("flags a depends_on index outside the tasks array", () => {
    const errors = validateDecompositionEnvelope(
      envelopeWithTasks([
        { title: "First", spec: quietSpec, depends_on: [3] },
        { title: "Second", spec: quietSpec },
      ]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe("depends_on_range");
    expect(errors[0].taskIndex).toBe(0);
    expect(errors[0].message).toContain("index 3");
    expect(errors[0].message).toContain("2 entries");
    expect(errors[0].message).toContain("First");
  });

  it("flags a cycle across tasks and a self-edge", () => {
    const cyclic = envelopeWithTasks([
      { title: "A", spec: quietSpec, depends_on: [1] },
      { title: "B", spec: quietSpec, depends_on: [0] },
      { title: "C", spec: quietSpec, depends_on: [2] },
    ]);
    const errors = validateDecompositionEnvelope(cyclic);
    expect(errors.filter((e) => e.rule === "depends_on_cycle")).toHaveLength(1);
    expect(
      errors.find((e) => e.rule === "depends_on_cycle")?.message,
    ).toContain("0, 1, 2");
  });

  it("flags phantom-dependency phrasing only when depends_on is empty", () => {
    const spec =
      "Consume the contract produced by a sibling task; stop and report if it is missing.";
    const flagged = validateDecompositionEnvelope(
      envelopeWithTasks([
        { title: "Producer", spec: quietSpec },
        { title: "Consumer", spec, depends_on: [0] },
        { title: "Orphan", spec },
      ]),
    );
    const orphan = flagged.filter((e) => e.rule === "phantom_dependency");
    expect(orphan).toHaveLength(1);
    expect(orphan[0].taskIndex).toBe(2);
    expect(orphan[0].message).toContain("produced by a sibling task");
    expect(orphan[0].message).toContain("depends_on");
    expect(flagged.find((e) => e.taskIndex === 1)).toBeUndefined();
  });

  it("flags unrelated tasks that reference the same file path", () => {
    const shared = `Edit apps/colonyd/src/tick.ts to emit the heartbeat.`;
    const errors = validateDecompositionEnvelope(
      envelopeWithTasks([
        { title: "Emitter", spec: shared },
        { title: "Formatter", spec: shared },
      ]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe("shared_file_without_edge");
    expect(errors[0].message).toContain("apps/colonyd/src/tick.ts");
    expect(errors[0].message).toContain("Emitter");
    expect(errors[0].message).toContain("Formatter");
  });

  it("accepts transitively connected tasks that share a path (A<-B<-C)", () => {
    const shared = "Update packages/core/src/store.ts for the new cache.";
    const errors = validateDecompositionEnvelope(
      envelopeWithTasks([
        { title: "Base cache", spec: shared },
        { title: "Middle", spec: quietSpec, depends_on: [0] },
        { title: "Top cache", spec: shared, depends_on: [1] },
      ]),
    );
    expect(errors).toEqual([]);
  });

  it("returns no errors for a fully valid envelope", () => {
    const errors = validateDecompositionEnvelope(
      envelopeWithTasks([
        {
          title: "Schema",
          spec: "Add packages/core/src/types.ts with the DTO.",
        },
        {
          title: "API",
          spec: "Add apps/colonyd/src/routes/api.ts serving the DTO.",
          depends_on: [0],
        },
        {
          title: "Console",
          spec: "Render the payload in packages/console/app.js.",
          depends_on: [1],
        },
      ]),
    );
    expect(errors).toEqual([]);
  });
});
