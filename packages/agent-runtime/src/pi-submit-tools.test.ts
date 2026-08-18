import { describe, expect, it } from "vitest";

import { createImplementerSubmitTool } from "./pi-runner-common.js";

const completion = {
  kind: "implementer_completion" as const,
  status: "complete" as const,
  summary: "Implemented the requested change.",
  branch: "colony/col-a1b2c3d4.1",
  head_sha: "a".repeat(40),
  commands: [],
};

describe("implementer submission", () => {
  it("rejects missing evidence, then accepts a corrected submission", async () => {
    let captured: unknown;
    const tool = createImplementerSubmitTool((value) => {
      captured = value;
    });

    await expect(
      tool.execute(
        "submit-1",
        completion,
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("requires command evidence");
    expect(captured).toBeUndefined();

    const corrected = {
      ...completion,
      commands: [{ cmd: "npm test", exit_code: 0 }],
    };
    const accepted = await tool.execute(
      "submit-2",
      corrected,
      undefined,
      undefined,
      undefined as never,
    );

    expect(accepted.terminate).toBe(true);
    expect(captured).toEqual(corrected);
  });
});
