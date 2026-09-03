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
  const dir = mkdtempSync(join(tmpdir(), "colonyd-project-archive-"));
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

describe("project archiving HTTP contract", () => {
  it("archives and unarchives a project returning 200 with correct archived_at", async () => {
    const { app } = appWithStore();
    const createRes = await createProject(app, "p1");
    expect(createRes.status).toBe(201);

    // Archive
    const archRes = await app.request("/projects/p1/archive", {
      method: "POST",
      headers: ACTOR.headers,
    });
    expect(archRes.status).toBe(200);
    const archBody = (await archRes.json()) as {
      project: { archived_at: string | null };
    };
    expect(archBody.project.archived_at).toBeString();

    // GET /projects/:name includes archived_at
    const getRes = await app.request("/projects/p1", {
      headers: ACTOR.headers,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      project: { archived_at: string | null };
    };
    expect(getBody.project.archived_at).toBe(archBody.project.archived_at);

    // Unarchive
    const unarchRes = await app.request("/projects/p1/unarchive", {
      method: "POST",
      headers: ACTOR.headers,
    });
    expect(unarchRes.status).toBe(200);
    const unarchBody = (await unarchRes.json()) as {
      project: { archived_at: string | null };
    };
    expect(unarchBody.project.archived_at).toBeNull();
  });

  it("returns 404 for unknown project on archive and unarchive", async () => {
    const { app } = appWithStore();
    const archRes = await app.request("/projects/missing/archive", {
      method: "POST",
      headers: ACTOR.headers,
    });
    expect(archRes.status).toBe(404);
    expect(await archRes.json()).toEqual({
      error: { code: "NOT_FOUND", message: "project not found" },
    });

    const unarchRes = await app.request("/projects/missing/unarchive", {
      method: "POST",
      headers: ACTOR.headers,
    });
    expect(unarchRes.status).toBe(404);
    expect(await unarchRes.json()).toEqual({
      error: { code: "NOT_FOUND", message: "project not found" },
    });
  });

  it("returns 409 conflict when archiving with non-terminal scopes and lists scope_ids", async () => {
    const { app, store } = appWithStore();
    await createProject(app, "p-scopes");
    const scope = store.createScope({
      goal: "draft scope",
      title: "draft scope",
      provider_repo_id: "1",
      provider_repo_path: "so/demo",
      project: "p-scopes",
    });

    const archRes = await app.request("/projects/p-scopes/archive", {
      method: "POST",
      headers: ACTOR.headers,
    });
    expect(archRes.status).toBe(409);
    const archBody = (await archRes.json()) as {
      error: { code: string; message: string; scope_ids?: string[] };
    };
    expect(archBody.error.code).toBe("CONFLICT");
    expect(archBody.error.scope_ids).toEqual([scope.id]);
    expect(archBody.error.message).toContain(scope.id);
  });

  it("returns 409 idempotency conflict when archiving already archived or unarchiving live project", async () => {
    const { app } = appWithStore();
    await createProject(app, "p-idem");

    // Unarchive live project -> 409
    const unarchRes1 = await app.request("/projects/p-idem/unarchive", {
      method: "POST",
      headers: ACTOR.headers,
    });
    expect(unarchRes1.status).toBe(409);
    expect(
      ((await unarchRes1.json()) as { error: { code: string } }).error.code,
    ).toBe("CONFLICT");

    // Archive once -> 200
    const archRes1 = await app.request("/projects/p-idem/archive", {
      method: "POST",
      headers: ACTOR.headers,
    });
    expect(archRes1.status).toBe(200);

    // Archive again -> 409
    const archRes2 = await app.request("/projects/p-idem/archive", {
      method: "POST",
      headers: ACTOR.headers,
    });
    expect(archRes2.status).toBe(409);
    expect(
      ((await archRes2.json()) as { error: { code: string } }).error.code,
    ).toBe("CONFLICT");
  });

  it("filters list by default and includes archived when ?archived=1", async () => {
    const { app } = appWithStore();
    await createProject(app, "live-1");
    await createProject(app, "arch-1");
    await app.request("/projects/arch-1/archive", {
      method: "POST",
      headers: ACTOR.headers,
    });

    // Default: excludes archived
    const defaultRes = await app.request("/projects", {
      headers: ACTOR.headers,
    });
    expect(defaultRes.status).toBe(200);
    const defaultBody = (await defaultRes.json()) as {
      projects: Array<{ name: string; archived_at: string | null }>;
      total: number;
    };
    expect(defaultBody.total).toBe(1);
    expect(defaultBody.projects.map((p) => p.name)).toEqual(["live-1"]);
    expect(defaultBody.projects[0]!.archived_at).toBeNull();

    // With ?archived=1
    const withArchRes = await app.request("/projects?archived=1", {
      headers: ACTOR.headers,
    });
    expect(withArchRes.status).toBe(200);
    const withArchBody = (await withArchRes.json()) as {
      projects: Array<{ name: string; archived_at: string | null }>;
      total: number;
    };
    expect(withArchBody.total).toBe(2);
    expect(withArchBody.projects.map((p) => p.name).sort()).toEqual([
      "arch-1",
      "live-1",
    ]);
    const archEntry = withArchBody.projects.find((p) => p.name === "arch-1");
    expect(archEntry?.archived_at).toBeString();
  });

  it("POST /scopes against an archived project returns 409 while new project name returns 201", async () => {
    const { app } = appWithStore();
    await createProject(app, "arch-proj");
    await app.request("/projects/arch-proj/archive", {
      method: "POST",
      headers: ACTOR.headers,
    });

    // Attempt createScope against archived project -> 409
    const scopeArchRes = await app.request("/scopes", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        goal: "try on archived",
        title: "try on archived",
        project: "arch-proj",
        repo: { path: "so/demo" },
      }),
    });
    expect(scopeArchRes.status).toBe(409);
    const scopeArchBody = (await scopeArchRes.json()) as {
      error: { code: string; message: string };
    };
    expect(scopeArchBody.error.code).toBe("CONFLICT");
    expect(scopeArchBody.error.message).toContain("arch-proj");

    // Scope creation with new project name -> 201
    const scopeNewRes = await app.request("/scopes", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        goal: "try on brand new",
        title: "try on brand new",
        project: "fresh-new-proj",
        repo: { path: "so/demo" },
      }),
    });
    expect(scopeNewRes.status).toBe(201);
  });

  it("records project.archived and project.unarchived audit rows with request actor", async () => {
    const { app } = appWithStore();
    await createProject(app, "audit-proj");

    await app.request("/projects/audit-proj/archive", {
      method: "POST",
      headers: { "X-Actor-Id": "human:op-42" },
    });
    await app.request("/projects/audit-proj/unarchive", {
      method: "POST",
      headers: { "X-Actor-Id": "human:op-42" },
    });

    const auditRes = await app.request("/audit?limit=100", {
      headers: ACTOR.headers,
    });
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as {
      events: Array<{
        action: string;
        actor: string;
        detail_json: string;
      }>;
    };

    const archAudit = auditBody.events.find(
      (e) => e.action === "project.archived",
    );
    expect(archAudit).toBeDefined();
    expect(archAudit?.actor).toBe("human:op-42");
    expect(JSON.parse(archAudit!.detail_json)).toEqual({
      project: "audit-proj",
    });

    const unarchAudit = auditBody.events.find(
      (e) => e.action === "project.unarchived",
    );
    expect(unarchAudit).toBeDefined();
    expect(unarchAudit?.actor).toBe("human:op-42");
    expect(JSON.parse(unarchAudit!.detail_json)).toEqual({
      project: "audit-proj",
    });
  });
});
