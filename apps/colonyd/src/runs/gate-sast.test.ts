import { describe, expect, it } from "bun:test";
import {
  SAST_RESULT_MARKER,
  buildSastCommand,
  parseSastOutput,
} from "./gate-sast.js";

function resultLine(summary: Record<string, unknown>): string {
  return `semgrep noise\n${SAST_RESULT_MARKER}${JSON.stringify(summary)}\n`;
}

describe("parseSastOutput", () => {
  it("passes a scan with no findings", () => {
    expect(
      parseSastOutput(
        resultLine({ status: 0, total: 0, errors: 0, findings: [] }),
      ),
    ).toEqual({ kind: "clean" });
  });

  it("reports findings with their total", () => {
    const finding = {
      rule: "javascript.lang.security.detect-child-process",
      path: "src/run.ts",
      line: 12,
      message: "child_process with user input",
    };
    expect(
      parseSastOutput(
        resultLine({ status: 0, total: 3, errors: 0, findings: [finding] }),
      ),
    ).toEqual({ kind: "findings", total: 3, findings: [finding] });
  });

  // A scan that did not happen must never read as a clean scan.
  it.each([
    ["a semgrep error exit", resultLine({ status: 2, total: 0, findings: [] })],
    [
      "an unreadable report",
      resultLine({ status: 0, error: "Unexpected end of JSON input" }),
    ],
    ["a missing result line", "bash: semgrep: command not found\n"],
  ])("treats %s as a tool failure", (_, output) => {
    expect(parseSastOutput(output).kind).toBe("tool_failed");
  });
});

describe("buildSastCommand", () => {
  it("refuses a baseline that is not a commit id", () => {
    expect(() =>
      buildSastCommand("main; rm -rf /", "/opt/semgrep-rules"),
    ).toThrow("invalid SAST baseline commit");
  });
});
