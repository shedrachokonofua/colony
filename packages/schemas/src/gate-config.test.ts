import { describe, expect, it } from "bun:test";
import { parseGateConfig } from "./gate-config.js";

describe("parseGateConfig", () => {
  it("accepts a commands list without timeout_seconds", () => {
    expect(
      parseGateConfig('commands:\n  - "bun test"\n  - "bun run typecheck"\n'),
    ).toEqual({
      ok: true,
      commands: ["bun test", "bun run typecheck"],
    });
  });

  it("accepts a commands list with timeout_seconds", () => {
    expect(
      parseGateConfig('commands:\n  - "bun test"\ntimeout_seconds: 300\n'),
    ).toEqual({ ok: true, commands: ["bun test"], timeoutSeconds: 300 });
  });

  it("rejects malformed YAML without echoing parser diagnostics", () => {
    // A YAML error can quote the value it choked on; a secret in the file
    // must never reach the caller.
    const result = parseGateConfig("commands: [glpat-SECRETVALUE");
    expect(result).toEqual({
      ok: false,
      detail: "colony.gate.yaml is malformed YAML",
    });
    expect(JSON.stringify(result)).not.toContain("SECRETVALUE");
  });

  it.each([
    ["a bare scalar", '"just a string"\n'],
    ["an empty file", ""],
    ["a top-level array", "[]\n"],
  ])("rejects %s with a mapping-only detail", (_name, text) => {
    expect(parseGateConfig(text)).toEqual({
      ok: false,
      detail: "colony.gate.yaml must contain a mapping",
    });
  });

  it.each([
    ["no commands key", "timeout_seconds: 60\n"],
    ["an empty commands list", "commands: []\n"],
  ])("rejects %s", (_name, text) => {
    expect(parseGateConfig(text)).toEqual({
      ok: false,
      detail: "commands must be a non-empty array",
    });
  });

  it.each([
    ["a non-string command", 'commands:\n  - true\n  - "true"\n'],
    ["a blank command", 'commands:\n  - "  "\n'],
  ])("rejects %s", (_name, text) => {
    expect(parseGateConfig(text)).toEqual({
      ok: false,
      detail: "commands must contain only non-blank strings",
    });
  });

  it.each([
    ["zero", 'commands:\n  - "true"\ntimeout_seconds: 0\n'],
    ["negative", 'commands:\n  - "true"\ntimeout_seconds: -5\n'],
    ["a string", 'commands:\n  - "true"\ntimeout_seconds: "60"\n'],
  ])("rejects a timeout_seconds that is %s", (_name, text) => {
    expect(parseGateConfig(text)).toEqual({
      ok: false,
      detail: "timeout_seconds must be a positive finite number",
    });
  });

  it("rejects the invented version/checks format with a commands detail", () => {
    const invented = [
      "version: 1",
      "checks:",
      "  - name: ci",
      '    run: "bun test"',
      "",
    ].join("\n");
    expect(parseGateConfig(invented)).toEqual({
      ok: false,
      detail: "commands must be a non-empty array",
    });
  });
});
