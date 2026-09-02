import { describe, expect, it } from "bun:test";

import { createArchitectSubmitTool } from "./pi-runner-common.js";
import { createArchitectExtensionSubmitTool } from "./architect-extension.js";
function decomposition(
  tasks: Array<{ title: string; spec: string; depends_on?: number[] }>,
) {
  // The zod schema defaults depends_on to []; mirror that so the accepted
  // envelope compares equal to what zod parses.
  return {
    kind: "architect_decomposition" as const,
    summary: "Plan the scope.",
    acceptance: [{ description: "Tests pass.", command: "npm test" }],
    tasks: tasks.map((task) => ({ depends_on: [], ...task })),
  };
}

const producer = {
  title: "Producer",
  spec: "Add the contract in packages/core/src/store.ts.",
};

describe("architect submission", () => {
  it("rejects a phantom dependency, then accepts a corrected plan", async () => {
    let captured: unknown;
    const tool = createArchitectSubmitTool((value) => {
      captured = value;
    });

    const defective = decomposition([
      producer,
      {
        title: "Consumer",
        spec: "Consume the store contract produced by a sibling task; stop and report if it is missing.",
      },
    ]);
    await expect(
      tool.execute(
        "submit-1",
        defective,
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(/mechanical validation/);
    await expect(
      tool.execute(
        "submit-1b",
        defective,
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("Consumer");
    expect(captured).toBeUndefined();

    const corrected = decomposition([
      producer,
      {
        title: "Consumer",
        spec: "Consume the store contract exported from packages/core/src/store.ts.",
        depends_on: [0],
      },
    ]);
    await tool.execute(
      "submit-2",
      corrected,
      undefined,
      undefined,
      undefined as never,
    );
    expect(captured).toEqual(corrected);
  });

  it("rejects unrelated tasks that share a file path", async () => {
    let captured: unknown;
    const tool = createArchitectSubmitTool((value) => {
      captured = value;
    });

    await expect(
      tool.execute(
        "submit-1",
        decomposition([
          { title: "A", spec: "Extend packages/core/src/store.ts with TTLs." },
          { title: "B", spec: "Refactor packages/core/src/store.ts getters." },
        ]),
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("packages/core/src/store.ts");
    expect(captured).toBeUndefined();
  });

  it("rejects an out-of-range depends_on index", async () => {
    let captured: unknown;
    const tool = createArchitectSubmitTool((value) => {
      captured = value;
    });

    await expect(
      tool.execute(
        "submit-1",
        decomposition([
          producer,
          { title: "B", spec: "Wire the CLI.", depends_on: [5] },
        ]),
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(/depends_on index 5/);
    expect(captured).toBeUndefined();
  });

  it("rejects a cyclic depends_on graph", async () => {
    let captured: unknown;
    const tool = createArchitectSubmitTool((value) => {
      captured = value;
    });

    await expect(
      tool.execute(
        "submit-1",
        decomposition([
          { title: "A", spec: "Build the schema.", depends_on: [1] },
          { title: "B", spec: "Build the API.", depends_on: [0] },
        ]),
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("dependency cycle");
    expect(captured).toBeUndefined();
  });

  describe("with an architect size gate", () => {
    // Three distinct real repo paths * 600_000 ms/file = 1.8M ms, well past
    // the 900_000 ms developer budget; one path stays under it.
    const oversizedSpec = [
      "Extend packages/core/src/store.ts, packages/core/src/cache.ts and",
      "apps/colonyd/src/tick.ts to ship the feature.",
    ].join(" ");
    const tightGate = {
      model: { version: "v1" as const, sample_size: 3, ms_per_file: 600_000 },
      budget_ms: 900_000,
    };

    it("rejects an oversized task naming rule, prediction and budget, then accepts the re-planned envelope under a generous gate", async () => {
      let captured: unknown;
      const tool = createArchitectSubmitTool((value) => {
        captured = value;
      }, tightGate);

      const oversized = decomposition([
        { title: "Monster", spec: oversizedSpec },
      ]);
      const rejection = tool.execute(
        "submit-gate",
        oversized,
        undefined,
        undefined,
        undefined as never,
      );
      await expect(rejection).rejects.toThrow("task_over_budget");
      await expect(rejection).rejects.toThrow(
        "predicted 1800000 ms from 3 spec file paths (model v1, 3 samples)",
      );
      await expect(rejection).rejects.toThrow(
        "exceeds the 900000 ms implementer budget",
      );
      expect(captured).toBeUndefined();

      // Same envelope shape, generous budget: accepted and captured.
      let generousCaptured: unknown;
      const generousTool = createArchitectSubmitTool(
        (value) => {
          generousCaptured = value;
        },
        { ...tightGate, budget_ms: Number.MAX_SAFE_INTEGER },
      );
      await generousTool.execute(
        "submit-gate-ok",
        oversized,
        undefined,
        undefined,
        undefined as never,
      );
      expect(generousCaptured).toEqual(oversized);
    });

    it("keeps DAG-defect rejections on the same replan path alongside size errors", async () => {
      let captured: unknown;
      const tool = createArchitectSubmitTool((value) => {
        captured = value;
      }, tightGate);

      const defective = decomposition([
        producer,
        {
          title: "Consumer",
          spec: `Consume the store contract produced by a sibling task via ${oversizedSpec}`,
        },
      ]);
      const rejection = tool.execute(
        "submit-mixed",
        defective,
        undefined,
        undefined,
        undefined as never,
      );
      await expect(rejection).rejects.toThrow("task_over_budget");
      await expect(rejection).rejects.toThrow(/mechanical validation/);
      expect(captured).toBeUndefined();
    });
  });
  it("accepts an acceptance fix and validates extension dependencies", async () => {
    let captured: unknown;
    const tool = createArchitectExtensionSubmitTool(
      (value) => {
        captured = value;
      },
      [{ id: "col-abcd.1", depends_on: [] }],
    );
    await tool.execute(
      "extension-fix",
      {
        kind: "acceptance_fix",
        acceptance: [{ description: "unit", command: "bun run test:unit" }],
      },
      undefined,
      undefined,
      undefined as never,
    );
    expect(captured).toMatchObject({ kind: "acceptance_fix" });

    captured = undefined;
    await tool.execute(
      "extension-tasks",
      {
        kind: "extend",
        tasks: [
          {
            title: "Repair",
            spec: "repair packages/core/src/store.ts",
            depends_on: ["col-abcd.1"],
          },
          {
            title: "Verify",
            spec: "verify packages/core/src/store.ts",
            depends_on: [0],
          },
        ],
      },
      undefined,
      undefined,
      undefined as never,
    );
    expect(captured).toMatchObject({ kind: "extend" });
  });

  it("infers the envelope kind from shape when the model omits it", async () => {
    // Every extension submission on 2026-09-01 arrived without `kind`
    // (a top-level union parameter schema flattened in transit) and was
    // rejected 14-15 times per run. Shape is unambiguous; infer it.
    let captured: unknown;
    const tool = createArchitectExtensionSubmitTool(
      (value) => {
        captured = value;
      },
      [{ id: "col-abcd.1", depends_on: [] }],
    );
    await tool.execute(
      "no-kind-extend",
      { tasks: [{ title: "Fix flaky test", spec: "Pin the clock." }] },
      undefined,
      undefined,
      undefined as never,
    );
    expect(captured).toMatchObject({ kind: "extend" });

    await tool.execute(
      "no-kind-human",
      { reason: "Needs a credential only an operator holds." },
      undefined,
      undefined,
      undefined as never,
    );
    expect(captured).toMatchObject({ kind: "human_required" });

    await tool.execute(
      "no-kind-acceptance",
      { acceptance: [{ description: "unit", command: "bun run test:unit" }] },
      undefined,
      undefined,
      undefined as never,
    );
    expect(captured).toMatchObject({ kind: "acceptance_fix" });

    // Nothing recognisable: still a schema error, still teaches the kinds.
    await expect(
      tool.execute(
        "no-kind-empty",
        {},
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(/kind/);
  });

  it("rejects an extension cycle and unknown existing dependency", async () => {
    const tool = createArchitectExtensionSubmitTool(() => {}, [
      { id: "col-abcd.1", depends_on: [] },
    ]);
    await expect(
      tool.execute(
        "extension-cycle",
        {
          kind: "extend",
          tasks: [
            { title: "A", spec: "a", depends_on: [1] },
            { title: "B", spec: "b", depends_on: [0] },
          ],
        },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("dependency cycle");
    await expect(
      tool.execute(
        "extension-unknown",
        {
          kind: "extend",
          tasks: [{ title: "A", spec: "a", depends_on: ["col-missing.9"] }],
        },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("unknown existing task id");
  });
});
