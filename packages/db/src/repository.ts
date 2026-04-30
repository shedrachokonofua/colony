import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  assertScopeTransition,
  assertTaskTransition,
  type ActorId,
  type AuditId,
  type AuditRecord,
  type Capability,
  type DependencyKind,
  type Event,
  type EventKind,
  type Iso8601,
  type ProviderProjectId,
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

export interface ProposedDecompositionTaskInput {
  readonly proposed_task_id: TaskId;
  readonly title: string;
  readonly description: string;
  readonly acceptance_criteria: readonly string[];
  readonly non_goals?: readonly string[];
  readonly suggested_role?: string;
  readonly suggested_capabilities?: readonly string[];
  readonly estimated_effort_minutes?: number;
}

export interface ProposedDecompositionDependencyInput {
  readonly from_task_id: TaskId;
  readonly to_task_id: TaskId;
  readonly kind: Extract<DependencyKind, "blocks" | "parent_child" | "related">;
}

export interface SubmitDecompositionProposalInput {
  readonly scope_id: ScopeId;
  readonly scope_state_version: number;
  readonly scope_brief_version: string;
  readonly proposed_tasks: readonly ProposedDecompositionTaskInput[];
  readonly proposed_dependencies: readonly ProposedDecompositionDependencyInput[];
  readonly target_project_mapping?: Readonly<Record<string, string>>;
  readonly assumptions: readonly string[];
  readonly open_questions: readonly string[];
  readonly packet_hash: string;
  readonly envelope_hash: string;
  readonly envelope: Readonly<Record<string, unknown>>;
}

export interface RecordDecompositionReviewInput {
  readonly scope_id: ScopeId;
  readonly proposal_id: string;
  readonly envelope_hash: string;
  readonly reviewer: ActorId;
  readonly result: "approved" | "changes_requested" | "blocked" | "escalate";
}

export interface ApproveDecompositionProposalInput {
  readonly scope_id: ScopeId;
  readonly proposal_id: string;
  readonly expected_scope_state_version: number;
  readonly envelope_hash: string;
}

export interface CommitDecompositionProposalInput {
  readonly scope_id: ScopeId;
  readonly proposal_id: string;
  readonly expected_scope_state_version: number;
  readonly envelope_hash: string;
}

