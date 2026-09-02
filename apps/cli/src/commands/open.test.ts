import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../args.js";
import { ApiError } from "../client.js";
import { captureStdout, fakeClient, json, parseJsonOut } from "../fakes.js";
import { run } from "./open.js";

const IO = { json: false, isTty: false };

function projectsPage(names: string[], offset = 0) {
  return {
    items: names.map((name) => ({
      name,
      context_doc: null,
      created_at: "2026-08-30T09:00:00.000Z",
      updated_at: "2026-08-30T10:00:00.000Z",
    })),
    total: names.length,
    limit: 100,
    offset,
  };
}

const SCOPE = {
  id: "col-abcd1234",
  title: "Ship the CLI",
  status: "draft",
  project_name: "colony",
  created_at: "2026-08-30T10:00:00.000Z",
  goal: "land the mutation slice",
  plan_json: null,
};

function openRoute() {
  return {
    "get /projects": json(projectsPage(["colony", "infra"])),
    "post /scopes": json(SCOPE),
  };
}

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function goalFile(contents = "land the mutation slice\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "colony-cli-open-"));
  tempDirs.push(dir);
  const path = join(dir, "goal.md");
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

describe("open", () => {
  it("posts the goal file to /scopes with repo.path", async () => {
    const file = goalFile();
    const { client, calls } = fakeClient(openRoute());
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs([
          "open",
          file,
          "--title",
          "Ship the CLI",
          "--repo",
          "/srv/repo",
        ]),
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
        path: "/scopes",
        query: undefined,
        body: {
          goal: "land the mutation slice\n",
          title: "Ship the CLI",
          repo: { path: "/srv/repo" },
        },
      },
    ]);
    expect(out.text()).toBe("opened col-abcd1234 — Ship the CLI (draft)\n");
  });

  it("reads the goal from stdin for '-'", async () => {
    const { client, calls } = fakeClient(openRoute());
    const original = process.stdin;
    process.stdin = (async function* () {
      yield Buffer.from("piped goal\n");
    })() as unknown as typeof process.stdin;
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["open", "-", "--repo", "/srv/repo"]),
        client,
        IO,
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
      process.stdin = original;
    }
    expect(calls[0]!.body).toEqual({
      goal: "piped goal\n",
      repo: { path: "/srv/repo" },
    });
  });

  it("refuses an unknown project with the known list and no POST", async () => {
    const file = goalFile();
    const { client, calls } = fakeClient(openRoute());
    const err = captureStderr();
    try {
      const code = await run(
        parseArgs(["open", file, "--project", "colny", "--repo", "/srv/repo"]),
        client,
        IO,
      );
      expect(code).toBe(2);
    } finally {
      err.restore();
    }
    expect(calls.some((call) => call.method === "post")).toBe(false);
    expect(err.text()).toBe(
      'unknown project "colny" — known projects: colony, infra\n',
    );
  });

  it("posts anyway with --create-project for an unknown project", async () => {
    const file = goalFile();
    const { client, calls } = fakeClient(openRoute());
    try {
      const code = await run(
        parseArgs([
          "open",
          file,
          "--project",
          "colny",
          "--create-project",
          "--repo",
          "/srv/repo",
        ]),
        client,
        IO,
      );
      expect(code).toBe(0);
    } finally {
      // stdout write of the success line happens after the POST; nothing to check.
    }
    expect(calls[0]).toMatchObject({
      method: "post",
      path: "/scopes",
      body: {
        goal: "land the mutation slice\n",
        project: "colny",
        repo: { path: "/srv/repo" },
      },
    });
  });

  it("does not consult /projects when --project is absent", async () => {
    const file = goalFile();
    const { client, calls } = fakeClient(openRoute());
    const out = captureStdout();
    try {
      await run(parseArgs(["open", file, "--repo", "/srv/repo"]), client, IO);
    } finally {
      out.restore();
    }
    expect(calls.every((call) => call.method !== "get")).toBe(true);
  });

  it("walks every page of /projects before judging a project unknown", async () => {
    const file = goalFile();
    let page = 0;
    const { client, calls } = fakeClient({
      "get /projects": () => {
        page += 1;
        return page === 1
          ? {
              items: projectsPage(
                Array.from({ length: 100 }, (_, i) => `p${i}`),
              ).items,
              total: 101,
              limit: 100,
              offset: 0,
            }
          : {
              items: projectsPage(["colony"], 100).items,
              total: 101,
              limit: 100,
              offset: 100,
            };
      },
      "post /scopes": json(SCOPE),
    });
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["open", file, "--project", "colony", "--repo", "/srv/repo"]),
        client,
        IO,
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(calls).toHaveLength(3);
  });

  it("exits 2 with a hint when --repo is missing", async () => {
    const file = goalFile();
    const { client, calls } = fakeClient(openRoute());
    await expect(
      run(parseArgs(["open", file]), client, IO),
    ).rejects.toMatchObject({
      name: "UsageError",
      message: expect.stringContaining("--repo"),
    });
    expect(calls).toHaveLength(0);
  });

  it("exits 2 when the goal source is empty", async () => {
    const file = goalFile("");
    const { client, calls } = fakeClient(openRoute());
    await expect(
      run(parseArgs(["open", file, "--repo", "/srv/repo"]), client, IO),
    ).rejects.toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
  });

  it("prints the honest created scope with --json", async () => {
    const file = goalFile();
    const { client } = fakeClient(openRoute());
    const out = captureStdout();
    try {
      const code = await run(
        parseArgs(["open", file, "--repo", "/srv/repo", "--json"]),
        client,
        { json: true, isTty: false },
      );
      expect(code).toBe(0);
    } finally {
      out.restore();
    }
    expect(parseJsonOut(out.text())).toEqual(SCOPE);
  });

  it("maps an ApiError from POST /scopes to a thrown error (exit 1 via main)", async () => {
    const file = goalFile();
    const { client } = fakeClient({
      "get /projects": json(projectsPage(["colony"])),
      "post /scopes": () => {
        throw new ApiError(404, "REPO_NOT_FOUND", "no such repo");
      },
    });
    await expect(
      run(parseArgs(["open", file, "--repo", "/srv/repo"]), client, IO),
    ).rejects.toMatchObject({ status: 404, code: "REPO_NOT_FOUND" });
  });
});
