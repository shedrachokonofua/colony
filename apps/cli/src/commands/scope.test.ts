import { describe, expect, it } from "bun:test";
import { parseArgs } from "../args.js";
import { captureStdout, fakeClient, json, parseJsonOut } from "../fakes.js";
import { run, type RunsRow, type TaskRow } from "./scope.js";
import type { ScopeRow } from "./scopes.js";

const IO = { json: false, isTty: false };
const ESC = "\u001b[";

function scope(overrides: Partial<ScopeRow> = {}): ScopeRow {
  return {
    id: "col-1",
    title: "Ship the CLI",
    status: "active",
    project_name: "colony",
    created_at: "2026-08-30T10:00:00.000Z",
    goal: "land the CLI",
    plan_json: null,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    index: 0,
    title: `Task ${id}`,
    state: "pending",
    attempt: 1,
    mr_iid: null,
    branch: null,
    model: "claude-opus-4",
    ...overrides,
  };
}

function runRow(id: string, overrides: Partial<RunsRow> = {}): RunsRow {
  return {
    id,
    kind: "code",
    model: "claude-opus-4",
    status: "succeeded",
    started_at: "2026-08-30T10:00:00.000Z",
    finished_at: "2026-08-30T10:05:00.000Z",
    ...overrides,
  };
}

interface Detail {
  scope: ScopeRow;
  project: { name: string; context_doc: string | null } | null;
  tasks: TaskRow[];
  deps: string[];
  runs: RunsRow[];
}

function detail(overrides: Partial<Detail> = {}): Detail {
  return {
    scope: scope(),
    project: { name: "colony", context_doc: null },
    tasks: [],
    deps: [],
    runs: [],
    ...overrides,
  };
}

function route(payload: Detail, path = `/scopes/${payload.scope.id}`) {
  return { [`get ${path}`]: json(payload) };
}

const PLAN = JSON.stringify({
  summary: "three steps",
  tasks: [{ title: "write tests" }, { title: "ship it" }],
});

describe("scope", () => {
  it("reads GET /scopes/<id>", async () => {
    const payload = detail();
    const { client, calls } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["scope", "col-1"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/scopes/col-1");
  });

  it("escapes the id in the GET path", async () => {
    const payload = detail({ scope: scope({ id: "col 1" }) });
    const { client, calls } = fakeClient(route(payload, "/scopes/col%201"));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col 1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(calls[0]!.path).toBe("/scopes/col%201");
  });

  it("prints the whole detail payload with --json", async () => {
    const payload = detail({
      scope: scope({ plan_json: PLAN }),
      tasks: [task("t-1")],
      deps: ["col-0"],
      runs: [runRow("run-1")],
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["scope", "col-1", "--json"]), client, {
        json: true,
        isTty: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text.startsWith("{")).toBe(true);
    expect(parseJsonOut(text)).toEqual(payload);
  });

  it("prints the goal and untangles plan_json into summary and numbered tasks", async () => {
    const payload = detail({ scope: scope({ plan_json: PLAN }) });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("col-1  active  Ship the CLI");
    expect(text).toContain("project: colony");
    expect(text).toContain("goal: land the CLI");
    expect(text).toContain("plan: three steps");
    expect(text).toContain("  1. write tests");
    expect(text).toContain("  2. ship it");
    expect(text).not.toContain("plan (raw)");
    expect(text).not.toContain(ESC);
  });

  it("prints plan_json raw when it is not JSON", async () => {
    const payload = detail({
      scope: scope({ plan_json: "step one, step two" }),
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("plan (raw): step one, step two");
    expect(text).not.toContain("plan: ");
    expect(text).not.toContain("  1. write tests");
  });

  it("prints the task table with state, attempt, merge request and model", async () => {
    const payload = detail({
      tasks: [
        task("t-1", {
          title: "Write tests",
          state: "running",
          attempt: 2,
          mr_iid: 17,
          model: "claude-opus-4",
        }),
        task("t-2", {
          title: "Ship",
          state: "pending",
          mr_iid: null,
          model: null,
        }),
      ],
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("task  state    attempt  mr   model          title");
    expect(text).toContain(
      "t-1   running  2        !17  claude-opus-4  Write tests",
    );
    expect(text).toContain("t-2   pending  1        -    -              Ship");
  });

  it("prints at most the five most recent runs", async () => {
    const payload = detail({
      runs: [
        runRow("run-1"),
        runRow("run-2"),
        runRow("run-3"),
        runRow("run-4"),
        runRow("run-5"),
        runRow("run-6", {
          kind: "validate",
          model: null,
          status: "running",
          finished_at: null,
        }),
      ],
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("recent runs:");
    expect(text).toContain("run    kind      model          status");
    expect(text).toContain("run-6  validate  -              running");
    expect(text).toContain("run-2  code      claude-opus-4  succeeded");
    // Only the tail of the run list is shown.
    expect(text).not.toContain("run-1");
  });

  it("prints no task table or runs list for a bare scope", async () => {
    const payload = detail();
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("goal: land the CLI");
    expect(text).not.toContain("recent runs");
    expect(text).not.toContain("task  state");
    expect(text).not.toContain("acceptance:");
    expect(text).not.toContain("validation:");
  });

  it("lists acceptance criteria from acceptance_json", async () => {
    const payload = detail({
      scope: scope({
        acceptance_json: JSON.stringify([
          { description: "tests pass", command: "bun test" },
          { description: "lint clean", command: "bun lint" },
        ]),
      }),
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("acceptance:");
    expect(text).toContain("  - tests pass");
    expect(text).toContain("  - lint clean");
    expect(text).not.toContain("bun lint");
  });

  it("falls back to the command when a criterion has no description", async () => {
    const payload = detail({
      scope: scope({
        acceptance_json: JSON.stringify([{ command: "bun test" }]),
      }),
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("  - bun test");
  });

  it("reports a passed validation verdict", async () => {
    const payload = detail({
      runs: [
        runRow("run-1"),
        runRow("run-2", { kind: "validate", status: "succeeded" }),
      ],
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("validation: passed");
  });

  it("reports a validating verdict while the newest validate run is running", async () => {
    const payload = detail({
      runs: [
        runRow("run-1", { kind: "validate", status: "succeeded" }),
        runRow("run-2", {
          kind: "validate",
          status: "running",
          finished_at: null,
        }),
      ],
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("validation: validating...");
  });

  it("reports a failed verdict from the newest validate run, not the oldest", async () => {
    const payload = detail({
      runs: [
        runRow("run-1", { kind: "validate", status: "succeeded" }),
        runRow("run-2", { kind: "validate", status: "crashed" }),
      ],
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("validation: failed (crashed)");
    expect(text).not.toContain("passed");
  });

  it("prints no verdict when no run is a validate run", async () => {
    const payload = detail({ runs: [runRow("run-1"), runRow("run-2")] });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).not.toContain("validation:");
  });

  it("colors the scope status only on a TTY", async () => {
    const payload = detail();
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["scope", "col-1"]), client, {
        json: false,
        isTty: true,
      });
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("\u001b[36mactive\u001b[0m");
  });
});
