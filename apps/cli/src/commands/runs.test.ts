import { describe, expect, it } from "bun:test";
import { parseArgs } from "../args.js";
import { captureStdout, fakeClient, json, parseJsonOut } from "../fakes.js";
import { run } from "./runs.js";
import type { RunsRow } from "./scope.js";

const IO = { json: false, isTty: false };
const ESC = "\u001b[";

function runsRow(id: string, overrides: Partial<RunsRow> = {}): RunsRow {
  return {
    id,
    kind: "code",
    model_id: "claude-opus-4",
    status: "running",
    started_at: "2026-08-30T10:00:00.000Z",
    finished_at: null,
    ...overrides,
  };
}

function route(runs: RunsRow[], path = "/scopes/col-1") {
  return { [`get ${path}`]: json({ runs }) };
}

describe("runs", () => {
  it("reads the scope and prints its runs", async () => {
    const { client, calls } = fakeClient(route([runsRow("run-1")]));
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["runs", "col-1"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/scopes/col-1");
  });

  it("escapes the scope id in the GET path", async () => {
    const { client, calls } = fakeClient(
      route([runsRow("run-1")], "/scopes/col%201"),
    );
    const out = captureStdout();
    try {
      await run(parseArgs(["runs", "col 1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(calls[0]!.path).toBe("/scopes/col%201");
  });

  it("prints the runs array honestly with --json", async () => {
    const runs = [
      runsRow("run-1"),
      runsRow("run-2", {
        status: "succeeded",
        finished_at: "2026-08-30T10:05:00.000Z",
      }),
    ];
    const { client } = fakeClient(route(runs));
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["runs", "col-1", "--json"]), client, {
        json: true,
        isTty: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(out.text().startsWith("[")).toBe(true);
    expect(parseJsonOut(out.text())).toEqual(runs);
  });

  it("prints a table of id, kind, model, status and age", async () => {
    const { client } = fakeClient(
      route([
        runsRow("run-1", {
          started_at: new Date(Date.now() - 90_000).toISOString(),
        }),
        runsRow("run-2", {
          kind: "validate",
          model_id: null,
          status: "succeeded",
          started_at: new Date(Date.now() - 4_500).toISOString(),
          finished_at: new Date(Date.now() - 1_500).toISOString(),
        }),
      ]),
    );
    const out = captureStdout();
    try {
      await run(parseArgs(["runs", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("run    kind      model          status     age");
    // Unfinished: age counts from start to now (90s -> "1m 30s").
    expect(text).toContain("run-1  code      claude-opus-4  running    1m 30s");
    // Finished: age is the fixed 3s the run actually took.
    expect(text).toContain("run-2  validate  -              succeeded  3s");
    expect(text).not.toContain(ESC);
  });

  it("prints exactly 'no runs' when the scope has none", async () => {
    const { client } = fakeClient(route([]));
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["runs", "col-1"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(out.text()).toBe("no runs\n");
  });

  it("colors the status only on a TTY", async () => {
    const { client } = fakeClient(route([runsRow("run-1")]));
    const out = captureStdout();
    try {
      await run(parseArgs(["runs", "col-1"]), client, {
        json: false,
        isTty: true,
      });
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("\u001b[36mrunning\u001b[0m");
  });
});
