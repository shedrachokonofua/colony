import { describe, expect, it } from "bun:test";
import { parseArgs } from "../args.js";
import { captureStdout, fakeClient, json, parseJsonOut } from "../fakes.js";
import { run, type AuditRow } from "./audit.js";

const IO = { json: false, isTty: false };

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 7,
    at: "2026-08-30T10:00:00.000Z",
    actor: "human:ada",
    action: "scope.created",
    scope_id: "col-1",
    task_id: "t-1",
    run_id: null,
    detail_json: "{}",
    ...overrides,
  };
}

function page(events: AuditRow[], overrides: Record<string, unknown> = {}) {
  return {
    events,
    has_more: false,
    oldest_id: events[0]?.id ?? null,
    newest_id: events.at(-1)?.id ?? null,
    ...overrides,
  };
}

function route(events: AuditRow[]) {
  return { "get /audit": json(page(events)) };
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

describe("audit", () => {
  it("reads GET /audit with a default limit of 25", async () => {
    const { client, calls } = fakeClient(route([row()]));
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["audit"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/audit");
    expect(calls[0]!.query).toEqual({
      scope_id: undefined,
      task_id: undefined,
      limit: 25,
    });
  });

  it("renders a table of id/at/actor/action/scope/task without color", async () => {
    const { client } = fakeClient(route([row()]));
    const out = captureStdout();
    try {
      await run(parseArgs(["audit"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(lines(text)[0]).toBe(
      "id  at                        actor      action         scope  task",
    );
    expect(text).toContain("7   2026-08-30T10:00:00.000Z  human:ada");
    expect(text).toContain("scope.created");
    expect(text).toContain("col-1");
    expect(text).not.toContain("\u001b[");
  });

  it("renders '-' for a null scope and a null task", async () => {
    const { client } = fakeClient(
      route([row({ scope_id: null, task_id: null })]),
    );
    const out = captureStdout();
    try {
      await run(parseArgs(["audit"]), client, IO);
    } finally {
      out.restore();
    }
    // header + one row
    const body = lines(out.text());
    expect(body).toHaveLength(2);
    expect(body[1]!).toBe(
      "7   2026-08-30T10:00:00.000Z  human:ada  scope.created  -      -",
    );
  });

  it("prints the honest rows array with --json", async () => {
    const events = [row(), row({ id: 8, action: "run.start" })];
    const { client } = fakeClient(route(events));
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["audit", "--json"]), client, {
        json: true,
        isTty: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(out.text().startsWith("[")).toBe(true);
    // The rows only: the page envelope's cursor fields are not printed.
    expect(parseJsonOut(out.text())).toEqual(events);
  });

  it("forwards --scope as scope_id and --task as task_id", async () => {
    const { client, calls } = fakeClient(route([row()]));
    const out = captureStdout();
    try {
      await run(parseArgs(["audit", "--scope", "col-1"]), client, IO);
    } finally {
      out.restore();
    }
    expect(calls[0]!.query).toEqual({
      scope_id: "col-1",
      task_id: undefined,
      limit: 25,
    });
  });

  it("forwards both filters together", async () => {
    const { client, calls } = fakeClient(route([row()]));
    const out = captureStdout();
    try {
      await run(
        parseArgs(["audit", "--scope", "col-1", "--task", "t-1"]),
        client,
        IO,
      );
    } finally {
      out.restore();
    }
    expect(calls[0]!.query).toEqual({
      scope_id: "col-1",
      task_id: "t-1",
      limit: 25,
    });
  });

  it("sends -n as the server limit", async () => {
    const { client, calls } = fakeClient(route([row()]));
    const out = captureStdout();
    try {
      await run(parseArgs(["audit", "-n", "3"]), client, IO);
    } finally {
      out.restore();
    }
    expect(calls[0]!.query).toEqual({
      scope_id: undefined,
      task_id: undefined,
      limit: 3,
    });
  });

  it("prints only -n rows when the page is longer", async () => {
    const events = [1, 2, 3, 4, 5].map((id) =>
      row({ id, action: `step.${id}` }),
    );
    const { client } = fakeClient(route(events));
    const out = captureStdout();
    try {
      await run(parseArgs(["audit", "-n", "2"]), client, IO);
    } finally {
      out.restore();
    }
    // one header line + two rows
    expect(lines(out.text())).toHaveLength(3);
    expect(out.text()).toContain("step.1");
    expect(out.text()).toContain("step.2");
    expect(out.text()).not.toContain("step.3");
  });

  it("prints the whole page when it is shorter than -n", async () => {
    const events = [row({ id: 1 }), row({ id: 2 })];
    const { client } = fakeClient(route(events));
    const out = captureStdout();
    try {
      await run(parseArgs(["audit", "-n", "10"]), client, IO);
    } finally {
      out.restore();
    }
    expect(lines(out.text())).toHaveLength(3);
  });

  it("says so when there are no audit entries", async () => {
    const { client } = fakeClient(route([]));
    const out = captureStdout();
    try {
      await run(parseArgs(["audit"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toBe("no audit entries\n");
  });
});
