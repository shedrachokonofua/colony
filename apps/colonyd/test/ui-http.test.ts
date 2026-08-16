import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "@colony/core";
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
    provider: {} as ColonydContext["provider"],
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

function appWithStore(): ReturnType<typeof buildApp> {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
  dirs.push(dir);
  return buildApp(fakeCtx(new Store(join(dir, "test.db"))));
}

describe("operator console", () => {
  it("serves the console without an actor", async () => {
    const app = appWithStore();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Operator console");
    expect(html).toContain("/ui/app.js");
  });

  it("serves CSS, JS, and fonts without an actor", async () => {
    const app = appWithStore();
    const css = await app.request("/ui/styles.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);

    const js = await app.request("/ui/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);

    const font = await app.request("/ui/fonts/big-shoulders-800.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toMatch(/font\/woff2/);
  });

  it("exposes public console config without secrets", async () => {
    const app = appWithStore();
    const res = await app.request("/ui/config");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      service: "colonyd",
      gitlab_base_url: "https://gitlab.home.shdr.ch",
      review_mode: "required",
      hitl_mode: "yolo",
      oidc: null,
    });
  });

  it("does not serve files outside ui/", async () => {
    const app = appWithStore();
    const res = await app.request("/ui/%2e%2e/src/http.ts");
    expect(res.status).not.toBe(200);
  });

  it("still requires an actor for the API", async () => {
    const app = appWithStore();
    const res = await app.request("/scopes");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "MISSING_ACTOR" },
    });
  });

  it("includes runs on GET /scopes/:id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const app = buildApp(fakeCtx(store));
    const scope = store.createScope({
      goal: "add /version",
      provider_project_id: "1",
      provider_project_path: "so/colony",
    });
    store.startRun({
      scope_id: scope.id,
      kind: "architect",
      lease_ttl_ms: 60_000,
    });
    const res = await app.request(`/scopes/${scope.id}`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: { kind: string }[];
      tasks: unknown[];
    };
    expect(body.tasks).toEqual([]);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.kind).toBe("architect");
  });
});
