import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../args.js";
import { ApiError } from "../client.js";
import { captureStdout, fakeClient, json, parseJsonOut } from "../fakes.js";
import { run } from "./scope-mutations.js";

const IO = { json: false, isTty: false };

function scope(overrides: Record<string, unknown> = {}) {
  return {
    id: "col-1",
    title: "Ship the CLI",
    status: "planning",
    project_name: "colony",
    created_at: "2026-08-30T10:00:00.000Z",
    goal: "land it",
    plan_json: null,
    ...overrides,
  };
}

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-cli-mutations-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

/**
 * Stand in a TTY-attached stdin answering with the given line: mocks the
 * node:fs readSync that confirm() uses, so no real terminal is needed.
 */
function stdinAnswer(line: string): { restore: () => void } {
  const stdin = process.stdin as unknown as { isTTY?: boolean };
  const originalIsTty = stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  const answer = Buffer.from(line, "utf8");
  const spy = spyOn(fs, "readSync").mockImplementation(
    ((_fd: number, buffer: Buffer) => {
      answer.copy(buffer);
      return answer.byteLength;
    }) as unknown as typeof fs.readSync,
  );
  return {
    restore: () => {
      spy.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTty,
        configurable: true,
      });
    },
  };
}

describe("approve", () => {
  it("POSTs approve-plan with no body and prints the resulting status", async () => {
    const { client, calls } = fakeClient({
      "post /scopes/col-1/approve-plan": json({
        scope: scope({ status: "active" }),
      }),
    });
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["approve", "col-1"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("post");
    expect(calls[0]!.path).toBe("/scopes/col-1/approve-plan");
    expect(calls[0]!.body).toBeUndefined();
    expect(out.text()).toBe("col-1  active — Ship the CLI\n");
  });

  it("prints the honest {scope} payload with --json", async () => {
    const payload = { scope: scope({ status: "active" }) };
    const { client } = fakeClient({
      "post /scopes/col-1/approve-plan": json(payload),
    });
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["approve", "col-1", "--json"]),
        client,
        {
          json: true,
          isTty: false,
        },
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(parseJsonOut(out.text())).toEqual(payload);
  });

  it("surfaces NO_PLAN_PENDING as an ApiError for main to exit 1", async () => {
    const { client } = fakeClient({
      "post /scopes/col-1/approve-plan": () =>
        Promise.reject(
          new ApiError(
            409,
            "NO_PLAN_PENDING",
            "scope has no plan awaiting approval",
          ),
        ),
    });
    await expect(
      run(parseArgs(["approve", "col-1"]), client, IO),
    ).rejects.toMatchObject({ status: 409, code: "NO_PLAN_PENDING" });
  });
});

describe("replan", () => {
  it("POSTs the feedback read from a file", async () => {
    const file = tempFile("feedback.md", "split the auth piece out\n");
    const { client, calls } = fakeClient({
      "post /scopes/col-1/replan": json(scope({ status: "planning" })),
    });
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["replan", "col-1", "--feedback", file]),
        client,
        IO,
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls[0]!.path).toBe("/scopes/col-1/replan");
    expect(calls[0]!.body).toEqual({ feedback: "split the auth piece out\n" });
    expect(out.text()).toBe("col-1  planning — Ship the CLI\n");
  });

  it("reads stdin for --feedback -", async () => {
    const { client, calls } = fakeClient({
      "post /scopes/col-1/replan": json(scope()),
    });
    const original = process.stdin;
    process.stdin = (async function* () {
      yield Buffer.from("piped feedback");
    })() as unknown as typeof process.stdin;
    const out = captureStdout();
    try {
      await run(parseArgs(["replan", "col-1", "--feedback", "-"]), client, IO);
    } finally {
      out.restore();
      process.stdin = original;
    }
    expect(calls[0]!.body).toEqual({ feedback: "piped feedback" });
  });

  it("exits 2 on empty feedback without posting", async () => {
    const file = tempFile("empty.md", "   \n");
    const { client, calls } = fakeClient({
      "post /scopes/col-1/replan": json(scope()),
    });
    const err = captureStderr();
    let code = 0;
    try {
      code = await run(
        parseArgs(["replan", "col-1", "--feedback", file]),
        client,
        IO,
      );
    } catch {
      code = -1;
    } finally {
      err.restore();
    }
    expect(code).toBe(-1);
    expect(calls).toHaveLength(0);
  });
});

