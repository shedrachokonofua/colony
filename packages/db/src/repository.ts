import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  assertTaskTransition,
  type ActorId,
  type AuditId,
  type AuditRecord,
  type Capability,
  type DependencyKind,
  type Event,
  type EventKind,
  type Iso8601,
  type Scope,
  type ScopeId,
  type ScopeState,
  type Task,
  type TaskDependency,
  type TaskId,
  type TaskState,
} from "@colony/domain";
import { RepositoryError } from "./errors.js";

/**
 * Context carried into every mutation.
 *
 * Every mutation writes an `audit_log` row in the same transaction; this is
 * the actor/capability/reason stamped onto that row.
 */
export interface ActorContext {
  readonly actor: ActorId;
  readonly capability?: Capability;
  readonly reason?: string;
}

export interface CreateScopeInput {
  readonly id: ScopeId;
  readonly title: string;
  readonly description: string;
  readonly state?: ScopeState;
}

export interface CreateTaskInput {
  readonly id: TaskId;
  readonly scope_id: ScopeId;
  readonly title: string;
  readonly description: string;
  readonly acceptance_criteria?: readonly string[];
  readonly non_goals?: readonly string[];
  readonly state?: TaskState;
}

export interface ListTasksFilter {
  readonly state?: TaskState;
}

export interface ListAuditOptions {
  readonly task_id?: TaskId;
  /** Default 100, max 500. */
  readonly limit?: number;
}

