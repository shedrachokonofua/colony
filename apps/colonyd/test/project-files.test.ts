import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Store } from "@colony/core";
import { createLocalArtifactStore } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeCtx(store: Store): ColonydContext {
  return {
    store,
    provider: {
      repos: {
        getByPath: async (path: string) =>
          path === "so/demo"
            ? { id: "1", path: "so/demo", default_branch: "main" }
            : null,
      },
    } as unknown as ColonydContext["provider"],
    config: {
      reviewMode: "required",
      hitlMode: "yolo",
    } as ColonydContext["config"],
    agents: {} as ColonydContext["agents"],
    artifacts: createLocalArtifactStore(
      mkdtempSync(join(tmpdir(), "colonyd-artifacts-")),
    ),
    logger: { info() {}, warn() {}, error() {} },
    env: {
      gitlabBaseUrl: "https://gitlab.home.shdr.ch",
      gitlabToken: "",
      webhookSecret: "",
      singleToken: true,
      maxConcurrent: 1,
      maxAttempts: 3,
      oidcIssuer: "",
      oidcClientId: "colony",
      oidcRequiredRole: "",
      traceUiBaseUrl: "",
      consoleBaseUrl: "",
    },
    draining: { isDraining: () => false },
    requestTick() {},
  };
}

function appWithStore() {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-project-files-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  return { store, app: buildApp(fakeCtx(store)) };
}

const ACTOR = { headers: { "X-Actor-Id": "human:op-1" } };
const JSON_HEADERS = { ...ACTOR.headers, "content-type": "application/json" };

interface TestApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

async function createProject(
  app: TestApp,
  name: string,
  context_doc: string | null = null,
): Promise<Response> {
  return app.request("/projects", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, context_doc }),
  });
}

async function createFile(
  app: TestApp,
  project: string,
  filename: string,
  content = "hello",
  media_type = "text/plain",
): Promise<Response> {
  return app.request(`/projects/${project}/files`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ filename, media_type, content }),
  });
}

