import { describe, expect, it } from "bun:test";
import { parseArgs } from "../args.js";
import { captureStdout, fakeClient, json, parseJsonOut } from "../fakes.js";
import { run, type RunDetail } from "./run.js";

const IO = { json: false, isTty: false };
const ESC = "\u001b[";

function detail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "run-1",
    scope_id: "col-1",
    task_id: "t-1",
    kind: "code",
    model_id: "claude-opus-4",
    status: "running",
    started_at: "2026-08-30T10:00:00.000Z",
    finished_at: null,
    ...overrides,
  };
}

function route(payload: RunDetail, path = `/runs/${payload.id}`) {
  return { [`get ${path}`]: json(payload) };
}

describe("run", () => {
  it("reads GET /runs/<id>", async () => {
    const payload = detail();
    const { client, calls } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["run", "run-1"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/runs/run-1");
  });

  it("escapes the run id in the GET path", async () => {
    const payload = detail({ id: "run 1" });
    const { client, calls } = fakeClient(route(payload, "/runs/run%201"));
    const out = captureStdout();
    try {
      await run(parseArgs(["run", "run 1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(calls[0]!.path).toBe("/runs/run%201");
  });

  it("prints the run row honestly with --json", async () => {
    const payload = detail({
      status: "failed",
      finished_at: "2026-08-30T10:05:00.000Z",
      error: "tests failed",
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["run", "run-1", "--json"]), client, {
        json: true,
        isTty: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(out.text().startsWith("{")).toBe(true);
    expect(parseJsonOut(out.text())).toEqual(payload);
  });

  it("prints kind, model, scope, task and a live duration", async () => {
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const payload = detail({ started_at: startedAt, finished_at: null });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["run", "run-1"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("run-1  running");
    expect(text).toContain("kind:     code");
    expect(text).toContain("model:    claude-opus-4");
    expect(text).toContain("scope:    col-1");
    expect(text).toContain("task:     t-1");
    expect(text).toContain(`started:  ${startedAt}`);
    // Still running: the duration counts from start to now.
    expect(text).toContain("duration: 1m 30s");
    expect(text).not.toContain(ESC);
  });

  it("uses the finished timestamp for a run that is done", async () => {
    const payload = detail({
      status: "succeeded",
      started_at: new Date(Date.now() - 400_000).toISOString(),
      finished_at: new Date(Date.now() - 10_000).toISOString(),
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["run", "run-1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("duration: 6m 30s");
  });

  it("prints the failure reason when the run failed", async () => {
    const payload = detail({
      status: "failed",
      finished_at: "2026-08-30T10:05:00.000Z",
      error: "tests failed",
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["run", "run-1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("failure:  tests failed");
  });

  it("prints the run error as the failure", async () => {
    const payload = detail({
      status: "failed",
      finished_at: "2026-08-30T10:05:00.000Z",
      error: "sandbox OOM",
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["run", "run-1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("failure:  sandbox OOM");
  });

  it("reads the failure from evidence_json when error is null", async () => {
    // Gate and validate failures record their reason in evidence_json and
    // leave runs.error NULL (e.g. apps/colonyd/src/runs/merge-gate.ts:182).
    const payload = detail({
      status: "failed",
      finished_at: "2026-08-30T10:05:00.000Z",
      error: null,
      evidence_json: JSON.stringify({
        reason: "head_moved",
        head_sha: "abc123",
        observed: "def456",
      }),
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["run", "run-1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("failure:  head_moved");
  });

  it("prints the first failing command when evidence has no reason", async () => {
    const payload = detail({
      status: "failed",
      finished_at: "2026-08-30T10:05:00.000Z",
      error: null,
      evidence_json: JSON.stringify({
        head_sha: "abc123",
        results: [
          { command: "bun test", exit_code: 0 },
          { command: "bun run lint", exit_code: 1 },
        ],
      }),
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["run", "run-1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("failure:  bun run lint (exit 1)");
  });

  it("prints no failure line when the run is healthy", async () => {
    const payload = detail({
      status: "succeeded",
      finished_at: "2026-08-30T10:05:00.000Z",
    });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["run", "run-1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).not.toContain("failure:");
  });

  it("renders '-' for an absent model and a null task", async () => {
    const payload = detail({ model_id: null, task_id: null });
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["run", "run-1"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("model:    -");
    expect(text).toContain("task:     -");
  });

  it("colors the status only on a TTY", async () => {
    const payload = detail();
    const { client } = fakeClient(route(payload));
    const out = captureStdout();
    try {
      await run(parseArgs(["run", "run-1"]), client, {
        json: false,
        isTty: true,
      });
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("\u001b[36mrunning\u001b[0m");
  });
});