export interface DecompositionProposal {
  readonly id: string;
  readonly scope_id: ScopeId;
  readonly scope_state_version: number;
  readonly scope_brief_version: string;
  readonly status:
    | "proposed"
    | "review_approved"
    | "changes_requested"
    | "human_approved"
    | "committed";
  readonly proposed_tasks: readonly ProposedDecompositionTaskInput[];
  readonly proposed_dependencies: readonly ProposedDecompositionDependencyInput[];
  readonly target_project_mapping: Readonly<Record<string, string>>;
  readonly assumptions: readonly string[];
  readonly open_questions: readonly string[];
  readonly packet_hash: string;
  readonly envelope_hash: string;
  readonly reviewer?: ActorId;
  readonly reviewer_result?:
    | "approved"
    | "changes_requested"
    | "blocked"
    | "escalate";
  readonly human_approved_by?: ActorId;
  readonly created_at: Iso8601;
  readonly updated_at: Iso8601;
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

export interface RecordTaskAgentTokenInput {
  readonly task_id: TaskId;
  readonly provider_project_id: string;
  readonly token_id: string;
  readonly expires_at: Date | string;
}

export interface RevokeTaskAgentTokenInput {
  readonly task_id: TaskId;
  readonly token_id: string;
}

export interface TaskAgentTokenRecord {
  readonly task_id: TaskId;
  readonly scope_id: ScopeId;
  readonly provider_project_id: string;
  readonly token_id: string;
  readonly expires_at: Iso8601;
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
  agent_token_project_id: string | null;
  agent_token_id: string | null;
  agent_token_expires_at: Date | null;
  agent_token_revoked_at: Date | null;
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

interface DecompositionProposalRow {
  id: string;
  scope_id: string;
  scope_state_version: number;
  scope_brief_version: string;
  status: DecompositionProposal["status"];
  proposed_tasks: ProposedDecompositionTaskInput[];
  proposed_dependencies: ProposedDecompositionDependencyInput[];
  target_project_mapping: Record<string, string>;
  assumptions: string[];
  open_questions: string[];
  packet_hash: string;
  envelope_hash: string;
  reviewer: string | null;
  reviewer_result: DecompositionProposal["reviewer_result"] | null;
  human_approved_by: string | null;
  created_at: Date;
  updated_at: Date;
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
  agent_token_project_id: r.agent_token_project_id ?? undefined,
  agent_token_id: r.agent_token_id ?? undefined,
  agent_token_expires_at: r.agent_token_expires_at
    ? toIso(r.agent_token_expires_at)
    : undefined,
  agent_token_revoked_at: r.agent_token_revoked_at
    ? toIso(r.agent_token_revoked_at)
    : undefined,
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

const mapDecompositionProposal = (
  r: DecompositionProposalRow,
): DecompositionProposal => ({
  id: r.id,
  scope_id: r.scope_id as ScopeId,
  scope_state_version: r.scope_state_version,
  scope_brief_version: r.scope_brief_version,
  status: r.status,
  proposed_tasks: r.proposed_tasks,
  proposed_dependencies: r.proposed_dependencies,
  target_project_mapping: r.target_project_mapping,
  assumptions: r.assumptions,
  open_questions: r.open_questions,
  packet_hash: r.packet_hash,
  envelope_hash: r.envelope_hash,
  reviewer: r.reviewer ? (r.reviewer as ActorId) : undefined,
  reviewer_result: r.reviewer_result ?? undefined,
  human_approved_by: r.human_approved_by
    ? (r.human_approved_by as ActorId)
    : undefined,
  created_at: toIso(r.created_at),
  updated_at: toIso(r.updated_at),
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

  async recordTaskAgentToken(
    input: RecordTaskAgentTokenInput,
    ctx: ActorContext,
  ): Promise<Task> {
    return this.withTransaction((tx) => tx.recordTaskAgentToken(input, ctx));
  }

  async markTaskAgentTokenRevoked(
    input: RevokeTaskAgentTokenInput,
    ctx: ActorContext,
  ): Promise<Task | null> {
    return this.withTransaction((tx) =>
      tx.markTaskAgentTokenRevoked(input, ctx),
    );
  }

  async listActiveTaskAgentTokens(
    input: {
      readonly states?: readonly TaskState[];
    } = {},
  ): Promise<TaskAgentTokenRecord[]> {
    const params: unknown[] = [];
    const where = [
      `agent_token_id IS NOT NULL`,
      `agent_token_project_id IS NOT NULL`,
      `agent_token_revoked_at IS NULL`,
    ];
    if (input.states && input.states.length > 0) {
      params.push(input.states);
      where.push(`state = ANY($${params.length}::text[])`);
    }
    const { rows } = await queryRows<{
      id: string;
      scope_id: string;
      agent_token_project_id: string;
      agent_token_id: string;
      agent_token_expires_at: Date;
    }>(
      this.pool,
      `SELECT id, scope_id, agent_token_project_id, agent_token_id,
              agent_token_expires_at
       FROM tasks
       WHERE ${where.join(" AND ")}
       ORDER BY updated_at`,
      params,
    );
    return rows.map((r) => ({
      task_id: r.id as TaskId,
      scope_id: r.scope_id as ScopeId,
      provider_project_id: r.agent_token_project_id,
      token_id: r.agent_token_id,
      expires_at: toIso(r.agent_token_expires_at),
    }));
  }

  async updateScopeState(
    scope_id: ScopeId,
    expected_state_version: number,
    next_state: ScopeState,
    ctx: ActorContext,
  ): Promise<Scope> {
    return this.withTransaction((tx) =>
      tx.updateScopeState(scope_id, expected_state_version, next_state, ctx),
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

  async getTaskDependencies(task_id: TaskId): Promise<{
    readonly blocked_by: readonly TaskId[];
    readonly blocks: readonly TaskId[];
  }> {
    const { rows: upstream } = await queryRows<{ from_task_id: string }>(
      this.pool,
      `SELECT from_task_id FROM task_dependencies
       WHERE to_task_id = $1 AND kind = 'blocks'
       ORDER BY created_at`,
      [task_id],
    );
    const { rows: downstream } = await queryRows<{ to_task_id: string }>(
      this.pool,
      `SELECT to_task_id FROM task_dependencies
       WHERE from_task_id = $1 AND kind = 'blocks'
       ORDER BY created_at`,
      [task_id],
    );
    return {
      blocked_by: upstream.map((r) => r.from_task_id as TaskId),
      blocks: downstream.map((r) => r.to_task_id as TaskId),
    };
  }

  // -------------------------------------------------------------------------
  // Scope decomposition proposals.
  // -------------------------------------------------------------------------

  async submitDecompositionProposal(
    input: SubmitDecompositionProposalInput,
    ctx: ActorContext,
  ): Promise<DecompositionProposal> {
    return this.withTransaction((tx) =>
      tx.submitDecompositionProposal(input, ctx),
    );
  }

  async getDecompositionProposal(
    scope_id: ScopeId,
    proposal_id: string,
  ): Promise<DecompositionProposal | null> {
    const { rows } = await queryRows<DecompositionProposalRow>(
      this.pool,
      `SELECT * FROM decomposition_proposals
       WHERE scope_id = $1 AND id = $2`,
      [scope_id, proposal_id],
    );
    return rows[0] ? mapDecompositionProposal(rows[0]) : null;
  }

  /**
   * All decomposition proposals for a scope, newest first. Used by the
   * web UI to render the proposal trail (including
   * changes_requested/committed history).
   */
  async listDecompositionProposals(
    scope_id: ScopeId,
  ): Promise<readonly DecompositionProposal[]> {
    const { rows } = await queryRows<DecompositionProposalRow>(
      this.pool,
      `SELECT * FROM decomposition_proposals
       WHERE scope_id = $1
       ORDER BY created_at DESC`,
      [scope_id],
    );
    return rows.map(mapDecompositionProposal);
  }

  /**
   * Latest active proposal for a scope, optionally filtered by status.
   * "Active" = not in `committed` (committed proposals have already
   * created tasks; we should never re-review a committed proposal).
   * Used by the webhook -> workflow path that resolves a scope-level
   * `/approve` or `/changes` to a specific proposal at command time.
   */
  async getLatestDecompositionProposal(
    scope_id: ScopeId,
    options: {
      readonly status?: DecompositionProposal["status"];
    } = {},
  ): Promise<DecompositionProposal | null> {
    const params: unknown[] = [scope_id];
    let statusClause = "AND status <> 'committed'";
    if (options.status) {
      params.push(options.status);
      statusClause = `AND status = $${params.length}`;
    }
    const { rows } = await queryRows<DecompositionProposalRow>(
      this.pool,
      `SELECT * FROM decomposition_proposals
       WHERE scope_id = $1 ${statusClause}
       ORDER BY created_at DESC
       LIMIT 1`,
      params,
    );
    return rows[0] ? mapDecompositionProposal(rows[0]) : null;
  }

  async recordDecompositionReview(
    input: RecordDecompositionReviewInput,
    ctx: ActorContext,
  ): Promise<DecompositionProposal> {
    return this.withTransaction((tx) =>
      tx.recordDecompositionReview(input, ctx),
    );
  }

  async approveDecompositionProposal(
    input: ApproveDecompositionProposalInput,
    ctx: ActorContext,
  ): Promise<{
    readonly scope: Scope;
    readonly proposal: DecompositionProposal;
  }> {
    return this.withTransaction((tx) =>
      tx.approveDecompositionProposal(input, ctx),
    );
  }

  async commitDecompositionProposal(
    input: CommitDecompositionProposalInput,
    ctx: ActorContext,
  ): Promise<{
    readonly scope: Scope;
    readonly proposal: DecompositionProposal;
    readonly tasks: readonly Task[];
    readonly dependencies: readonly TaskDependency[];
  }> {
    return this.withTransaction((tx) =>
      tx.commitDecompositionProposal(input, ctx),
    );
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

  async updateScopeState(
    scope_id: ScopeId,
    expected_state_version: number,
    next_state: ScopeState,
    ctx: ActorContext,
  ): Promise<Scope> {
    const current = await this.lockScopeRow(scope_id);
    if (!current) {
      throw new RepositoryError("NOT_FOUND", `scope not found: ${scope_id}`, {
        scope_id,
      });
    }
    if (current.state_version !== expected_state_version) {
      throw new RepositoryError(
        "STATE_VERSION_MISMATCH",
        `scope ${scope_id}: expected state_version=${expected_state_version}, got ${current.state_version}`,
        {
          scope_id,
          expected: expected_state_version,
          actual: current.state_version,
        },
      );
    }
    assertScopeTransition(current.state, next_state);
    const { rows } = await queryRows<ScopeRow>(
      this.client,
      `UPDATE scopes
         SET state = $2,
             state_version = state_version + 1,
             updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [scope_id, next_state],
    );
    const scope = mapScope(rows[0]);
    await this.writeAudit({
      scope_id: scope.id,
      actor: ctx.actor,
      action: "scope.transition",
      capability: ctx.capability,
      target_kind: "scope",
      target_id: scope.id,
      previous_state: current.state,
      new_state: next_state,
      reason: ctx.reason,
      evidence: { state_version: scope.state_version },
    });
    await this.recordEvent({
      scope_id: scope.id,
      kind: "scope_state_changed",
      actor: ctx.actor,
      payload: { from: current.state, to: next_state },
    });
    return scope;
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

  async recordTaskAgentToken(
    input: RecordTaskAgentTokenInput,
    ctx: ActorContext,
  ): Promise<Task> {
    const { rows } = await queryRows<TaskRow>(
      this.client,
      `UPDATE tasks
         SET agent_token_project_id = $2,
             agent_token_id = $3,
             agent_token_expires_at = $4,
             agent_token_revoked_at = NULL,
             updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        input.task_id,
        input.provider_project_id,
        input.token_id,
        input.expires_at,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new RepositoryError(
        "NOT_FOUND",
        `task not found: ${input.task_id}`,
        {
          task_id: input.task_id,
        },
      );
    }
    const task = mapTask(row);
    await this.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: ctx.actor,
      action: "task.agent_token.minted",
      capability: ctx.capability,
      target_kind: "provider_access_token",
      target_id: input.token_id,
      reason: ctx.reason,
      evidence: {
        provider_project_id: input.provider_project_id,
        expires_at:
          input.expires_at instanceof Date
            ? input.expires_at.toISOString()
            : input.expires_at,
      },
    });
    return task;
  }

  async markTaskAgentTokenRevoked(
    input: RevokeTaskAgentTokenInput,
    ctx: ActorContext,
  ): Promise<Task | null> {
    const { rows } = await queryRows<TaskRow>(
      this.client,
      `UPDATE tasks
         SET agent_token_revoked_at = now(),
             updated_at = now()
       WHERE id = $1
         AND agent_token_id = $2
         AND agent_token_revoked_at IS NULL
       RETURNING *`,
      [input.task_id, input.token_id],
    );
    const row = rows[0];
    if (!row) {
      const { rows: existing } = await queryRows<TaskRow>(
        this.client,
        `SELECT * FROM tasks WHERE id = $1`,
        [input.task_id],
      );
      const task = existing[0] ? mapTask(existing[0]) : null;
      await this.writeAudit({
        scope_id: task?.scope_id,
        task_id: input.task_id,
        actor: ctx.actor,
        action: "task.agent_token.revoke_skipped",
        capability: ctx.capability,
        target_kind: "provider_access_token",
        target_id: input.token_id,
        reason: ctx.reason,
        evidence: {
          current_token_id: task?.agent_token_id,
          already_revoked: task?.agent_token_revoked_at !== undefined,
        },
      });
      return null;
    }
    const task = mapTask(row);
    await this.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: ctx.actor,
      action: "task.agent_token.revoked",
      capability: ctx.capability,
      target_kind: "provider_access_token",
      target_id: input.token_id,
      reason: ctx.reason,
      evidence: {
        provider_project_id: task.agent_token_project_id,
        revoked_at: task.agent_token_revoked_at,
      },
    });
    return task;
  }

  async submitDecompositionProposal(
    input: SubmitDecompositionProposalInput,
    ctx: ActorContext,
  ): Promise<DecompositionProposal> {
    const scope = await this.lockScopeRow(input.scope_id);
    if (!scope) {
      throw new RepositoryError(
        "NOT_FOUND",
        `scope not found: ${input.scope_id}`,
        {
          scope_id: input.scope_id,
        },
      );
    }
    if (scope.state !== "draft") {
      throw new RepositoryError(
        "INVALID_SCOPE_STATE",
        "decomposition proposals can only be submitted for draft scopes",
        { scope_id: input.scope_id, state: scope.state },
      );
    }
    if (scope.state_version !== input.scope_state_version) {
      throw new RepositoryError(
        "STATE_VERSION_MISMATCH",
        `scope ${input.scope_id}: expected state_version=${input.scope_state_version}, got ${scope.state_version}`,
        {
          scope_id: input.scope_id,
          expected: input.scope_state_version,
          actual: scope.state_version,
        },
      );
    }
    validateDecomposition(input);

    const id = `decomp-${randomUUID()}`;
    const { rows } = await queryRows<DecompositionProposalRow>(
      this.client,
      `INSERT INTO decomposition_proposals
         (id, scope_id, scope_state_version, scope_brief_version, status,
          proposed_tasks, proposed_dependencies, target_project_mapping,
          assumptions, open_questions, packet_hash, envelope_hash, envelope)
       VALUES ($1, $2, $3, $4, 'proposed', $5::jsonb, $6::jsonb, $7::jsonb,
               $8, $9, $10, $11, $12::jsonb)
       RETURNING *`,
      [
        id,
        input.scope_id,
        input.scope_state_version,
        input.scope_brief_version,
        JSON.stringify(input.proposed_tasks),
        JSON.stringify(input.proposed_dependencies),
        JSON.stringify(input.target_project_mapping ?? {}),
        [...input.assumptions],
        [...input.open_questions],
        input.packet_hash,
        input.envelope_hash,
        JSON.stringify(input.envelope),
      ],
    );
    const proposal = mapDecompositionProposal(rows[0]);

    await this.writeAudit({
      scope_id: input.scope_id,
      actor: ctx.actor,
      action: "decomposition.proposed",
      capability: ctx.capability,
      target_kind: "decomposition_proposal",
      target_id: proposal.id,
      reason: ctx.reason,
      evidence: {
        scope_state_version: input.scope_state_version,
        task_count: proposal.proposed_tasks.length,
        dependency_count: proposal.proposed_dependencies.length,
        packet_hash: proposal.packet_hash,
        envelope_hash: proposal.envelope_hash,
      },
    });
    await this.recordEvent({
      scope_id: input.scope_id,
      kind: "envelope_received",
      actor: ctx.actor,
      payload: {
        role: "architect",
        proposal_id: proposal.id,
        packet_hash: proposal.packet_hash,
        envelope_hash: proposal.envelope_hash,
      },
    });

    await this.openSpecDagGate(input.scope_id);
    await this.updateScopeState(
      input.scope_id,
      scope.state_version,
      "decomposition_proposed",
      {
        ...ctx,
        reason: ctx.reason ?? "architect_decomposition_envelope",
      },
    );
    return proposal;
  }

  async recordDecompositionReview(
    input: RecordDecompositionReviewInput,
    ctx: ActorContext,
  ): Promise<DecompositionProposal> {
    const proposal = await this.lockDecompositionProposalRow(
      input.scope_id,
      input.proposal_id,
    );
    if (!proposal) {
      throw new RepositoryError(
        "NOT_FOUND",
        "decomposition proposal not found",
        {
          scope_id: input.scope_id,
          proposal_id: input.proposal_id,
        },
      );
    }
    if (proposal.envelope_hash !== input.envelope_hash) {
      throw new RepositoryError(
        "STALE_DECOMPOSITION_ENVELOPE",
        "decomposition envelope hash mismatch",
        {
          expected: proposal.envelope_hash,
          actual: input.envelope_hash,
        },
      );
    }
    if (proposal.status !== "proposed") {
      throw new RepositoryError(
        "INVALID_DECOMPOSITION_STATUS",
        "proposal is not awaiting review",
        {
          status: proposal.status,
        },
      );
    }

    const status =
      input.result === "approved" ? "review_approved" : "changes_requested";
    const { rows } = await queryRows<DecompositionProposalRow>(
      this.client,
      `UPDATE decomposition_proposals
       SET status = $3,
           reviewer = $4,
           reviewer_result = $5,
           reviewed_at = now(),
           updated_at = now()
       WHERE scope_id = $1 AND id = $2
       RETURNING *`,
      [input.scope_id, input.proposal_id, status, input.reviewer, input.result],
    );
    const updated = mapDecompositionProposal(rows[0]);
    await this.writeAudit({
      scope_id: input.scope_id,
      actor: ctx.actor,
      action:
        input.result === "approved"
          ? "decomposition.review.approved"
          : "decomposition.review.changes_requested",
      capability: ctx.capability,
      target_kind: "decomposition_proposal",
      target_id: input.proposal_id,
      reason: ctx.reason,
      evidence: {
        reviewer: input.reviewer,
        result: input.result,
        envelope_hash: input.envelope_hash,
      },
    });
    await this.recordEvent({
      scope_id: input.scope_id,
      kind: "review_resolved",
      actor: input.reviewer,
      payload: {
        proposal_id: input.proposal_id,
        result: input.result,
        envelope_hash: input.envelope_hash,
      },
    });

    if (input.result !== "approved") {
      const scope = await this.lockScopeRow(input.scope_id);
      if (scope?.state === "decomposition_proposed") {
        await this.updateScopeState(
          input.scope_id,
          scope.state_version,
          "draft",
          {
            ...ctx,
            reason: "spec_dag_changes_requested",
          },
        );
      }
    }
    return updated;
  }

  async approveDecompositionProposal(
    input: ApproveDecompositionProposalInput,
    ctx: ActorContext,
  ): Promise<{
    readonly scope: Scope;
    readonly proposal: DecompositionProposal;
  }> {
    const scope = await this.lockScopeRow(input.scope_id);
    if (!scope) {
      throw new RepositoryError(
        "NOT_FOUND",
        `scope not found: ${input.scope_id}`,
        {
          scope_id: input.scope_id,
        },
      );
    }
    if (scope.state_version !== input.expected_scope_state_version) {
      throw new RepositoryError(
        "STATE_VERSION_MISMATCH",
        `scope ${input.scope_id}: expected state_version=${input.expected_scope_state_version}, got ${scope.state_version}`,
        {
          scope_id: input.scope_id,
          expected: input.expected_scope_state_version,
          actual: scope.state_version,
        },
      );
    }
    if (scope.state !== "decomposition_proposed") {
      throw new RepositoryError(
        "INVALID_SCOPE_STATE",
        "scope is not awaiting decomposition approval",
        {
          scope_id: input.scope_id,
          state: scope.state,
        },
      );
    }
    const proposal = await this.lockDecompositionProposalRow(
      input.scope_id,
      input.proposal_id,
    );
    if (!proposal) {
      throw new RepositoryError(
        "NOT_FOUND",
        "decomposition proposal not found",
        {
          scope_id: input.scope_id,
          proposal_id: input.proposal_id,
        },
      );
    }
    if (proposal.envelope_hash !== input.envelope_hash) {
      throw new RepositoryError(
        "STALE_DECOMPOSITION_ENVELOPE",
        "decomposition envelope hash mismatch",
        {
          expected: proposal.envelope_hash,
          actual: input.envelope_hash,
        },
      );
    }
    if (
      proposal.status !== "review_approved" ||
      proposal.reviewer_result !== "approved"
    ) {
      throw new RepositoryError(
        "REVIEW_NOT_APPROVED",
        "spec/DAG proposal needs reviewer approval before human approval",
        {
          status: proposal.status,
          reviewer_result: proposal.reviewer_result,
        },
      );
    }

    const { rows } = await queryRows<DecompositionProposalRow>(
      this.client,
      `UPDATE decomposition_proposals
       SET status = 'human_approved',
           human_approved_by = $3,
           human_approved_at = now(),
           updated_at = now()
       WHERE scope_id = $1 AND id = $2
       RETURNING *`,
      [input.scope_id, input.proposal_id, ctx.actor],
    );
    const updatedProposal = mapDecompositionProposal(rows[0]);
    await this.writeAudit({
      scope_id: input.scope_id,
      actor: ctx.actor,
      action: "decomposition.human_approved",
      capability: ctx.capability,
      target_kind: "decomposition_proposal",
      target_id: input.proposal_id,
      reason: ctx.reason,
      evidence: { envelope_hash: input.envelope_hash },
    });
    await this.recordEvent({
      scope_id: input.scope_id,
      kind: "approval_recorded",
      actor: ctx.actor,
      payload: {
        proposal_id: input.proposal_id,
        envelope_hash: input.envelope_hash,
      },
    });
    const updatedScope = await this.updateScopeState(
      input.scope_id,
      scope.state_version,
      "decomposition_approved",
      { ...ctx, reason: ctx.reason ?? "spec_dag_human_approved" },
    );
    return { scope: updatedScope, proposal: updatedProposal };
  }

  async commitDecompositionProposal(
    input: CommitDecompositionProposalInput,
    ctx: ActorContext,
  ): Promise<{
    readonly scope: Scope;
    readonly proposal: DecompositionProposal;
    readonly tasks: readonly Task[];
    readonly dependencies: readonly TaskDependency[];
  }> {
    const scope = await this.lockScopeRow(input.scope_id);
    if (!scope) {
      throw new RepositoryError(
        "NOT_FOUND",
        `scope not found: ${input.scope_id}`,
        {
          scope_id: input.scope_id,
        },
      );
    }
    if (scope.state_version !== input.expected_scope_state_version) {
      throw new RepositoryError(
        "STATE_VERSION_MISMATCH",
        `scope ${input.scope_id}: expected state_version=${input.expected_scope_state_version}, got ${scope.state_version}`,
        {
          scope_id: input.scope_id,
          expected: input.expected_scope_state_version,
          actual: scope.state_version,
        },
      );
    }
    if (scope.state !== "decomposition_approved") {
      throw new RepositoryError(
        "INVALID_SCOPE_STATE",
        "scope is not approved for DAG commit",
        {
          scope_id: input.scope_id,
          state: scope.state,
        },
      );
    }
    const proposalRow = await this.lockDecompositionProposalRow(
      input.scope_id,
      input.proposal_id,
    );
    if (!proposalRow) {
      throw new RepositoryError(
        "NOT_FOUND",
        "decomposition proposal not found",
        {
          scope_id: input.scope_id,
          proposal_id: input.proposal_id,
        },
      );
    }
    const proposal = mapDecompositionProposal(proposalRow);
    if (proposal.envelope_hash !== input.envelope_hash) {
      throw new RepositoryError(
        "STALE_DECOMPOSITION_ENVELOPE",
        "decomposition envelope hash mismatch",
        {
          expected: proposal.envelope_hash,
          actual: input.envelope_hash,
        },
      );
    }
    if (proposal.status !== "human_approved") {
      throw new RepositoryError(
        "DECOMPOSITION_NOT_APPROVED",
        "proposal needs human approval before commit",
        {
          status: proposal.status,
        },
      );
    }
    const { rows: existingTasks } = await queryRows<{ id: string }>(
      this.client,
      `SELECT id FROM tasks WHERE scope_id = $1 LIMIT 1`,
      [input.scope_id],
    );
    if (existingTasks.length > 0) {
      throw new RepositoryError(
        "DAG_ALREADY_COMMITTED",
        "scope already has task rows",
        {
          scope_id: input.scope_id,
        },
      );
    }

    const primaryTarget = await this.primaryScopeTarget(input.scope_id);
    const tasks: Task[] = [];
    for (const proposed of proposal.proposed_tasks) {
      const task = await this.createTask(
        {
          id: proposed.proposed_task_id,
          scope_id: input.scope_id,
          title: proposed.title,
          description: proposed.description,
          acceptance_criteria: proposed.acceptance_criteria,
          non_goals: proposed.non_goals ?? [],
          state: "ready",
        },
        { ...ctx, reason: "decomposition_commit" },
      );
      tasks.push(task);
      const projectId =
        proposal.target_project_mapping[task.id] ?? primaryTarget;
      if (!projectId) {
        throw new RepositoryError(
          "MISSING_TASK_TARGET",
          "committed task has no provider project target",
          {
            task_id: task.id,
          },
        );
      }
      await this.linkTaskTarget(task.id, projectId as ProviderProjectId);
    }

    const dependencies: TaskDependency[] = [];
    for (const dep of proposal.proposed_dependencies) {
      dependencies.push(
        await this.addDependency(dep.from_task_id, dep.to_task_id, dep.kind, {
          ...ctx,
          reason: "decomposition_commit",
        }),
      );
    }

    const { rows } = await queryRows<DecompositionProposalRow>(
      this.client,
      `UPDATE decomposition_proposals
       SET status = 'committed',
           committed_at = now(),
           updated_at = now()
       WHERE scope_id = $1 AND id = $2
       RETURNING *`,
      [input.scope_id, input.proposal_id],
    );
    await this.closeSpecDagGate(input.scope_id);
    await this.writeAudit({
      scope_id: input.scope_id,
      actor: ctx.actor,
      action: "decomposition.committed",
      capability: ctx.capability,
      target_kind: "decomposition_proposal",
      target_id: input.proposal_id,
      reason: ctx.reason,
      evidence: {
        task_ids: tasks.map((task) => task.id),
        dependency_count: dependencies.length,
        envelope_hash: input.envelope_hash,
      },
    });
    const activeScope = await this.updateScopeState(
      input.scope_id,
      scope.state_version,
      "active",
      { ...ctx, reason: ctx.reason ?? "decomposition_committed" },
    );
    return {
      scope: activeScope,
      proposal: mapDecompositionProposal(rows[0]),
      tasks,
      dependencies,
    };
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

  private async lockScopeRow(scope_id: ScopeId): Promise<ScopeRow | undefined> {
    const { rows } = await queryRows<ScopeRow>(
      this.client,
      `SELECT * FROM scopes WHERE id = $1 FOR UPDATE`,
      [scope_id],
    );
    return rows[0];
  }

  private async lockDecompositionProposalRow(
    scope_id: ScopeId,
    proposal_id: string,
  ): Promise<DecompositionProposalRow | undefined> {
    const { rows } = await queryRows<DecompositionProposalRow>(
      this.client,
      `SELECT * FROM decomposition_proposals
       WHERE scope_id = $1 AND id = $2
       FOR UPDATE`,
      [scope_id, proposal_id],
    );
    return rows[0];
  }

  private async openSpecDagGate(scope_id: ScopeId): Promise<void> {
    const existing = await queryRows<{ id: string }>(
      this.client,
      `SELECT id FROM gates
       WHERE scope_id = $1
         AND task_id IS NULL
         AND kind = 'spec_dag'
         AND status IN ('pending', 'open')
       LIMIT 1`,
      [scope_id],
    );
    if (existing.rows.length > 0) return;
    await queryRows(
      this.client,
      `INSERT INTO gates
         (id, scope_id, task_id, kind, status, required_approvals, opened_at)
       VALUES ($1, $2, NULL, 'spec_dag', 'open', $3, now())`,
      [`gate-${randomUUID()}`, scope_id, ["human"]],
    );
  }

  private async closeSpecDagGate(scope_id: ScopeId): Promise<void> {
    await queryRows(
      this.client,
      `UPDATE gates
       SET status = 'closed',
           closed_at = now()
       WHERE scope_id = $1
         AND task_id IS NULL
         AND kind = 'spec_dag'
         AND status IN ('pending', 'open')`,
      [scope_id],
    );
  }

  private async primaryScopeTarget(
    scope_id: ScopeId,
  ): Promise<ProviderProjectId | undefined> {
    const { rows } = await queryRows<{ provider_project_id: string }>(
      this.client,
      `SELECT provider_project_id FROM scope_targets
       WHERE scope_id = $1 AND role = 'primary'`,
      [scope_id],
    );
    return rows[0]?.provider_project_id as ProviderProjectId | undefined;
  }

  private async linkTaskTarget(
    task_id: TaskId,
    provider_project_id: ProviderProjectId,
  ): Promise<void> {
    await queryRows(
      this.client,
      `INSERT INTO task_targets (id, task_id, provider_project_id, role)
       VALUES ($1, $2, $3, 'primary')
       ON CONFLICT ON CONSTRAINT task_targets_project_unique DO NOTHING`,
      [randomUUID(), task_id, provider_project_id],
    );
  }
}

// ---------------------------------------------------------------------------
// Small typed query helper.
// ---------------------------------------------------------------------------

function validateDecomposition(input: SubmitDecompositionProposalInput): void {
  if (input.proposed_tasks.length === 0) {
    throw new RepositoryError(
      "EMPTY_DECOMPOSITION",
      "decomposition has no tasks",
      {
        scope_id: input.scope_id,
      },
    );
  }
  const ids = new Set<string>();
  for (const task of input.proposed_tasks) {
    if (ids.has(task.proposed_task_id)) {
      throw new RepositoryError(
        "DUPLICATE_TASK_ID",
        "decomposition repeats a task id",
        {
          task_id: task.proposed_task_id,
        },
      );
    }
    ids.add(task.proposed_task_id);
    if (!task.proposed_task_id.startsWith(`${input.scope_id}.`)) {
      throw new RepositoryError(
        "TASK_SCOPE_MISMATCH",
        "proposed task id does not belong to scope",
        {
          scope_id: input.scope_id,
          task_id: task.proposed_task_id,
        },
      );
    }
    if (task.acceptance_criteria.length === 0) {
      throw new RepositoryError(
        "MISSING_ACCEPTANCE_CRITERIA",
        "proposed task has no acceptance criteria",
        {
          task_id: task.proposed_task_id,
        },
      );
    }
  }
  for (const dep of input.proposed_dependencies) {
    if (!ids.has(dep.from_task_id) || !ids.has(dep.to_task_id)) {
      throw new RepositoryError(
        "UNKNOWN_DEPENDENCY_TASK",
        "dependency references a task outside the proposal",
        {
          from_task_id: dep.from_task_id,
          to_task_id: dep.to_task_id,
        },
      );
    }
    if (dep.from_task_id === dep.to_task_id) {
      throw new RepositoryError(
        "SELF_DEPENDENCY",
        "dependency cannot point at the same task",
        {
          task_id: dep.from_task_id,
        },
      );
    }
  }
  for (const taskId of Object.keys(input.target_project_mapping ?? {})) {
    if (!ids.has(taskId)) {
      throw new RepositoryError(
        "UNKNOWN_TARGET_TASK",
        "target mapping references a task outside the proposal",
        {
          task_id: taskId,
        },
      );
    }
  }
}

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
