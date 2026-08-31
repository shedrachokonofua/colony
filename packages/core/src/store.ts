import { randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database, type SQLQueryBindings } from "./sqlite-compat.js";
import { migrate } from "./migrations.js";
import {
  DomainStateError,
  domainError,
  type DomainErrorCode,
  type ScopeId,
  type TaskId,
} from "@colony/domain";
import type {
  ArchitectDecompositionV2,
  TaskCostModelV1,
} from "@colony/schemas";
import {
  SCOPE_STATUSES,
  assertScopeTransition,
  assertTaskTransition,
  type ScopeStatus,
  type TaskState,
} from "./state-machine.js";
import {
  DEFAULT_IMPLEMENTER_BUDGET_MS,
  buildTaskCostModel,
  predictTaskCost,
} from "./task-cost.js";

export interface Project {
  readonly name: string;
  readonly context_doc: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** A project row plus honest whole-table scope tallies. */
export interface ProjectWithCounts extends Project {
  readonly scope_count: number;
  /** Every SCOPE_STATUSES key is present; statuses with no scopes are 0. */
  readonly status_counts: Record<ScopeStatus, number>;
  readonly last_activity_at: string | null;
  /** Number of curated reference files in this project. */
  readonly file_count: number;
  /** Total bytes of curated reference files (0 when none). */
  readonly file_bytes: number;
  /** Distinct connected repositories, derived from scopes only. */
  readonly repositories: readonly ProjectRepository[];
}

export interface ProjectFile {
  readonly id: string;
  readonly project_name: string;
  readonly filename: string;
  readonly media_type: "text/plain" | "text/markdown";
  readonly content: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** A project file row with content omitted (list/detail views). */
export interface ProjectFileMeta {
  readonly id: string;
  readonly filename: string;
  readonly media_type: "text/plain" | "text/markdown";
  readonly byte_size: number;
  readonly sha256: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProjectRepository {
  readonly repo_id: string;
  readonly repo_path: string;
}

export interface Scope {
  readonly id: ScopeId;
  readonly goal: string;
  readonly title: string | null;
  readonly project_name: string | null;
  readonly approvals: ScopeApprovals;
  readonly plan_feedback: string | null;
  readonly status: ScopeStatus;
  readonly provider_repo_id: string;
  readonly provider_repo_path: string;
  readonly default_branch: string;
  readonly plan_json: string | null;
  readonly blocked_reason: string | null;
  readonly acceptance_json: string | null;
  readonly extension_rounds: number;
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
  readonly merge_approved_sha: string | null;
  readonly human_feedback: string | null;
  /** TaskCostPrediction v1 blob; written when a plan is materialized. */
  readonly cost_prediction_json: string | null;
}

export interface Run {
  readonly id: string;
  readonly scope_id: ScopeId;
  readonly task_id: TaskId | null;
  readonly kind:
    | "architect"
    | "implement"
    | "merge_gate"
    | "review"
    | "validate";
  readonly status: "running" | "succeeded" | "failed" | "canceled";
  readonly lease_expires_at: string;
  readonly base_sha: string | null;
  readonly head_sha: string | null;
  readonly workspace_path: string | null;
  readonly envelope_json: string | null;
  readonly evidence_json: string | null;
  readonly token_id: string | null;
  readonly model_id: string | null;
  /** Run root span's trace id; links spans recorded elsewhere to this run. */
  readonly trace_id: string | null;
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

export interface RunEvent {
  readonly id: number;
  readonly run_id: string;
  readonly at: string;
  readonly event: string;
  readonly detail_json: string;
}

/** One row of run_artifacts: durable, append-only artifact metadata. */
export interface RunArtifactRow {
  readonly id: string;
  readonly run_id: string;
  readonly kind: string;
  readonly key: string;
  readonly ref: string;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly content_type: string | null;
  readonly created_at: string;
}

/** Ascending-by-id cursor page; newest page by default. */
export interface RunEventPage {
  readonly events: RunEvent[];
  readonly has_more: boolean;
  readonly oldest_id: number | null;
  readonly newest_id: number | null;
}

/** Cursor page of audit rows, same envelope as RunEventPage. */
export interface AuditPage {
  readonly events: AuditRow[];
  readonly has_more: boolean;
  readonly oldest_id: number | null;
  readonly newest_id: number | null;
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
  readonly run_id?: string;
  readonly before_id?: number;
  readonly limit?: number;
}

export type ScopeApprovals = "auto" | "manual";

export interface CreateScopeInput {
  readonly goal: string;
  readonly title?: string;
  /** Name of the (created-on-demand) project this scope belongs to. */
  readonly project?: string;
  readonly approvals?: ScopeApprovals;
  readonly provider_repo_id: string;
  readonly provider_repo_path: string;
  readonly default_branch?: string;
}
export interface AppendTaskInput {
  readonly title: string;
  readonly spec: string;
  /** Numeric refs index appended tasks; strings are existing task ids. */
  readonly depends_on?: readonly (number | string)[];
}

export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

/** `pf-` + 12 lowercase hex, matching the `col-<hex>` id style. */
export function projectFileId(): string {
  return `pf-${randomBytes(6).toString("hex")}`;
}

/** `ra-` + 12 lowercase hex, matching the `col-<hex>` id style. */
export function runArtifactId(): string {
  return `ra-${randomBytes(6).toString("hex")}`;
}

/** Lowercase hex sha256 of the UTF-8 content. */
export function sha256Hex(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(content, "utf8"))
    .digest("hex");
}

/** Byte length of the UTF-8 content. */
export function byteSize(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/**
 * bun:sqlite binds named parameters only when the object keys carry the
 * placeholder prefix, unlike better-sqlite3's bare keys.
 *
 * The driver types `run/get/all` as variadic positional binds; the named-object
 * form is legal at runtime but only expressible through `prepare`'s Params type
 * parameter, which every statement here would have to thread. Assert once at
 * this boundary instead.
 */
function named(values: Record<string, SQLQueryBindings>): SQLQueryBindings {
  const bound: Record<string, SQLQueryBindings> = {};
  for (const [key, value] of Object.entries(values)) bound[`@${key}`] = value;
  return bound as unknown as SQLQueryBindings;
}

/** Page sizes are caller-chosen but bounded: default 200, clamp 1..1000. */
function clampPageLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? 200, 1000));
}

export class Store {
  readonly db: InstanceType<typeof Database>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    // journal_mode persists in the file but is set here for fresh DBs;
    // foreign_keys is per-connection and MUST be set on every open.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------
  // Scopes
  // ---------------------------------------------------------------------

