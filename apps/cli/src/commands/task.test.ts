import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../args.js";
import { ApiError } from "../client.js";
import { captureStdout, fakeClient, json, parseJsonOut } from "../fakes.js";
import { run } from "./task.js";

const IO = { json: false, isTty: false };

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-cli-task-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "col-1.1",
    scope_id: "col-1",
    title: "Land the parser",
    spec: "# Task\n\nWrite the parser.\n",
    state: "queued",
    attempt: 2,
    mr_iid: null,
    branch: "colony/col-1.1",
    blocked_reason: null,
    ...overrides,
  };
}

function taskRoute(overrides: Record<string, unknown> = {}) {
  return {
    "get /tasks/col-1.1": json({
      task: task(overrides),
      runs: [
        {
          id: "run-1",
          kind: "implement",
          model_id: "claude-x",
          status: "succeeded",
          started_at: "2026-08-30T10:00:00.000Z",
          finished_at: "2026-08-30T10:05:00.000Z",
        },
      ],
      deps: [],
    }),
  };
}

function postRoute(path: string, overrides: Record<string, unknown> = {}) {
  return { [`post /tasks/col-1.1/${path}`]: json(task(overrides)) };
}

describe("task <id>", () => {
  it("GETs the task detail and renders state, attempt, MR and model", async () => {
    const { client, calls } = fakeClient(
      taskRoute({ state: "mr_open", mr_iid: 7 }),
    );
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["task", "col-1.1"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toEqual([
      { method: "get", path: "/tasks/col-1.1", query: undefined, body: undefined },
    ]);
    const text = out.text();
    expect(text).toContain("col-1.1");
    expect(text).toContain("mr_open");
    expect(text).toContain("attempt 2");
    expect(text).toContain("claude-x");
    expect(text).toContain("!7");
    expect(text).toContain("# Task");
  });

  it("prints the honest detail payload with --json", async () => {
    const payload = {
      task: task(),
      runs: [],
      deps: [],
    };
    const { client } = fakeClient({
      "get /tasks/col-1.1": json(payload),
    });
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["task", "col-1.1", "--json"]), client, {
        json: true,
        isTty: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(parseJsonOut(out.text())).toEqual(payload);
  });
});

describe("task mutations", () => {
  for (const verb of ["retry", "stop", "cancel", "restore", "unblock"]) {
    it(`POSTs /tasks/:id/${verb} with no body`, async () => {
      const { client, calls } = fakeClient(
        postRoute(verb, { state: verb === "restore" ? "queued" : "running" }),
      );
      const out = captureStdout();
      try {
        const code = await run(
          parseArgs(["task", "col-1.1", verb]),
          client,
          IO,
        );
        expect(code).toBe(0);
      } finally {
        out.restore();
      }
      expect(calls).toEqual([
        {
          method: "post",
          path: `/tasks/col-1.1/${verb}`,
          query: undefined,
          body: undefined,
        },
      ]);
expect(out.text()).toBe(
        `col-1.1  ${verb === "restore" ? "queued" : "running"}  attempt 2\n`,
      );
    });
  }

  it("exits 2 on an unknown verb before anything is posted", async () => {
    // The parser itself rejects unknown verbs (exit 2 via main's catch).
    expect(() => parseArgs(["task", "col-1.1", "frobnicate"])).toThrow(
      /unknown task verb 'frobnicate'/,
    );
    // The command module keeps the same guard for a hand-built command.
    const { client, calls } = fakeClient({});
    await expect(
      run(
        { command: "task", positional: ["col-1.1", "frobnicate"], flags: {} },
        client,
        IO,
      ),
    ).rejects.toMatchObject({
      name: "UsageError",
      message: expect.stringContaining("frobnicate"),
    });
    expect(calls).toHaveLength(0);
  });

  it("maps an ApiError from a mutation to a thrown error (exit 1 via main)", async () => {
    const { client } = fakeClient({
      "post /tasks/col-1.1/stop": () =>
        Promise.reject(new ApiError(409, "NOT_RUNNING", "only a running task can be stopped")),
    });
    await expect(
      run(parseArgs(["task", "col-1.1", "stop"]), client, IO),
    ).rejects.toMatchObject({ status: 409, code: "NOT_RUNNING" });
  });
});

describe("task amend", () => {
  it("POSTs amend-spec with the spec file content as feedback", async () => {
    const file = tempFile("amendment.md", "add a rollback step\n");
    const { client, calls } = fakeClient(postRoute("amend-spec"));
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["task", "col-1.1", "amend", "--spec", file]),
        client,
        IO,
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toEqual([
      {
        method: "post",
        path: "/tasks/col-1.1/amend-spec",
        query: undefined,
        body: { feedback: "add a rollback step\n" },
      },
    ]);
  });

  it("reads stdin for --spec -", async () => {
    const { client, calls } = fakeClient(postRoute("amend-spec"));
    const original = process.stdin;
    process.stdin = (async function* () {
      yield Buffer.from("piped amendment");
    })() as unknown as typeof process.stdin;
    const out = captureStdout();
    try {
      await run(parseArgs(["task", "col-1.1", "amend", "--spec", "-"]), client, IO);
    } finally {
      out.restore();
      process.stdin = original;
    }
    expect(calls[0]!.body).toEqual({ feedback: "piped amendment" });
  });

  it("exits 2 on empty spec content without posting", async () => {
    const file = tempFile("empty.md", "  ");
    const { client, calls } = fakeClient(postRoute("amend-spec"));
    await expect(
      run(parseArgs(["task", "col-1.1", "amend", "--spec", file]), client, IO),
    ).rejects.toBeInstanceOf(Object);
    expect(calls).toHaveLength(0);
  });
});

describe("task request-changes", () => {
  it("POSTs request-changes with {feedback}", async () => {
    const { client, calls } = fakeClient(postRoute("request-changes"));
    const original = process.stdin;
    process.stdin = (async function* () {
      yield Buffer.from("please split the auth piece out");
    })() as unknown as typeof process.stdin;
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["task", "col-1.1", "request-changes", "--feedback", "-"]),
        client,
        IO,
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
      process.stdin = original;
    }
    expect(calls).toEqual([
      {
        method: "post",
        path: "/tasks/col-1.1/request-changes",
        query: undefined,
        body: { feedback: "please split the auth piece out" },
      },
    ]);
  });
});

describe("task approve-merge", () => {
  it("POSTs approve-merge with no body and echoes the approved sha", async () => {
    const { client, calls } = fakeClient(
      postRoute("approve-merge", { state: "mr_open", mr_iid: 7 }),
    );
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["task", "col-1.1", "approve-merge", "--sha", "abc123"]),
        client,
        IO,
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toEqual([
      {
        method: "post",
        path: "/tasks/col-1.1/approve-merge",
        query: undefined,
        body: undefined,
      },
    ]);
    expect(out.text()).toContain("merge approved at abc123: col-1.1");
  });
});