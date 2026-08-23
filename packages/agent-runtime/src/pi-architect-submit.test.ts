import { describe, expect, it } from "bun:test";

import { createArchitectSubmitTool } from "./pi-runner-common.js";

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
});
