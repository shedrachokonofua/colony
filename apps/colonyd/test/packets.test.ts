import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Store } from "@colony/core";
import { createLocalArtifactStore } from "@colony/core";
import { provisionScratchDir } from "@colony/agent-runtime";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";
import {
  buildArchitectPacket,
  buildImplementPacket,
  buildReviewPacket,
  projectContextSection,
} from "../src/runs/packets.js";

const HEADING = "## Operator-authored project background (project: demo)";
const DOC = "# Demo context\n\nUse bun, never npm. Postgres on :5433.";
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
    },
    draining: { isDraining: () => false },
    requestTick() {},
  };
}

function appWithStore() {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-packets-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  return { store, app: buildApp(fakeCtx(store)) };
}

const ACTOR = { headers: { "X-Actor-Id": "human:op-1" } };

/** Structural view of the Hono app: tests only ever call `.request`. */
interface TestApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

async function createScope(
  app: TestApp,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await app.request("/scopes", {
    method: "POST",
    headers: { ...ACTOR.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe("project context packets", () => {
  it("carries the operator doc in the architect packet under the stable heading", async () => {
    const { store, app } = appWithStore();
    const scope = await createScope(app, {
      goal: "ship the demo endpoint",
      project: "demo",
      repo: { path: "so/demo" },
    });
    const put = await app.request("/projects/demo/context", {
      method: "PUT",
      headers: { ...ACTOR.headers, "content-type": "application/json" },
      body: JSON.stringify({ context_doc: DOC }),
    });
    expect(put.status).toBe(200);

    const packet = buildArchitectPacket(
      store.getScope(scope.id)!,
      store.getProject("demo")!,
      store.listProjectFiles("demo"),
      { id: "1", path: "so/demo" },
      "abc123",
    );
    expect(packet.body).toContain(DOC);
    expect(packet.body).toContain(HEADING);
    expect(packet.project).toEqual({
      name: "demo",
      context_doc: DOC,
      files: [],
    });
    // Unchanged packet contract.
    expect(packet.kind).toBe("architect_scope");
    expect(packet.scope_id).toBe(scope.id);
    expect(packet.goal).toBe("ship the demo endpoint");
    expect(packet.repo).toEqual({
      url: "so/demo",
      branch: "main",
      base_commit: "abc123",
    });
    // The builder never mints credentials; architect.ts attaches the token.
    expect("credentials" in packet.repo).toBe(false);
  });

  it("gives a scope with no project a null project field and no background section", async () => {
    const { store, app } = appWithStore();
    const scope = await createScope(app, {
      goal: "ungrouped work",
      repo: { path: "so/demo" },
    });
    const packet = buildArchitectPacket(
      store.getScope(scope.id)!,
      null,
      [],
      { id: "1", path: "so/demo" },
      "abc123",
    );
    expect(packet.project).toBeNull();
    expect(packet.body).not.toContain("Operator-authored project background");
  });

  it("treats an empty or whitespace-only doc as no context", () => {
    expect(projectContextSection(null)).toBe("");
    expect(projectContextSection(undefined)).toBe("");
    expect(projectContextSection({ name: "demo", context_doc: null })).toBe("");
    expect(projectContextSection({ name: "demo", context_doc: "" })).toBe("");
    expect(projectContextSection({ name: "demo", context_doc: "  \n\t" })).toBe(
      "",
    );
    const section = projectContextSection({ name: "demo", context_doc: DOC });
    expect(section.startsWith(`${HEADING}\n\n`)).toBe(true);
    expect(section.endsWith(`${DOC}\n`)).toBe(true);
  });
});

const JSON_HEADERS = { ...ACTOR.headers, "content-type": "application/json" };

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

describe("project reference files in packets", () => {
  it("carries a compact files manifest and body paths for a brief + two files", async () => {
    const { store, app } = appWithStore();
    expect((await createProject(app, "demo", DOC)).status).toBe(201);
    expect((await createFile(app, "demo", "b.txt", "second")).status).toBe(201);
    expect(
      (await createFile(app, "demo", "a.md", "# First", "text/markdown"))
        .status,
    ).toBe(201);

    const scope = await createScope(app, {
      goal: "ship",
      project: "demo",
      repo: { path: "so/demo" },
    });
    const project = store.getProject("demo")!;
    const files = store.listProjectFiles("demo");
    const packet = buildArchitectPacket(
      store.getScope(scope.id)!,
      project,
      files,
      { id: "1", path: "so/demo" },
      "abc123",
    );

    expect(packet.project).not.toBeNull();
    const manifest = packet.project!.files;
    expect(manifest).toHaveLength(2);
    // Sorted by filename: a.md before b.txt
    expect(manifest[0]!.filename).toBe("a.md");
    expect(manifest[0]!.media_type).toBe("text/markdown");
    expect(manifest[0]!.path).toBe(".colony/project/a.md");
    expect(manifest[0]!.id).toBe(files.find((f) => f.filename === "a.md")!.id);
    expect(manifest[0]!.byte_size).toBe(
      files.find((f) => f.filename === "a.md")!.byte_size,
    );
    // No file content in the packet JSON.
    const json = JSON.stringify(packet);
    expect(json).not.toContain("# First");
    expect(json).not.toContain("second");
    expect(json).not.toMatch(/(?<=project\.files.*?)content.*?:/s);
    // Body lists paths, brief heading unchanged.
    expect(packet.body).toContain(
      "## Project reference files (read on demand)",
    );
    expect(packet.body).toContain("- .colony/project/a.md (text/markdown");
    expect(packet.body).toContain("- .colony/project/b.txt (text/plain");
    expect(packet.body).toContain(HEADING);
    expect(packet.body).toContain(DOC);
  });

  it("carries a files manifest for a file-only project (empty brief)", async () => {
    const { store, app } = appWithStore();
    expect((await createProject(app, "fileonly", "")).status).toBe(201);
    expect(
      (
        await createFile(
          app,
          "fileonly",
          "guide.md",
          "# Guide",
          "text/markdown",
        )
      ).status,
    ).toBe(201);
    const scope = await createScope(app, {
      goal: "files only",
      project: "fileonly",
      repo: { path: "so/demo" },
    });
    const project = store.getProject("fileonly")!;
    const files = store.listProjectFiles("fileonly");
    const packet = buildArchitectPacket(
      store.getScope(scope.id)!,
      project,
      files,
      { id: "1", path: "so/demo" },
      "abc123",
    );
    expect(packet.project).not.toBeNull();
    expect(packet.project!.name).toBe("fileonly");
    expect(packet.project!.context_doc).toBe("");
    expect(packet.project!.files.map((f) => f.filename)).toEqual(["guide.md"]);
    expect(packet.body).not.toContain("Operator-authored project background");
    expect(packet.body).toContain(
      "## Project reference files (read on demand)",
    );
  });

  it("yields project: null when a project has neither brief nor files", async () => {
    const { store, app } = appWithStore();
    expect((await createProject(app, "bare", null)).status).toBe(201);
    const scope = await createScope(app, {
      goal: "bare",
      project: "bare",
      repo: { path: "so/demo" },
    });
    const project = store.getProject("bare")!;
    const files = store.listProjectFiles("bare");
    const packet = buildArchitectPacket(
      store.getScope(scope.id)!,
      project,
      files,
      { id: "1", path: "so/demo" },
      "abc123",
    );
    expect(packet.project).toBeNull();
    expect(packet.body).not.toContain("## Project reference files");
  });

  it("all three builders carry the files manifest and body section", async () => {
    const { store, app } = appWithStore();
    expect((await createProject(app, "all-test", DOC)).status).toBe(201);
    expect(
      (await createFile(app, "all-test", "ref.md", "# Ref", "text/markdown"))
        .status,
    ).toBe(201);
    const scope = await createScope(app, {
      goal: "test all builders",
      project: "all-test",
      repo: { path: "so/demo" },
    });
    // Move draft -> planning so materializePlan can transition planning -> active.
    store.setScopeStatus(scope.id, "planning", "human:op-1");
    // Materialize a plan to create a real task.
    store.materializePlan(
      scope.id,
      {
        kind: "architect_decomposition",
        summary: "test",
        acceptance: [{ description: "d", command: "true" }],
        tasks: [{ title: "task1", spec: "spec1", depends_on: [] }],
      },
      "human:op-1",
    );
    const task = store.listTasks(scope.id)[0]!;
    const project = store.getProject("all-test")!;
    const files = store.listProjectFiles("all-test");
    const s = store.getScope(scope.id)!;

    const arch = buildArchitectPacket(
      s,
      project,
      files,
      { id: "1", path: "so/demo" },
      "base",
    );
    const impl = buildImplementPacket(
      task,
      s,
      project,
      files,
      { id: "1", path: "so/demo" },
      "colony/x",
      "base",
    );
    const rev = buildReviewPacket(
      task,
      s,
      project,
      files,
      { id: "1", path: "so/demo" },
      "base",
    );

    for (const packet of [arch, impl, rev]) {
      expect(packet.project).not.toBeNull();
      expect(packet.project!.files.map((f) => f.filename)).toEqual(["ref.md"]);
      expect(packet.project!.files[0]!.path).toBe(".colony/project/ref.md");
      expect(JSON.stringify(packet)).not.toContain("# Ref");
      expect(packet.body).toContain(
        "## Project reference files (read on demand)",
      );
      expect(packet.body).toContain("- .colony/project/ref.md (text/markdown");
      expect(packet.body).toContain(
        "## Operator-authored project background (project: all-test)",
      );
      expect(packet.body).toContain(DOC);
    }
  });

  it("implement packet instructs pre-submit rebase and lands existing MRs", async () => {
    const { store, app } = appWithStore();
    const scope = await createScope(app, {
      goal: "landing test",
      repo: { path: "so/demo" },
    });
    store.setScopeStatus(scope.id, "planning", "human:op-1");
    store.materializePlan(
      scope.id,
      {
        kind: "architect_decomposition",
        summary: "test",
        acceptance: [{ description: "d", command: "true" }],
        tasks: [{ title: "task1", spec: "spec1", depends_on: [] }],
      },
      "human:op-1",
    );
    const task = store.listTasks(scope.id)[0]!;
    const s = store.getScope(scope.id)!;

    const fresh = buildImplementPacket(
      task,
      s,
      null,
      [],
      { id: "1", path: "so/demo" },
      "colony/x",
      "base",
    );
    expect(fresh.body).toContain("git rebase origin/");
    expect(fresh.body).not.toContain("LAND IT");

    const landing = buildImplementPacket(
      task,
      s,
      null,
      [],
      { id: "1", path: "so/demo" },
      "colony/x",
      "base",
      { openMr: "MR !7 is open on branch `colony/x`." },
    );
    expect(landing.body).toContain(
      "## An MR for this task already exists — LAND IT",
    );
    expect(landing.body).toContain("MR !7 is open on branch `colony/x`.");
    expect(landing.body).toContain("Do NOT start over or open a new MR.");
  });

  it("materializes real file bytes from a builder-produced packet into the workspace", async () => {
    const { store, app } = appWithStore();
    expect((await createProject(app, "deliver", DOC)).status).toBe(201);
    expect(
      (await createFile(app, "deliver", "guide.md", "# Guide", "text/markdown"))
        .status,
    ).toBe(201);
    expect(
      (await createFile(app, "deliver", "notes.txt", "hello world")).status,
    ).toBe(201);
    const scope = await createScope(app, {
      goal: "deliver",
      project: "deliver",
      repo: { path: "so/demo" },
    });
    const packet = buildArchitectPacket(
      store.getScope(scope.id)!,
      store.getProject("deliver")!,
      store.listProjectFiles("deliver"),
      { id: "1", path: "so/demo" },
      "abc123",
    );

    const dir = mkdtempSync(join(tmpdir(), "colonyd-deliver-"));
    dirs.push(dir);
    provisionScratchDir(
      "deliver-run",
      packet as unknown as Parameters<typeof provisionScratchDir>[1],
      dir,
    );

    // The workspace files carry the real reference content, read-only.
    const guide = join(dir, ".colony", "project", "guide.md");
    const notes = join(dir, ".colony", "project", "notes.txt");
    expect(readFileSync(guide, "utf8")).toBe("# Guide");
    expect(readFileSync(notes, "utf8")).toBe("hello world");

    // The persisted PACKET.json stays content-free: the manifest lists
    // paths only, never file contents.
    const persisted = readFileSync(join(dir, "PACKET.json"), "utf8");
    expect(persisted).not.toContain("# Guide");
    expect(persisted).not.toContain("hello world");
    expect(persisted).toContain(".colony/project/guide.md");
  });
});

describe("project context HTTP contract", () => {
  it("PUT creates an unknown project, GET round-trips, null clears, writes audit", async () => {
    const { store, app } = appWithStore();

    const created = await app.request("/projects/pre-seeded/context", {
      method: "PUT",
      headers: { ...ACTOR.headers, "content-type": "application/json" },
      body: JSON.stringify({ context_doc: DOC }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      project: { name: string; context_doc: string | null };
    };
    expect(createdBody.project.name).toBe("pre-seeded");
    expect(createdBody.project.context_doc).toBe(DOC);

    const got = await app.request("/projects/pre-seeded/context", ACTOR);
    expect(got.status).toBe(200);
    await expect(got.json()).resolves.toEqual({ context_doc: DOC });

    const cleared = await app.request("/projects/pre-seeded/context", {
      method: "PUT",
      headers: { ...ACTOR.headers, "content-type": "application/json" },
      body: JSON.stringify({ context_doc: null }),
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      project: { name: "pre-seeded", context_doc: null },
    });
    await expect(
      (await app.request("/projects/pre-seeded/context", ACTOR)).json(),
    ).resolves.toEqual({ context_doc: null });

    const auditRes = await app.request("/audit?limit=100", ACTOR);
    const audit = (
      (await auditRes.json()) as {
        events: { actor: string; action: string; detail_json: string }[];
      }
    ).events;
    const writes = audit.filter(
      (row) => row.action === "project.context_updated",
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]!.actor).toBe("human:op-1");
    expect(JSON.parse(writes[0]!.detail_json)).toEqual({
      name: "pre-seeded",
      bytes: Buffer.byteLength(DOC),
    });
    expect(JSON.parse(writes[1]!.detail_json).bytes).toBe(0);

    expect(store.getProject("pre-seeded")).toBeTruthy();
  });

  it("404s reads of an unknown project and rejects invalid bodies strictly", async () => {
    const { app } = appWithStore();
    const missing = await app.request("/projects/nope/context", ACTOR);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    const detail = await app.request("/projects/nope", ACTOR);
    expect(detail.status).toBe(404);

    const oversize = await app.request("/projects/demo/context", {
      method: "PUT",
      headers: { ...ACTOR.headers, "content-type": "application/json" },
      body: JSON.stringify({ context_doc: "x".repeat(100_001) }),
    });
    expect(oversize.status).toBe(400);
    const extraKeys = await app.request("/projects/demo/context", {
      method: "PUT",
      headers: { ...ACTOR.headers, "content-type": "application/json" },
      body: JSON.stringify({ context_doc: null, actor: "x" }),
    });
    expect(extraKeys.status).toBe(400);
    const missingKey = await app.request("/projects/demo/context", {
      method: "PUT",
      headers: { ...ACTOR.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingKey.status).toBe(400);
  });

  it("returns honest pagination from GET /projects", async () => {
    const { store, app } = appWithStore();
    for (let i = 0; i < 7; i += 1) {
      const res = await app.request(`/projects/p${i}/context`, {
        method: "PUT",
        headers: { ...ACTOR.headers, "content-type": "application/json" },
        body: JSON.stringify({ context_doc: `doc ${i}` }),
      });
      expect(res.status).toBe(200);
    }
    // Force a deterministic updated_at per project so the ordering contract
    // (updated_at DESC, name ASC) is asserted without millisecond ties.
    for (let i = 0; i < 7; i += 1) {
      store.db
        .prepare(`UPDATE projects SET updated_at = ? WHERE name = ?`)
        .run(`2026-01-01T00:00:0${i}.000Z`, `p${i}`);
    }
    const page = await app.request("/projects?limit=3&offset=2", ACTOR);
    expect(page.status).toBe(200);
    const body = (await page.json()) as {
      projects: { name: string }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBe(7);
    expect(body.limit).toBe(3);
    expect(body.offset).toBe(2);
    // Most recently updated first: p6..p0, so offset 2 -> p4, p3, p2.
    expect(body.projects.map((p) => p.name)).toEqual(["p4", "p3", "p2"]);

    const defaults = (await (await app.request("/projects", ACTOR)).json()) as {
      limit: number;
      offset: number;
      total: number;
    };
    expect(defaults.limit).toBe(25);
    expect(defaults.offset).toBe(0);
    expect(defaults.total).toBe(7);

    const bad = await app.request("/projects?limit=101", ACTOR);
    expect(bad.status).toBe(400);
    const negative = await app.request("/projects?offset=-1", ACTOR);
    expect(negative.status).toBe(400);

    // GET /scopes/:id resolves the project alongside tasks/deps/runs.
    const scope = await createScope(app, {
      goal: "with project",
      project: "p1",
      repo: { path: "so/demo" },
    });
    const detail = await app.request(`/scopes/${scope.id}`, ACTOR);
    expect(detail.status).toBe(200);
    const scoped = (await detail.json()) as {
      project: { name: string; context_doc: string | null } | null;
    };
    expect(scoped.project).toMatchObject({ name: "p1", context_doc: "doc 1" });
  });
});
