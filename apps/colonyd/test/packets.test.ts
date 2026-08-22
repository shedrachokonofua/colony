import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Store } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";
import {
  buildArchitectPacket,
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
    },
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
      { id: "1", path: "so/demo" },
      "abc123",
    );
    expect(packet.body).toContain(DOC);
    expect(packet.body).toContain(HEADING);
    expect(packet.project).toEqual({ name: "demo", context_doc: DOC });
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
    const audit = (await auditRes.json()) as {
      actor: string;
      action: string;
      detail_json: string;
    }[];
    const writes = audit.filter(
      (row) => row.action === "project.context_updated",
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]!.actor).toBe("human:op-1");
    expect(JSON.parse(writes[0]!.detail_json)).toEqual({
      name: "pre-seeded",
      bytes: 0,
    });
    expect(JSON.parse(writes[1]!.detail_json).bytes).toBe(
      Buffer.byteLength(DOC),
    );

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
    const { app } = appWithStore();
    for (let i = 0; i < 7; i += 1) {
      const res = await app.request(`/projects/p${i}/context`, {
        method: "PUT",
        headers: { ...ACTOR.headers, "content-type": "application/json" },
        body: JSON.stringify({ context_doc: `doc ${i}` }),
      });
      expect(res.status).toBe(200);
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
    expect(body.projects.map((p) => p.name)).toEqual(["p2", "p3", "p4"]);

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
