import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../args.js";
import { captureStdout, fakeClient, json, parseJsonOut } from "../fakes.js";
import { context, run, type ProjectRow } from "./projects.js";

const IO = { json: false, isTty: false };

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    name: "colony",
    context_doc: null,
    created_at: "2026-08-30T09:00:00.000Z",
    updated_at: "2026-08-30T10:00:00.000Z",
    scope_count: 3,
    file_count: 2,
    ...overrides,
  };
}

function page(projects: ProjectRow[]) {
  return { projects, total: projects.length, limit: 50, offset: 0 };
}

/** A row as the API returns it when it tallies nothing for the project. */
function bare(): ProjectRow {
  return {
    name: "colony",
    context_doc: null,
    created_at: "2026-08-30T09:00:00.000Z",
    updated_at: "2026-08-30T10:00:00.000Z",
  };
}

/** Temp dirs to clean up: `context --set <file>` reads real files. */
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-cli-projects-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("projects", () => {
  it("pages GET /projects with limit 50 and offset 0", async () => {
    const { client, calls } = fakeClient({ "get /projects": json(page([])) });
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["projects"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/projects");
    expect(calls[0]!.query).toEqual({ limit: 50, offset: 0 });
  });

  it("renders a table of name/scopes/files/updated without color", async () => {
    const { client } = fakeClient({
      "get /projects": json(page([project()])),
    });
    const out = captureStdout();
    try {
      await run(parseArgs(["projects"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("name    scopes  files  updated");
    expect(text).toContain("colony  3       2      2026-08-30T10:00:00.000Z");
    expect(text).not.toContain("\u001b[");
  });

  it("renders '-' where the API omits the counts", async () => {
    const { client } = fakeClient({
      "get /projects": json(page([bare()])),
    });
    const out = captureStdout();
    try {
      await run(parseArgs(["projects"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain(
      "colony  -       -      2026-08-30T10:00:00.000Z",
    );
  });

  it("prints the honest page envelope with --json", async () => {
    const payload = page([project()]);
    const { client } = fakeClient({ "get /projects": json(payload) });
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["projects", "--json"]), client, {
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

  it("says so when there are no projects", async () => {
    const { client } = fakeClient({ "get /projects": json(page([])) });
    const out = captureStdout();
    try {
      await run(parseArgs(["projects"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toBe("no projects\n");
  });
});

describe("project <name>", () => {
  it("reads GET /projects/<name>", async () => {
    const { client, calls } = fakeClient({
      "get /projects/colony": json({ project: project() }),
    });
    const out = captureStdout();
    try {
      const code = await run(parseArgs(["project", "colony"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/projects/colony");
  });

  it("escapes the project name in the GET path", async () => {
    const { client, calls } = fakeClient({
      "get /projects/my%20project": json({ project: project() }),
    });
    const out = captureStdout();
    try {
      await run(parseArgs(["project", "my project"]), client, IO);
    } finally {
      out.restore();
    }
    expect(calls[0]!.path).toBe("/projects/my%20project");
  });

  it("prints name, created, updated and the counts when present", async () => {
    const { client } = fakeClient({
      "get /projects/colony": json({ project: project() }),
    });
    const out = captureStdout();
    try {
      await run(parseArgs(["project", "colony"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toBe(
      [
        "colony",
        "created: 2026-08-30T09:00:00.000Z",
        "updated: 2026-08-30T10:00:00.000Z",
        "scopes:  3",
        "files:   2",
        "",
      ].join("\n"),
    );
  });

  it("omits the count lines when the API omits them", async () => {
    const { client } = fakeClient({
      "get /projects/colony": json({ project: bare() }),
    });
    const out = captureStdout();
    try {
      await run(parseArgs(["project", "colony"]), client, IO);
    } finally {
      out.restore();
    }
    const text = out.text();
    expect(text).toContain("created: 2026-08-30T09:00:00.000Z");
    expect(text).not.toContain("scopes:");
    expect(text).not.toContain("files:");
  });

  it("prints the honest {project} payload with --json", async () => {
    const payload = { project: project() };
    const { client } = fakeClient({
      "get /projects/colony": json(payload),
    });
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["project", "colony", "--json"]),
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
    expect(out.text().startsWith("{")).toBe(true);
    expect(parseJsonOut(out.text())).toEqual(payload);
  });
});

describe("context <name>", () => {
  const DOC = "# colony\n\nOperator background.\n";

  it("reads GET /projects/<name>/context and prints the doc", async () => {
    const { client, calls } = fakeClient({
      "get /projects/colony/context": json({ context_doc: DOC }),
    });
    const out = captureStdout();
    try {
      const code = await context(parseArgs(["context", "colony"]), client, IO);
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/projects/colony/context");
    expect(out.text()).toBe(`${DOC}\n`);
  });

  it("escapes the project name in the GET path", async () => {
    const { client, calls } = fakeClient({
      "get /projects/my%20project/context": json({ context_doc: DOC }),
    });
    const out = captureStdout();
    try {
      await context(parseArgs(["context", "my project"]), client, IO);
    } finally {
      out.restore();
    }
    expect(calls[0]!.path).toBe("/projects/my%20project/context");
  });

  it("says so when the project has no context doc", async () => {
    const { client } = fakeClient({
      "get /projects/colony/context": json({ context_doc: null }),
    });
    const out = captureStdout();
    try {
      await context(parseArgs(["context", "colony"]), client, IO);
    } finally {
      out.restore();
    }
    expect(out.text()).toBe("no context doc\n");
  });

  it("prints the honest {context_doc} payload with --json", async () => {
    const payload = { context_doc: DOC };
    const { client } = fakeClient({
      "get /projects/colony/context": json(payload),
    });
    const out = captureStdout();
    try {
      const code = await context(
        parseArgs(["context", "colony", "--json"]),
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

  it("PUTs the file contents as context_doc with --set <file>", async () => {
    const markdown = "# colony\n\nWritten from a file.\n";
    const file = tempFile("context.md", markdown);
    const { client, calls } = fakeClient({
      "put /projects/colony/context": json({ project: project() }),
    });
    const out = captureStdout();
    try {
      const code = await context(
        parseArgs(["context", "colony", "--set", file]),
        client,
        IO,
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("put");
    expect(calls[0]!.path).toBe("/projects/colony/context");
    expect(calls[0]!.body).toEqual({ context_doc: markdown });
    expect(out.text()).toBe("updated context for colony\n");
  });

  it("does not GET the context doc when --set is given", async () => {
    const file = tempFile("context.md", "# colony\n");
    const { client, calls } = fakeClient({
      "put /projects/colony/context": json({ project: project() }),
    });
    const out = captureStdout();
    try {
      await context(
        parseArgs(["context", "colony", "--set", file]),
        client,
        IO,
      );
    } finally {
      out.restore();
    }
    expect(calls.every((call) => call.method !== "get")).toBe(true);
  });

  it("prints the honest PUT response with --set <file> --json", async () => {
    const markdown = "# colony\n\nWritten from a file.\n";
    const file = tempFile("context.md", markdown);
    const payload = { project: project({ context_doc: markdown }) };
    const { client } = fakeClient({
      "put /projects/colony/context": json(payload),
    });
    const out = captureStdout();
    try {
      const code = await context(
        parseArgs(["context", "colony", "--set", file, "--json"]),
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
