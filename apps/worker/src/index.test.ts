import { describe, expect, it } from "vitest";
import { workerBootMessage } from "./index.js";

describe("@colony/worker", () => {
  it("resolves @colony/domain via the workspace graph", () => {
    expect(workerBootMessage()).toBe("worker:colony-domain");
  });
});
