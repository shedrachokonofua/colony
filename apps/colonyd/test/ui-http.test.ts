import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";
import { isInfraError } from "../src/tick.js";

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

  it("serves the console package files exactly", async () => {
    const pkgDir = dirname(
      createRequire(import.meta.url).resolve("@colony/console/package.json"),
    );
    const app = appWithStore();

    const js = await app.request("/ui/app.js");
    expect(js.status).toBe(200);
    expect(await js.text()).toBe(readFileSync(join(pkgDir, "app.js"), "utf8"));

    const root = await app.request("/");
    expect(root.status).toBe(200);
    expect(await root.text()).toBe(
      readFileSync(join(pkgDir, "index.html"), "utf8"),
    );
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

  it("persists an optional scope title", () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const titled = store.createScope({
      goal: "add /version",
      title: "Version endpoint",
      provider_project_id: "1",
      provider_project_path: "so/colony",
    });
    expect(titled.title).toBe("Version endpoint");
    const untitled = store.createScope({
      goal: "retire hostname",
      provider_project_id: "1",
      provider_project_path: "so/colony",
    });
    expect(untitled.title).toBeNull();
  });

  it("serves the agent event feed for a run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const app = buildApp(fakeCtx(store));
    const scope = store.createScope({
      goal: "add /version",
      provider_project_id: "1",
      provider_project_path: "so/colony",
    });
    const run = store.startRun({
      scope_id: scope.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    store.appendRunEvent(run.id, "pi_tool_call", {
      tool: "bash",
      isError: false,
    });
    const res = await app.request(`/runs/${run.id}/events`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as {
      event: string;
      detail_json: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe("pi_tool_call");
    expect(JSON.parse(rows[0]!.detail_json).tool).toBe("bash");

    const missing = await app.request("/runs/nope/events", {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(missing.status).toBe(404);
  });

  it("serves a single run with its model_id at GET /runs/:id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const app = buildApp(fakeCtx(store));
    const scope = store.createScope({
      goal: "add /version",
      provider_project_id: "1",
      provider_project_path: "so/colony",
    });
    const run = store.startRun({
      scope_id: scope.id,
      kind: "architect",
      lease_ttl_ms: 60_000,
      model_id: "m",
    });
    const res = await app.request(`/runs/${run.id}`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; model_id: string | null };
    expect(body.id).toBe(run.id);
    expect(body.model_id).toBe("m");

    const missing = await app.request("/runs/nope", {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(missing.status).toBe(404);
  });

  it("holds merges in manual-approvals scopes until approved at head", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const ctx = fakeCtx(store);
    const headSha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const withProvider: typeof ctx = {
      ...ctx,
      provider: {
        mergeRequests: {
          get: async () => ({ state: "opened", head_commit_sha: headSha }),
        },
      } as unknown as (typeof ctx)["provider"],
    };
    const app = buildApp(withProvider);

    const auto = store.createScope({
      goal: "auto scope",
      provider_project_id: "1",
      provider_project_path: "so/colony",
    });
    expect(auto.approvals).toBe("auto");

    const manual = store.createScope({
      goal: "manual scope",
      approvals: "manual",
      provider_project_id: "1",
      provider_project_path: "so/colony",
    });
    expect(manual.approvals).toBe("manual");
    store.setScopeStatus(manual.id, "planning", "svc:test");
    const [task] = store.materializePlan(
      manual.id,
      {
        kind: "architect_decomposition",
        summary: "one task",
        acceptance: [{ description: "ui plan goal", command: "true" }],
        tasks: [{ title: "t", spec: "s", depends_on: [] }],
      },
      "human:op-1",
    );
    let current = store.transitionTask(
      task.id,
      task.state_version,
      "running",
      "svc:test",
    );
    current = store.transitionTask(
      current.id,
      current.state_version,
      "mr_open",
      "svc:test",
      { mr_iid: 7, branch: "colony/t" },
    );
    expect(current.merge_approved_sha).toBeNull();

    const res = await app.request(`/tasks/${current.id}/approve-merge`, {
      method: "POST",
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { merge_approved_sha: string };
    expect(updated.merge_approved_sha).toBe(headSha);
    const audit = store.listAudit({ scope_id: manual.id });
    expect(audit.some((row) => row.action === "merge.approved")).toBe(true);
  });

  it("replans with operator feedback and requeues on request-changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const app = buildApp(fakeCtx(store));

    const scope = store.createScope({
      goal: "goal",
      approvals: "manual",
      provider_project_id: "1",
      provider_project_path: "so/colony",
    });
    store.setScopeStatus(scope.id, "planning", "svc:test");
    store.setScopePlan(
      scope.id,
      JSON.stringify({
        kind: "architect_decomposition",
        summary: "v1",
        acceptance: [{ description: "ui plan goal", command: "true" }],
        tasks: [{ title: "t", spec: "s", depends_on: [] }],
      }),
    );

    const replan = await app.request(`/scopes/${scope.id}/replan`, {
      method: "POST",
      headers: {
        "X-Actor-Id": "human:op-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ feedback: "split task t into two" }),
    });
    expect(replan.status).toBe(200);
    const updated = store.getScope(scope.id)!;
    expect(updated.plan_json).toBeNull();
    expect(updated.plan_feedback).toBe("split task t into two");

    // A fresh plan consumes the feedback.
    store.setScopePlan(
      scope.id,
      JSON.stringify({
        kind: "architect_decomposition",
        summary: "v2",
        acceptance: [{ description: "ui plan goal", command: "true" }],
        tasks: [{ title: "t", spec: "s", depends_on: [] }],
      }),
    );
    expect(store.getScope(scope.id)!.plan_feedback).toBeNull();

    const [task] = store.materializePlan(
      scope.id,
      {
        kind: "architect_decomposition",
        summary: "v2",
        acceptance: [{ description: "ui plan goal", command: "true" }],
        tasks: [{ title: "t", spec: "s", depends_on: [] }],
      },
      "human:op-1",
    );
    let current = store.transitionTask(
      task.id,
      task.state_version,
      "running",
      "svc:test",
    );
    current = store.transitionTask(
      current.id,
      current.state_version,
      "mr_open",
      "svc:test",
      { mr_iid: 9, branch: "colony/t" },
    );

    const changes = await app.request(`/tasks/${current.id}/request-changes`, {
      method: "POST",
      headers: {
        "X-Actor-Id": "human:op-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ feedback: "handle the empty case" }),
    });
    expect(changes.status).toBe(200);
    const requeued = store.getTask(current.id)!;
    expect(requeued.state).toBe("queued");
    expect(requeued.human_feedback).toBe("handle the empty case");
    expect(requeued.merge_approved_sha).toBeNull();
    const audit = store.listAudit({ scope_id: scope.id });
    expect(audit.some((r) => r.action === "task.changes_requested")).toBe(true);
    expect(audit.some((r) => r.action === "plan.replan_requested")).toBe(true);
  });
});

describe("operator controls", () => {
  function planningScope(store: Store, approvals: "auto" | "manual" = "auto") {
    const scope = store.createScope({
      goal: "goal",
      approvals,
      provider_project_id: "1",
      provider_project_path: "so/colony",
    });
    store.setScopeStatus(scope.id, "planning", "svc:test");
    const [task] = store.materializePlan(
      scope.id,
      {
        kind: "architect_decomposition",
        summary: "one",
        acceptance: [{ description: "ui plan goal", command: "true" }],
        tasks: [{ title: "t", spec: "original spec", depends_on: [] }],
      },
      "svc:test",
    );
    return { scope, task };
  }

  it("unblocking the last blocked task reactivates a parked scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const app = buildApp(fakeCtx(store));
    const { scope, task } = planningScope(store);
    let current = store.transitionTask(
      task.id,
      task.state_version,
      "running",
      "svc:test",
    );
    current = store.transitionTask(
      current.id,
      current.state_version,
      "blocked",
      "svc:test",
      { blocked_reason: "retries exhausted: run_failed" },
    );
    store.setScopeStatus(scope.id, "blocked", "svc:test", {
      blocked_reason: `no runnable tasks; blocked: ${task.id}`,
    });

    const res = await app.request(`/tasks/${current.id}/unblock`, {
      method: "POST",
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(res.status).toBe(200);
    expect(store.getTask(task.id)!.state).toBe("queued");
    expect(store.getScope(scope.id)!.status).toBe("active");
  });

  it("amend-spec appends an authoritative section and requeues open MRs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const app = buildApp(fakeCtx(store));
    const { task } = planningScope(store);
    let current = store.transitionTask(
      task.id,
      task.state_version,
      "running",
      "svc:test",
    );
    current = store.transitionTask(
      current.id,
      current.state_version,
      "mr_open",
      "svc:test",
      { mr_iid: 11, branch: "colony/t" },
    );

    const res = await app.request(`/tasks/${current.id}/amend-spec`, {
      method: "POST",
      headers: {
        "X-Actor-Id": "human:op-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ feedback: "env split is authoritative" }),
    });
    expect(res.status).toBe(200);
    const updated = store.getTask(task.id)!;
    expect(updated.spec).toContain("original spec");
    expect(updated.spec).toContain("Spec amendment (operator, authoritative)");
    expect(updated.spec).toContain("env split is authoritative");
    expect(updated.state).toBe("queued");
    const audit = store.listAudit({ task_id: task.id });
    expect(audit.some((r) => r.action === "task.spec_amended")).toBe(true);
  });

  it("classifies infrastructure errors distinctly from agent failures", () => {
    expect(isInfraError("process_restart")).toBe(true);
    expect(isInfraError("502 status code (no body)")).toBe(true);
    expect(isInfraError("fetch failed")).toBe(true);
    expect(isInfraError("ECONNRESET")).toBe(true);
    expect(isInfraError("envelope invalid")).toBe(false);
    expect(isInfraError("timeout_without_envelope")).toBe(false);
    expect(isInfraError(null)).toBe(false);
  });
});
