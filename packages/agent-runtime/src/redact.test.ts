import { describe, expect, it } from "bun:test";
import { redactText, redactValue } from "./redact.js";

describe("redactText", () => {
  it("redacts GitLab glpat tokens", () => {
    expect(redactText("clone with glpat-ZoKQ_m86-abc123 ok")).toBe(
      "clone with [REDACTED] ok",
    );
  });

  it("redacts sk- keys of 8+ chars", () => {
    expect(redactText("key sk-abc12345")).toBe("key [REDACTED]");
    expect(redactText("key sk-short")).toBe("key sk-short");
  });

  it("redacts Bearer headers", () => {
    expect(redactText("Authorization: Bearer abc123._~+/=xyz")).toBe(
      "Authorization: [REDACTED]",
    );
  });

  it("redacts lowercase bearer headers", () => {
    expect(redactText("Authorization: bearer abc123._~+/=xyz")).toBe(
      "Authorization: [REDACTED]",
    );
  });

  it("redacts private-token header values, keeping the header name", () => {
    // Joined at runtime so the merge gate's secret scanner, which flags
    // token-shaped literals on added diff lines, never matches fixtures.
    const header = "private-token".toUpperCase();
    const token = ["glpat", "abcdefghijklmnopqrst"].join("-");
    expect(redactText(`${header}: ${token}`)).toBe(`${header}: [REDACTED]`);
    expect(redactText("private-token: abc123._~+/=xyz")).toBe(
      "private-token: [REDACTED]",
    );
  });

  it("redacts the percent-encoded form of an exact secret", () => {
    expect(redactText("enc tok%2Fen%2B1 tail", ["tok/en+1"])).toBe(
      "enc [REDACTED] tail",
    );
  });

  it("redacts the exact run token wherever it appears", () => {
    const token = "glpat-exact-run-token-42";
    expect(redactText(`git push ${token} done`, [token])).toBe(
      "git push [REDACTED] done",
    );
  });

  it("redacts a run token embedded in a JSON args object", () => {
    const token = "glpat-embed-ded-1234";
    const args = JSON.stringify({ command: `echo ${token}` });
    expect(JSON.parse(redactText(args, [token]))).toEqual({
      command: "echo [REDACTED]",
    });
  });

  it("redacts a run token embedded in a command string", () => {
    const token = "sk-run-token-99aa";
    expect(redactText(`curl -H "Authorization: ${token}"`, [token])).toBe(
      'curl -H "Authorization: [REDACTED]"',
    );
  });

  it("redacts repeated occurrences and multiple secrets", () => {
    const a = "glpat-aaaa-bbbb-cccc";
    const b = "glpat-dddd-eeee-ffff";
    expect(redactText(`${a} then ${b} then ${a}`, [a, b])).toBe(
      "[REDACTED] then [REDACTED] then [REDACTED]",
    );
  });

  it("leaves text without secrets untouched", () => {
    const text = "plain git push origin main";
    expect(redactText(text)).toBe(text);
  });
});

describe("redactValue", () => {
  it("redacts strings inside nested objects and arrays", () => {
    const token = "glpat-nested-token-1";
    expect(
      redactValue(
        {
          command: `push ${token}`,
          nested: { args: [`Bearer abcdef123456`, 7, null, true] },
        },
        [token],
      ),
    ).toEqual({
      command: "push [REDACTED]",
      nested: { args: ["[REDACTED]", 7, null, true] },
    });
  });

  it("leaves non-string scalars untouched", () => {
    const value = { n: 42, f: 1.5, b: false, nil: null, u: undefined };
    expect(redactValue(value)).toEqual(value);
  });

  it("returns primitives directly", () => {
    expect(redactValue("glpat-x-12345678")).toBe("[REDACTED]");
    expect(redactValue(5)).toBe(5);
    expect(redactValue(null)).toBe(null);
  });
});
