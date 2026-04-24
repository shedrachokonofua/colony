import { describe, expect, it } from "vitest";
import { healthCheckWorkflow } from "./workflows.js";

describe("@colony/worker", () => {
  it("exposes the placeholder health workflow", async () => {
    await expect(healthCheckWorkflow()).resolves.toBe("ok");
  });
});
