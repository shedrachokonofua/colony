import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  Iso8601,
  ProviderProject,
  ProviderProjectId,
  ProviderVisibility,
  ScopeId,
  ScopeTarget,
  ScopeTargetId,
  ScopeTargetRole,
  TaskId,
  TaskTarget,
  TaskTargetId,
  TaskTargetRole,
} from "@colony/domain";
import { RepositoryError } from "./errors.js";

export interface UpsertProviderProjectInput {
  readonly provider: string;
  readonly provider_id: string;
  readonly path: string;
  readonly default_branch?: string;
  readonly visibility?: ProviderVisibility;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LinkScopeTargetInput {
  readonly scope_id: ScopeId;
  readonly provider_project_id: ProviderProjectId;
  readonly role: ScopeTargetRole;
}

export interface LinkTaskTargetInput {
  readonly task_id: TaskId;
  readonly provider_project_id: ProviderProjectId;
  readonly role: TaskTargetRole;
}

interface ProviderProjectRow {
  id: string;
  provider: string;
  provider_id: string;
  path: string;
  default_branch: string;
  visibility: ProviderVisibility;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface ScopeTargetRow {
  id: string;
  scope_id: string;
  provider_project_id: string;
  role: ScopeTargetRole;
  created_at: Date;
}

interface TaskTargetRow {
  id: string;
  task_id: string;
  provider_project_id: string;
  role: TaskTargetRole;
  created_at: Date;
}

const toIso = (d: Date): Iso8601 => d.toISOString();

function mapProject(r: ProviderProjectRow): ProviderProject {
  return {
    id: r.id as ProviderProjectId,
    provider: r.provider,
    provider_id: r.provider_id,
    path: r.path,
    default_branch: r.default_branch,
    visibility: r.visibility,
    metadata: r.metadata,
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
}

function mapScopeTarget(r: ScopeTargetRow): ScopeTarget {
  return {
    id: r.id as ScopeTargetId,
    scope_id: r.scope_id as ScopeId,
    provider_project_id: r.provider_project_id as ProviderProjectId,
    role: r.role,
    created_at: toIso(r.created_at),
  };
}

function mapTaskTarget(r: TaskTargetRow): TaskTarget {
  return {
    id: r.id as TaskTargetId,
    task_id: r.task_id as TaskId,
    provider_project_id: r.provider_project_id as ProviderProjectId,
    role: r.role,
    created_at: toIso(r.created_at),
  };
}

/**
 * Registry for provider projects and the many-to-many links from scopes and
 * tasks onto them (COL-1.2b). The provider adapter never reads from this
 * registry directly — call sites resolve a project here and then pass the
 * project context into per-operation adapter calls.
 */
export class ProviderProjectRepository {
  constructor(private readonly pool: Pool) {}

  async upsertProject(
    input: UpsertProviderProjectInput,
  ): Promise<ProviderProject> {
    const id = randomUUID();
    const visibility = input.visibility ?? "private";
    const defaultBranch = input.default_branch ?? "main";
    const metadata = JSON.stringify(input.metadata ?? {});
    // ON CONFLICT on (provider, provider_id) — the project is identified by
    // its stable provider ID. The path can change; we update it on conflict.
    const { rows } = await this.pool.query<ProviderProjectRow>(
      `INSERT INTO provider_projects
         (id, provider, provider_id, path, default_branch, visibility, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (provider, provider_id) DO UPDATE
         SET path = EXCLUDED.path,
             default_branch = EXCLUDED.default_branch,
             visibility = EXCLUDED.visibility,
             metadata = EXCLUDED.metadata,
             updated_at = now()
       RETURNING *`,
      [
        id,
        input.provider,
        input.provider_id,
        input.path,
        defaultBranch,
        visibility,
        metadata,
      ],
    );
    return mapProject(rows[0]);
  }

  async getProject(id: ProviderProjectId): Promise<ProviderProject | null> {
    const { rows } = await this.pool.query<ProviderProjectRow>(
      `SELECT * FROM provider_projects WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapProject(rows[0]) : null;
  }

  async getProjectByProviderId(
    provider: string,
    provider_id: string,
  ): Promise<ProviderProject | null> {
    const { rows } = await this.pool.query<ProviderProjectRow>(
      `SELECT * FROM provider_projects
       WHERE provider = $1 AND provider_id = $2`,
      [provider, provider_id],
    );
    return rows[0] ? mapProject(rows[0]) : null;
  }

  async getProjectByPath(
    provider: string,
    path: string,
  ): Promise<ProviderProject | null> {
    const { rows } = await this.pool.query<ProviderProjectRow>(
      `SELECT * FROM provider_projects
       WHERE provider = $1 AND path = $2`,
      [provider, path],
    );
    return rows[0] ? mapProject(rows[0]) : null;
  }

  async linkScopeTarget(input: LinkScopeTargetInput): Promise<ScopeTarget> {
    const id = randomUUID();
    try {
      const { rows } = await this.pool.query<ScopeTargetRow>(
        `INSERT INTO scope_targets (id, scope_id, provider_project_id, role)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [id, input.scope_id, input.provider_project_id, input.role],
      );
      return mapScopeTarget(rows[0]);
    } catch (err) {
      throw wrapUniqueViolation(err, "scope_target", { ...input });
    }
  }

  async listScopeTargets(scope_id: ScopeId): Promise<ScopeTarget[]> {
    const { rows } = await this.pool.query<ScopeTargetRow>(
      `SELECT * FROM scope_targets WHERE scope_id = $1 ORDER BY created_at`,
      [scope_id],
    );
    return rows.map(mapScopeTarget);
  }

  async getPrimaryScopeTarget(scope_id: ScopeId): Promise<ScopeTarget | null> {
    const { rows } = await this.pool.query<ScopeTargetRow>(
      `SELECT * FROM scope_targets
       WHERE scope_id = $1 AND role = 'primary'`,
      [scope_id],
    );
    return rows[0] ? mapScopeTarget(rows[0]) : null;
  }

  async linkTaskTarget(input: LinkTaskTargetInput): Promise<TaskTarget> {
    const id = randomUUID();
    try {
      const { rows } = await this.pool.query<TaskTargetRow>(
        `INSERT INTO task_targets (id, task_id, provider_project_id, role)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [id, input.task_id, input.provider_project_id, input.role],
      );
      return mapTaskTarget(rows[0]);
    } catch (err) {
      throw wrapUniqueViolation(err, "task_target", { ...input });
    }
  }

  async listTaskTargets(task_id: TaskId): Promise<TaskTarget[]> {
    const { rows } = await this.pool.query<TaskTargetRow>(
      `SELECT * FROM task_targets WHERE task_id = $1 ORDER BY created_at`,
      [task_id],
    );
    return rows.map(mapTaskTarget);
  }

  async getPrimaryTaskTarget(task_id: TaskId): Promise<TaskTarget | null> {
    const { rows } = await this.pool.query<TaskTargetRow>(
      `SELECT * FROM task_targets
       WHERE task_id = $1 AND role = 'primary'`,
      [task_id],
    );
    return rows[0] ? mapTaskTarget(rows[0]) : null;
  }
}

function wrapUniqueViolation(
  err: unknown,
  kind: string,
  context: Readonly<Record<string, unknown>>,
): unknown {
  if (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  ) {
    return new RepositoryError(
      "UNIQUE_VIOLATION",
      `${kind} link violates uniqueness`,
      context,
    );
  }
  return err;
}
