import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { SCOPE_STATUSES, type ScopeStatus, Store } from "@colony/core";
import { createLocalArtifactStore } from "@colony/core";
import type { ColonydContext } from "../src/context.js";
import { buildApp } from "../src/http.js";
import { isInfraError } from "../src/run-classification.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeCtx(store: Store, traceUiBaseUrl = ""): ColonydContext {
  return {
    store,
    provider: {} as ColonydContext["provider"],
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
      traceUiBaseUrl,
      consoleBaseUrl: "",
    },
    draining: { isDraining: () => false },
    requestTick() {},
  };
}

/** App whose env carries a configured trace UI base URL. */
function appWithTraceUi(): ReturnType<typeof buildApp> {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
  dirs.push(dir);
  return buildApp(
    fakeCtx(new Store(join(dir, "test.db")), "https://traces.example.com"),
  );
}

function appWithStore(): ReturnType<typeof buildApp> {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
  dirs.push(dir);
  return buildApp(fakeCtx(new Store(join(dir, "test.db"))));
}

/** App plus its backing store, so tests can seed domain rows directly. */
function appAndStore(): {
  app: ReturnType<typeof buildApp>;
  store: Store;
} {
  const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  return { app: buildApp(fakeCtx(store)), store };
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

  it("serves duration.js as a loadable ES module", async () => {
    const app = appWithStore();
    const res = await app.request("/ui/duration.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
  });

  it("exposes public console config without secrets", async () => {
    const res = await appWithStore().request("/ui/config");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      service: "colonyd",
      gitlab_base_url: "https://gitlab.home.shdr.ch",
      review_mode: "required",
      hitl_mode: "yolo",
      oidc: null,
      trace_ui_base_url: null,
    });

    // A configured trace UI base is surfaced verbatim; nothing else leaks.
    const traced = await appWithTraceUi().request("/ui/config");
    expect(traced.status).toBe(200);
    await expect(traced.json()).resolves.toMatchObject({
      trace_ui_base_url: "https://traces.example.com",
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
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
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
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
    });
    expect(titled.title).toBe("Version endpoint");
    const untitled = store.createScope({
      goal: "retire hostname",
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
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
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
    });
    const run = store.startRun({
      scope_id: scope.id,
      kind: "implement",
      lease_ttl_ms: 60_000,
    });
    store.appendRunEvent(run.id, "tool_call", {
      tool: "bash",
      isError: false,
    });
    const res = await app.request(`/runs/${run.id}/events`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      events: { event: string; detail_json: string }[];
    };
    const rows = page.events;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe("tool_call");
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
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
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
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
    });
    expect(auto.approvals).toBe("auto");

    const manual = store.createScope({
      goal: "manual scope",
      approvals: "manual",
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
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
    const audit = store.listAudit({ scope_id: manual.id }).events;
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
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
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
    const audit = store.listAudit({ scope_id: scope.id }).events;
    expect(audit.some((r) => r.action === "task.changes_requested")).toBe(true);
    expect(audit.some((r) => r.action === "plan.replan_requested")).toBe(true);
  });
});

