import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import { RepositoryError, TaskGraphRepository } from "../src/index.js";

const TEST_URL = process.env.COLONY_TEST_DATABASE_URL;

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

const SCOPE_ID = "col-repo" as ScopeId;
const TASK_A = "col-repo.1" as TaskId;
const TASK_B = "col-repo.2" as TaskId;
const SUPERVISOR = "svc:supervisor" as ActorId;
const DEV_AGENT = "agent:dev-1" as ActorId;

describe.runIf(TEST_URL)("TaskGraphRepository", () => {
  const databaseUrl = TEST_URL!;
  let pool: Pool;
  let repo: TaskGraphRepository;

  beforeAll(async () => {
    // Fresh schema for this suite; migrations + roles applied once.
    const bootstrap = new Pool({ connectionString: databaseUrl });
    await bootstrap.query("DROP SCHEMA public CASCADE");
    await bootstrap.query("CREATE SCHEMA public");
    await bootstrap.query("GRANT ALL ON SCHEMA public TO public");
    await bootstrap.end();

    await runner({
      databaseUrl,
      dir: MIGRATIONS_DIR,
      migrationsTable: "pgmigrations",
      direction: "up",
      log: () => {},
    });

    pool = new Pool({ connectionString: databaseUrl });
    repo = new TaskGraphRepository(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    // Clean slate between tests. Order matches FK dependencies.
    await pool.query(
      `TRUNCATE
         task_dependencies, assignments, gates, reviews, approvals,
         agent_runs, events, audit_log, artifacts, decomposition_proposals,
         tasks, scopes
       RESTART IDENTITY CASCADE`,
    );
  });

  describe("scope + task CRUD", () => {
    it("creates scope and writes an audit row in the same transaction", async () => {
      const scope = await repo.createScope(
        { id: SCOPE_ID, title: "CSV export", description: "..." },
        { actor: SUPERVISOR, capability: "graph.write" },
      );
      expect(scope.id).toBe(SCOPE_ID);
      expect(scope.state).toBe("draft");

      const audit = await pool.query<{ action: string; actor: string }>(
        `SELECT action, actor FROM audit_log WHERE scope_id = $1`,
        [SCOPE_ID],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        action: "scope.create",
        actor: SUPERVISOR,
      });
    });

    it("creates task with default state=created and audits", async () => {
      await repo.createScope(
        { id: SCOPE_ID, title: "t", description: "d" },
        { actor: SUPERVISOR },
      );
      const task = await repo.createTask(
        {
          id: TASK_A,
          scope_id: SCOPE_ID,
          title: "Design schema",
          description: "schema",
          acceptance_criteria: ["ac1"],
        },
        { actor: SUPERVISOR },
      );
      expect(task.state).toBe("created");
      expect(task.acceptance_criteria).toEqual(["ac1"]);

      const audit = await pool.query<{ count: string }>(
        `SELECT count(*) as count FROM audit_log WHERE task_id = $1`,
        [TASK_A],
      );
      expect(Number(audit.rows[0].count)).toBe(1);
    });

    it("lists tasks filtered by state", async () => {
      await repo.createScope(
        { id: SCOPE_ID, title: "t", description: "d" },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        {
          id: TASK_A,
          scope_id: SCOPE_ID,
          title: "a",
          description: "d",
          state: "ready",
        },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        { id: TASK_B, scope_id: SCOPE_ID, title: "b", description: "d" },
        { actor: SUPERVISOR },
      );
      const ready = await repo.listTasks(SCOPE_ID, { state: "ready" });
      expect(ready.map((t) => t.id)).toEqual([TASK_A]);
    });

    it("advances scope state with optimistic version and audits", async () => {
      await repo.createScope(
        { id: SCOPE_ID, title: "t", description: "d", state: "draft" },
        { actor: SUPERVISOR },
      );

      const updated = await repo.updateScopeState(
        SCOPE_ID,
        0,
        "decomposition_proposed",
        {
          actor: SUPERVISOR,
          capability: "graph.write",
          reason: "architect_envelope",
        },
      );

      expect(updated.state).toBe("decomposition_proposed");
      expect(updated.state_version).toBe(1);
      const audit = await pool.query<{
        action: string;
        previous_state: string | null;
        new_state: string | null;
      }>(
        `SELECT action, previous_state, new_state
         FROM audit_log
         WHERE scope_id = $1 AND action = 'scope.transition'`,
        [SCOPE_ID],
      );
      expect(audit.rows[0]).toEqual({
        action: "scope.transition",
        previous_state: "draft",
        new_state: "decomposition_proposed",
      });
    });

    it("rejects invalid scope transitions", async () => {
      await repo.createScope(
        { id: SCOPE_ID, title: "t", description: "d", state: "draft" },
        { actor: SUPERVISOR },
      );

      await expect(
        repo.updateScopeState(SCOPE_ID, 0, "closed", { actor: SUPERVISOR }),
      ).rejects.toThrow("scope cannot transition draft -> closed");
    });

    it("rolls back the transaction when the audit row fails", async () => {
      // Force the audit insert to fail by passing an unsatisfiable FK
      // (task_id referencing a non-existent task). The enclosing scope insert
      // must roll back so we never end up with a scope row without audit.
      await expect(
        repo.withTransaction(async (tx) => {
          await tx.createScope(
            { id: SCOPE_ID, title: "t", description: "d" },
            { actor: SUPERVISOR },
          );
          await tx.writeAudit({
            task_id: "col-repo.99" as TaskId,
            actor: SUPERVISOR,
            action: "bogus",
          });
        }),
      ).rejects.toThrow();

      const { rows } = await pool.query(`SELECT id FROM scopes WHERE id = $1`, [
        SCOPE_ID,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  describe("task state transitions", () => {
    beforeEach(async () => {
      await repo.createScope(
        { id: SCOPE_ID, title: "t", description: "d" },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        {
          id: TASK_A,
          scope_id: SCOPE_ID,
          title: "a",
          description: "d",
          state: "created",
        },
        { actor: SUPERVISOR },
      );
    });

    it("advances task state when expected_state_version matches", async () => {
      const updated = await repo.updateTaskState(TASK_A, 0, "ready", {
        actor: SUPERVISOR,
      });
      expect(updated.state).toBe("ready");
      expect(updated.state_version).toBe(1);

      const audit = await pool.query<{
        previous_state: string | null;
        new_state: string | null;
      }>(
        `SELECT previous_state, new_state FROM audit_log
         WHERE task_id = $1 AND action = 'task.transition'`,
        [TASK_A],
      );
      expect(audit.rows[0]).toEqual({
        previous_state: "created",
        new_state: "ready",
      });
      const events = await pool.query<{ kind: string }>(
        `SELECT kind FROM events WHERE task_id = $1`,
        [TASK_A],
      );
      expect(events.rows.map((r) => r.kind)).toContain("task_state_changed");
    });

    it("rejects state transitions with a stale state_version", async () => {
      await repo.updateTaskState(TASK_A, 0, "ready", { actor: SUPERVISOR });
      await expect(
        repo.updateTaskState(TASK_A, 0, "claimed", { actor: SUPERVISOR }),
      ).rejects.toBeInstanceOf(RepositoryError);
    });

    it("rejects disallowed transitions via the domain state machine", async () => {
      await expect(
        repo.updateTaskState(TASK_A, 0, "merged", { actor: SUPERVISOR }),
      ).rejects.toThrow(/cannot transition/i);
    });
  });

  describe("ready_tasks(scope_id)", () => {
    beforeEach(async () => {
      await repo.createScope(
        { id: SCOPE_ID, title: "t", description: "d" },
        { actor: SUPERVISOR },
      );
    });

    it("excludes tasks with an open blocking dependency", async () => {
      // A blocks B. Both ready; only A should show up until A closes.
      await repo.createTask(
        {
          id: TASK_A,
          scope_id: SCOPE_ID,
          title: "a",
          description: "d",
          state: "ready",
        },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        {
          id: TASK_B,
          scope_id: SCOPE_ID,
          title: "b",
          description: "d",
          state: "ready",
        },
        { actor: SUPERVISOR },
      );
      await repo.addDependency(TASK_A, TASK_B, "blocks", { actor: SUPERVISOR });

      const ready = await repo.readyTasks(SCOPE_ID);
      expect(ready.map((t) => t.id)).toEqual([TASK_A]);
      const audit = await repo.listAuditForScope(SCOPE_ID);
      expect(audit.map((a) => a.action)).toContain("dependency.add");
    });

    it("includes a task once its blocker closes", async () => {
      await repo.createTask(
        {
          id: TASK_A,
          scope_id: SCOPE_ID,
          title: "a",
          description: "d",
          state: "closed",
        },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        {
          id: TASK_B,
          scope_id: SCOPE_ID,
          title: "b",
          description: "d",
          state: "ready",
        },
        { actor: SUPERVISOR },
      );
      await repo.addDependency(TASK_A, TASK_B, "blocks", { actor: SUPERVISOR });

      const ready = await repo.readyTasks(SCOPE_ID);
      expect(ready.map((t) => t.id)).toEqual([TASK_B]);
    });

    it("ignores non-blocking dependency kinds (parent_child, related)", async () => {
      await repo.createTask(
        {
          id: TASK_A,
          scope_id: SCOPE_ID,
          title: "a",
          description: "d",
          state: "created",
        },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        {
          id: TASK_B,
          scope_id: SCOPE_ID,
          title: "b",
          description: "d",
          state: "ready",
        },
        { actor: SUPERVISOR },
      );
      await repo.addDependency(TASK_A, TASK_B, "parent_child", {
        actor: SUPERVISOR,
      });

      const ready = await repo.readyTasks(SCOPE_ID);
      expect(ready.map((t) => t.id)).toEqual([TASK_B]);
    });

    it("returns empty list when no tasks are ready", async () => {
      await repo.createTask(
        { id: TASK_A, scope_id: SCOPE_ID, title: "a", description: "d" },
        { actor: SUPERVISOR },
      );
      expect(await repo.readyTasks(SCOPE_ID)).toEqual([]);
    });
  });

  describe("claim_task atomicity", () => {
    beforeEach(async () => {
      await repo.createScope(
        { id: SCOPE_ID, title: "t", description: "d" },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        {
          id: TASK_A,
          scope_id: SCOPE_ID,
          title: "a",
          description: "d",
          state: "ready",
        },
        { actor: SUPERVISOR },
      );
    });

    it("exactly one of two concurrent claimers wins", async () => {
      const dev2 = "agent:dev-2" as ActorId;
      const [r1, r2] = await Promise.all([
        repo.claimTask(TASK_A, DEV_AGENT, 0, { actor: SUPERVISOR }),
        repo.claimTask(TASK_A, dev2, 0, { actor: SUPERVISOR }),
      ]);
      const winners = [r1, r2].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.state).toBe("claimed");

      // Winner's assignee is recorded.
      const { rows } = await pool.query<{ assignee: string; state: string }>(
        `SELECT assignee, state FROM tasks WHERE id = $1`,
        [TASK_A],
      );
      expect(rows[0].state).toBe("claimed");
      expect([DEV_AGENT, dev2]).toContain(rows[0].assignee);

      // Audit reflects both attempts: one success, one failure.
      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM audit_log
         WHERE task_id = $1 AND action LIKE 'task.claim%'
         ORDER BY recorded_at`,
        [TASK_A],
      );
      const actions = audit.rows.map((r) => r.action);
      expect(actions).toContain("task.claim");
      expect(actions).toContain("task.claim_failed");
    });

    it("returns null when task is not in ready state", async () => {
      await pool.query(`UPDATE tasks SET state = 'in_progress' WHERE id = $1`, [
        TASK_A,
      ]);
      const result = await repo.claimTask(TASK_A, DEV_AGENT, 0, {
        actor: SUPERVISOR,
      });
      expect(result).toBeNull();
      const audit = await repo.listAuditForScope(SCOPE_ID);
      expect(audit.map((a) => a.action)).toContain("task.claim_failed");
    });

    it("returns null on expected_state_version mismatch", async () => {
      const result = await repo.claimTask(TASK_A, DEV_AGENT, 99, {
        actor: SUPERVISOR,
      });
      expect(result).toBeNull();
    });

    it("bumps claim_version and state_version on success", async () => {
      const claimed = await repo.claimTask(TASK_A, DEV_AGENT, 0, {
        actor: SUPERVISOR,
      });
      expect(claimed?.claim_version).toBe(1);
      expect(claimed?.state_version).toBe(1);
    });
  });

  describe("get_task_packet stub", () => {
    it("returns the graph-level packet shape with blocking deps", async () => {
      await repo.createScope(
        { id: SCOPE_ID, title: "t", description: "d" },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        {
          id: TASK_A,
          scope_id: SCOPE_ID,
          title: "a",
          description: "d",
        },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        {
          id: TASK_B,
          scope_id: SCOPE_ID,
          title: "Ship CSV export",
          description: "d",
          acceptance_criteria: ["rows match schema"],
          non_goals: ["multi-file export"],
          state: "ready",
        },
        { actor: SUPERVISOR },
      );
      await repo.addDependency(TASK_A, TASK_B, "blocks", { actor: SUPERVISOR });

      const packet = await repo.getTaskPacket(TASK_B);
      expect(packet).toMatchObject({
        task_id: TASK_B,
        scope_id: SCOPE_ID,
        goal: "Ship CSV export",
        acceptance_criteria: ["rows match schema"],
        non_goals: ["multi-file export"],
        dependencies: [TASK_A],
        state: "ready",
        state_version: 0,
        claim_version: 0,
      });
    });

    it("returns null for a missing task", async () => {
      const packet = await repo.getTaskPacket("col-repo.404" as TaskId);
      expect(packet).toBeNull();
    });
  });

  describe("task agent token metadata", () => {
    beforeEach(async () => {
      await repo.createScope(
        { id: SCOPE_ID, title: "t", description: "d" },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        {
          id: TASK_A,
          scope_id: SCOPE_ID,
          title: "a",
          description: "d",
          state: "claimed",
        },
        { actor: SUPERVISOR },
      );
    });

    it("records and revokes task-scoped provider token metadata", async () => {
      const recorded = await repo.recordTaskAgentToken(
        {
          task_id: TASK_A,
          provider_project_id: "20",
          token_id: "901",
          expires_at: "2026-05-02T23:59:59.999Z",
        },
        {
          actor: SUPERVISOR,
          capability: "task.assign",
          reason: "test_mint",
        },
      );
      expect(recorded.agent_token_project_id).toBe("20");
      expect(recorded.agent_token_id).toBe("901");
      expect(recorded.agent_token_revoked_at).toBeUndefined();

      await expect(
        repo.listActiveTaskAgentTokens({ states: ["claimed"] }),
      ).resolves.toMatchObject([
        {
          task_id: TASK_A,
          scope_id: SCOPE_ID,
          provider_project_id: "20",
          token_id: "901",
        },
      ]);

      const revoked = await repo.markTaskAgentTokenRevoked(
        { task_id: TASK_A, token_id: "901" },
        {
          actor: SUPERVISOR,
          capability: "task.assign",
          reason: "test_revoke",
        },
      );
      expect(revoked?.agent_token_revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      await expect(
        repo.listActiveTaskAgentTokens({ states: ["claimed"] }),
      ).resolves.toEqual([]);

      const audit = await repo.listAuditForScope(SCOPE_ID, {
        task_id: TASK_A,
        limit: 20,
      });
      expect(new Set(audit.map((a) => a.action))).toEqual(
        new Set([
          "task.create",
          "task.agent_token.minted",
          "task.agent_token.revoked",
        ]),
      );
    });
  });

  describe("agent run recovery", () => {
    it("cancels only running attempts for a timed-out task activity", async () => {
      await repo.createScope(
        { id: SCOPE_ID, title: "t", description: "d" },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        {
          id: TASK_A,
          scope_id: SCOPE_ID,
          title: "a",
          description: "d",
          state: "in_progress",
        },
        { actor: SUPERVISOR },
      );
      const completed = await repo.startAgentRun({
        task_id: TASK_A,
        role: "developer",
        packet_hash: "sha256:completed",
      });
      await repo.finishAgentRun({ id: completed.id, status: "succeeded" });
      await repo.startAgentRun({
        task_id: TASK_A,
        role: "developer",
        packet_hash: "sha256:running-1",
      });
      await repo.startAgentRun({
        task_id: TASK_A,
        role: "developer",
        packet_hash: "sha256:running-2",
      });

      await expect(repo.cancelRunningAgentRunsForTask(TASK_A)).resolves.toBe(2);
      const result = await pool.query<{
        status: string;
        finished_at: Date | null;
      }>(
        `SELECT status, finished_at
           FROM agent_runs
          WHERE task_id = $1
          ORDER BY started_at`,
        [TASK_A],
      );
      expect(result.rows.map((row) => row.status)).toEqual([
        "succeeded",
        "canceled",
        "canceled",
      ]);
      expect(result.rows.every((row) => row.finished_at !== null)).toBe(true);
    });
  });

  describe("audit invariant", () => {
    it("every mutation writes at least one audit row", async () => {
      await repo.createScope(
        { id: SCOPE_ID, title: "t", description: "d" },
        { actor: SUPERVISOR },
      );
      await repo.createTask(
        {
          id: TASK_A,
          scope_id: SCOPE_ID,
          title: "a",
          description: "d",
          state: "created",
        },
        { actor: SUPERVISOR },
      );
      await repo.updateTaskState(TASK_A, 0, "ready", { actor: SUPERVISOR });
      await repo.claimTask(TASK_A, DEV_AGENT, 1, { actor: SUPERVISOR });

      const { rows } = await pool.query<{ action: string }>(
        `SELECT action FROM audit_log ORDER BY recorded_at`,
      );
      const actions = rows.map((r) => r.action);
      expect(actions).toEqual([
        "scope.create",
        "task.create",
        "task.transition",
        "task.claim",
      ]);
    });
  });
});
