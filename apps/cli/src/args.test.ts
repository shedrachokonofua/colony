import { describe, expect, it } from "bun:test";
import { parseArgs, UsageError } from "./args.js";

function parse(argv: string[]) {
  return parseArgs(argv);
}

describe("parseArgs", () => {
  it("parses every read subcommand", () => {
    expect(parse(["scopes"])).toEqual({
      command: "scopes",
      positional: [],
      flags: {},
    });
    expect(parse(["scopes", "--project", "colony", "--page", "3"])).toEqual({
      command: "scopes",
      positional: [],
      flags: { project: "colony", page: "3" },
    });
    expect(parse(["scope", "col-1"])).toEqual({
      command: "scope",
      positional: ["col-1"],
      flags: {},
    });
    expect(parse(["runs", "col-1"])).toEqual({
      command: "runs",
      positional: ["col-1"],
      flags: {},
    });
    expect(parse(["run", "run-1"])).toEqual({
      command: "run",
      positional: ["run-1"],
      flags: {},
    });
    expect(parse(["logs", "run-1", "-f"])).toEqual({
      command: "logs",
      positional: ["run-1"],
      flags: { follow: true },
    });
    expect(parse(["logs", "run-1", "--follow"])).toEqual({
      command: "logs",
      positional: ["run-1"],
      flags: { follow: true },
    });
    expect(parse(["artifacts", "run-1"])).toEqual({
      command: "artifacts",
      positional: ["run-1"],
      flags: {},
    });
    expect(
      parse(["artifacts", "run-1", "get", "art-1", "-o", "out.log"]),
    ).toEqual({
      command: "artifacts",
      positional: ["run-1", "get", "art-1"],
      flags: { o: "out.log" },
    });
    expect(parse(["projects"])).toEqual({
      command: "projects",
      positional: [],
      flags: {},
    });
    expect(parse(["project", "colony"])).toEqual({
      command: "project",
      positional: ["colony"],
      flags: {},
    });
    expect(parse(["context", "colony"])).toEqual({
      command: "context",
      positional: ["colony"],
      flags: {},
    });
    expect(parse(["context", "colony", "--set", "-"])).toEqual({
      command: "context",
      positional: ["colony"],
      flags: { set: "-" },
    });
    expect(parse(["audit", "--scope", "col-1", "-n", "5"])).toEqual({
      command: "audit",
      positional: [],
      flags: { scope: "col-1", n: "5" },
    });
    expect(parse(["status"])).toEqual({
      command: "status",
      positional: [],
      flags: {},
    });
  });

  it("parses mutation subcommands", () => {
    expect(
      parse([
        "open",
        "spec.md",
        "--title",
        "T",
        "--project",
        "p",
        "--repo",
        "so/c",
        "--manual",
        "--create-project",
      ]),
    ).toEqual({
      command: "open",
      positional: ["spec.md"],
      flags: {
        title: "T",
        project: "p",
        repo: "so/c",
        manual: true,
        "create-project": true,
      },
    });
    expect(parse(["approve", "col-1"])).toEqual({
      command: "approve",
      positional: ["col-1"],
      flags: {},
    });
    expect(parse(["replan", "col-1", "--feedback", "notes.md"])).toEqual({
      command: "replan",
      positional: ["col-1"],
      flags: { feedback: "notes.md" },
    });
    expect(parse(["abandon", "col-1", "--yes"])).toEqual({
      command: "abandon",
      positional: ["col-1"],
      flags: { yes: true },
    });
    expect(parse(["revalidate", "col-1"])).toEqual({
      command: "revalidate",
      positional: ["col-1"],
      flags: {},
    });
    expect(parse(["task", "col-1.1"])).toEqual({
      command: "task",
      positional: ["col-1.1"],
      flags: {},
    });
    for (const verb of ["retry", "stop", "cancel", "restore", "unblock"]) {
      expect(parse(["task", "col-1.1", verb])).toEqual({
        command: "task",
        positional: ["col-1.1", verb],
        flags: {},
      });
    }
    expect(parse(["task", "col-1.1", "amend", "--spec", "-"])).toEqual({
      command: "task",
      positional: ["col-1.1", "amend"],
      flags: { spec: "-" },
    });
    expect(
      parse(["task", "col-1.1", "request-changes", "--feedback", "f.md"]),
    ).toEqual({
      command: "task",
      positional: ["col-1.1", "request-changes"],
      flags: { feedback: "f.md" },
    });
    expect(
      parse(["task", "col-1.1", "approve-merge", "--sha", "a".repeat(40)]),
    ).toEqual({
      command: "task",
      positional: ["col-1.1", "approve-merge"],
      flags: { sha: "a".repeat(40) },
    });
  });

  it("accepts global flags before or after the subcommand", () => {
    const before = parse([
      "--server",
      "https://colony.test",
      "--token",
      "t",
      "--actor",
      "a",
      "--json",
      "scopes",
    ]);
    const after = parse([
      "scopes",
      "--server",
      "https://colony.test",
      "--token",
      "t",
      "--actor",
      "a",
      "--json",
    ]);
    expect(before).toEqual(after);
    expect(before.flags).toEqual({
      server: "https://colony.test",
      token: "t",
      actor: "a",
      json: true,
    });
  });

  it("supports --flag=value syntax", () => {
    expect(parse(["scopes", "--project=colony"]).flags).toEqual({
      project: "colony",
    });
  });

  it("treats a lone dash as a positional", () => {
    expect(parse(["open", "-"]).positional).toEqual(["-"]);
  });

  it("throws UsageError for an unknown command", () => {
    expect(() => parse(["frobnicate"])).toThrow(UsageError);
  });

  it("throws UsageError when no command is given", () => {
    expect(() => parse(["--json"])).toThrow(UsageError);
  });

  it("throws UsageError for a missing required positional", () => {
    expect(() => parse(["scope"])).toThrow(UsageError);
    expect(() => parse(["run"])).toThrow(UsageError);
    expect(() => parse(["logs"])).toThrow(UsageError);
    expect(() => parse(["artifacts"])).toThrow(UsageError);
    expect(() => parse(["project"])).toThrow(UsageError);
    expect(() => parse(["context"])).toThrow(UsageError);
  });

  it("throws UsageError when a flag is missing its value", () => {
    expect(() => parse(["replan", "col-1", "--feedback"])).toThrow(
      /requires a value/,
    );
    expect(() => parse(["scopes", "--project"])).toThrow(/requires a value/);
    expect(() => parse(["--server"])).toThrow(/requires a value/);
  });

  it("throws UsageError for an unknown flag or verb", () => {
    expect(() => parse(["scopes", "--nope"])).toThrow(/unknown flag/);
    expect(() => parse(["task", "col-1.1", "destroy"])).toThrow(
      /unknown task verb/,
    );
  });

  it("throws UsageError when a verb's required flag is absent", () => {
    expect(() => parse(["task", "col-1.1", "amend"])).toThrow(
      /requires --spec/,
    );
    expect(() => parse(["task", "col-1.1", "approve-merge"])).toThrow(
      /requires --sha/,
    );
    expect(() => parse(["artifacts", "run-1", "get", "art-1"])).toThrow(
      /requires --o/,
    );
  });

  it("throws UsageError when a command's own required flag is absent", () => {
    expect(() => parse(["replan", "col-1"])).toThrow(
      /replan requires --feedback/,
    );
  });
});
