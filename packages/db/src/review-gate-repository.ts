import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  ActorId,
  Approval,
  ApprovalId,
  Artifact,
  ArtifactId,
  ArtifactKind,
  Gate,
  GateId,
  GateKind,
  GateStatus,
  Iso8601,
  Review,
  ReviewId,
  ReviewResult,
  Role,
  ScopeId,
  TaskId,
} from "@colony/domain";

/**
 * Repository for the Phase 2 review/approval/gate tables. Reads and writes
 * here are intentionally append-or-upsert with the `audit_log` invariant
 * carried by the caller — gate evaluation runs as a supervisor activity that
 * stamps an audit row in the same logical step but not necessarily the same
 * SQL transaction (we keep gate writes idempotent so retries are safe).
 */

export interface CreateArtifactInput {
  readonly id?: ArtifactId;
  readonly kind: ArtifactKind;
  readonly scope_id?: ScopeId;
  readonly task_id?: TaskId;
  readonly provider: string;
  readonly provider_id: string;
  readonly uri: string;
  readonly hash?: string;
}

export interface CreateReviewInput {
  readonly task_id: TaskId;
  readonly artifact_id?: ArtifactId;
  readonly reviewer: ActorId;
}

export interface ResolveReviewInput {
  readonly id: ReviewId;
  readonly result: ReviewResult;
  readonly envelope_hash: string;
}

export interface RecordApprovalInput {
  readonly artifact_id: ArtifactId;
  readonly actor: ActorId;
  readonly commit_sha?: string;
  readonly pipeline_id?: string;
}

export interface InvalidateApprovalsInput {
  readonly artifact_id: ArtifactId;
  readonly reason: string;
  readonly except_commit_sha?: string;
}

export interface OpenGateInput {
  readonly scope_id: ScopeId;
  readonly task_id?: TaskId;
  readonly kind: GateKind;
  readonly required_approvals: readonly Role[];
}

interface ArtifactRow {
  id: string;
  kind: ArtifactKind;
  scope_id: string | null;
  task_id: string | null;
  provider: string;
  provider_id: string;
  uri: string;
  hash: string | null;
  created_at: Date;
}

interface ReviewRow {
  id: string;
  task_id: string;
  artifact_id: string | null;
  reviewer: string;
  result: ReviewResult | null;
  envelope_hash: string | null;
  requested_at: Date;
  resolved_at: Date | null;
}

interface ApprovalRow {
  id: string;
  artifact_id: string;
  actor: string;
  commit_sha: string | null;
  pipeline_id: string | null;
  approved_at: Date;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
}

interface GateRow {
  id: string;
  scope_id: string;
  task_id: string | null;
  kind: GateKind;
  status: GateStatus;
  required_approvals: string[];
  opened_at: Date | null;
  closed_at: Date | null;
}

const toIso = (d: Date): Iso8601 => d.toISOString();

function mapArtifact(r: ArtifactRow): Artifact {
  return {
    id: r.id as ArtifactId,
    kind: r.kind,
    scope_id: r.scope_id ? (r.scope_id as ScopeId) : undefined,
    task_id: r.task_id ? (r.task_id as TaskId) : undefined,
    provider: r.provider,
    provider_id: r.provider_id,
    uri: r.uri,
    hash: r.hash ?? undefined,
    created_at: toIso(r.created_at),
  };
}

function mapReview(r: ReviewRow): Review {
  return {
    id: r.id as ReviewId,
    task_id: r.task_id as TaskId,
    artifact_id: r.artifact_id ? (r.artifact_id as ArtifactId) : undefined,
    reviewer: r.reviewer as ActorId,
    result: r.result ?? undefined,
    envelope_hash: r.envelope_hash ?? undefined,
    requested_at: toIso(r.requested_at),
    resolved_at: r.resolved_at ? toIso(r.resolved_at) : undefined,
  };
}

function mapApproval(r: ApprovalRow): Approval {
  return {
    id: r.id as ApprovalId,
    artifact_id: r.artifact_id as ArtifactId,
    actor: r.actor as ActorId,
    commit_sha: r.commit_sha ?? undefined,
    pipeline_id: r.pipeline_id ?? undefined,
    approved_at: toIso(r.approved_at),
    invalidated_at: r.invalidated_at ? toIso(r.invalidated_at) : undefined,
    invalidation_reason: r.invalidation_reason ?? undefined,
  };
}

