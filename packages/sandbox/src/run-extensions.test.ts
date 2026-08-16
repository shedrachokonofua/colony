import { describe, expect, it } from "vitest";
import { assertValidRunExtensions } from "./run-extensions.js";

describe("run extension validation", () => {
  it("requires generic CLI tools to declare tool.cli.execute", () => {
    expect(() =>
      assertValidRunExtensions({
        skillMounts: [],
        cliTools: [
          {
            name: "git",
            executable: "git",
            resolver: "image",
            requiredCapabilities: ["provider.branches.push"],
            envAllowlist: [],
          },
        ],
      }),
    ).toThrow(/tool\.cli\.execute/);
  });
});