describe("project files HTTP contract", () => {
  it("creates a project explicitly and reads it back enriched", async () => {
    const { app } = appWithStore();
    const res = await createProject(app, "alpha", "# Alpha");
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project: {
        name: string;
        context_doc: string | null;
        file_count: number;
        file_bytes: number;
        repositories: unknown[];
      };
    };
    expect(body.project.name).toBe("alpha");
    expect(body.project.context_doc).toBe("# Alpha");
    expect(body.project.file_count).toBe(0);
    expect(body.project.file_bytes).toBe(0);
    expect(body.project.repositories).toEqual([]);

    const detail = await app.request("/projects/alpha", ACTOR);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      project: { name: string; file_count: number };
    };
    expect(detailBody.project.name).toBe("alpha");
    expect(detailBody.project.file_count).toBe(0);
  });

  it("409s a duplicate project name", async () => {
    const { app } = appWithStore();
    expect((await createProject(app, "dup")).status).toBe(201);
    const dup = await createProject(app, "dup");
    expect(dup.status).toBe(409);
    await expect(dup.json()).resolves.toMatchObject({
      error: { code: "CONFLICT" },
    });
  });

  it("rejects an invalid project body strictly", async () => {
    const { app } = appWithStore();
    const empty = await app.request("/projects", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "" }),
    });
    expect(empty.status).toBe(400);
    const extra = await app.request("/projects", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "x", actor: "y" }),
    });
    expect(extra.status).toBe(400);
  });

  it("creates, lists, replaces, and deletes a file with audit rows", async () => {
    const { store, app } = appWithStore();
    await createProject(app, "p");

    const created = await createFile(
      app,
      "p",
      "notes.md",
      "# Notes",
      "text/markdown",
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      id: string;
      filename: string;
      media_type: string;
      content: string;
      byte_size: number;
      sha256: string;
    };
    expect(createdBody.filename).toBe("notes.md");
    expect(createdBody.media_type).toBe("text/markdown");
    expect(createdBody.content).toBe("# Notes");
    expect(createdBody.byte_size).toBe(Buffer.byteLength("# Notes"));
    expect(createdBody.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(createdBody.id).toMatch(/^pf-[0-9a-f]{12}$/);

    // List omits content.
    const list = await app.request("/projects/p/files", ACTOR);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      files: { id: string; filename: string; content?: string }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(listBody.total).toBe(1);
    expect(listBody.limit).toBe(25);
    expect(listBody.offset).toBe(0);
    expect(listBody.files[0]!.filename).toBe("notes.md");
    expect(listBody.files[0]).not.toHaveProperty("content");

    // Replace.
    const replaced = await app.request(`/projects/p/files/${createdBody.id}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ media_type: "text/plain", content: "replaced" }),
    });
    expect(replaced.status).toBe(200);
    const replacedBody = (await replaced.json()) as {
      content: string;
      media_type: string;
      byte_size: number;
    };
    expect(replacedBody.content).toBe("replaced");
    expect(replacedBody.media_type).toBe("text/plain");
    expect(replacedBody.byte_size).toBe(Buffer.byteLength("replaced"));

    // Delete.
    const deleted = await app.request(`/projects/p/files/${createdBody.id}`, {
      method: "DELETE",
      headers: ACTOR.headers,
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true });
    const after = await app.request("/projects/p/files", ACTOR);
    expect(((await after.json()) as { total: number }).total).toBe(0);

    // Audit rows for every mutation.
    const auditRes = await app.request("/audit?limit=100", ACTOR);
    const audit = (
      (await auditRes.json()) as {
        events: { action: string; actor: string; detail_json: string }[];
      }
    ).events;
    const actions = audit.map((row) => row.action);
    expect(actions).toContain("project.created");
    expect(actions).toContain("project.file_created");
    expect(actions).toContain("project.file_replaced");
    expect(actions).toContain("project.file_deleted");
    const createdAudit = audit.find(
      (row) => row.action === "project.file_created",
    )!;
    expect(createdAudit.actor).toBe("human:op-1");
    expect(JSON.parse(createdAudit.detail_json)).toEqual({
      project: "p",
      filename: "notes.md",
      byte_size: Buffer.byteLength("# Notes"),
      sha256: createdBody.sha256,
    });
  });

  it("409s a duplicate filename within a project", async () => {
    const { app } = appWithStore();
    await createProject(app, "p");
    expect((await createFile(app, "p", "a.txt")).status).toBe(201);
    const dup = await createFile(app, "p", "a.txt");
    expect(dup.status).toBe(409);
    await expect(dup.json()).resolves.toMatchObject({
      error: { code: "CONFLICT", message: "file exists: a.txt" },
    });
  });

  it("400s invalid filenames", async () => {
    const { app } = appWithStore();
    await createProject(app, "p");
    const cases = [
      "../secrets",
      "a/b",
      "a\\b",
      "a\0b",
      ".",
      "..",
      "PACKET.json",
      "packet.json",
      ".colony",
      ".git",
      ".env",
      "x".repeat(121),
      "-leading",
    ];
    for (const filename of cases) {
      const res = await createFile(app, "p", filename);
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("INVALID_BODY");
      expect(body.error.message).toContain("filename invalid");
    }
  });

  it("400s an invalid media type", async () => {
    const { app } = appWithStore();
    await createProject(app, "p");
    const res = await app.request("/projects/p/files", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        filename: "a.txt",
        media_type: "application/pdf",
        content: "x",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("media_type");
  });

  it("400s content that is not valid UTF-8", async () => {
    const { app } = appWithStore();
    await createProject(app, "p");
    const res = await createFile(app, "p", "a.txt", "\uD800");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("UTF-8");
  });

  it("400s content exceeding the per-file byte cap", async () => {
    const { app } = appWithStore();
    await createProject(app, "p");
    const res = await createFile(app, "p", "big.txt", "x".repeat(262145));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("262144");
  });

  it("400s when a write would exceed the aggregate project byte cap", async () => {
    const { app } = appWithStore();
    await createProject(app, "p");
    // 8 files of 256 KiB = 2 MiB exactly; the 9th must be rejected.
    for (let i = 0; i < 8; i += 1) {
      const res = await createFile(app, "p", `f${i}.txt`, "x".repeat(262144));
      expect(res.status).toBe(201);
    }
    const over = await createFile(app, "p", "f8.txt", "x".repeat(262144));
    expect(over.status).toBe(400);
    const body = (await over.json()) as { error: { message: string } };
    expect(body.error.message).toContain("2097152");
  });

  it("404s unknown projects and unknown files", async () => {
    const { app } = appWithStore();
    await createProject(app, "p");

    const listMissing = await app.request("/projects/nope/files", ACTOR);
    expect(listMissing.status).toBe(404);
    const createMissing = await createFile(app, "nope", "a.txt");
    expect(createMissing.status).toBe(404);
    const putMissing = await app.request(
      "/projects/nope/files/pf-000000000000",
      {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ media_type: "text/plain", content: "x" }),
      },
    );
    expect(putMissing.status).toBe(404);
    const deleteMissing = await app.request(
      "/projects/nope/files/pf-000000000000",
      {
        method: "DELETE",
        headers: ACTOR.headers,
      },
    );
    expect(deleteMissing.status).toBe(404);

    const putUnknownFile = await app.request(
      "/projects/p/files/pf-000000000000",
      {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ media_type: "text/plain", content: "x" }),
      },
    );
    expect(putUnknownFile.status).toBe(404);
    const deleteUnknownFile = await app.request(
      "/projects/p/files/pf-000000000000",
      {
        method: "DELETE",
        headers: ACTOR.headers,
      },
    );
    expect(deleteUnknownFile.status).toBe(404);
  });

  it("paginates files with content omitted and honest totals", async () => {
    const { app } = appWithStore();
    await createProject(app, "p");
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await createFile(app, "p", `f${i}.txt`, `content ${i}`)).status,
      ).toBe(201);
    }
    const page = await app.request("/projects/p/files?limit=2&offset=1", ACTOR);
    expect(page.status).toBe(200);
    const body = (await page.json()) as {
      files: { filename: string; content?: string }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.files.map((f) => f.filename)).toEqual(["f1.txt", "f2.txt"]);
    for (const file of body.files) expect(file).not.toHaveProperty("content");

    const badLimit = await app.request("/projects/p/files?limit=101", ACTOR);
    expect(badLimit.status).toBe(400);
    const badOffset = await app.request("/projects/p/files?offset=-1", ACTOR);
    expect(badOffset.status).toBe(400);
  });

  it("enriches GET /projects and GET /projects/:name with file and repo fields", async () => {
    const { store, app } = appWithStore();
    await createProject(app, "p");
    await createFile(app, "p", "a.txt", "hello");
    await createFile(app, "p", "b.md", "world", "text/markdown");
    store.createScope({
      goal: "g",
      title: "g",
      provider_repo_id: "1",
      provider_repo_path: "so/p",
      project: "p",
    });

    const list = await app.request("/projects", ACTOR);
    const listBody = (await list.json()) as {
      projects: {
        name: string;
        file_count: number;
        file_bytes: number;
        repositories: unknown[];
      }[];
    };
    const row = listBody.projects.find((x) => x.name === "p")!;
    expect(row.file_count).toBe(2);
    expect(row.file_bytes).toBe(
      Buffer.byteLength("hello") + Buffer.byteLength("world"),
    );
    expect(row.repositories).toEqual([{ repo_id: "1", repo_path: "so/p" }]);

    const detail = await app.request("/projects/p", ACTOR);
    const detailBody = (await detail.json()) as {
      project: {
        file_count: number;
        file_bytes: number;
        repositories: unknown[];
      };
    };
    expect(detailBody.project.file_count).toBe(2);
    expect(detailBody.project.file_bytes).toBe(row.file_bytes);
    expect(detailBody.project.repositories).toEqual([
      { repo_id: "1", repo_path: "so/p" },
    ]);
  });
});