function mapGate(r: GateRow): Gate {
  return {
    id: r.id as GateId,
    scope_id: r.scope_id as ScopeId,
    task_id: r.task_id ? (r.task_id as TaskId) : undefined,
    kind: r.kind,
    status: r.status,
    required_approvals: r.required_approvals as readonly Role[],
    opened_at: r.opened_at ? toIso(r.opened_at) : undefined,
    closed_at: r.closed_at ? toIso(r.closed_at) : undefined,
  };
}

export class ReviewGateRepository {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Artifacts.
  // -------------------------------------------------------------------------

  async upsertArtifact(input: CreateArtifactInput): Promise<Artifact> {
    const id = input.id ?? `art-${randomUUID()}`;
    const { rows } = await this.pool.query<ArtifactRow>(
      `INSERT INTO artifacts
         (id, kind, scope_id, task_id, provider, provider_id, uri, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (provider, kind, provider_id) DO UPDATE
         SET uri = EXCLUDED.uri,
             hash = EXCLUDED.hash,
             scope_id = COALESCE(artifacts.scope_id, EXCLUDED.scope_id),
             task_id = COALESCE(artifacts.task_id, EXCLUDED.task_id)
       RETURNING *`,
      [
        id,
        input.kind,
        input.scope_id ?? null,
        input.task_id ?? null,
        input.provider,
        input.provider_id,
        input.uri,
        input.hash ?? null,
      ],
    );
    return mapArtifact(rows[0]);
  }

  async getArtifactByProviderRef(input: {
    readonly provider: string;
    readonly kind: ArtifactKind;
    readonly provider_id: string;
  }): Promise<Artifact | null> {
    const { rows } = await this.pool.query<ArtifactRow>(
      `SELECT * FROM artifacts
       WHERE provider = $1 AND kind = $2 AND provider_id = $3`,
      [input.provider, input.kind, input.provider_id],
    );
    return rows[0] ? mapArtifact(rows[0]) : null;
  }

  // -------------------------------------------------------------------------
  // Reviews.
  // -------------------------------------------------------------------------

  async createReview(input: CreateReviewInput): Promise<Review> {
    const id = `rev-${randomUUID()}`;
    const { rows } = await this.pool.query<ReviewRow>(
      `INSERT INTO reviews (id, task_id, artifact_id, reviewer)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, input.task_id, input.artifact_id ?? null, input.reviewer],
    );
    return mapReview(rows[0]);
  }

  async resolveReview(input: ResolveReviewInput): Promise<Review | null> {
    const { rows } = await this.pool.query<ReviewRow>(
      `UPDATE reviews
         SET result = $2,
             envelope_hash = $3,
             resolved_at = now()
       WHERE id = $1 AND resolved_at IS NULL
       RETURNING *`,
      [input.id, input.result, input.envelope_hash],
    );
    return rows[0] ? mapReview(rows[0]) : null;
  }

  async listReviewsForTask(task_id: TaskId): Promise<Review[]> {
    const { rows } = await this.pool.query<ReviewRow>(
      `SELECT * FROM reviews
       WHERE task_id = $1
       ORDER BY requested_at DESC`,
      [task_id],
    );
    return rows.map(mapReview);
  }

  async latestResolvedReview(task_id: TaskId): Promise<Review | null> {
    const { rows } = await this.pool.query<ReviewRow>(
      `SELECT * FROM reviews
       WHERE task_id = $1 AND resolved_at IS NOT NULL
       ORDER BY resolved_at DESC
       LIMIT 1`,
      [task_id],
    );
    return rows[0] ? mapReview(rows[0]) : null;
  }

  // -------------------------------------------------------------------------
  // Approvals.
  // -------------------------------------------------------------------------

  async recordApproval(input: RecordApprovalInput): Promise<Approval> {
    const id = `app-${randomUUID()}`;
    const { rows } = await this.pool.query<ApprovalRow>(
      `INSERT INTO approvals
         (id, artifact_id, actor, commit_sha, pipeline_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        id,
        input.artifact_id,
        input.actor,
        input.commit_sha ?? null,
        input.pipeline_id ?? null,
      ],
    );
    return mapApproval(rows[0]);
  }

