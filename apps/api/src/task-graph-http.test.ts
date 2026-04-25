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
  TaskGraphRepository,
} from "@colony/db";
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
  const deps = {
    repo: new TaskGraphRepository(pool),
    policyRepo: new PolicyRepository(pool),
    idempotencyRepo: new IdempotencyRepository(pool),
  };
  const app = buildApp({ taskGraph: deps });

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
    await pool.query(
      `TRUNCATE
         task_dependencies, assignments, gates, reviews, approvals,
         agent_runs, events, audit_log, artifacts, tasks, scopes, idempotency_keys
       RESTART IDENTITY CASCADE`,
    );
  });

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
});