describe("abandon", () => {
  it("POSTs abandon when --yes skips the prompt", async () => {
    const { client, calls } = fakeClient({
      "post /scopes/col-1/abandon": json(scope({ status: "abandoned" })),
    });
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["abandon", "col-1", "--yes"]),
        client,
        IO,
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls[0]!.path).toBe("/scopes/col-1/abandon");
    expect(calls[0]!.body).toBeUndefined();
    expect(out.text()).toBe("col-1  abandoned — Ship the CLI\n");
  });

  it("exits 2 without posting when stdin is not a TTY and no --yes", async () => {
    const { client, calls } = fakeClient({
      "post /scopes/col-1/abandon": json(scope({ status: "abandoned" })),
    });
    await expect(
      run(parseArgs(["abandon", "col-1"]), client, IO),
    ).rejects.toMatchObject({
      name: "UsageError",
      message: expect.stringContaining("--yes"),
    });
    expect(calls).toHaveLength(0);
  });

  it("prompts on a TTY even when NO_COLOR disabled io.isTty", async () => {
    const { client, calls } = fakeClient({
      "post /scopes/col-1/abandon": json(scope({ status: "abandoned" })),
    });
    const out = captureStdout();
    const err = captureStderr();
    const answer = stdinAnswer("y\n");
    try {
      const code = await run(parseArgs(["abandon", "col-1"]), client, {
        json: false,
        isTty: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
      err.restore();
      answer.restore();
    }
    expect(calls[0]!.path).toBe("/scopes/col-1/abandon");
    expect(out.text()).toBe("col-1  abandoned — Ship the CLI\n");
    expect(err.text()).toBe("Abandon scope col-1? [y/N] ");
  });

  it("aborts without posting when the operator answers N", async () => {
    const { client, calls } = fakeClient({
      "post /scopes/col-1/abandon": json(scope({ status: "abandoned" })),
    });
    const out = captureStdout();
    const err = captureStderr();
    const answer = stdinAnswer("N\n");
    try {
      const code = await run(parseArgs(["abandon", "col-1"]), client, {
        json: true,
        isTty: true,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
      err.restore();
      answer.restore();
    }
    expect(calls).toHaveLength(0);
    expect(out.text()).toBe("");
    expect(err.text()).toBe("Abandon scope col-1? [y/N] aborted\n");
  });
});

describe("revalidate", () => {
  it("POSTs revalidate with no body", async () => {
    const { client, calls } = fakeClient({
      "post /scopes/col-1/revalidate": json(scope({ status: "validating" })),
    });
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["revalidate", "col-1"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("post");
    expect(calls[0]!.path).toBe("/scopes/col-1/revalidate");
    expect(calls[0]!.body).toBeUndefined();
    expect(out.text()).toBe("col-1  validating — Ship the CLI\n");
  });

  it("surfaces NOT_VALIDATING as an ApiError for main to exit 1", async () => {
    const { client } = fakeClient({
      "post /scopes/col-1/revalidate": () =>
        Promise.reject(
          new ApiError(
            409,
            "NOT_VALIDATING",
            "scope is not awaiting validation",
          ),
        ),
    });
    await expect(
      run(parseArgs(["revalidate", "col-1"]), client, IO),
    ).rejects.toMatchObject({ status: 409, code: "NOT_VALIDATING" });
  });

  it("prints the honest scope payload with --json", async () => {
    const payload = scope({ status: "validating" });
    const { client } = fakeClient({
      "post /scopes/col-1/revalidate": json(payload),
    });
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["revalidate", "col-1", "--json"]),
        client,
        { json: true, isTty: false },
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(parseJsonOut(out.text())).toEqual(payload);
  });
});