  async listActiveApprovals(artifact_id: ArtifactId): Promise<Approval[]> {
    const { rows } = await this.pool.query<ApprovalRow>(
      `SELECT * FROM approvals
       WHERE artifact_id = $1 AND invalidated_at IS NULL
       ORDER BY approved_at DESC`,
      [artifact_id],
    );
    return rows.map(mapApproval);
  }

  /**
   * Mark every active approval on `artifact_id` as invalidated, except those
   * whose `commit_sha` matches `except_commit_sha` (used to keep approvals
   * tied to the still-current head valid when only the pipeline state moves).
   */
  async invalidateApprovals(input: InvalidateApprovalsInput): Promise<number> {
    const params: unknown[] = [input.artifact_id, input.reason];
    let extra = "";
    if (input.except_commit_sha) {
      params.push(input.except_commit_sha);
      extra = ` AND (commit_sha IS NULL OR commit_sha <> $3)`;
    }
    const { rowCount } = await this.pool.query(
      `UPDATE approvals
         SET invalidated_at = now(),
             invalidation_reason = $2
       WHERE artifact_id = $1
         AND invalidated_at IS NULL${extra}`,
      params,
    );
    return rowCount ?? 0;
  }

  // -------------------------------------------------------------------------
  // Gates.
  // -------------------------------------------------------------------------

  async openGate(input: OpenGateInput): Promise<Gate> {
    const id = `gate-${randomUUID()}`;
    // A task/scope can only have one active gate per (task_id, kind). The
    // existing-row branch is the idempotent retry path: a workflow signal
    // arrives twice, gate is already pending — return the existing row.
    const existing = await this.findOpenGate(input.kind, input.task_id ?? null);
    if (existing) return existing;
    const { rows } = await this.pool.query<GateRow>(
      `INSERT INTO gates
         (id, scope_id, task_id, kind, status, required_approvals, opened_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, now())
       RETURNING *`,
      [
        id,
        input.scope_id,
        input.task_id ?? null,
        input.kind,
        [...input.required_approvals],
      ],
    );
    return mapGate(rows[0]);
  }

  async setGateStatus(id: GateId, status: GateStatus): Promise<Gate | null> {
    const closedClause =
      status === "closed" ? `, closed_at = now()` : `, closed_at = NULL`;
    const openedClause =
      status === "open" ? `, opened_at = COALESCE(opened_at, now())` : ``;
    const { rows } = await this.pool.query<GateRow>(
      `UPDATE gates
         SET status = $2${closedClause}${openedClause}
       WHERE id = $1
       RETURNING *`,
      [id, status],
    );
    return rows[0] ? mapGate(rows[0]) : null;
  }

  async getGate(id: GateId): Promise<Gate | null> {
    const { rows } = await this.pool.query<GateRow>(
      `SELECT * FROM gates WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapGate(rows[0]) : null;
  }

  async findOpenGate(
    kind: GateKind,
    task_id: TaskId | null,
  ): Promise<Gate | null> {
    const params: unknown[] = [kind];
    let where = "kind = $1 AND status IN ('pending', 'open')";
    if (task_id === null) {
      where += " AND task_id IS NULL";
    } else {
      params.push(task_id);
      where += ` AND task_id = $${params.length}`;
    }
    const { rows } = await this.pool.query<GateRow>(
      `SELECT * FROM gates WHERE ${where}
       ORDER BY opened_at DESC NULLS LAST
       LIMIT 1`,
      params,
    );
    return rows[0] ? mapGate(rows[0]) : null;
  }

  async listGatesForTask(task_id: TaskId): Promise<Gate[]> {
    const { rows } = await this.pool.query<GateRow>(
      `SELECT * FROM gates
       WHERE task_id = $1
       ORDER BY opened_at DESC NULLS LAST`,
      [task_id],
    );
    return rows.map(mapGate);
  }
}
