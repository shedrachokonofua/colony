import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import {
  createPool,
  IdempotencyRepository,
  PolicyRepository,
  ProviderProjectRepository,
  TaskGraphRepository,
} from "@colony/db";
import { FakeProviderAdapter } from "@colony/provider";
import { buildApp } from "./app.js";

const TEST = process.env.COLONY_TEST_DATABASE_URL;

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

const SCOPE = "col-http" as ScopeId;
const TASK = "col-http.1" as TaskId;
const SUP = "svc:supervisor" as ActorId;
const NOPE = "actor:no-grants" as ActorId;

describe.runIf(TEST)("Task Graph API (HTTP)", () => {
  const url = TEST!;
  const pool = createPool({ connectionString: url, role: "colony_writer" });
  const providerAdapter = new FakeProviderAdapter();
  const deps = {
    repo: new TaskGraphRepository(pool),
    policyRepo: new PolicyRepository(pool),
    idempotencyRepo: new IdempotencyRepository(pool),
    providerProjects: new ProviderProjectRepository(pool),
    providerAdapter,
  };
  const app = buildApp({
    taskGraph: deps,
    providerAdmin: {
      repo: deps.repo,
      policyRepo: deps.policyRepo,
      adapter: providerAdapter,
    },
  });

  beforeAll(async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    await c.query("DROP SCHEMA public CASCADE");
    await c.query("CREATE SCHEMA public");
    await c.query("GRANT ALL ON SCHEMA public TO public");
    await c.end();
    await runner({
      databaseUrl: url,
      dir: MIGRATIONS_DIR,
      migrationsTable: "pgmigrations",
      direction: "up",
      log: () => {},
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      await c.query(
        `TRUNCATE
           task_dependencies, assignments, gates, reviews, approvals,
           agent_runs, events, audit_log, artifacts, provider_mirrors,
           task_targets, scope_targets, provider_projects,
           tasks, scopes, idempotency_keys
         RESTART IDENTITY CASCADE`,
      );
      await c.query(
        `INSERT INTO capability_grants (id, actor, role, capability, scope_id, task_id, granted_by)
         VALUES
           ('cgr-sv-01', 'svc:supervisor', 'supervisor', 'graph.read', NULL, NULL, 'human:op-1'),
           ('cgr-sv-02', 'svc:supervisor', 'supervisor', 'graph.write', NULL, NULL, 'human:op-1'),
           ('cgr-sv-03', 'svc:supervisor', 'supervisor', 'task.claim', NULL, NULL, 'human:op-1'),
           ('cgr-hm-01', 'human:op-1', 'human', 'graph.read', NULL, NULL, 'human:op-1'),
           ('cgr-hm-02', 'human:op-1', 'human', 'graph.write', NULL, NULL, 'human:op-1'),
           ('cgr-hm-03', 'human:op-1', 'human', 'task.claim', NULL, NULL, 'human:op-1'),
           ('cgr-hm-04', 'human:op-1', 'human', 'policy.override', NULL, NULL, 'human:op-1'),
           ('cgr-hm-05', 'human:op-1', 'human', 'provider.admin.bootstrap', NULL, NULL, 'human:op-1'),
           ('cgr-dv-01', 'agent:dev-1', 'developer', 'graph.read', NULL, NULL, 'human:op-1'),
           ('cgr-dv-02', 'agent:dev-1', 'developer', 'task.claim', NULL, NULL, 'human:op-1')
         ON CONFLICT (id) DO NOTHING`,
      );
    } finally {
      await c.end();
    }
  }, 60_000);

  it("returns 400 when X-Actor-Id is missing on a protected route", async () => {
    const res = await app.request("http://x/scopes", { method: "GET" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_ACTOR");
  });

  it("returns 403 and writes policy.deny when the actor has no capability", async () => {
    const res = await app.request("http://x/scopes", {
      method: "GET",
      headers: { "X-Actor-Id": NOPE },
    });
    expect(res.status).toBe(403);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text as n FROM audit_log WHERE action = 'policy.deny' AND actor = $1`,
      [NOPE],
    );
    expect(rows[0]).toBeDefined();
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("stamps scope.create with capability in audit on success", async () => {
    const res = await app.request("http://x/scopes", {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: SCOPE,
        title: "API test",
        description: "d",
      }),
    });
    expect(res.status).toBe(201);
    const { rows } = await pool.query<{
      action: string;
      capability: string | null;
    }>(
      `SELECT action, capability FROM audit_log
       WHERE action = 'scope.create' AND scope_id = $1
       LIMIT 1`,
      [SCOPE],
    );
    expect(rows[0]).toEqual({
      action: "scope.create",
      capability: "graph.write",
    });
  });

  it("returns 409 for duplicate scope create without idempotency", async () => {
    const h = { "X-Actor-Id": SUP, "Content-Type": "application/json" };
    const body = JSON.stringify({
      id: SCOPE,
      title: "API test",
      description: "d",
    });
    const a = await app.request("http://x/scopes", {
      method: "POST",
      headers: h,
      body,
    });
    const b = await app.request("http://x/scopes", {
      method: "POST",
      headers: h,
      body,
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
    const err = (await b.json()) as { error: { code: string } };
    expect(err.error.code).toBe("CONFLICT");
  });

  it("transitions scope state with audit and provider label projection", async () => {
    const project = await deps.providerProjects.upsertProject({
      provider: "fake",
      provider_id: "proj-scope-state",
      path: "colony/scope-state",
    });
    const create = await app.request("http://x/scopes", {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: SCOPE,
        title: "Stateful scope",
        description: "d",
        provider_mirror: { provider_project_id: project.id },
      }),
    });
    expect(create.status).toBe(201);

    const res = await app.request(`http://x/scopes/${SCOPE}/state`, {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        expected_state_version: 0,
        state: "decomposition_proposed",
        reason: "architect_envelope",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      state_version: number;
    };
    expect(body).toMatchObject({
      state: "decomposition_proposed",
      state_version: 1,
    });
    const mirror = (
      await deps.providerProjects.listMirrorsForColony({
        colony_id: SCOPE,
        entity_kind: "scope",
      })
    )[0];
    expect(mirror).toBeDefined();
    const issue = await providerAdapter.issues.get(
      { id: project.provider_id, path: project.path },
      mirror!.provider_id,
    );
    expect(issue.labels).toContain("state:decomposition_proposed");
    expect(issue.labels).not.toContain("state:draft");

    const { rows } = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE scope_id = $1 ORDER BY recorded_at`,
      [SCOPE],
    );
    expect(rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "scope.transition",
        "provider.project.scope_state",
      ]),
    );
  });

  it("rejects invalid scope transitions with a structured error", async () => {
    await app.request("http://x/scopes", {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: SCOPE,
        title: "Invalid transition scope",
        description: "d",
      }),
    });

    const res = await app.request(`http://x/scopes/${SCOPE}/state`, {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        expected_state_version: 0,
        state: "closed",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_SCOPE_TRANSITION");
  });

  it("requests architect decomposition for an intake-ready scope", async () => {
    const project = await deps.providerProjects.upsertProject({
      provider: "fake",
      provider_id: "proj-decompose",
      path: "colony/decompose",
    });
    await app.request("http://x/scopes", {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: SCOPE,
        title: "Needs decomposition",
        description: "d",
      }),
    });

    const first = await app.request(
      `http://x/scopes/${SCOPE}/decomposition-request`,
      {
        method: "POST",
        headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_targets: [
            { provider_project_id: project.id, role: "primary" },
          ],
          reason: "operator_intake",
        }),
      },
    );
    const second = await app.request(
      `http://x/scopes/${SCOPE}/decomposition-request`,
      {
        method: "POST",
        headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_targets: [
            { provider_project_id: project.id, role: "primary" },
          ],
          reason: "operator_retry",
        }),
      },
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const body = (await first.json()) as {
      requested: boolean;
      state: string;
      provider_targets: Array<{ provider_project_id: string; role: string }>;
    };
    expect(body).toMatchObject({
      requested: true,
      state: "draft",
      provider_targets: [{ provider_project_id: project.id, role: "primary" }],
    });
    const scope = await deps.repo.getScope(SCOPE);
    expect(scope?.state).toBe("draft");
    const targets = await deps.providerProjects.listScopeTargets(SCOPE);
    expect(targets).toHaveLength(1);
    const { rows: auditRows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM audit_log
       WHERE scope_id = $1 AND action = 'scope.decomposition_request'`,
      [SCOPE],
    );
    expect(Number(auditRows[0]?.n)).toBe(2);
    const { rows: eventRows } = await pool.query<{ kind: string }>(
      `SELECT kind FROM events WHERE scope_id = $1 ORDER BY recorded_at`,
      [SCOPE],
    );
    expect(eventRows.map((row) => row.kind)).toContain(
      "architect_decomposition_requested",
    );
  });

  it("rejects decomposition requests without provider targets", async () => {
    await app.request("http://x/scopes", {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: SCOPE,
        title: "No targets",
        description: "d",
      }),
    });

    const res = await app.request(
      `http://x/scopes/${SCOPE}/decomposition-request`,
      {
        method: "POST",
        headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_PROVIDER_TARGET");
  });

  it("mirrors one scope and tasks into distinct provider projects", async () => {
    const frontend = await deps.providerProjects.upsertProject({
      provider: "fake",
      provider_id: "proj-fe",
      path: "colony/frontend",
    });
    const backend = await deps.providerProjects.upsertProject({
      provider: "fake",
      provider_id: "proj-be",
      path: "colony/backend",
    });

    const scopeRes = await app.request("http://x/scopes", {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: SCOPE,
        title: "Mirrored scope",
        description: "d",
        provider_targets: [
          { provider_project_id: frontend.id, role: "frontend" },
          { provider_project_id: backend.id, role: "backend" },
        ],
        provider_mirror: { provider_project_id: frontend.id },
      }),
    });
    expect(scopeRes.status).toBe(201);

    const feTask = await app.request(`http://x/scopes/${SCOPE}/tasks`, {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: TASK,
        title: "frontend task",
        description: "d",
        provider_project_id: frontend.id,
        acceptance_criteria: ["button exports CSV"],
      }),
    });
    expect(feTask.status).toBe(201);

    const beTask = await app.request(`http://x/scopes/${SCOPE}/tasks`, {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "col-http.2",
        title: "backend task",
        description: "d",
        provider_project_id: backend.id,
      }),
    });
    expect(beTask.status).toBe(201);

    const { rows } = await pool.query<{
      colony_id: string;
      provider_project_id: string;
      source_version: string | null;
      projected_at: Date | null;
    }>(
      `SELECT colony_id, provider_project_id, source_version, projected_at
       FROM provider_mirrors
       WHERE colony_id IN ($1, $2, $3)
       ORDER BY colony_id`,
      [SCOPE, TASK, "col-http.2"],
    );
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          colony_id: SCOPE,
          provider_project_id: frontend.id,
          source_version: "1",
        }),
        expect.objectContaining({
          colony_id: TASK,
          provider_project_id: frontend.id,
          source_version: "1",
        }),
        expect.objectContaining({
          colony_id: "col-http.2",
          provider_project_id: backend.id,
          source_version: "1",
        }),
      ]),
    );
    expect(rows.every((row) => row.projected_at instanceof Date)).toBe(true);
  });

  it("reports provider sync status for mirrored and pending tasks", async () => {
    const project = await deps.providerProjects.upsertProject({
      provider: "fake",
      provider_id: "proj-sync",
      path: "colony/sync",
    });

    await app.request("http://x/scopes", {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: SCOPE,
        title: "Sync scope",
        description: "d",
        provider_mirror: { provider_project_id: project.id },
      }),
    });
    await app.request(`http://x/scopes/${SCOPE}/tasks`, {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: TASK,
        title: "mirrored task",
        description: "d",
        provider_project_id: project.id,
      }),
    });
    await deps.repo.createTask(
      {
        id: "col-http.2" as TaskId,
        scope_id: SCOPE,
        title: "pending task",
        description: "d",
      },
      { actor: SUP, capability: "graph.write" },
    );

    const res = await app.request(`http://x/scopes/${SCOPE}/provider-sync`, {
      headers: { "X-Actor-Id": SUP },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scope: { status: string; mirrors: Array<{ provider_url?: string }> };
      tasks: Array<{
        colony_id: string;
        status: string;
        mirrors: Array<{ provider_url?: string }>;
      }>;
    };
    expect(body.scope.status).toBe("synced");
    expect(body.scope.mirrors[0]?.provider_url).toContain("fake://provider");
    expect(body.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ colony_id: TASK, status: "synced" }),
        expect.objectContaining({ colony_id: "col-http.2", status: "pending" }),
      ]),
    );
  });

  it("returns 404 when creating a task in a missing scope", async () => {
    const res = await app.request("http://x/scopes/col-miss/tasks", {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "col-miss.1",
        title: "missing parent",
        description: "d",
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when recording an event for a missing explicit scope", async () => {
    const res = await app.request("http://x/events", {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        scope_id: "col-miss",
        kind: "provider_event",
        payload: { source: "test" },
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns the same JSON for duplicate Idempotency-Key and creates one row", async () => {
    const body = JSON.stringify({
      id: SCOPE,
      title: "once",
      description: "d",
    });
    const h = {
      "X-Actor-Id": SUP,
      "Content-Type": "application/json",
      "Idempotency-Key": "key-repeat-1",
    };
    const a = await app.request("http://x/scopes", {
      method: "POST",
      headers: h,
      body,
    });
    const b = await app.request("http://x/scopes", {
      method: "POST",
      headers: h,
      body,
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const ja = await a.json();
    const jb = await b.json();
    expect(ja).toEqual(jb);
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text as n FROM scopes WHERE id = $1",
      [SCOPE],
    );
    expect(rows[0]).toBeDefined();
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("rejects an Idempotency-Key reused with a different request", async () => {
    const h = {
      "X-Actor-Id": SUP,
      "Content-Type": "application/json",
      "Idempotency-Key": "key-reused-different-body",
    };
    const a = await app.request("http://x/scopes", {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        id: SCOPE,
        title: "first",
        description: "d",
      }),
    });
    const b = await app.request("http://x/scopes", {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        id: "col-http2",
        title: "second",
        description: "d",
      }),
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
    const err = (await b.json()) as { error: { code: string } };
    expect(err.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM scopes ORDER BY id",
    );
    expect(rows.map((r) => r.id)).toEqual([SCOPE]);
  });

  it("serializes concurrent requests with the same Idempotency-Key", async () => {
    const h = {
      "X-Actor-Id": SUP,
      "Content-Type": "application/json",
      "Idempotency-Key": "key-concurrent-repeat",
    };
    const body = JSON.stringify({
      id: SCOPE,
      title: "once concurrently",
      description: "d",
    });
    const [a, b] = await Promise.all([
      app.request("http://x/scopes", { method: "POST", headers: h, body }),
      app.request("http://x/scopes", { method: "POST", headers: h, body }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(await a.json()).toEqual(await b.json());
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text as n FROM scopes WHERE id = $1",
      [SCOPE],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("returns policy deny even when denied route scope does not exist", async () => {
    const res = await app.request("http://x/scopes/col-miss/tasks", {
      method: "POST",
      headers: { "X-Actor-Id": NOPE, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "col-miss.1",
        title: "blocked",
        description: "d",
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("POLICY_DENY");
    const { rows } = await pool.query<{
      scope_id: string | null;
      evidence: { attempted_scope_id?: string };
    }>(
      `SELECT scope_id, evidence FROM audit_log
       WHERE action = 'policy.deny' AND actor = $1`,
      [NOPE],
    );
    expect(rows[0]?.scope_id).toBeNull();
    expect(rows[0]?.evidence.attempted_scope_id).toBe("col-miss");
  });

  it("POST /events with only task_id sets scope_id on the stored event and audit from resolved scope", async () => {
    await deps.repo.createScope(
      { id: SCOPE, title: "s", description: "d" },
      { actor: SUP, capability: "graph.write" },
    );
    await deps.repo.createTask(
      {
        id: TASK,
        scope_id: SCOPE,
        title: "t",
        description: "d",
      },
      { actor: SUP, capability: "graph.write" },
    );
    const res = await app.request("http://x/events", {
      method: "POST",
      headers: { "X-Actor-Id": SUP, "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: TASK,
        kind: "provider_event",
        payload: { source: "test" },
      }),
    });
    expect(res.status).toBe(201);
    const ev = (await res.json()) as { scope_id?: string; id: string };
    expect(ev.scope_id).toBe(SCOPE);
    const { rows: aud } = await pool.query<{
      scope_id: string | null;
    }>(
      `SELECT scope_id FROM audit_log WHERE action = 'event.record' AND target_id = $1`,
      [ev.id],
    );
    expect(aud[0]?.scope_id).toBe(SCOPE);
  });

  it("returns blocked_by and blocks for a task", async () => {
    await deps.repo.createScope(
      { id: SCOPE, title: "s", description: "d" },
      { actor: SUP, capability: "graph.write" },
    );
    const A = "col-http.1" as TaskId;
    const B = "col-http.2" as TaskId;
    const C = "col-http.3" as TaskId;
    for (const id of [A, B, C]) {
      await deps.repo.createTask(
        { id, scope_id: SCOPE, title: id, description: "d" },
        { actor: SUP, capability: "graph.write" },
      );
    }
    // A blocks B; B blocks C.
    await deps.repo.addDependency(A, B, "blocks", {
      actor: SUP,
      capability: "graph.write",
    });
    await deps.repo.addDependency(B, C, "blocks", {
      actor: SUP,
      capability: "graph.write",
    });

    const res = await app.request(`http://x/tasks/${B}/dependencies`, {
      method: "GET",
      headers: { "X-Actor-Id": SUP },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      blocked_by: string[];
      blocks: string[];
    };
    expect(body.blocked_by).toEqual([A]);
    expect(body.blocks).toEqual([C]);
  });

  it("returns 404 for dependencies on a missing task", async () => {
    const res = await app.request("http://x/tasks/col-http.9/dependencies", {
      method: "GET",
      headers: { "X-Actor-Id": SUP },
    });
    expect(res.status).toBe(404);
  });

  it("POST /admin/provider/bootstrap requires the bootstrap capability", async () => {
    const res = await app.request("http://x/admin/provider/bootstrap", {
      method: "POST",
      headers: {
        "X-Actor-Id": "agent:dev-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bootstrapBody()),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("POLICY_DENY");
  });

  it("POST /admin/provider/bootstrap audits a redacted bootstrap result", async () => {
    const res = await app.request("http://x/admin/provider/bootstrap", {
      method: "POST",
      headers: {
        "X-Actor-Id": "human:op-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bootstrapBody()),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      redacted_env: string;
      bot_tokens: { engine: string; architect: string };
    };
    expect(body.redacted_env).toContain("GITLAB_TOKEN=");
    expect(body.bot_tokens.engine).not.toContain("fake-token-colony-engine");
    expect(body.bot_tokens.architect).not.toContain(
      "fake-token-colony-architect",
    );

    const { rows } = await pool.query<{ evidence: unknown }>(
      `SELECT evidence FROM audit_log
       WHERE action = 'provider.bootstrap' AND actor = 'human:op-1'
       ORDER BY recorded_at DESC
       LIMIT 1`,
    );
    const evidence = JSON.stringify(rows[0]?.evidence);
    expect(evidence).not.toContain("fake-token-colony-engine");

    const identities = await pool.query<{
      actor: string;
      role: string;
      provider_username: string | null;
      is_bot: boolean;
      token_fingerprint: string | null;
    }>(
      `SELECT actor, role, provider_username, is_bot, token_fingerprint
       FROM provider_identities
       WHERE provider = 'fake'
       ORDER BY actor`,
    );
    expect(identities.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "bot:engine",
          role: "developer",
          provider_username: "colony-engine",
          is_bot: true,
        }),
        expect.objectContaining({
          actor: "bot:architect",
          role: "architect",
          provider_username: "colony-architect",
          is_bot: true,
        }),
      ]),
    );
    expect(
      identities.rows.every((row) => row.token_fingerprint?.length === 16),
    ).toBe(true);
  });
});

function bootstrapBody() {
  return {
    provider: "gitlab",
    environment: "dev",
    base_url: "https://gitlab.example.test",
    group: { name: "Colony", path: "colony" },
    project: { name: "Colony Dev", path: "dev" },
    oauth_application: {
      name: "Colony Web",
      redirect_uris: ["https://colony.example.test/oauth/callback"],
      scopes: ["read_user"],
    },
    webhook: {
      url: "https://colony.example.test/webhook/gitlab",
      secret: "webhook-secret",
    },
  };
}
