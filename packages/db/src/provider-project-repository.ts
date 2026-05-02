import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  Iso8601,
  ProviderEntityKind,
  ProviderMirror,
  ProviderMirrorId,
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

export interface UpsertProviderMirrorInput {
  readonly colony_id: string;
  readonly entity_kind: ProviderEntityKind;
  readonly provider: string;
  readonly provider_id: string;
  readonly provider_project_id?: ProviderProjectId;
  readonly provider_project_path?: string;
  readonly source_version?: string;
  readonly freshness_ttl_seconds?: number;
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

interface ProviderMirrorRow {
  id: string;
  colony_id: string;
  entity_kind: ProviderEntityKind;
  provider: string;
  provider_id: string;
  provider_project_id: string | null;
  provider_project_path: string | null;
  source_version: string | null;
  projected_at: Date | null;
  freshness_ttl_seconds: number | null;
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

function mapMirror(r: ProviderMirrorRow): ProviderMirror {
  return {
    id: r.id as ProviderMirrorId,
    colony_id: r.colony_id,
    entity_kind: r.entity_kind,
    provider: r.provider,
    provider_id: r.provider_id,
    provider_project_id: r.provider_project_id
      ? (r.provider_project_id as ProviderProjectId)
      : undefined,
    provider_project_path: r.provider_project_path ?? undefined,
    source_version: r.source_version ?? undefined,
    projected_at: r.projected_at ? toIso(r.projected_at) : undefined,
    freshness_ttl_seconds: r.freshness_ttl_seconds ?? undefined,
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

  async listProjects(): Promise<ProviderProject[]> {
    const { rows } = await this.pool.query<ProviderProjectRow>(
      `SELECT * FROM provider_projects ORDER BY provider, path`,
    );
    return rows.map(mapProject);
  }

  async linkScopeTarget(input: LinkScopeTargetInput): Promise<ScopeTarget> {
    const id = randomUUID();
    try {
      const { rows } = await this.pool.query<ScopeTargetRow>(
        `INSERT INTO scope_targets (id, scope_id, provider_project_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT scope_targets_role_unique DO UPDATE
           SET scope_id = EXCLUDED.scope_id
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
         ON CONFLICT ON CONSTRAINT task_targets_project_unique DO UPDATE
           SET task_id = EXCLUDED.task_id
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

  async upsertMirror(
    input: UpsertProviderMirrorInput,
  ): Promise<ProviderMirror> {
    const id = randomUUID();
    const { rows } = await this.pool.query<ProviderMirrorRow>(
      `INSERT INTO provider_mirrors
         (id, colony_id, entity_kind, provider, provider_id,
          provider_project_id, provider_project_path, source_version,
          projected_at, freshness_ttl_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
       ON CONFLICT (
         provider,
         entity_kind,
         provider_id,
         COALESCE(provider_project_id, '')
       ) DO UPDATE
       SET colony_id = EXCLUDED.colony_id,
           provider_project_path = EXCLUDED.provider_project_path,
           source_version = EXCLUDED.source_version,
           projected_at = now(),
           freshness_ttl_seconds = EXCLUDED.freshness_ttl_seconds
       RETURNING *`,
      [
        id,
        input.colony_id,
        input.entity_kind,
        input.provider,
        input.provider_id,
        input.provider_project_id ?? null,
        input.provider_project_path ?? null,
        input.source_version ?? null,
        input.freshness_ttl_seconds ?? 900,
      ],
    );
    return mapMirror(rows[0]);
  }

  /**
   * Resolve a provider reference (provider + provider_id, optionally
   * scoped by provider_project_id for multi-repo disambiguation) to its
   * Colony mirror row. The unique index on
   * (provider, entity_kind, provider_id, COALESCE(provider_project_id,''))
   * means in practice (provider, provider_id, project) is unique across
   * entity_kinds for a single provider artifact, so this returns the
   * single matching row regardless of entity_kind.
   */
  async findMirrorByProviderRef(input: {
    readonly provider: string;
    readonly provider_id: string;
    readonly provider_project_id?: string;
  }): Promise<ProviderMirror | null> {
    const params: unknown[] = [input.provider, input.provider_id];
    let projectClause = "";
    if (input.provider_project_id) {
      params.push(input.provider_project_id);
      projectClause = `AND provider_project_id = $${params.length}`;
    }
    const { rows } = await this.pool.query<ProviderMirrorRow>(
      `SELECT * FROM provider_mirrors
       WHERE provider = $1 AND provider_id = $2 ${projectClause}
       ORDER BY projected_at DESC NULLS LAST
       LIMIT 1`,
      params,
    );
    return rows[0] ? mapMirror(rows[0]) : null;
  }

  async listMirrorsForColony(input: {
    readonly colony_id: string;
    readonly entity_kind?: ProviderEntityKind;
  }): Promise<ProviderMirror[]> {
    const params: unknown[] = [input.colony_id];
    const where = ["colony_id = $1"];
    if (input.entity_kind) {
      params.push(input.entity_kind);
      where.push(`entity_kind = $${params.length}`);
    }
    const { rows } = await this.pool.query<ProviderMirrorRow>(
      `SELECT * FROM provider_mirrors
       WHERE ${where.join(" AND ")}
       ORDER BY projected_at DESC NULLS LAST`,
      params,
    );
    return rows.map(mapMirror);
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
