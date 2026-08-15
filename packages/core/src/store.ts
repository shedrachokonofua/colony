import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  DomainStateError,
  domainError,
  type ScopeId,
  type TaskId,
} from "@colony/domain";
import type { ArchitectDecompositionV2 } from "@colony/schemas";
import {
  assertScopeTransition,
  assertTaskTransition,
  type ScopeStatus,
  type TaskState,
} from "./state-machine.js";

export interface Scope {
  readonly id: ScopeId;
  readonly goal: string;
  readonly status: ScopeStatus;
  readonly provider_project_id: string;
  readonly provider_project_path: string;
  readonly default_branch: string;
  readonly plan_json: string | null;
  readonly blocked_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Task {
  readonly id: TaskId;
  readonly scope_id: ScopeId;
  readonly title: string;
  readonly spec: string;
  readonly state: TaskState;
  readonly state_version: number;
  readonly branch: string | null;
  readonly mr_iid: number | null;
  readonly attempt: number;
  readonly next_retry_at: string | null;
  readonly blocked_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Run {
  readonly id: string;
  readonly scope_id: ScopeId;
  readonly task_id: TaskId | null;
  readonly kind: "architect" | "implement" | "merge_gate";
  readonly status: "running" | "succeeded" | "failed" | "canceled";
  readonly lease_expires_at: string;
  readonly base_sha: string | null;
  readonly head_sha: string | null;
  readonly workspace_path: string | null;
  readonly envelope_json: string | null;
  readonly evidence_json: string | null;
  readonly error: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

export interface AuditRow {
  readonly id: number;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly scope_id: string | null;
  readonly task_id: string | null;
  readonly run_id: string | null;
  readonly detail_json: string;
}

export interface TaskTransitionPatch {
  readonly branch?: string | null;
  readonly mr_iid?: number | null;
  readonly blocked_reason?: string | null;
  readonly attempt?: number;
  readonly next_retry_at?: string | null;
}

export interface AuditFilter {
  readonly scope_id?: string;
  readonly task_id?: string;
  readonly limit?: number;
}

export interface CreateScopeInput {
  readonly goal: string;
  readonly provider_project_id: string;
  readonly provider_project_path: string;
  readonly default_branch?: string;
}

const SCHEMA_SQL = readFileSync(
  new URL("./schema.sql", import.meta.url),
  "utf8",
);

export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

export class Store {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------
  // Scopes
  // ---------------------------------------------------------------------

  createScope(input: CreateScopeInput): Scope {
    const id = `col-${randomBytes(4).toString("hex")}` as ScopeId;
    this.db
      .prepare(
        `INSERT INTO scopes (id, goal, status, provider_project_id, provider_project_path, default_branch)
         VALUES (@id, @goal, 'draft', @provider_project_id, @provider_project_path, @default_branch)`,
      )
      .run({
        id,
        goal: input.goal,
        provider_project_id: input.provider_project_id,
        provider_project_path: input.provider_project_path,
        default_branch: input.default_branch ?? "main",
      });
    const scope = this.getScope(id);
    if (!scope) throw new Error(`scope insert lost: ${id}`);
    return scope;
  }

  getScope(id: ScopeId | string): Scope | undefined {
    return this.db.prepare(`SELECT * FROM scopes WHERE id = ?`).get(id) as
      | Scope
      | undefined;
  }

  listScopes(): Scope[] {
    return this.db
      .prepare(`SELECT * FROM scopes ORDER BY created_at`)
      .all() as Scope[];
  }

  setScopeStatus(
    id: ScopeId | string,
    status: ScopeStatus,
    actor: string,
    detail?: Record<string, unknown>,
  ): Scope {
    const apply = this.db.transaction(() => {
      const scope = this.getScope(id);
      if (!scope) {
        throw new DomainStateError(
          domainError("UNKNOWN_SCOPE_STATE", `unknown scope: ${id}`, { id }),
        );
      }
      assertScopeTransition(scope.status, status);
      const blocked_reason =
        status === "blocked"
          ? ((detail?.blocked_reason as string | undefined) ??
            scope.blocked_reason)
          : null;
      this.db
        .prepare(
          `UPDATE scopes SET status = @status, blocked_reason = @blocked_reason,
           updated_at = @now WHERE id = @id`,
        )
        .run({ id: scope.id, status, blocked_reason, now: nowIso() });
      this.audit(actor, "scope.transition", {
        scope_id: scope.id,
        detail: { from: scope.status, to: status, ...detail },
      });
    });
    apply();
    const scope = this.getScope(id);
    if (!scope) throw new Error(`scope lost after transition: ${id}`);
    return scope;
  }

  setScopePlan(id: ScopeId | string, planJson: string): void {
    this.db
      .prepare(`UPDATE scopes SET plan_json = ?, updated_at = ? WHERE id = ?`)
      .run(planJson, nowIso(), id);
  }

  /**
   * Materialize an approved architect decomposition: create tasks + deps
   * and move the scope planning -> active. Returns tasks in index order.
   */
  materializePlan(
    scopeId: ScopeId | string,
    plan: ArchitectDecompositionV2,
    actor: string,
  ): Task[] {
    const scope = this.getScope(scopeId);
    if (!scope) {
      throw new DomainStateError(
        domainError("UNKNOWN_SCOPE_STATE", `unknown scope: ${scopeId}`, {
          id: scopeId,
        }),
      );
    }
    assertScopeTransition(scope.status, "active");

    const ids: TaskId[] = plan.tasks.map(
      (_, index) => `${scope.id}.${index + 1}` as TaskId,
    );
    for (const [index, task] of plan.tasks.entries()) {
      for (const dep of task.depends_on) {
        if (dep < 0 || dep >= plan.tasks.length || dep === index) {
          throw new Error(`task ${index} depends_on invalid index ${dep}`);
        }
      }
    }
    assertAcyclic(plan.tasks.map((task) => task.depends_on));

    const insertTask = this.db.prepare(
      `INSERT INTO tasks (id, scope_id, title, spec, state) VALUES (?, ?, ?, ?, 'queued')`,
    );
    const insertDep = this.db.prepare(
      `INSERT INTO task_deps (task_id, depends_on_task_id) VALUES (?, ?)`,
    );
    const apply = this.db.transaction(() => {
      for (const [index, task] of plan.tasks.entries()) {
        insertTask.run(ids[index], scope.id, task.title, task.spec);
        for (const dep of task.depends_on) {
          insertDep.run(ids[index], ids[dep]);
        }
      }
      this.db
        .prepare(
          `UPDATE scopes SET status = 'active', updated_at = ? WHERE id = ?`,
        )
        .run(nowIso(), scope.id);
      this.audit(actor, "scope.plan_materialized", {
        scope_id: scope.id,
        detail: { task_count: plan.tasks.length },
      });
    });
    apply();
    return ids.map((taskId) => this.getTask(taskId)!);
  }

  // ---------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------

  getTask(id: TaskId | string): Task | undefined {
    return this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
      | Task
      | undefined;
  }

  listTasks(scopeId: ScopeId | string): Task[] {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE scope_id = ? ORDER BY id`)
      .all(scopeId) as Task[];
  }

  taskDeps(taskId: TaskId | string): TaskId[] {
    return (
      this.db
        .prepare(`SELECT depends_on_task_id FROM task_deps WHERE task_id = ?`)
        .all(taskId) as { depends_on_task_id: TaskId }[]
    ).map((row) => row.depends_on_task_id);
  }

  /** All dependency edges among a scope's tasks. */
  scopeDeps(
    scopeId: ScopeId | string,
  ): { task_id: TaskId; depends_on_task_id: TaskId }[] {
    return this.db
      .prepare(
        `SELECT d.task_id, d.depends_on_task_id FROM task_deps d
         JOIN tasks t ON t.id = d.task_id WHERE t.scope_id = ? ORDER BY d.task_id`,
      )
      .all(scopeId) as { task_id: TaskId; depends_on_task_id: TaskId }[];
  }

  /** Clear the retry backoff on a queued task so it dispatches immediately. */
  clearRetryDelay(taskId: TaskId | string): void {
    this.db
      .prepare(
        `UPDATE tasks SET next_retry_at = NULL, updated_at = ? WHERE id = ? AND state = 'queued'`,
      )
      .run(nowIso(), taskId);
  }

  transitionTask(
    id: TaskId | string,
    expectedVersion: number,
    to: TaskState,
    actor: string,
    patch?: TaskTransitionPatch,
  ): Task {
    const task = this.getTask(id);
    if (!task) {
      throw new DomainStateError(
        domainError("UNKNOWN_TASK_STATE", `unknown task: ${id}`, { id }),
      );
    }
    if (task.state_version !== expectedVersion) {
      throw new DomainStateError(
        domainError(
          "STATE_VERSION_MISMATCH",
          `task ${id}: expected state_version ${expectedVersion}, found ${task.state_version}`,
          { id, expectedVersion, found: task.state_version },
        ),
      );
    }
    assertTaskTransition(task.state, to);

    const blocked_reason =
      to === "blocked"
        ? (patch?.blocked_reason ?? task.blocked_reason ?? "blocked")
        : to === "queued" && task.state === "blocked"
          ? null
          : (patch?.blocked_reason ??
            (to === "queued" ? null : task.blocked_reason));
    const attempt =
      patch?.attempt ??
      (to === "queued" && task.state === "blocked" ? 0 : task.attempt);
    const next_retry_at =
      patch?.next_retry_at !== undefined
        ? patch.next_retry_at
        : to === "queued" && task.state === "blocked"
          ? null
          : task.next_retry_at;
    const branch = patch?.branch ?? task.branch;
    const mr_iid = patch?.mr_iid ?? task.mr_iid;

    const apply = this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE tasks SET state = @state, state_version = state_version + 1,
           branch = @branch, mr_iid = @mr_iid, attempt = @attempt,
           next_retry_at = @next_retry_at, blocked_reason = @blocked_reason,
           updated_at = @now
           WHERE id = @id AND state_version = @expectedVersion`,
        )
        .run({
          id: task.id,
          expectedVersion,
          state: to,
          branch,
          mr_iid,
          attempt,
          next_retry_at,
          blocked_reason,
          now: nowIso(),
        });
      if (updated.changes !== 1) {
        throw new DomainStateError(
          domainError(
            "STATE_VERSION_MISMATCH",
            `task ${id}: concurrent state write`,
            { id },
          ),
        );
      }
      this.audit(actor, "task.transition", {
        scope_id: task.scope_id,
        task_id: task.id,
        detail: { from: task.state, to },
      });
    });
    apply();
    const next = this.getTask(id);
    if (!next) throw new Error(`task lost after transition: ${id}`);
    return next;
  }

