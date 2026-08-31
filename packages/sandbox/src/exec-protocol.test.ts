import { describe, expect, it } from "bun:test";
import {
  ExecEventSchema,
  ExecRequestSchema,
  ExecResultSchema,
  SANDBOX_QUOTA_EXHAUSTED,
  SandboxQuotaError,
  isQuotaDeferred,
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

describe("SandboxQuotaError and marker contract", () => {
  it("constructs with the marker prefix", () => {
    const err = new SandboxQuotaError("request did not admit");
    expect(err.message).toBe(
      `${SANDBOX_QUOTA_EXHAUSTED}: request did not admit`,
    );
    expect(err.name).toBe("SandboxQuotaError");
  });

  it("recognises its own message", () => {
    const err = new SandboxQuotaError("pods=1 used=20 limited=20");
    expect(isQuotaDeferred(err.message)).toBe(true);
  });

  it("rejects unadorned messages", () => {
    expect(isQuotaDeferred("workspace_provision_failed")).toBe(false);
  });

  it("tolerates null or undefined", () => {
    expect(isQuotaDeferred(null)).toBe(false);
    expect(isQuotaDeferred(undefined)).toBe(false);
  });
});
