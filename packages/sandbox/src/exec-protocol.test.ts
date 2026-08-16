import { describe, expect, it } from "vitest";
import {
  ExecEventSchema,
  ExecRequestSchema,
  ExecResultSchema,
  type ExecEvent,
  type ExecRequest,
  type ExecResult,
} from "./exec-protocol.js";

describe("ExecRequestSchema", () => {
  it("parses a minimal request", () => {
    const parsed = ExecRequestSchema.parse({ command: "ls -la" });
    expect(parsed).toEqual({ command: "ls -la" });
  });

  it("rejects a non-string command", () => {
    expect(() => ExecRequestSchema.parse({ command: 42 })).toThrow();
  });
});

describe("ExecEventSchema", () => {
  it("accepts a stdout event", () => {
    const event: ExecEvent = {
      kind: "stdout",
      seq: 1,
      data: "hello\n",
    };
    expect(ExecEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a stderr event", () => {
    const event: ExecEvent = {
      kind: "stderr",
      seq: 2,
      data: "warning\n",
    };
    expect(ExecEventSchema.parse(event)).toEqual(event);
  });

  it("discriminates on kind", () => {
    const stdout = ExecEventSchema.parse({
      kind: "stdout",
      seq: 1,
      data: "out",
    });
    const stderr = ExecEventSchema.parse({
      kind: "stderr",
      seq: 2,
      data: "err",
    });
    expect(stdout.kind).toBe("stdout");
    expect(stderr.kind).toBe("stderr");

    expect(
      ExecEventSchema.safeParse({ kind: "stdout", exitCode: 3 }).success,
    ).toBe(false);
    expect(ExecEventSchema.safeParse({ kind: "bogus", seq: 1 }).success).toBe(
      false,
    );
  });
});

describe("ExecResultSchema", () => {
  it("accepts { exitCode: 0 }", () => {
    const result: ExecResult = { exitCode: 0 };
    expect(ExecResultSchema.parse(result)).toEqual(result);
  });

  it("rejects a non-integer exit code", () => {
    expect(() => ExecResultSchema.parse({ exitCode: 0.5 })).toThrow();
  });
});