  createScope(input: CreateScopeInput): Scope {
    const id = `col-${randomBytes(4).toString("hex")}` as ScopeId;
    const apply = this.db.transaction(() => {
      if (input.project !== undefined) this.ensureProject(input.project);
      this.db
        .prepare(
          `INSERT INTO scopes (id, goal, title, project_name, status, approvals, provider_repo_id, provider_repo_path, default_branch)
           VALUES (@id, @goal, @title, @project_name, 'draft', @approvals, @provider_repo_id, @provider_repo_path, @default_branch)`,
        )
        .run(
          named({
            id,
            goal: input.goal,
            title: input.title ?? null,
            project_name: input.project ?? null,
            approvals: input.approvals ?? "auto",
            provider_repo_id: input.provider_repo_id,
            provider_repo_path: input.provider_repo_path,
            default_branch: input.default_branch ?? "main",
          }),
        );
    });
    apply();
    const scope = this.getScope(id);
    if (!scope) throw new Error(`scope insert lost: ${id}`);
    return scope;
  }

  // ---------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------

  getProject(name: string): ProjectWithCounts | undefined {
    const project = this.db
      .prepare(`SELECT * FROM projects WHERE name = ?`)
      .get(name) as Project | undefined;
    if (!project) return undefined;
    return this.enrichProjectFileStats(this.withScopeCounts([project]))[0];
  }

  listProjects(): Project[] {
    return this.db
      .prepare(`SELECT * FROM projects ORDER BY created_at`)
      .all() as Project[];
  }

  /**
   * One page of projects, most recently updated first; `total` counts the
   * whole table. Every row carries its whole-table scope tallies from a
   * single GROUP BY. Order is deterministic: updated_at DESC, then name ASC
   * as tiebreaker so rows with identical timestamps never shuffle pages.
   */
  pageProjects(
    limit: number,
    offset: number,
  ): { projects: ProjectWithCounts[]; total: number } {
    const rows = this.db
      .prepare(
        `SELECT * FROM projects ORDER BY updated_at DESC, name LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Project[];
    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM projects`)
      .get() as { n: number };
    return {
      projects: this.enrichProjectFileStats(this.withScopeCounts(rows)),
      total: n,
    };
  }

  /**
   * Attach whole-table scope tallies to project rows: one GROUP BY over
   * scopes serves every row, never N+1 queries or JS-side scope filtering.
   * status_counts is zero-filled so consumers never probe for missing keys,
   * and scope_count is its sum.
   */
  private withScopeCounts(projects: readonly Project[]): ProjectWithCounts[] {
    const rows = this.db
      .prepare(
        `SELECT project_name, status, COUNT(*) AS n, MAX(updated_at) AS last_activity_at
         FROM scopes
         WHERE project_name IS NOT NULL
         GROUP BY project_name, status`,
      )
      .all() as {
      project_name: string;
      status: ScopeStatus;
      n: number;
      last_activity_at: string | null;
    }[];
    const byName = new Map<string, Map<ScopeStatus, number>>();
    const lastActivity = new Map<string, string>();
    for (const { project_name, status, n, last_activity_at } of rows) {
      const perStatus = byName.get(project_name);
      if (perStatus) perStatus.set(status, n);
      else byName.set(project_name, new Map([[status, n]]));
      // Every status group contributes its own MAX; the project-wide
      // last_activity_at is the greatest of those (each scope belongs to
      // exactly one group, so this equals MAX(scopes.updated_at)).
      const current = lastActivity.get(project_name);
      if (
        last_activity_at !== null &&
        (current === undefined || last_activity_at > current)
      ) {
        lastActivity.set(project_name, last_activity_at);
      }
    }
    return projects.map((project) => {
      const perStatus = byName.get(project.name);
      const status_counts = Object.fromEntries(
        SCOPE_STATUSES.map((status) => [status, perStatus?.get(status) ?? 0]),
      ) as Record<ScopeStatus, number>;
      return {
        ...project,
        scope_count: Object.values(status_counts).reduce((a, b) => a + b, 0),
        status_counts,
        last_activity_at: lastActivity.get(project.name) ?? null,
        file_count: 0,
        file_bytes: 0,
        repositories: [] as readonly ProjectRepository[],
      };
    });
  }