  /**
   * Tasks dispatchable now: queued, all dependencies merged, retry time
   * elapsed, and the owning scope active.
   */
  readyTasks(scopeId?: ScopeId | string): Task[] {
    const now = nowIso();
    const sql = `SELECT t.* FROM tasks t
       JOIN scopes s ON s.id = t.scope_id
       WHERE t.state = 'queued'
         AND s.status = 'active'
         AND (t.next_retry_at IS NULL OR t.next_retry_at <= @now)
         AND NOT EXISTS (
           SELECT 1 FROM task_deps d JOIN tasks dep ON dep.id = d.depends_on_task_id
           WHERE d.task_id = t.id AND dep.state <> 'merged'
         )
         ${scopeId ? "AND t.scope_id = @scopeId" : ""}
       ORDER BY t.id`;
    const params: Record<string, unknown> = { now };
    if (scopeId) params.scopeId = scopeId;
    return this.db.prepare(sql).all(params) as Task[];
  }

  // ---------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------

  startRun(input: {
    scope_id: ScopeId | string;
    task_id?: TaskId | string | null;
    kind: Run["kind"];
    lease_ttl_ms: number;
    base_sha?: string;
    workspace_path?: string;
  }): Run {
    const id = crypto.randomUUID();
    const lease = new Date(Date.now() + input.lease_ttl_ms).toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (id, scope_id, task_id, kind, status, lease_expires_at, base_sha, workspace_path)
         VALUES (@id, @scope_id, @task_id, @kind, 'running', @lease, @base_sha, @workspace_path)`,
      )
      .run({
        id,
        scope_id: input.scope_id,
        task_id: input.task_id ?? null,
        kind: input.kind,
        lease,
        base_sha: input.base_sha ?? null,
        workspace_path: input.workspace_path ?? null,
      });
    const run = this.getRun(id);
    if (!run) throw new Error(`run insert lost: ${id}`);
    return run;
  }

  getRun(id: string): Run | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
      | Run
      | undefined;
  }

  heartbeatRun(runId: string, lease_ttl_ms: number): void {
    const lease = new Date(Date.now() + lease_ttl_ms).toISOString();
    this.db
      .prepare(
        `UPDATE runs SET lease_expires_at = ? WHERE id = ? AND status = 'running'`,
      )
      .run(lease, runId);
  }

  finishRun(
    runId: string,
    status: "succeeded" | "failed" | "canceled",
    patch: {
      head_sha?: string;
      envelope_json?: string;
      evidence_json?: string;
      error?: string;
    } = {},
  ): Run {
    this.db
      .prepare(
        `UPDATE runs SET status = @status, head_sha = @head_sha,
         envelope_json = @envelope_json, evidence_json = @evidence_json,
         error = @error, finished_at = @now
         WHERE id = @id AND status = 'running'`,
      )
      .run({
        id: runId,
        status,
        head_sha: patch.head_sha ?? null,
        envelope_json: patch.envelope_json ?? null,
        evidence_json: patch.evidence_json ?? null,
        error: patch.error ?? null,
        now: nowIso(),
      });
    const run = this.getRun(runId);
    if (!run) throw new Error(`run lost after finish: ${runId}`);
    return run;
  }

  /** Fail running runs whose lease expired; returns the expired runs. */
  expireDeadLeases(now: Date): Run[] {
    const expired = this.db
      .prepare(
        `SELECT * FROM runs WHERE status = 'running' AND lease_expires_at < ?`,
      )
      .all(now.toISOString()) as Run[];
    for (const run of expired) {
      this.finishRun(run.id, "failed", { error: "lease_expired" });
    }
    return expired;
  }

  /**
   * Fail every in-flight run. A previous process's work cannot still be
   * executing after this process opened the DB (single-process colonyd).
   */
  expireOrphanedRuns(): Run[] {
    const orphans = this.db
      .prepare(`SELECT * FROM runs WHERE status = 'running'`)
      .all() as Run[];
    for (const run of orphans) {
      this.finishRun(run.id, "failed", { error: "process_restart" });
    }
    return orphans;
  }

  activeRunCount(kind?: Run["kind"]): number {
    const row = kind
      ? (this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM runs WHERE status = 'running' AND kind = ?`,
          )
          .get(kind) as { n: number })
      : (this.db
          .prepare(`SELECT COUNT(*) AS n FROM runs WHERE status = 'running'`)
          .get() as { n: number });
    return row.n;
  }

  activeRuns(kind?: Run["kind"]): Run[] {
    return (
      kind
        ? this.db
            .prepare(
              `SELECT * FROM runs WHERE status = 'running' AND kind = ? ORDER BY started_at`,
            )
            .all(kind)
        : this.db
            .prepare(
              `SELECT * FROM runs WHERE status = 'running' ORDER BY started_at`,
            )
            .all()
    ) as Run[];
  }

  runsForTask(taskId: TaskId | string): Run[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY started_at`)
      .all(taskId) as Run[];
  }

  runsForScope(scopeId: ScopeId | string): Run[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE scope_id = ? ORDER BY started_at`)
      .all(scopeId) as Run[];
  }

  latestRun(
    scopeId: ScopeId | string,
    kind: Run["kind"],
    taskId?: TaskId | string | null,
  ): Run | undefined {
    return this.db
      .prepare(
        `SELECT * FROM runs WHERE scope_id = @scopeId AND kind = @kind
         AND (@taskId IS NULL OR task_id = @taskId)
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get({ scopeId, kind, taskId: taskId ?? null }) as Run | undefined;
  }

  // ---------------------------------------------------------------------
  // Observations + audit
  // ---------------------------------------------------------------------

  /** INSERT OR IGNORE; false when the dedup key already existed. */
  recordObservation(
    kind: "webhook" | "poll",
    dedupKey: string,
    payloadJson: string,
    taskId?: TaskId | string,
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO observations (kind, dedup_key, task_id, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(kind, dedupKey, taskId ?? null, payloadJson);
    return result.changes > 0;
  }

  audit(
    actor: string,
    action: string,
    refs: {
      scope_id?: ScopeId | string | null;
      task_id?: TaskId | string | null;
      run_id?: string | null;
      detail?: Record<string, unknown>;
    } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit (actor, action, scope_id, task_id, run_id, detail_json)
         VALUES (@actor, @action, @scope_id, @task_id, @run_id, @detail_json)`,
      )
      .run({
        actor,
        action,
        scope_id: refs.scope_id ?? null,
        task_id: refs.task_id ?? null,
        run_id: refs.run_id ?? null,
        detail_json: JSON.stringify(refs.detail ?? {}),
      });
  }

  listAudit(filter: AuditFilter = {}): AuditRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {
      scopeId: filter.scope_id ?? null,
      taskId: filter.task_id ?? null,
    };
    if (filter.scope_id) clauses.push(`scope_id = @scopeId`);
    if (filter.task_id) clauses.push(`task_id = @taskId`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM audit ${where} ORDER BY id DESC LIMIT ${Math.max(1, Math.min(filter.limit ?? 200, 1000))}`,
      )
      .all(params) as AuditRow[];
  }
}

/** Reject cyclic depends_on graphs (Kahn's algorithm). */
function assertAcyclic(deps: ReadonlyArray<readonly number[]>): void {
  const indegree = deps.map((edges) => edges.length);
  const queue: number[] = [];
  indegree.forEach((degree, node) => {
    if (degree === 0) queue.push(node);
  });
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited += 1;
    deps.forEach((edges, target) => {
      if (edges.includes(node)) {
        indegree[target] -= 1;
        if (indegree[target] === 0) queue.push(target);
      }
    });
  }
  if (visited !== deps.length) {
    throw new Error("plan dependency graph is cyclic");
  }
}
