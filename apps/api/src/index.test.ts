import { describe, expect, it } from "vitest";
import { apiBootMessage } from "./index.js";

describe("@colony/api", () => {
  it("resolves @colony/domain via the workspace graph", () => {
    expect(apiBootMessage()).toBe("api:colony-domain");
  });
});