describe("operator controls", () => {
  function planningScope(store: Store, approvals: "auto" | "manual" = "auto") {
    const scope = store.createScope({
      goal: "goal",
      approvals,
      provider_repo_id: "1",
      provider_repo_path: "so/colony",
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
    const audit = store.listAudit({ task_id: task.id }).events;
    expect(audit.some((r) => r.action === "task.spec_amended")).toBe(true);
  });

  it("classifies infrastructure errors distinctly from agent failures", () => {
    expect(isInfraError("process_restart")).toBe(true);
    expect(isInfraError("502 status code (no body)")).toBe(true);
    expect(isInfraError("fetch failed")).toBe(true);
    expect(isInfraError("ECONNRESET")).toBe(true);
    expect(isInfraError("liveness_watchdog_no_progress")).toBe(true);
    expect(
      isInfraError(
        "timed out after 300000ms waiting for Sandbox CR colony-a in namespace colony-sandboxes to become ready",
      ),
    ).toBe(true);
    expect(isInfraError("429 model cooldown")).toBe(true);
    expect(
      isInfraError(
        'HTTP-Code: 404\nMessage: Unknown API Status Code!\nBody: "{\\"kind\\":\\"Status\\",\\"message\\":\\"sandboxes.agents.x-k8s.io \\\\\\"colony-12ada898\\\\\\" not found\\"}"',
      ),
    ).toBe(true);
    expect(
      isInfraError('Agent "Main" was replaced during session initialization.'),
    ).toBe(true);
    expect(isInfraError("envelope invalid")).toBe(false);
    expect(isInfraError("timeout_without_envelope")).toBe(false);
    expect(isInfraError(null)).toBe(false);
  });
});

describe("acceptance amendment", () => {
  it("replaces criteria on a live scope, audits, and rejects finished scopes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const app = buildApp(fakeCtx(store));
    const scope = store.createScope({
      goal: "acceptance surgery",
      provider_repo_id: "1",
      provider_repo_path: "so/x",
    });
    const acceptance = [
      { description: "suite passes", command: "bun run test" },
    ];
    const res = await app.request(`/scopes/${scope.id}/acceptance`, {
      method: "PATCH",
      headers: {
        "X-Actor-Id": "human:op-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ acceptance }),
    });
    expect(res.status).toBe(200);
    const updated = store.getScope(scope.id)!;
    expect(JSON.parse(updated.acceptance_json!)).toEqual(acceptance);
    const audit = store.listAudit({ scope_id: scope.id }).events;
    expect(audit.some((r) => r.action === "scope.acceptance_amended")).toBe(
      true,
    );

    // Empty and oversized bodies are rejected.
    const bad = await app.request(`/scopes/${scope.id}/acceptance`, {
      method: "PATCH",
      headers: {
        "X-Actor-Id": "human:op-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ acceptance: [] }),
    });
    expect(bad.status).toBe(400);

    // Finished scopes are immutable evidence.
    store.db
      .prepare("UPDATE scopes SET status='done' WHERE id=?")
      .run(scope.id);
    const finished = await app.request(`/scopes/${scope.id}/acceptance`, {
      method: "PATCH",
      headers: {
        "X-Actor-Id": "human:op-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ acceptance }),
    });
    expect(finished.status).toBe(409);
  });
});

describe("scope pagination and grouping", () => {
  it("pages scopes newest-first with a total, and rejects bad params", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const app = buildApp(fakeCtx(store));
    for (let i = 0; i < 7; i += 1) {
      store.createScope({
        goal: `scope ${i}`,
        provider_repo_id: "1",
        provider_repo_path: "so/x",
        project: i < 3 ? "Wave one" : undefined,
      });
    }
    const res = await app.request("/scopes?limit=3&offset=0", {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      scopes: { goal: string; project_name: string | null }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(page.total).toBe(7);
    expect(page.scopes.length).toBe(3);
    expect(page.limit).toBe(3);

    const rest = await app.request("/scopes?limit=100&offset=3", {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    const tail = (await rest.json()) as { scopes: unknown[]; total: number };
    expect(tail.scopes.length).toBe(4);
    expect(tail.total).toBe(7);

    const grouped = await app.request("/scopes?limit=100&project=Wave%20one", {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    const g = (await grouped.json()) as {
      scopes: { project_name: string | null }[];
      total: number;
      projects: { project: string | null; n: number }[];
    };
    expect(g.total).toBe(3);
    expect(g.scopes.every((s) => s.project_name === "Wave one")).toBe(true);
    expect(g.projects.find((x) => x.project === "Wave one")?.n).toBe(3);
    expect(g.projects.find((x) => x.project === null)?.n).toBe(4);

    const bad = await app.request("/scopes?limit=0", {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(bad.status).toBe(400);
    const huge = await app.request("/scopes?limit=101", {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    expect(huge.status).toBe(400);
  });

  it("stores the project name and returns it on reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-ui-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const app = buildApp(fakeCtx(store));
    const scope = store.createScope({
      goal: "grouped",
      project: "Operator console",
      provider_repo_id: "1",
      provider_repo_path: "so/x",
    });
    expect(scope.project_name).toBe("Operator console");
    expect(store.getProject("Operator console")).toMatchObject({
      name: "Operator console",
    });
    const res = await app.request(`/scopes/${scope.id}`, {
      headers: { "X-Actor-Id": "human:op-1" },
    });
    const body = (await res.json()) as {
      scope: { project_name: string };
    };
    expect(body.scope.project_name).toBe("Operator console");
  });
});

describe("projects pagination with scope tallies", () => {
  const ACTOR = { headers: { "X-Actor-Id": "human:op-1" } };
  const zeroCounts = () =>
    Object.fromEntries(SCOPE_STATUSES.map((s) => [s, 0])) as Record<
      ScopeStatus,
      number
    >;

  interface ProjectRow {
    name: string;
    context_doc: string | null;
    created_at: string;
    updated_at: string;
    scope_count: number;
    status_counts: Record<ScopeStatus, number>;
  }

  /** Seed "Wave one" with scopes in several statuses; leave "Solo" empty. */
  function seedProjects(store: Store): void {
    store.ensureProject("Solo");
    const statuses = ["active", "active", "done", "blocked"] as const;
    for (const status of statuses) {
      const id = store.createScope({
        goal: `scope ${status}`,
        provider_repo_id: "1",
        provider_repo_path: "so/x",
        project: "Wave one",
      }).id;
      if (status === "done") {
        store.setScopeStatus(id, "planning", "svc:test");
        store.setScopeStatus(id, "active", "svc:test");
        store.setScopeStatus(id, status, "svc:test");
      } else {
        store.setScopeStatus(id, "planning", "svc:test");
        store.setScopeStatus(id, status, "svc:test");
      }
    }
  }

  it("pages projects with honest totals and per-status scope counts", async () => {
    const { app, store } = appAndStore();
    seedProjects(store);

    const res = await app.request("/projects?limit=1&offset=0", ACTOR);
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      projects: ProjectRow[];
      total: number;
      limit: number;
      offset: number;
    };
    // total is the whole-table project count, not the page length.
    expect(page.total).toBe(2);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(0);
    expect(page.projects).toHaveLength(1);

    const rest = await app.request("/projects?limit=100&offset=1", ACTOR);
    const tail = (await rest.json()) as {
      projects: ProjectRow[];
      total: number;
    };
    expect(tail.total).toBe(2);
    const rows = [...page.projects, ...tail.projects];
    expect(rows.map((p) => p.name).sort()).toEqual(["Solo", "Wave one"]);

    const wave = rows.find((p) => p.name === "Wave one")!;
    expect(wave.scope_count).toBe(4);
    expect(wave.status_counts).toEqual({
      ...zeroCounts(),
      active: 2,
      done: 1,
      blocked: 1,
    });
    expect(Object.keys(wave.status_counts).sort()).toEqual(
      [...SCOPE_STATUSES].sort(),
    );
    expect(wave.scope_count).toBe(
      Object.values(wave.status_counts).reduce((a, b) => a + b, 0),
    );

    const solo = rows.find((p) => p.name === "Solo")!;
    expect(solo.scope_count).toBe(0);
    expect(solo.status_counts).toEqual(zeroCounts());
  });

  it("rejects bad pagination params unchanged", async () => {
    const { app } = appAndStore();
    for (const query of ["limit=0", "limit=101", "offset=-1", "limit=abc"]) {
      const res = await app.request(`/projects?${query}`, ACTOR);
      expect(res.status).toBe(400);
    }
  });

  it("returns the same row shape from /projects/:name and 404s unknowns", async () => {
    const { app, store } = appAndStore();
    seedProjects(store);

    const res = await app.request("/projects/Wave%20one", ACTOR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: ProjectRow };
    expect(body.project.name).toBe("Wave one");
    expect(body.project.context_doc).toBeNull();
    expect(typeof body.project.created_at).toBe("string");
    expect(typeof body.project.updated_at).toBe("string");
    expect(body.project.scope_count).toBe(4);
    expect(body.project.status_counts).toEqual({
      ...zeroCounts(),
      active: 2,
      done: 1,
      blocked: 1,
    });

    const listed = await app.request("/projects?limit=100", ACTOR);
    const list = (await listed.json()) as { projects: ProjectRow[] };
    const waveFromList = list.projects.find((p) => p.name === "Wave one")!;
    expect(body.project).toEqual(waveFromList);

    const missing = await app.request("/projects/nope", ACTOR);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "NOT_FOUND", message: "project not found" },
    });
  });

  it("serves the context doc round-trip on /projects/:name/context", async () => {
    const { app } = appAndStore();

    const put = await app.request("/projects/Wave%20one/context", {
      ...ACTOR,
      method: "PUT",
      headers: {
        "X-Actor-Id": "human:op-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ context_doc: "Use bun workspaces." }),
    });
    expect(put.status).toBe(200);

    // The editor's prefill read matches exactly what the save persisted.
    const get = await app.request("/projects/Wave%20one/context", ACTOR);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ context_doc: "Use bun workspaces." });

    // Clearing stores null.
    await app.request("/projects/Wave%20one/context", {
      ...ACTOR,
      method: "PUT",
      headers: {
        "X-Actor-Id": "human:op-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ context_doc: null }),
    });
    const cleared = await app.request("/projects/Wave%20one/context", ACTOR);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ context_doc: null });

    // Unknown projects have nothing to read.
    const missing = await app.request("/projects/nope/context", ACTOR);
    expect(missing.status).toBe(404);
  });
});