  /**
   * Enrich project rows with file aggregate counts and repositories.
   */
  private enrichProjectFileStats(
    rows: readonly ProjectWithCounts[],
  ): ProjectWithCounts[] {
    if (rows.length === 0) return rows as ProjectWithCounts[];
    const names = rows.map((r) => r.name);
    const placeholders = names.map(() => "?").join(",");
    const fileAggs = this.db
      .prepare(
        `SELECT project_name, COUNT(*) AS cnt, COALESCE(SUM(byte_size),0) AS bytes FROM project_files WHERE project_name IN (${placeholders}) GROUP BY project_name`,
      )
      .all(...names) as { project_name: string; cnt: number; bytes: number }[];
    const fileByProject = new Map<string, { cnt: number; bytes: number }>();
    for (const row of fileAggs)
      fileByProject.set(row.project_name, { cnt: row.cnt, bytes: row.bytes });

    const scopeRows = this.db
      .prepare(
        `SELECT DISTINCT project_name, provider_repo_id, provider_repo_path FROM scopes WHERE project_name IN (${placeholders}) ORDER BY project_name, provider_repo_path`,
      )
      .all(...names) as {
      project_name: string;
      provider_repo_id: string;
      provider_repo_path: string;
    }[];
    const reposByProject = new Map<string, ProjectRepository[]>();
    for (const row of scopeRows) {
      const list = reposByProject.get(row.project_name) ?? [];
      list.push({
        repo_id: row.provider_repo_id,
        repo_path: row.provider_repo_path,
      });
      reposByProject.set(row.project_name, list);
    }

    return rows.map((project) => {
      const fileAgg = fileByProject.get(project.name);
      const projRepos = reposByProject.get(project.name) ?? [];
      return {
        ...project,
        file_count: fileAgg?.cnt ?? 0,
        file_bytes: fileAgg?.bytes ?? 0,
        repositories: projRepos,
      };
    }) as ProjectWithCounts[];
  }

  /**
   * Operator-authored background document for a project. Audited writes go
   * through the colonyd API, never here — callers own the audit row.
   */
  setProjectContext(name: string, doc: string | null): Project {
    this.db
      .prepare(
        `UPDATE projects SET context_doc = ?, updated_at = ? WHERE name = ?`,
      )
      .run(doc, nowIso(), name);
    const project = this.getProject(name);
    if (!project) throw new Error(`unknown project: ${name}`);
    return project;
  }

  /**
   * Idempotent insert-or-read. An existing row is never touched, so its
   * `updated_at` stays the creation timestamp.
   */
  ensureProject(name: string): Project {
    this.db
      .prepare(`INSERT OR IGNORE INTO projects (name) VALUES (@name)`)
      .run(named({ name }));
    const project = this.getProject(name);
    if (!project) throw new Error(`project insert lost: ${name}`);
    return project;
  }

  /**
   * Explicit project creation. Duplicate name throws DomainStateError → 409.
   */
  createProject(input: { name: string; context_doc: string | null }): Project {
    try {
      this.db
        .prepare(`INSERT INTO projects (name, context_doc) VALUES (?, ?)`)
        .run(input.name, input.context_doc);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        typeof (err as unknown as Record<string, unknown>).code === "string" &&
        String((err as unknown as Record<string, unknown>).code).startsWith(
          "SQLITE_CONSTRAINT",
        )
      ) {
        throw new DomainStateError(
          domainError(
            "DUPLICATE_PROJECT" as DomainErrorCode,
            `project already exists: ${input.name}`,
            { name: input.name },
          ),
        );
      }
      throw err;
    }
    const project = this.getProject(input.name);
    if (!project) throw new Error(`project insert lost: ${input.name}`);
    return project;
  }

  // ---------------------------------------------------------------------
  // Project Files
  // ---------------------------------------------------------------------

  /** Full file rows including content, ordered by filename; [] for unknown project. */
  listProjectFiles(projectName: string): readonly ProjectFile[] {
    const project = this.db
      .prepare(`SELECT 1 FROM projects WHERE name = ?`)
      .get(projectName);
    if (!project) return [];
    return this.db
      .prepare(
        `SELECT * FROM project_files WHERE project_name = ? ORDER BY filename`,
      )
      .all(projectName) as ProjectFile[];
  }