export interface RecordEventInput {
  readonly scope_id?: ScopeId;
  readonly task_id?: TaskId;
  readonly kind: EventKind;
  readonly actor?: ActorId;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface WriteAuditInput {
  readonly scope_id?: ScopeId;
  readonly task_id?: TaskId;
  readonly actor: ActorId;
  readonly action: string;
  readonly capability?: Capability;
  readonly target_kind?: string;
  readonly target_id?: string;
  readonly previous_state?: string;
  readonly new_state?: string;
  readonly reason?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/**
 * "Query shape" for get_task_packet — a minimal bundle the API / Supervisor
 * will later turn into a full `@colony/schemas` task packet (with memory,
 * policy, freshness, and provider context mixed in). COL-0.7 only ships the
 * graph-level portion so downstream packet assembly has a stable shape to
 * hang off.
 */
export interface TaskPacketStub {
  readonly task_id: TaskId;
  readonly scope_id: ScopeId;
  readonly goal: string;
  readonly acceptance_criteria: readonly string[];
  readonly non_goals: readonly string[];
  readonly dependencies: readonly TaskId[];
  readonly state: TaskState;
  readonly state_version: number;
  readonly claim_version: number;
}

type Executor = Pool | PoolClient;

// ---------------------------------------------------------------------------
// Row → domain object mapping.
// ---------------------------------------------------------------------------

interface ScopeRow {
  id: string;
  title: string;
  description: string;
  state: ScopeState;
  state_version: number;
  created_at: Date;
  updated_at: Date;
}

interface TaskRow {
  id: string;
  scope_id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  non_goals: string[];
  state: TaskState;
  state_version: number;
  claim_version: number;
  assignee: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DependencyRow {
  id: string;
  from_task_id: string;
  to_task_id: string;
  kind: DependencyKind;
  created_at: Date;
}

interface EventRow {
  id: string;
  scope_id: string | null;
  task_id: string | null;
  kind: EventKind;
  actor: string | null;
  payload: Record<string, unknown>;
  recorded_at: Date;
}

interface AuditRow {
  id: string;
}

const toIso = (d: Date): Iso8601 => d.toISOString();

const mapScope = (r: ScopeRow): Scope => ({
  id: r.id as ScopeId,
  title: r.title,
  description: r.description,
  state: r.state,
  state_version: r.state_version,
  created_at: toIso(r.created_at),
  updated_at: toIso(r.updated_at),
});

const mapTask = (r: TaskRow): Task => ({
  id: r.id as TaskId,
  scope_id: r.scope_id as ScopeId,
  title: r.title,
  description: r.description,
  acceptance_criteria: r.acceptance_criteria,
  non_goals: r.non_goals,
  state: r.state,
  state_version: r.state_version,
  claim_version: r.claim_version,
  assignee: r.assignee ? (r.assignee as ActorId) : undefined,
  created_at: toIso(r.created_at),
  updated_at: toIso(r.updated_at),
});

const mapDependency = (r: DependencyRow): TaskDependency => ({
  id: r.id as TaskDependency["id"],
  from_task_id: r.from_task_id as TaskId,
  to_task_id: r.to_task_id as TaskId,
  kind: r.kind,
  created_at: toIso(r.created_at),
});

const mapEvent = (r: EventRow): Event => ({
  id: r.id as Event["id"],
  scope_id: r.scope_id ? (r.scope_id as ScopeId) : undefined,
  task_id: r.task_id ? (r.task_id as TaskId) : undefined,
  kind: r.kind,
  actor: r.actor ? (r.actor as ActorId) : undefined,
  payload: r.payload,
  recorded_at: toIso(r.recorded_at),
});

interface AuditRow {
  id: string;
  scope_id: string | null;
  task_id: string | null;
  actor: string;
  action: string;
  capability: string | null;
  target_kind: string | null;
  target_id: string | null;
  previous_state: string | null;
  new_state: string | null;
  reason: string | null;
  evidence: Record<string, unknown>;
  recorded_at: Date;
}

const mapAuditRow = (r: AuditRow): AuditRecord => ({
  id: r.id as AuditId,
  scope_id: r.scope_id ? (r.scope_id as ScopeId) : undefined,
  task_id: r.task_id ? (r.task_id as TaskId) : undefined,
  actor: r.actor as ActorId,
  action: r.action,
  capability: (r.capability as Capability) ?? undefined,
  target_kind: r.target_kind ?? undefined,
  target_id: r.target_id ?? undefined,
  previous_state: r.previous_state ?? undefined,
  new_state: r.new_state ?? undefined,
  reason: r.reason ?? undefined,
  evidence: r.evidence,
  recorded_at: toIso(r.recorded_at),
});

// ---------------------------------------------------------------------------
// Repository.
// ---------------------------------------------------------------------------

/**
 * Thin transactional wrapper around the colony schema.
 *
 * Every mutation runs in a single transaction and writes an `audit_log` row
 * inside that transaction — the audit invariant is the reason this lives
 * behind a repository class rather than scattered query helpers.
 */
export class TaskGraphRepository {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Transaction helper. Exposed so call sites can compose multiple repo
  // operations into a single transaction (e.g. create scope + initial task).
  // -------------------------------------------------------------------------

  async withTransaction<T>(
    fn: (tx: TaskGraphTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new TaskGraphTransaction(client);
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // best effort; original error surfaces below
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Scope CRUD.
  // -------------------------------------------------------------------------

  async createScope(
    input: CreateScopeInput,
    ctx: ActorContext,
  ): Promise<Scope> {
    return this.withTransaction((tx) => tx.createScope(input, ctx));
  }

  async getScope(id: ScopeId): Promise<Scope | null> {
    const { rows } = await queryRows<ScopeRow>(
      this.pool,
      `SELECT * FROM scopes WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapScope(rows[0]) : null;
  }

  async listScopes(): Promise<Scope[]> {
    const { rows } = await queryRows<ScopeRow>(
      this.pool,
      `SELECT * FROM scopes ORDER BY created_at`,
    );
    return rows.map(mapScope);
  }

  // -------------------------------------------------------------------------
  // Task CRUD.
  // -------------------------------------------------------------------------

  async createTask(input: CreateTaskInput, ctx: ActorContext): Promise<Task> {
    return this.withTransaction((tx) => tx.createTask(input, ctx));
  }

  async getTask(id: TaskId): Promise<Task | null> {
    const { rows } = await queryRows<TaskRow>(
      this.pool,
      `SELECT * FROM tasks WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async listTasks(
    scope_id: ScopeId,
    filter: ListTasksFilter = {},
  ): Promise<Task[]> {
    const where: string[] = ["scope_id = $1"];
    const params: unknown[] = [scope_id];
    if (filter.state) {
      params.push(filter.state);
      where.push(`state = $${params.length}`);
    }
    const { rows } = await queryRows<TaskRow>(
      this.pool,
      `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY created_at`,
      params,
    );
    return rows.map(mapTask);
  }

  async updateTaskState(
    task_id: TaskId,
    expected_state_version: number,
    next_state: TaskState,
    ctx: ActorContext,
  ): Promise<Task> {
    return this.withTransaction((tx) =>
      tx.updateTaskState(task_id, expected_state_version, next_state, ctx),
    );
  }

  // -------------------------------------------------------------------------
  // Dependencies.
  // -------------------------------------------------------------------------

  async addDependency(
    from_task_id: TaskId,
    to_task_id: TaskId,
    kind: DependencyKind,
    ctx: ActorContext,
  ): Promise<TaskDependency> {
    return this.withTransaction((tx) =>
      tx.addDependency(from_task_id, to_task_id, kind, ctx),
    );
  }

  // -------------------------------------------------------------------------
  // Readiness + atomic claim.
  // -------------------------------------------------------------------------

  /**
   * Tasks in `ready` state with no open blocking dependencies.
   *
   * A blocker is "open" when the source task is not closed. `kind='blocks'`
   * is the only dependency kind that gates readiness — parent/related/etc.
   * are organizational, not runtime preconditions.
   */
  async readyTasks(scope_id: ScopeId): Promise<Task[]> {
    const { rows } = await queryRows<TaskRow>(
      this.pool,
      `
      SELECT t.*
      FROM tasks t
      WHERE t.scope_id = $1
        AND t.state = 'ready'
        AND NOT EXISTS (
          SELECT 1
          FROM task_dependencies d
          JOIN tasks b ON b.id = d.from_task_id
          WHERE d.to_task_id = t.id
            AND d.kind = 'blocks'
            AND b.state <> 'closed'
        )
      ORDER BY t.created_at
      `,
      [scope_id],
    );
    return rows.map(mapTask);
  }

  /**
   * Atomic claim. Succeeds at most once per (task_id, state_version).
   *
   * Under concurrent callers, exactly one UPDATE matches because the WHERE
   * clause filters on `state='ready' AND state_version=$expected`; the first
   * successful UPDATE bumps `state_version` and subsequent UPDATEs see no
   * matching row and return null.
   */
  async claimTask(
    task_id: TaskId,
    assignee: ActorId,
    expected_state_version: number,
    ctx: ActorContext,
  ): Promise<Task | null> {
    return this.withTransaction((tx) =>
      tx.claimTask(task_id, assignee, expected_state_version, ctx),
    );
  }

  // -------------------------------------------------------------------------
  // Events + audit (exposed for Supervisor activities that need to record a
  // provider event / audit write without mutating an entity).
  // -------------------------------------------------------------------------

  async recordEvent(input: RecordEventInput): Promise<Event> {
    return this.withTransaction((tx) => tx.recordEvent(input));
  }

  async writeAudit(input: WriteAuditInput): Promise<string> {
    return this.withTransaction((tx) => tx.writeAudit(input));
  }

  // -------------------------------------------------------------------------
  // Task packet stub.
  // -------------------------------------------------------------------------

  async getTaskPacket(task_id: TaskId): Promise<TaskPacketStub | null> {
    const { rows: taskRows } = await queryRows<TaskRow>(
      this.pool,
      `SELECT * FROM tasks WHERE id = $1`,
      [task_id],
    );
    const row = taskRows[0];
    if (!row) return null;
    const { rows: depRows } = await queryRows<{ from_task_id: string }>(
      this.pool,
      `SELECT from_task_id FROM task_dependencies
       WHERE to_task_id = $1 AND kind = 'blocks'
       ORDER BY created_at`,
      [task_id],
    );
    return {
      task_id: row.id as TaskId,
      scope_id: row.scope_id as ScopeId,
      goal: row.title,
      acceptance_criteria: row.acceptance_criteria,
      non_goals: row.non_goals,
      dependencies: depRows.map((d) => d.from_task_id as TaskId),
      state: row.state,
      state_version: row.state_version,
      claim_version: row.claim_version,
    };
  }

  async listAuditForScope(
    scope_id: ScopeId,
    options: ListAuditOptions = {},
  ): Promise<readonly AuditRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const params: unknown[] = [scope_id];
    const parts = ["scope_id = $1"];
    if (options.task_id) {
      params.push(options.task_id);
      parts.push(`task_id = $${params.length}`);
    }
    params.push(limit);
    const { rows } = await queryRows<AuditRow>(
      this.pool,
      `SELECT * FROM audit_log
       WHERE ${parts.join(" AND ")}
       ORDER BY recorded_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(mapAuditRow);
  }
}

// ---------------------------------------------------------------------------
// Transaction-scoped repository. Same operations, but all writes go through
// a single PoolClient so audit + mutation commit atomically.
// ---------------------------------------------------------------------------

export class TaskGraphTransaction {
  constructor(private readonly client: PoolClient) {}

  async createScope(
    input: CreateScopeInput,
    ctx: ActorContext,
  ): Promise<Scope> {
    const state: ScopeState = input.state ?? "draft";
    const { rows } = await queryRows<ScopeRow>(
      this.client,
      `INSERT INTO scopes (id, title, description, state)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.id, input.title, input.description, state],
    );
    const scope = mapScope(rows[0]);
    await this.writeAudit({
      scope_id: scope.id,
      actor: ctx.actor,
      action: "scope.create",
      capability: ctx.capability,
      target_kind: "scope",
      target_id: scope.id,
      new_state: scope.state,
      reason: ctx.reason,
      evidence: { title: scope.title },
    });
    return scope;
  }

  async createTask(input: CreateTaskInput, ctx: ActorContext): Promise<Task> {
    const state: TaskState = input.state ?? "created";
    const { rows } = await queryRows<TaskRow>(
      this.client,
      `INSERT INTO tasks
         (id, scope_id, title, description, acceptance_criteria, non_goals, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.id,
        input.scope_id,
        input.title,
        input.description,
        input.acceptance_criteria ?? [],
        input.non_goals ?? [],
        state,
      ],
    );
    const task = mapTask(rows[0]);
    await this.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: ctx.actor,
      action: "task.create",
      capability: ctx.capability,
      target_kind: "task",
      target_id: task.id,
      new_state: task.state,
      reason: ctx.reason,
      evidence: { title: task.title },
    });
    return task;
  }

  async updateTaskState(
    task_id: TaskId,
    expected_state_version: number,
    next_state: TaskState,
    ctx: ActorContext,
  ): Promise<Task> {
    const current = await this.lockTaskRow(task_id);
    if (!current) {
      throw new RepositoryError("NOT_FOUND", `task not found: ${task_id}`, {
        task_id,
      });
    }
    if (current.state_version !== expected_state_version) {
      throw new RepositoryError(
        "STATE_VERSION_MISMATCH",
        `task ${task_id}: expected state_version=${expected_state_version}, got ${current.state_version}`,
        {
          task_id,
          expected: expected_state_version,
          actual: current.state_version,
        },
      );
    }
    // Domain check — throws DomainStateError for invalid transitions.
    assertTaskTransition(current.state, next_state);
    const { rows } = await queryRows<TaskRow>(
      this.client,
      `UPDATE tasks
         SET state = $2,
             state_version = state_version + 1,
             updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [task_id, next_state],
    );
    const task = mapTask(rows[0]);
    await this.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: ctx.actor,
      action: "task.transition",
      capability: ctx.capability,
      target_kind: "task",
      target_id: task.id,
      previous_state: current.state,
      new_state: next_state,
      reason: ctx.reason,
      evidence: { state_version: task.state_version },
    });
    await this.recordEvent({
      scope_id: task.scope_id,
      task_id: task.id,
      kind: "task_state_changed",
      actor: ctx.actor,
      payload: { from: current.state, to: next_state },
    });
    return task;
  }

  async addDependency(
    from_task_id: TaskId,
    to_task_id: TaskId,
    kind: DependencyKind,
    ctx: ActorContext,
  ): Promise<TaskDependency> {
    const id = randomUUID();
    const { rows } = await queryRows<DependencyRow>(
      this.client,
      `INSERT INTO task_dependencies (id, from_task_id, to_task_id, kind)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, from_task_id, to_task_id, kind],
    );
    const dep = mapDependency(rows[0]);
    const { rows: taskRows } = await queryRows<{ scope_id: string }>(
      this.client,
      `SELECT scope_id FROM tasks WHERE id = $1`,
      [to_task_id],
    );
    await this.writeAudit({
      scope_id: taskRows[0]?.scope_id as ScopeId | undefined,
      task_id: to_task_id,
      actor: ctx.actor,
      action: "dependency.add",
      capability: ctx.capability,
      target_kind: "dependency",
      target_id: id,
      reason: ctx.reason,
      evidence: { from_task_id, to_task_id, kind },
    });
    return dep;
  }

  async claimTask(
    task_id: TaskId,
    assignee: ActorId,
    expected_state_version: number,
    ctx: ActorContext,
  ): Promise<Task | null> {
    // Atomic: only the (task_id, state='ready', state_version=$3) row matches.
    // The first concurrent caller wins; the losers see zero affected rows.
    const { rows } = await queryRows<TaskRow>(
      this.client,
      `UPDATE tasks
         SET state = 'claimed',
             assignee = $2,
             claim_version = claim_version + 1,
             state_version = state_version + 1,
             updated_at = now()
       WHERE id = $1
         AND state = 'ready'
         AND state_version = $3
       RETURNING *`,
      [task_id, assignee, expected_state_version],
    );
    const row = rows[0];
    if (!row) {
      const { rows: existing } = await queryRows<{ scope_id: string }>(
        this.client,
        `SELECT scope_id FROM tasks WHERE id = $1`,
        [task_id],
      );
      const scope_id = existing[0]?.scope_id as ScopeId | undefined;
      await this.writeAudit({
        scope_id,
        task_id,
        actor: ctx.actor,
        action: "task.claim_failed",
        capability: ctx.capability,
        target_kind: "task",
        target_id: task_id,
        reason: ctx.reason,
        evidence: {
          assignee,
          expected_state_version,
        },
      });
      await this.recordEvent({
        scope_id,
        task_id,
        kind: "claim_failed",
        actor: ctx.actor,
        payload: { assignee, expected_state_version },
      });
      return null;
    }
    const task = mapTask(row);
    await this.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: ctx.actor,
      action: "task.claim",
      capability: ctx.capability,
      target_kind: "task",
      target_id: task.id,
      previous_state: "ready",
      new_state: "claimed",
      reason: ctx.reason,
      evidence: {
        assignee,
        claim_version: task.claim_version,
        state_version: task.state_version,
      },
    });
    await this.recordEvent({
      scope_id: task.scope_id,
      task_id: task.id,
      kind: "claim_succeeded",
      actor: ctx.actor,
      payload: {
        assignee,
        claim_version: task.claim_version,
        state_version: task.state_version,
      },
    });
    return task;
  }

  async recordEvent(input: RecordEventInput): Promise<Event> {
    const id = randomUUID();
    const { rows } = await queryRows<EventRow>(
      this.client,
      `INSERT INTO events (id, scope_id, task_id, kind, actor, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [
        id,
        input.scope_id ?? null,
        input.task_id ?? null,
        input.kind,
        input.actor ?? null,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return mapEvent(rows[0]);
  }

  async writeAudit(input: WriteAuditInput): Promise<string> {
    const id = randomUUID();
    await queryRows<AuditRow>(
      this.client,
      `INSERT INTO audit_log
         (id, scope_id, task_id, actor, action, capability,
          target_kind, target_id, previous_state, new_state, reason, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        id,
        input.scope_id ?? null,
        input.task_id ?? null,
        input.actor,
        input.action,
        input.capability ?? null,
        input.target_kind ?? null,
        input.target_id ?? null,
        input.previous_state ?? null,
        input.new_state ?? null,
        input.reason ?? null,
        JSON.stringify(input.evidence ?? {}),
      ],
    );
    return id;
  }

  private async lockTaskRow(task_id: TaskId): Promise<TaskRow | undefined> {
    const { rows } = await queryRows<TaskRow>(
      this.client,
      `SELECT * FROM tasks WHERE id = $1 FOR UPDATE`,
      [task_id],
    );
    return rows[0];
  }
}

// ---------------------------------------------------------------------------
// Small typed query helper.
// ---------------------------------------------------------------------------

async function queryRows<R>(
  exec: Executor,
  text: string,
  params: readonly unknown[] = [],
): Promise<{ rows: R[] }> {
  // pg's QueryResultRow requires an index signature we do not want to
  // propagate to our row types. Casting at this boundary keeps the rest of
  // the repository strongly typed.
  const result = await (exec as Pool).query(text, params as unknown[]);
  return { rows: result.rows as R[] };
}
