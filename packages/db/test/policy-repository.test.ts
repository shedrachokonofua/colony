import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ActorId, ScopeId } from "@colony/domain";
import { createPool, PolicyRepository } from "../src/index.js";

const TEST_URL = process.env.COLONY_TEST_DATABASE_URL;

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

const SCOPE = "col-pol1" as ScopeId;
const HUMAN = "human:op-1" as ActorId;
const FUTURE = "future-grant" as ActorId;

describe.runIf(TEST_URL)("PolicyRepository", () => {
  const url = TEST_URL!;
  let pool: Pool;
  let pr: PolicyRepository;

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
    pool = createPool({ connectionString: url, role: "colony_writer" });
    pr = new PolicyRepository(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE tasks, events, audit_log, scopes, capability_grants, policies, provider_identities, idempotency_keys RESTART IDENTITY CASCADE`,
    );
    await pool.query(
      `INSERT INTO policies (id, scope, target_id, version, protected_paths, security_labels, always_human_review, review_loop_cap, settings)
       VALUES ('pol-g', 'global', NULL, 1, '{}', '{}', false, 3, '{}'::jsonb)`,
    );
    await pool.query(
      `INSERT INTO policies (id, scope, target_id, version, protected_paths, security_labels, always_human_review, review_loop_cap, settings)
       VALUES ('pol-s', 'scope', $1, 1, '{}', '{x}', true, 5, '{}'::jsonb)`,
      [SCOPE],
    );
    await pool.query(
      `INSERT INTO provider_identities (actor, provider, provider_user_id, role, is_bot)
       VALUES ($1, 'colony', '1', 'human', false)`,
      [FUTURE],
    );
  });

  it("getGlobalPolicy returns the global row", async () => {
    const p = await pr.getGlobalPolicy();
    expect(p.id).toBe("pol-g");
    expect(p.scope).toBe("global");
  });

  it("getEffectivePolicy returns scope override when a scope row exists", async () => {
    const p = await pr.getEffectivePolicy(SCOPE);
    expect(p.id).toBe("pol-s");
    expect(p.target_id).toBe(SCOPE);
    expect(p.security_labels).toEqual(["x"]);
    expect(p.always_human_review).toBe(true);
  });

  it("getEffectivePolicy falls back to global when no scope row", async () => {
    await pool.query(`DELETE FROM policies WHERE id = 'pol-s'`);
    const p = await pr.getEffectivePolicy(SCOPE);
    expect(p.id).toBe("pol-g");
  });

  it("getCapabilityGrantsForActor filters expired grants", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    await pool.query(
      `INSERT INTO capability_grants (id, actor, role, capability, scope_id, task_id, granted_by, expires_at)
       VALUES ($1, $2, 'human', 'graph.read', NULL, NULL, $3, now() - interval '1 day'),
              ($4, $2, 'human', 'graph.write', NULL, NULL, $3, now() + interval '1 day')`,
      [id1, FUTURE, HUMAN, id2],
    );
    const g = await pr.getCapabilityGrantsForActor(FUTURE, null);
    expect([...g].sort()).toEqual(["graph.write"]);
  });
});