  /** Paginated file metadata (content omitted). Unknown project returns zero rows. */
  pageProjectFiles(
    projectName: string,
    limit: number,
    offset: number,
  ): { files: ProjectFileMeta[]; total: number } {
    const fileRows = this.db
      .prepare(
        `SELECT id, filename, media_type, byte_size, sha256, created_at, updated_at
         FROM project_files WHERE project_name = ? ORDER BY filename LIMIT ? OFFSET ?`,
      )
      .all(projectName, limit, offset) as ProjectFileMeta[];
    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM project_files WHERE project_name = ?`)
      .get(projectName) as { n: number };
    return { files: fileRows, total: n };
  }

  /** Create a new project file. Throws DomainStateError for unknown project or duplicate filename. */
  createProjectFile(input: {
    project_name: string;
    filename: string;
    media_type: "text/plain" | "text/markdown";
    content: string;
  }): ProjectFile {
    const project = this.db
      .prepare(`SELECT 1 FROM projects WHERE name = ?`)
      .get(input.project_name);
    if (!project) {
      throw new DomainStateError(
        domainError(
          "UNKNOWN_PROJECT" as DomainErrorCode,
          `unknown project: ${input.project_name}`,
          { project_name: input.project_name },
        ),
      );
    }
    const id = projectFileId();
    const hash = sha256Hex(input.content);
    const bsize = byteSize(input.content);
    try {
      this.db
        .prepare(
          `INSERT INTO project_files (id, project_name, filename, media_type, content, byte_size, sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.project_name,
          input.filename,
          input.media_type,
          input.content,
          bsize,
          hash,
        );
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        typeof (err as unknown as Record<string, unknown>).code === "string" &&
        String((err as unknown as Record<string, unknown>).code).startsWith(
          "SQLITE_CONSTRAINT",
        )
      ) {
        throw new DomainStateError(
          domainError(
            "FILE_EXISTS" as DomainErrorCode,
            `file exists: ${input.filename}`,
            { filename: input.filename },
          ),
        );
      }
      throw err;
    }
    const file = this.db
      .prepare(`SELECT * FROM project_files WHERE id = ?`)
      .get(id) as ProjectFile | undefined;
    if (!file) throw new Error(`file insert lost: ${id}`);
    return file;
  }

  /** Replace file content and metadata (full replace). Unknown project or file → undefined. */
  replaceProjectFile(
    projectName: string,
    id: string,
    input: { media_type: "text/plain" | "text/markdown"; content: string },
  ): ProjectFile | undefined {
    const existing = this.db
      .prepare(`SELECT * FROM project_files WHERE id = ? AND project_name = ?`)
      .get(id, projectName) as ProjectFile | undefined;
    if (!existing) return undefined;
    const hash = sha256Hex(input.content);
    const bsize = byteSize(input.content);
    this.db
      .prepare(
        `UPDATE project_files SET media_type = ?, content = ?, byte_size = ?, sha256 = ?,
         updated_at = ? WHERE id = ?`,
      )
      .run(input.media_type, input.content, bsize, hash, nowIso(), id);
    const file = this.db
      .prepare(`SELECT * FROM project_files WHERE id = ?`)
      .get(id) as ProjectFile | undefined;
    if (!file) throw new Error(`file lost after replace: ${id}`);
    return file;
  }

  /** Delete a project file. Returns false when not found. */
  deleteProjectFile(projectName: string, id: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM project_files WHERE id = ? AND project_name = ?`)
      .run(id, projectName);
    return result.changes > 0;
  }

  /**
   * Distinct connected repositories for a project, derived from scopes only.
   * Returns [] for unknown project. Ordered by provider_repo_path.
   */
  projectRepositories(projectName: string): readonly ProjectRepository[] {
    return this.db
      .prepare(
        `SELECT DISTINCT provider_repo_id AS repo_id, provider_repo_path AS repo_path FROM scopes WHERE project_name = ? ORDER BY provider_repo_path`,
      )
      .all(projectName) as ProjectRepository[];
  }

  /**
   * Record human approval to merge a task at an exact head SHA. The merge
   * gate in manual-approvals scopes only dispatches when the approved SHA
   * matches the MR head observed this tick.
   */
  approveMerge(taskId: TaskId | string, headSha: string): Task {
    this.db
      .prepare(
        `UPDATE tasks SET merge_approved_sha = ?, updated_at = ? WHERE id = ?`,
      )
      .run(headSha, nowIso(), taskId);
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task lost after merge approval: ${taskId}`);
    return task;
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

  /**
   * One page of scopes, most recently touched first - the board's feed.
   * Optional `project` filters and paginates within one project name; `counts`
   * reports whole-table project sizes so page-local grouping can show honest
   * totals. `listScopes` stays unpaginated for internal full-table walks.
   */
  pageScopes(
    limit: number,
    offset: number,
    project?: string,
  ): {
    scopes: Scope[];
    total: number;
    projects: { project: string | null; n: number }[];
  } {
    const where = project === undefined ? "" : ` WHERE project_name = ?`;
    const args: (string | number)[] = project === undefined ? [] : [project];
    const scopes = this.db
      .prepare(
        `SELECT * FROM scopes${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Scope[];
    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM scopes${where}`)
      .get(...args) as { n: number };
    const projects = this.db
      .prepare(
        `SELECT project_name AS proj, COUNT(*) AS n FROM scopes GROUP BY project_name ORDER BY MAX(updated_at) DESC`,
      )
      .all() as { proj: string | null; n: number }[];
    return {
      scopes,
      total: n,
      projects: projects.map((p) => ({ project: p.proj, n: p.n })),
    };
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
        .run(named({ id: scope.id, status, blocked_reason, now: nowIso() }));
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

  /** Store the architect's proposed plan; consumes any pending feedback. */
  setScopePlan(id: ScopeId | string, planJson: string): void {
    this.db
      .prepare(
        `UPDATE scopes SET plan_json = ?, plan_feedback = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(planJson, nowIso(), id);
  }

  /**
   * Reject the proposed plan with feedback: the plan is cleared and the
   * next tick re-dispatches the architect with the feedback in its packet.
   */
  requestReplan(id: ScopeId | string, feedback: string): Scope {
    this.db
      .prepare(
        `UPDATE scopes SET plan_json = NULL, plan_feedback = ?, updated_at = ? WHERE id = ?`,
      )
      .run(feedback, nowIso(), id);
    const scope = this.getScope(id);
    if (!scope) throw new Error(`scope lost after replan request: ${id}`);
    return scope;
  }

  /**
   * Operator feedback for the next implement attempt; also revokes any
   * pending merge approval since the branch is about to change.
   */
  setTaskFeedback(taskId: TaskId | string, feedback: string): Task {
    this.db
      .prepare(
        `UPDATE tasks SET human_feedback = ?, merge_approved_sha = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(feedback, nowIso(), taskId);
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task lost after feedback: ${taskId}`);
    return task;
  }
  /**
   * Append an operator amendment to the task spec. Amendments are part of
   * the shared spec every role reads (implementer, reviewer), which is what
   * keeps operator requirements from diverging between roles.
   */
  amendTaskSpec(taskId: TaskId | string, amendment: string): Task {
    this.db
      .prepare(`UPDATE tasks SET spec = spec || ?, updated_at = ? WHERE id = ?`)
      .run(
        `\n\n## Spec amendment (operator, authoritative)\n${amendment}`,
        nowIso(),
        taskId,
      );
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task lost after spec amendment: ${taskId}`);
    return task;
  }

  /**
   * Replace a scope's acceptance criteria. Operator-only surface: criteria
   * are authored at scope creation, and the factory can migrate the tree
   * underneath them (runtime swaps, substrate changes) - amendment must be
   * an audited API action rather than DB surgery.
   */
  setScopeAcceptance(
    scopeId: ScopeId | string,
    acceptance: ReadonlyArray<{ description: string; command: string }>,
  ): Scope {
    this.db
      .prepare(
        `UPDATE scopes SET acceptance_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(acceptance), nowIso(), scopeId);
    const scope = this.getScope(scopeId);
    if (!scope) {
      throw new Error(`scope lost after acceptance amendment: ${scopeId}`);
    }
    return scope;
  }

  /** Atomically consume one of the bounded architect repair rounds. */
  incrementExtensionRound(
    scopeId: ScopeId | string,
    maxRounds = 2,
  ): Scope | undefined {
    this.db
      .prepare(
        `UPDATE scopes SET extension_rounds = extension_rounds + 1,
         updated_at = ? WHERE id = ? AND extension_rounds < ?`,
      )
      .run(nowIso(), scopeId, maxRounds);
    return this.getScope(scopeId);
  }
  /**
   * Materialize an approved architect decomposition: create tasks + deps
   * and move the scope planning -> active. Returns tasks in index order.
   */
  materializePlan(
    scopeId: ScopeId | string,
    plan: ArchitectDecompositionV2,
    actor: string,

    budgetMs: number = DEFAULT_IMPLEMENTER_BUDGET_MS,
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

    // Offline heuristic over landed history only — never blocks planning:
    // an empty runs table yields a zero model and unflagged predictions.
    const costModel: TaskCostModelV1 = buildTaskCostModel(
      this.db
        .prepare(
          `SELECT * FROM runs WHERE status = 'succeeded' AND kind IN ('implement','merge_gate')`,
        )
        .all() as Run[],
    );

    const insertTask = this.db.prepare(
      `INSERT INTO tasks (id, scope_id, title, spec, state, cost_prediction_json)
       VALUES (?, ?, ?, ?, 'queued', ?)`,
    );
    const insertDep = this.db.prepare(
      `INSERT INTO task_deps (task_id, depends_on_task_id) VALUES (?, ?)`,
    );
    const apply = this.db.transaction(() => {
      for (const [index, task] of plan.tasks.entries()) {
        insertTask.run(
          ids[index],
          scope.id,
          task.title,
          task.spec,
          JSON.stringify(
            predictTaskCost(costModel, extractSpecPaths(task.spec), budgetMs),
          ),
        );
        for (const dep of task.depends_on) {
          insertDep.run(ids[index], ids[dep]);
        }
      }
      this.db
        .prepare(
          `UPDATE scopes SET status = 'active', acceptance_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify(plan.acceptance), nowIso(), scope.id);
      this.audit(actor, "scope.plan_materialized", {
        scope_id: scope.id,
        detail: {
          task_count: plan.tasks.length,
          acceptance_count: plan.acceptance.length,
        },
      });
    });
    apply();
    return ids.map((taskId) => this.getTask(taskId)!);
  }

  /**
   * Append an extension plan without replacing the existing DAG. Numeric
   * dependencies index the new tasks; string dependencies name existing ids.
   * Validation and insertion share one transaction so a rejected cycle cannot
   * leave a partial repair plan behind.
   */
  appendTasks(
    scopeId: ScopeId | string,
    tasks: readonly AppendTaskInput[],
    actor: string,
    acceptance?: readonly { description: string; command: string }[],
  ): Task[] {
    const scope = this.getScope(scopeId);
    if (!scope) throw new Error(`unknown scope: ${scopeId}`);
    assertScopeTransition(scope.status, "active");
    if (tasks.length === 0)
      throw new Error("extension must add at least one task");
    const existing = this.listTasks(scope.id);
    const maxNumber = existing.reduce((max, task) => {
      const suffix = Number(task.id.split(".").at(-1));
      return Number.isInteger(suffix) ? Math.max(max, suffix) : max;
    }, 0);
    const ids = tasks.map(
      (_, index) => `${scope.id}.${maxNumber + index + 1}` as TaskId,
    );
    const existingIds = new Set<string>(existing.map((task) => task.id));
    const deps = new Map<string, string[]>();
    for (const task of existing) deps.set(task.id, this.taskDeps(task.id));
    for (const [index, task] of tasks.entries()) {
      const resolved: string[] = [];
      for (const dependency of task.depends_on ?? []) {
        if (typeof dependency === "number") {
          if (
            !Number.isInteger(dependency) ||
            dependency < 0 ||
            dependency >= tasks.length ||
            dependency === index
          ) {
            throw new Error(
              `task ${index} depends_on invalid index ${dependency}`,
            );
          }
          resolved.push(ids[dependency]!);
        } else {
          if (!existingIds.has(dependency)) {
            throw new Error(
              `task ${index} depends_on unknown task ${dependency}`,
            );
          }
          resolved.push(dependency);
        }
      }
      deps.set(ids[index]!, resolved);
    }
    const remaining = new Set(deps.keys());
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const [node, nodeDeps] of deps) {
      indegree.set(node, nodeDeps.length);
      for (const prerequisite of nodeDeps) {
        const list = dependents.get(prerequisite) ?? [];
        list.push(node);
        dependents.set(prerequisite, list);
      }
    }
    while (remaining.size > 0) {
      const ready = [...remaining].filter(
        (node) => (indegree.get(node) ?? 0) === 0,
      );
      if (ready.length === 0) {
        throw new Error("extension dependency graph is cyclic");
      }
      for (const node of ready) remaining.delete(node);
      for (const node of ready) {
        for (const dependent of dependents.get(node) ?? []) {
          indegree.set(dependent, (indegree.get(dependent) ?? 1) - 1);
        }
      }
    }
    const insertTask = this.db.prepare(
      `INSERT INTO tasks (id, scope_id, title, spec, state)
       VALUES (?, ?, ?, ?, 'queued')`,
    );
    const insertDep = this.db.prepare(
      `INSERT INTO task_deps (task_id, depends_on_task_id) VALUES (?, ?)`,
    );
    const apply = this.db.transaction(() => {
      for (const [index, task] of tasks.entries()) {
        insertTask.run(ids[index], scope.id, task.title, task.spec);
        for (const dependency of deps.get(ids[index]!) ?? []) {
          insertDep.run(ids[index], dependency);
        }
      }
      this.db
        .prepare(
          `UPDATE scopes SET status = 'active',
           acceptance_json = COALESCE(?, acceptance_json),
           plan_json = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(
          acceptance ? JSON.stringify(acceptance) : null,
          nowIso(),
          scope.id,
        );
      this.audit(actor, "scope.extended", {
        scope_id: scope.id,
        detail: {
          task_count: tasks.length,
          acceptance_count: acceptance?.length,
        },
      });
    });
    apply();
    return ids.map((id) => this.getTask(id)!);
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
        .run(
          named({
            id: task.id,
            expectedVersion,
            state: to,
            branch,
            mr_iid,
            attempt,
            next_retry_at,
            blocked_reason,
            now: nowIso(),
          }),
        );
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
    const params: Record<string, SQLQueryBindings> = { now };
    if (scopeId) params.scopeId = String(scopeId);
    return this.db.prepare(sql).all(named(params)) as Task[];
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
    model_id?: string;
    trace_id?: string | null;
    /** Pre-minted id so a span started before the row can carry it. */
    id?: string;
  }): Run {
    const id = input.id ?? crypto.randomUUID();
    const lease = new Date(Date.now() + input.lease_ttl_ms).toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (id, scope_id, task_id, kind, status, lease_expires_at, base_sha, workspace_path, model_id, trace_id)
         VALUES (@id, @scope_id, @task_id, @kind, 'running', @lease, @base_sha, @workspace_path, @model_id, @trace_id)`,
      )
      .run(
        named({
          id,
          scope_id: input.scope_id,
          task_id: input.task_id ?? null,
          kind: input.kind,
          lease,
          base_sha: input.base_sha ?? null,
          workspace_path: input.workspace_path ?? null,
          model_id: input.model_id ?? null,
          trace_id: input.trace_id ?? null,
        }),
      );
    const run = this.getRun(id);
    if (!run) throw new Error(`run insert lost: ${id}`);
    return run;
  }

  getRun(id: string): Run | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
      | Run
      | undefined;
  }

  /** Persist the minted provider token id so crash-reap can revoke it. */
  setRunToken(runId: string, tokenId: string): void {
    this.db
      .prepare(
        `UPDATE runs SET token_id = ? WHERE id = ? AND status = 'running'`,
      )
      .run(tokenId, runId);
  }

  /** Backfill base_sha once it resolves (validate runs start before the provider round-trip). */
  setRunBaseSha(runId: string, baseSha: string): void {
    this.db
      .prepare(
        `UPDATE runs SET base_sha = ? WHERE id = ? AND status = 'running'`,
      )
      .run(baseSha, runId);
  }

  /** Record the model a run is doing work with (mid-run fallback may switch it). */
  setRunModel(runId: string, modelId: string): void {
    this.db
      .prepare(`UPDATE runs SET model_id = ? WHERE id = ?`)
      .run(modelId, runId);
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
    const finished = this.db
      .prepare(
        `UPDATE runs SET status = @status, head_sha = @head_sha,
         envelope_json = @envelope_json, evidence_json = @evidence_json,
         error = @error, finished_at = @now
         WHERE id = @id AND status = 'running'`,
      )
      .run(
        named({
          id: runId,
          status,
          head_sha: patch.head_sha ?? null,
          envelope_json: patch.envelope_json ?? null,
          evidence_json: patch.evidence_json ?? null,
          error: patch.error ?? null,
          now: nowIso(),
        }),
      );
    const run = this.getRun(runId);
    if (!run) throw new Error(`run lost after finish: ${runId}`);
    // Only a matched UPDATE moved the row to terminal. A no-op (the run was
    // already finished) must not append a second run.finished row that
    // contradicts the runs row's terminal status.
    if (finished.changes === 1) {
      this.audit("svc:colonyd", "run.finished", {
        run_id: run.id,
        scope_id: run.scope_id,
        task_id: run.task_id,
        detail: {
          run_id: run.id,
          status,
          ...(patch.error === undefined ? {} : { error: patch.error }),
        },
      });
    }
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

  /** Count in-flight runs attributed to a model. Follows runs.model_id as the fallback sink rewrites it. */
  activeRunCountByModel(modelId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE status = 'running' AND model_id = ?`,
      )
      .get(modelId) as { n: number };
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
      .get(named({ scopeId, kind, taskId: taskId ?? null })) as Run | undefined;
  }

  /** Append-only activity feed for a run (tool calls, limits, failures). */
  appendRunEvent(
    runId: string,
    event: string,
    detail?: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO run_events (run_id, event, detail_json) VALUES (?, ?, ?)`,
      )
      .run(runId, event, JSON.stringify(detail ?? {}));
  }

  /**
   * Run activity feed paginated at the store layer. Rows come back ascending
   * by id; with no cursor you get the newest `limit` rows (default 200, clamp
   * 1..1000). `before_id` is an exclusive cursor: only rows older than it are
   * considered, so paging `before_id: page.oldest_id` walks the feed backwards.
   */
  listRunEvents(
    runId: string,
    opts: { before_id?: number; limit?: number } = {},
  ): RunEventPage {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM run_events WHERE run_id = @runId
             AND (@beforeId IS NULL OR id < @beforeId)
           ORDER BY id DESC LIMIT @limit
         ) ORDER BY id`,
      )
      .all(
        named({
          runId,
          beforeId: opts.before_id ?? null,
          limit: clampPageLimit(opts.limit),
        }),
      ) as RunEvent[];
    return this.pageEnvelope(rows, () => {
      const oldest = rows[0]!.id;
      // bun:sqlite yields null (node:sqlite undefined) when no row matches;
      // accept neither as "a row was found".
      const row = this.db
        .prepare(
          `SELECT 1 AS one FROM run_events WHERE run_id = ? AND id < ? LIMIT 1`,
        )
        .get(runId, oldest) as { one: number } | null | undefined;
      return row !== null && row !== undefined;
    });
  }

  /**
   * Every event row of one name for a run, ascending by id, no limit —
   * provenance reads must not be truncated by the feed's page window.
   */
  listRunEventsByName(runId: string, event: string): RunEvent[] {
    return this.db
      .prepare(
        `SELECT * FROM run_events WHERE run_id = ? AND event = ? ORDER BY id`,
      )
      .all(runId, event) as RunEvent[];
  }

  // ---------------------------------------------------------------------
  // Run artifacts (append-only)
  // ---------------------------------------------------------------------

  /**
   * Record one artifact row after its bytes were stored via an
   * ArtifactStore. The table is append-only (triggers abort UPDATE/DELETE);
   * a re-upload of the same key appends a new row, never rewrites one.
   */
  recordRunArtifact(
    runId: string,
    input: {
      kind: string;
      key: string;
      ref: string;
      sha256?: string;
      bytes?: number;
      contentType?: string;
    },
  ): RunArtifactRow {
    const id = runArtifactId();
    this.db
      .prepare(
        `INSERT INTO run_artifacts (id, run_id, kind, key, ref, sha256, bytes, content_type)
         VALUES (@id, @runId, @kind, @key, @ref, @sha256, @bytes, @contentType)`,
      )
      .run(
        named({
          id,
          runId,
          kind: input.kind,
          key: input.key,
          ref: input.ref,
          sha256: input.sha256 ?? null,
          bytes: input.bytes ?? null,
          contentType: input.contentType ?? null,
        }),
      );
    const row = this.getRunArtifact(runId, id);
    if (!row) throw new Error(`run artifact insert lost: ${id}`);
    return row;
  }

  /**
   * One page of a run's artifacts, ascending by (created_at, id) — creation
   * order with a deterministic tiebreak; `total` counts the whole run.
   * Default 200, clamp 1..1000.
   */
  listRunArtifacts(
    runId: string,
    opts: { limit?: number; offset?: number } = {},
  ): { items: RunArtifactRow[]; total: number; limit: number; offset: number } {
    const limit = clampPageLimit(opts.limit);
    const offset = Math.max(0, opts.offset ?? 0);
    const items = this.db
      .prepare(
        `SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?`,
      )
      .all(runId, limit, offset) as RunArtifactRow[];
    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM run_artifacts WHERE run_id = ?`)
      .get(runId) as { n: number };
    return { items, total: n, limit, offset };
  }

  getRunArtifact(
    runId: string,
    artifactId: string,
  ): RunArtifactRow | undefined {
    // bun:sqlite yields null (not undefined) for a missing row; normalize so
    // the declared `| undefined` contract holds.
    const row = this.db
      .prepare(`SELECT * FROM run_artifacts WHERE run_id = ? AND id = ?`)
      .get(runId, artifactId) as RunArtifactRow | null | undefined;
    return row ?? undefined;
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
      .run(
        named({
          actor,
          action,
          scope_id: refs.scope_id ?? null,
          task_id: refs.task_id ?? null,
          run_id: refs.run_id ?? null,
          detail_json: JSON.stringify(refs.detail ?? {}),
        }),
      );
  }

  listAudit(filter: AuditFilter = {}): AuditPage {
    const clauses: string[] = [];
    if (filter.scope_id) clauses.push("scope_id = @scopeId");
    if (filter.task_id) clauses.push("task_id = @taskId");
    if (filter.run_id) clauses.push("run_id = @runId");
    if (filter.before_id !== undefined) clauses.push("id < @beforeId");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM audit ${where} ORDER BY id DESC LIMIT @limit
         ) ORDER BY id`,
      )
      .all(
        named({
          scopeId: filter.scope_id ?? null,
          taskId: filter.task_id ?? null,
          runId: filter.run_id ?? null,
          beforeId: filter.before_id ?? null,
          limit: clampPageLimit(filter.limit),
        }),
      ) as AuditRow[];
    return {
      events: rows,
      has_more: this.olderAuditRowExists(filter, rows),
      oldest_id: rows[0]?.id ?? null,
      newest_id: rows[rows.length - 1]?.id ?? null,
    };
  }

  /** Shared {events, has_more, oldest_id, newest_id} envelope for list pages. */
  private pageEnvelope<T extends { id: number }>(
    rows: T[],
    hasMore: () => boolean,
  ): {
    events: T[];
    has_more: boolean;
    oldest_id: number | null;
    newest_id: number | null;
  } {
    return {
      events: rows,
      has_more: rows.length === 0 ? false : hasMore(),
      oldest_id: rows[0]?.id ?? null,
      newest_id: rows[rows.length - 1]?.id ?? null,
    };
  }

  /**
   * True iff older audit rows exist than the page just returned, honoring the
   * filter's scope/task/run narrowing — i.e. the cursor can still be walked.
   */
  private olderAuditRowExists(
    filter: AuditFilter,
    rows: readonly { id: number }[],
  ): boolean {
    if (rows.length === 0) return false;
    const cursor = rows[0]!.id;
    const clauses = ["id < ?"];
    const bindings: (string | number)[] = [cursor];
    if (filter.scope_id) {
      clauses.push("scope_id = ?");
      bindings.push(filter.scope_id);
    }
    if (filter.task_id) {
      clauses.push("task_id = ?");
      bindings.push(filter.task_id);
    }
    if (filter.run_id) {
      clauses.push("run_id = ?");
      bindings.push(filter.run_id);
    }
    const row = this.db
      .prepare(
        `SELECT 1 AS one FROM audit WHERE ${clauses.join(" AND ")} LIMIT 1`,
      )
      .get(...bindings) as { one: number } | null | undefined;
    return row !== null && row !== undefined;
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

/**
 * File paths mentioned in a task spec, for the cost heuristic's touched-file
 * count. Same shape as FILE_PATH_PATTERN in @colony/agent-runtime; core does
 * not depend on @colony/agent-runtime.
 */
const SPEC_FILE_PATH_PATTERN =
  /[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)+\.[A-Za-z0-9]{1,8}/g;

function extractSpecPaths(spec: string): string[] {
  return spec.match(SPEC_FILE_PATH_PATTERN) ?? [];
}
