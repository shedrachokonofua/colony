import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const TEST_URL = process.env.COLONY_TEST_DATABASE_URL;

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

const EXPECTED_TABLES = [
  "agent_runs",
  "approvals",
  "artifacts",
  "assignments",
  "audit_log",
  "capability_grants",
  "events",
  "gates",
  "idempotency_keys",
  "policies",
  "provider_identities",
  "provider_mirrors",
  "provider_projects",
  "reviews",
  "scope_targets",
  "scopes",
  "task_dependencies",
  "task_targets",
  "tasks",
] as const;

// runIf rather than skipIf so vitest still emits a "0 tests" entry when the
// env var is missing — clearer than a silent skip and leaves the integration
// guard discoverable in CI logs.
describe.runIf(TEST_URL)("colony schema migrations", () => {
  const databaseUrl = TEST_URL!;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();

    // Reset the database to a clean state. Roles are cluster-level and the
    // role-creation migration is idempotent, so we only need to drop schema
    // contents.
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("GRANT ALL ON SCHEMA public TO public");

    await runner({
      databaseUrl,
      dir: MIGRATIONS_DIR,
      migrationsTable: "pgmigrations",
      direction: "up",
      log: () => {},
    });
  }, 60_000);

  afterAll(async () => {
    if (client) await client.end();
  });

  it("creates every expected table", async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const expected of EXPECTED_TABLES) {
      expect(tables, `missing table: ${expected}`).toContain(expected);
    }
  });

  it("creates colony_writer and colony_reader roles", async () => {
    const { rows } = await client.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles
       WHERE rolname IN ('colony_writer', 'colony_reader')
       ORDER BY rolname`,
    );
    expect(rows.map((r) => r.rolname)).toEqual([
      "colony_reader",
      "colony_writer",
    ]);
  });

  describe("audit_log immutability", () => {
    beforeAll(async () => {
      // Let the bootstrap user assume colony_writer for these checks.
      await client.query(
        "GRANT colony_writer TO " + (await currentRole(client)),
      );
    });

    it("permits INSERT under colony_writer", async () => {
      await withRole(client, "colony_writer", async () => {
        await client.query(
          `INSERT INTO audit_log (id, actor, action) VALUES ($1, $2, $3)`,
          ["audit-insert-test", "human:test", "create_scope"],
        );
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM audit_log WHERE id = $1`,
          ["audit-insert-test"],
        );
        expect(rows).toHaveLength(1);
      });
    });

    it("rejects UPDATE under colony_writer", async () => {
      await withRole(client, "colony_writer", async () => {
        await expect(
          client.query(`UPDATE audit_log SET reason = 'tamper' WHERE id = $1`, [
            "audit-insert-test",
          ]),
        ).rejects.toThrow(/permission denied/i);
      });
    });

    it("rejects DELETE under colony_writer", async () => {
      await withRole(client, "colony_writer", async () => {
        await expect(
          client.query(`DELETE FROM audit_log WHERE id = $1`, [
            "audit-insert-test",
          ]),
        ).rejects.toThrow(/permission denied/i);
      });
    });

    it("rejects TRUNCATE under colony_writer", async () => {
      await withRole(client, "colony_writer", async () => {
        await expect(client.query(`TRUNCATE audit_log`)).rejects.toThrow(
          /permission denied/i,
        );
      });
    });
  });

  describe("scope/task ID format constraints", () => {
    it("rejects scope IDs that do not match the col-xxxx pattern", async () => {
      await expect(
        client.query(
          `INSERT INTO scopes (id, title, description, state)
           VALUES ('not-a-scope', 't', 'd', 'draft')`,
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("rejects task IDs that do not match the col-xxxx.N pattern", async () => {
      await client.query(
        `INSERT INTO scopes (id, title, description, state)
         VALUES ('col-abcd', 't', 'd', 'draft')
         ON CONFLICT (id) DO NOTHING`,
      );
      await expect(
        client.query(
          `INSERT INTO tasks (id, scope_id, title, description, state)
           VALUES ('col-abcd-no-dot', 'col-abcd', 't', 'd', 'created')`,
        ),
      ).rejects.toThrow(/check constraint/i);
    });
  });

  describe("dependency readiness index coverage", () => {
    it("indexes (to_task_id, kind) for ready_tasks dependency walks", async () => {
      const { rows } = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'task_dependencies'`,
      );
      const names = rows.map((r) => r.indexname);
      expect(names).toContain("task_dependencies_to_kind_idx");
      expect(names).toContain("task_dependencies_from_kind_idx");
    });

    it("indexes tasks (scope_id, state) for ready_tasks(scope_id) scans", async () => {
      const { rows } = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'tasks'`,
      );
      expect(rows.map((r) => r.indexname)).toContain("tasks_scope_state_idx");
    });
  });
});

async function currentRole(client: Client): Promise<string> {
  const { rows } = await client.query<{ user_name: string }>(
    `SELECT current_user AS user_name`,
  );
  return rows[0].user_name;
}

async function withRole<T>(
  client: Client,
  role: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query(`SET ROLE ${role}`);
  try {
    return await fn();
  } finally {
    // Always restore the connection's role even on failure so subsequent
    // tests don't inherit it.
    try {
      await client.query("RESET ROLE");
    } catch {
      // If the connection is already broken, RESET will fail; ignore.
    }
  }
}
