import { describe, expect, it } from "bun:test";
import { ApiError } from "../client.js";
import { parseArgs } from "../args.js";
import {
  captureStdout,
  fakeClient,
  json,
  parseJsonOut,
  type Responder,
} from "../fakes.js";
import { run } from "./status.js";
import type { ScopeRow } from "./scopes.js";
import type { RunsRow } from "./scope.js";

const IO = { json: false, isTty: false };

function scope(id: string, status: string, title = `Scope ${id}`): ScopeRow {
  return {
    id,
    title,
    status,
    project_name: "colony",
    created_at: "2026-08-30T10:00:00.000Z",
    goal: "land it",
    plan_json: null,
  };
}

function runsRow(id: string, overrides: Partial<RunsRow> = {}): RunsRow {
  return {
    id,
    kind: "code",
    model: "claude-opus-4",
    status: "running",
    started_at: "2026-08-30T10:00:00.000Z",
    finished_at: null,
    ...overrides,
  };
}

const RUNS: Record<string, RunsRow[]> = {
  "col-1": [
    runsRow("run-1"),
    runsRow("run-2", {
      status: "succeeded",
      finished_at: "2026-08-30T10:05:00.000Z",
    }),
  ],
  "col-2": [runsRow("run-3", { model: "gpt-5" })],
};

interface StatusRoutes {
  ready?: Responder;
  scopes?: ScopeRow[];
}

function routes({ ready, scopes }: StatusRoutes = {}) {
  const rows = scopes ?? [scope("col-1", "active"), scope("col-2", "active")];
  return {
    "get /health": json({ ok: true, service: "colonyd" }),
    "get /ready": ready ?? (json({ ok: true }) as Responder),
    "get /scopes": json({
      scopes: rows,
      total: rows.length,
      limit: 100,
      offset: 0,
    }),
    ...Object.fromEntries(
      Object.entries(RUNS).map(([id, rows]) => [
        `get /scopes/${id}`,
        json({ runs: rows }),
      ]),
    ),
  };
}

describe("status", () => {
  it("issues at most 6 requests for health, ready, scopes and active detail reads", async () => {
    const { client, calls } = fakeClient(routes());
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["status"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    const paths = calls.map((call) => call.path);
    expect(paths).toContain("/health");
    expect(paths).toContain("/ready");
    expect(paths).toContain("/scopes");
    expect(calls.find((call) => call.path === "/scopes")!.query).toEqual({
      limit: 100,
      offset: 0,
    });
    // One detail read per active scope, and nothing else.
    expect(paths).toContain("/scopes/col-1");
    expect(paths).toContain("/scopes/col-2");
    expect(paths.filter((path) => path.startsWith("/scopes/"))).toHaveLength(2);
    expect(calls.length).toBe(5);
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it("tallies scopes by status", async () => {
    const { client } = fakeClient(
      routes({
        scopes: [
          scope("col-1", "active"),
          scope("col-2", "draft"),
          scope("col-3", "blocked"),
        ],
      }),
    );
    const out = captureStdout();
    try {
      await run(parseArgs(["status"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain(
      [
        "status      count",
        "draft       1",
        "planning    0",
        "active      1",
        "validating  0",
        "blocked     1",
        "done        0",
        "abandoned   0",
      ].join("\n"),
    );
  });

  it("lists running runs with their scope, model and age", async () => {
    const { client } = fakeClient(routes());
    const out = captureStdout();
    try {
      await run(parseArgs(["status"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("run    scope  kind  model          age");
    expect(text).toContain("run-1  col-1  code  claude-opus-4");
    expect(text).toContain("run-3  col-2  code  gpt-5");
    // Finished runs are not active work.
    expect(text).not.toContain("run-2");
    expect(text).not.toContain("\u001b[");
  });

  it("treats a 503 from /ready as not-ready instead of crashing", async () => {
    const { client, calls } = fakeClient(
      routes({
        ready: () => {
          throw new ApiError(503, "HTTP_503", "draining");
        },
      }),
    );
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["status"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(out.text()).toContain("health=ok");
    expect(out.text()).toContain("ready=no");
  });

  it("prints the honest payload with --json", async () => {
    const scopes = [scope("col-1", "active")];
    const { client } = fakeClient(
      routes({ ready: json({ ok: false }), scopes }),
    );
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["status", "--json"]), client, {
        json: true,
        isTty: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    const parsed = parseJsonOut(out.text()) as {
      health: { ok: boolean; service: string };
      ready: { ok: boolean };
      scopes: ScopeRow[];
      running: { scope: ScopeRow; runs: RunsRow[] }[];
    };
    expect(parsed.health).toEqual({ ok: true, service: "colonyd" });
    expect(parsed.ready).toEqual({ ok: false });
    expect(parsed.scopes).toEqual(scopes);
    expect(parsed.running).toEqual([{ scope: scopes[0], runs: RUNS["col-1"] }]);
  });
});
