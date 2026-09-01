import { describe, expect, it } from "bun:test";
import { parseArgs } from "../args.js";
import { captureStdout, fakeClient, json, parseJsonOut } from "../fakes.js";
import { run } from "./scopes.js";

const SCOPE = {
  id: "col-1",
  title: "Ship the CLI",
  status: "active",
  project_name: "colony",
  created_at: "2026-08-30T10:00:00.000Z",
  goal: "land it",
  plan_json: null,
};

function route(overrides: Record<string, unknown> = {}) {
  return {
    "get /scopes": json({
      scopes: [SCOPE],
      total: 1,
      limit: 25,
      offset: 0,
      projects: ["colony"],
      ...overrides,
    }),
  };
}

describe("scopes", () => {
  it("prints the honest API JSON with --json", async () => {
    const { client } = fakeClient(route());
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["scopes", "--json"]), client, {
        json: true,
        isTty: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    const parsed = parseJsonOut(out.text()) as {
      scopes: unknown[];
      total: number;
    };
    expect(parsed.scopes).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });

  it("paginates with limit 25 and offset (page-1)*25", async () => {
    const { client, calls } = fakeClient(route());
    const out = captureStdout();
    try {
      await run(parseArgs(["scopes", "--page", "3"]), client, {
        json: false,
        isTty: false,
      });
    } finally {
      out.restore();
    }
    expect(calls[0]!.query).toEqual({
      limit: 25,
      offset: 50,
      project: undefined,
    });
  });

  it("passes the project filter", async () => {
    const { client, calls } = fakeClient(route());
    const out = captureStdout();
    try {
      await run(parseArgs(["scopes", "--project", "colony"]), client, {
        json: false,
        isTty: false,
      });
    } finally {
      out.restore();
    }
    expect(calls[0]!.query).toEqual({
      limit: 25,
      offset: 0,
      project: "colony",
    });
  });

  it("renders a table of id/status/title/created without color", async () => {
    const { client } = fakeClient(route());
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["scopes"]), client, {
        json: false,
        isTty: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("id     status  title         created");
    expect(out.text()).toContain(
      "col-1  active  Ship the CLI  2026-08-30T10:00:00.000Z",
    );
    expect(out.text()).not.toContain("\u001b[");
  });

  it("colors the status only on a TTY", async () => {
    const { client } = fakeClient(route());
    const out = captureStdout();
    try {
      await run(parseArgs(["scopes"]), client, { json: false, isTty: true });
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("\u001b[36mactive\u001b[0m");
  });

  it("says so when there are no scopes", async () => {
    const { client } = fakeClient(route({ scopes: [], total: 0 }));
    const out = captureStdout();
    try {
      await run(parseArgs(["scopes"]), client, { json: false, isTty: false });
    } finally {
      out.restore();
    }
    expect(out.text()).toBe("no scopes\n");
  });
});
