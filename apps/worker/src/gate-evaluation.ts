import {
  PolicyRepository,
  ProviderProjectRepository,
  ReviewGateRepository,
  TaskGraphRepository,
} from "@colony/db";
import {
  isTaskId,
  type ActorId,
  type Approval,
  type Artifact,
  type Capability,
  type Gate,
  type Role,
  type Task,
} from "@colony/domain";
import { evaluate as evaluatePolicy } from "@colony/policy";
import type { ProviderAdapter } from "@colony/provider";

/**
 * COL-2.12 — HITL gate evaluation.
 *
 * Gate kinds in scope here:
 *   - mr_pr: opens once a task is `review_requested` and the MR mirror exists.
 *            Closes (status='open') when reviewer approval, human approval (if
 *            required by policy), and a green pipeline at the head commit are
 *            all present. Approvals on prior commits are invalidated when a
 *            new commit lands on the MR.
 *
 * Stale-approval invalidation is wired through:
 *   - new commit on MR head    -> invalidate all approvals not at the new sha
 *   - failed pipeline           -> invalidate all approvals (green required)
 *   - changes_requested         -> invalidate all (handled in reviewer-run)
 *   - policy version change     -> invalidate all (policy_version mismatch)
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

const REQUIRED_APPROVERS_DEFAULT: readonly Role[] = [
  "reviewer",
  "human",
] as const;

export interface GateDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly reviewGate: ReviewGateRepository;
  readonly policy: PolicyRepository;
  /**
   * Optional provider adapter. The `mr_pr` mirror records `head_commit_sha`
   * only when the developer opens or updates the MR, so any later commit on
   * the branch leaves it stale — and every head-bound decision (pipeline
   * selection, approval staleness, re-review eligibility) then evaluates a
   * dead commit. When an adapter is supplied the gate reads the live head
   * from the provider and treats the mirror as a cache.
   */
  readonly providerAdapter?: ProviderAdapter;
}

export interface OpenMrGateInput {
  readonly task_id: string;
}

export interface OpenMrGateResult {
  readonly opened: boolean;
  readonly gate_id?: string;
  readonly artifact_id?: string;
  readonly reason?: string;
}

export function createOpenMrGate(deps: GateDependencies) {
  return async function openMrGate(
    input: OpenMrGateInput,
  ): Promise<OpenMrGateResult> {
    if (!isTaskId(input.task_id)) {
      return { opened: false, reason: "invalid_task_id" };
    }
    const task = await deps.repo.getTask(input.task_id);
    if (!task) return { opened: false, reason: "task_not_found" };

    const mrMirror = (
      await deps.providerProjects.listMirrorsForColony({
        colony_id: task.id,
        entity_kind: "mr_pr",
      })
    )[0];
    if (!mrMirror) return { opened: false, reason: "no_mr_mirror" };

    const project = mrMirror.provider_project_id
      ? await deps.providerProjects.getProject(mrMirror.provider_project_id)
      : null;
    if (!project)
      return { opened: false, reason: "provider_project_not_found" };

    const artifact = await deps.reviewGate.upsertArtifact({
      kind: "mr",
      provider: project.provider,
      provider_id: mrMirror.provider_id,
      uri: `${project.path}/merge_requests/${mrMirror.provider_id}`,
      scope_id: task.scope_id,
      task_id: task.id,
    });
    const gate = await deps.reviewGate.openGate({
      scope_id: task.scope_id,
      task_id: task.id,
      kind: "mr_pr",
      required_approvals: REQUIRED_APPROVERS_DEFAULT,
    });
    await deps.repo.recordEvent({
      scope_id: task.scope_id,
      task_id: task.id,
      kind: "gate_opened",
      actor: SUPERVISOR_ACTOR,
      payload: { gate_id: gate.id, kind: "mr_pr", artifact_id: artifact.id },
    });
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: SUPERVISOR_ACTOR,
      action: "gate.open",
      capability: "task.assign",
      target_kind: "gate",
      target_id: gate.id,
      reason: "task_in_review_requested",
      evidence: {
        gate_kind: "mr_pr",
        artifact_id: artifact.id,
        required_approvals: REQUIRED_APPROVERS_DEFAULT.slice(),
      },
    });
    return { opened: true, gate_id: gate.id, artifact_id: artifact.id };
  };
}

// ---------------------------------------------------------------------------
// Human approval ingestion (`/approve` comment).
// ---------------------------------------------------------------------------

export interface RecordHumanApprovalInput {
  readonly task_id: string;
  readonly actor: string;
  readonly commit_sha?: string;
  readonly pipeline_id?: string;
  /** Provenance for audit (provider event id, comment id). */
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly auto_approved?: boolean;
}

export type RecordHumanApprovalResult =
  | { readonly recorded: false; readonly reason: string }
  | {
      readonly recorded: true;
      readonly approval_id: string;
      readonly artifact_id: string;
    };

export function createRecordHumanApproval(deps: GateDependencies) {
  return async function recordHumanApproval(
    input: RecordHumanApprovalInput,
  ): Promise<RecordHumanApprovalResult> {
    if (!isTaskId(input.task_id)) {
      return { recorded: false, reason: "invalid_task_id" };
    }
    const task = await deps.repo.getTask(input.task_id);
    if (!task) return { recorded: false, reason: "task_not_found" };
    const actor = input.actor as ActorId;
    const autoApproved = input.auto_approved === true;
    if (autoApproved && actor !== SUPERVISOR_ACTOR) {
      return { recorded: false, reason: "invalid_auto_approval_actor" };
    }
    if (
      autoApproved &&
      (input.commit_sha === undefined ||
        input.pipeline_id === undefined ||
        input.evidence?.reviewer_result !== "approved" ||
        input.evidence?.pipeline_status !== "success" ||
        input.evidence?.commit_sha !== input.commit_sha)
    ) {
      return { recorded: false, reason: "auto_approval_evidence_incomplete" };
    }
    const capability: Capability = "policy.override";
    if (!autoApproved) {
      // Capability check: human must hold `policy.override`.
      const grants = await deps.policy.getCapabilityGrantsForActor(
        actor,
        task.scope_id,
      );
      const identity = await deps.policy.getProviderIdentity(actor);
      const policyDecision = evaluatePolicy({
        action: "task.claim",
        requiredCapability: capability,
        granted: grants,
        providerIdentity: identity,
        effectivePolicy: null,
      });
      if (!policyDecision.allowed) {
        await deps.repo.writeAudit({
          scope_id: task.scope_id,
          task_id: task.id,
          actor,
          action: "approval.denied",
          capability,
          target_kind: "task",
          target_id: task.id,
          reason: policyDecision.reason,
          evidence: input.evidence ?? {},
        });
        return {
          recorded: false,
          reason: `capability_denied:${policyDecision.reason}`,
        };
      }
    }

    const mrMirror = (
      await deps.providerProjects.listMirrorsForColony({
        colony_id: task.id,
        entity_kind: "mr_pr",
      })
    )[0];
    if (!mrMirror) return { recorded: false, reason: "no_mr_mirror" };

    const project = mrMirror.provider_project_id
      ? await deps.providerProjects.getProject(mrMirror.provider_project_id)
      : null;
    if (!project)
      return { recorded: false, reason: "provider_project_not_found" };

    const artifact = await deps.reviewGate.upsertArtifact({
      kind: "mr",
      provider: project.provider,
      provider_id: mrMirror.provider_id,
      uri: `${project.path}/merge_requests/${mrMirror.provider_id}`,
      scope_id: task.scope_id,
      task_id: task.id,
    });
    const approval = await deps.reviewGate.recordApproval({
      artifact_id: artifact.id,
      actor,
      commit_sha: input.commit_sha,
      pipeline_id: input.pipeline_id,
    });
    await deps.repo.recordEvent({
      scope_id: task.scope_id,
      task_id: task.id,
      kind: "approval_recorded",
      actor,
      payload: {
        approval_id: approval.id,
        artifact_id: artifact.id,
        commit_sha: input.commit_sha,
      },
    });
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor,
      action: autoApproved
        ? "approval.record.auto_approved"
        : "approval.record",
      capability,
      target_kind: "approval",
      target_id: approval.id,
      reason: autoApproved
        ? "yolo_mode_reviewer_and_pipeline_preconditions"
        : "human_approve_command",
      evidence: {
        ...(input.evidence ?? {}),
        artifact_id: artifact.id,
        commit_sha: input.commit_sha,
        pipeline_id: input.pipeline_id,
      },
    });
    return {
      recorded: true,
      approval_id: approval.id,
      artifact_id: artifact.id,
    };
  };
}

// ---------------------------------------------------------------------------
// Pipeline status ingestion (webhook).
// ---------------------------------------------------------------------------

export type PipelineStatusValue =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "canceled"
  | "skipped";

export interface RecordPipelineStatusInput {
  readonly task_id: string;
  readonly pipeline_id: string;
  readonly commit_sha: string;
  readonly status: PipelineStatusValue;
}

export type RecordPipelineStatusResult =
  | { readonly recorded: false; readonly reason: string }
  | { readonly recorded: true; readonly invalidated_approvals: number };

export function createRecordPipelineStatus(deps: GateDependencies) {
  return async function recordPipelineStatus(
    input: RecordPipelineStatusInput,
  ): Promise<RecordPipelineStatusResult> {
    if (!isTaskId(input.task_id)) {
      return { recorded: false, reason: "invalid_task_id" };
    }
    const task = await deps.repo.getTask(input.task_id);
    if (!task) return { recorded: false, reason: "task_not_found" };

    const mrMirror = (
      await deps.providerProjects.listMirrorsForColony({
        colony_id: task.id,
        entity_kind: "mr_pr",
      })
    )[0];
    if (!mrMirror) return { recorded: false, reason: "no_mr_mirror" };
    const project = mrMirror.provider_project_id
      ? await deps.providerProjects.getProject(mrMirror.provider_project_id)
      : null;
    if (!project)
      return { recorded: false, reason: "provider_project_not_found" };

    // Persist as a pipeline mirror so downstream gate evaluation can read the
    // latest status without re-fetching from the provider.
    await deps.providerProjects.upsertMirror({
      colony_id: task.id,
      entity_kind: "pipeline",
      provider: project.provider,
      provider_id: input.pipeline_id,
      provider_project_id: project.id,
      provider_project_path: project.path,
      source_version: JSON.stringify({
        status: input.status,
        commit_sha: input.commit_sha,
      }),
    });

    let invalidated = 0;
    if (input.status === "failed") {
      const artifact = await deps.reviewGate.getArtifactByProviderRef({
        provider: project.provider,
        kind: "mr",
        provider_id: mrMirror.provider_id,
      });
      if (artifact) {
        invalidated = await deps.reviewGate.invalidateApprovals({
          artifact_id: artifact.id,
          reason: `pipeline_failed:${input.pipeline_id}`,
        });
      }
    }
    await deps.repo.recordEvent({
      scope_id: task.scope_id,
      task_id: task.id,
      kind: "provider_event",
      actor: SUPERVISOR_ACTOR,
      payload: {
        kind: "pipeline_status",
        pipeline_id: input.pipeline_id,
        commit_sha: input.commit_sha,
        status: input.status,
        invalidated_approvals: invalidated,
      },
    });
    if (invalidated > 0) {
      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor: SUPERVISOR_ACTOR,
        action: "approval.invalidate",
        capability: "task.assign",
        target_kind: "approval",
        target_id: input.pipeline_id,
        reason: `pipeline_failed:${input.pipeline_id}`,
        evidence: {
          pipeline_id: input.pipeline_id,
          commit_sha: input.commit_sha,
          invalidated_approvals: invalidated,
        },
      });
    }
    return { recorded: true, invalidated_approvals: invalidated };
  };
}

// ---------------------------------------------------------------------------
// Gate evaluation: are all the conditions for `merge_ready` met?
// ---------------------------------------------------------------------------

export interface GateEvaluationContext {
  readonly task: Task;
  readonly artifact: Artifact;
  readonly gate: Gate;
  readonly head_commit_sha: string;
  readonly approvals: readonly Approval[];
  readonly pipeline_status: PipelineStatusValue | null;
  readonly pipeline_commit_sha: string | null;
  readonly allow_service_approval?: boolean;
}

export interface GateEvaluationResult {
  readonly open: boolean;
  readonly reasons: readonly string[];
  readonly missing: readonly Role[];
}

export function evaluateMrGate(
  ctx: GateEvaluationContext,
): GateEvaluationResult {
  const reasons: string[] = [];
  const required = new Set<Role>(ctx.gate.required_approvals);
  const matchedRoles = new Set<Role>();

  // Approvals are valid when not invalidated, optionally tied to the head sha
  // (when an approval has a commit_sha). Approvals without a commit_sha (e.g.
  // some legacy bot approvals) count too — the protocol records sha for new
  // approvals, but we don't reject prior data.
  for (const approval of ctx.approvals) {
    if (approval.invalidated_at) continue;
    if (approval.commit_sha && approval.commit_sha !== ctx.head_commit_sha) {
      reasons.push(
        `approval ${approval.id} is on stale sha ${approval.commit_sha}`,
      );
      continue;
    }
    const role = roleForApprover(approval.actor, ctx.allow_service_approval);
    if (role && required.has(role)) matchedRoles.add(role);
  }
  const missing: Role[] = [];
  for (const role of required) {
    if (!matchedRoles.has(role)) missing.push(role);
  }
  if (missing.length > 0) {
    reasons.push(`missing approvals from: ${missing.join(", ")}`);
  }
  if (ctx.pipeline_status !== "success") {
    reasons.push(
      `pipeline status is ${ctx.pipeline_status ?? "missing"}, need success`,
    );
  } else if (
    ctx.pipeline_commit_sha &&
    ctx.pipeline_commit_sha !== ctx.head_commit_sha
  ) {
    reasons.push(
      `pipeline ran on ${ctx.pipeline_commit_sha}, head is ${ctx.head_commit_sha}`,
    );
  }

  return {
    open: reasons.length === 0,
    reasons,
    missing,
  };
}

function roleForApprover(
  actor: ActorId,
  allowServiceApproval = false,
): Role | null {
  if (allowServiceApproval && actor === SUPERVISOR_ACTOR) return "human";
  // Convention from bot bootstrap (COL-1.1c): bots use `bot:<role>` actor IDs.
  // Humans use `human:<id>`. Anything else falls back to null and won't
  // satisfy a required approval.
  if (actor.startsWith("bot:")) {
    const tail = actor.slice(4);
    return tail as Role;
  }
  if (actor.startsWith("human:")) return "human";
  return null;
}

export function isReReviewEligible(input: {
  readonly missing: readonly Role[];
  readonly head_commit_sha: string;
  readonly pipeline_status: PipelineStatusValue | null;
  readonly pipeline_commit_sha: string | null;
}): boolean {
  return (
    input.missing.includes("reviewer") &&
    input.pipeline_status === "success" &&
    input.head_commit_sha.length > 0 &&
    input.pipeline_commit_sha === input.head_commit_sha
  );
}

// ---------------------------------------------------------------------------
// Public driver: evaluate the gate; promote task to merge_ready when open.
// ---------------------------------------------------------------------------

export interface CheckMrGateInput {
  readonly task_id: string;
  readonly allow_service_approval?: boolean;
}

export type CheckMrGateResult =
  | { readonly checked: false; readonly reason: string }
  | {
      readonly checked: true;
      readonly task_id: string;
      readonly final_state: Task["state"];
      readonly gate_open: boolean;
      readonly reasons: readonly string[];
      readonly missing: readonly Role[];
      /** True when a green current-head pipeline can satisfy a missing reviewer approval. */
      readonly needs_re_review?: boolean;
      readonly review_attempts?: number;
      readonly head_commit_sha?: string;
      readonly pipeline_status?: PipelineStatusValue | null;
      readonly pipeline_commit_sha?: string | null;
    };

export function createCheckMrGate(deps: GateDependencies) {
  return async function checkMrGate(
    input: CheckMrGateInput,
  ): Promise<CheckMrGateResult> {
    if (!isTaskId(input.task_id)) {
      return { checked: false, reason: "invalid_task_id" };
    }
    const task = await deps.repo.getTask(input.task_id);
    if (!task) return { checked: false, reason: "task_not_found" };
    if (task.state !== "review_requested") {
      // Only `review_requested` is a candidate for merge_ready.
      return {
        checked: true,
        task_id: task.id,
        final_state: task.state,
        gate_open: false,
        reasons: [`task not in review_requested: ${task.state}`],
        missing: [],
      };
    }

    const mrMirror = (
      await deps.providerProjects.listMirrorsForColony({
        colony_id: task.id,
        entity_kind: "mr_pr",
      })
    )[0];
    if (!mrMirror) return { checked: false, reason: "no_mr_mirror" };
    const project = mrMirror.provider_project_id
      ? await deps.providerProjects.getProject(mrMirror.provider_project_id)
      : null;
    if (!project)
      return { checked: false, reason: "provider_project_not_found" };

    const artifact = await deps.reviewGate.getArtifactByProviderRef({
      provider: project.provider,
      kind: "mr",
      provider_id: mrMirror.provider_id,
    });
    if (!artifact) return { checked: false, reason: "no_mr_artifact" };

    const gate = await deps.reviewGate.findOpenGate("mr_pr", task.id);
    if (!gate) return { checked: false, reason: "no_open_gate" };

    const approvals = await deps.reviewGate.listActiveApprovals(artifact.id);
    const reviews = await deps.reviewGate.listReviewsForTask(task.id);
    const review = reviews.find((candidate) => candidate.resolved_at);
    let mirrorHeadCommitSha: string | null = null;
    if (mrMirror.source_version) {
      try {
        const decoded = JSON.parse(mrMirror.source_version) as {
          readonly head_commit_sha?: string;
        };
        mirrorHeadCommitSha = decoded.head_commit_sha ?? null;
      } catch {
        // ignore malformed mirror payload
      }
    }
    // Provider truth wins over the cached mirror: the mirror's
    // head_commit_sha is only written when the developer opens/updates the
    // MR, so a later commit (rework push, CI fix) leaves it pointing at a
    // dead commit and every head-bound check below evaluates the wrong
    // revision. Fall back to the mirror when no adapter is wired or the
    // provider read fails — a stale head is still better than none.
    let providerHeadCommitSha: string | null = null;
    if (deps.providerAdapter) {
      try {
        const liveMr = await deps.providerAdapter.mergeRequests.get(
          { id: project.provider_id, path: project.path },
          mrMirror.provider_id,
        );
        providerHeadCommitSha = liveMr.head_commit_sha ?? null;
      } catch {
        // Provider unreachable: fall through to the cached mirror value.
      }
    }
    const head_commit_sha =
      providerHeadCommitSha ??
      mirrorHeadCommitSha ??
      artifact.hash ??
      approvals.find((a) => a.commit_sha)?.commit_sha ??
      review?.envelope_hash ??
      "";

    // A task accumulates one pipeline mirror per pipeline id, so picking an
    // arbitrary row makes the gate evaluate a stale run: a task whose head
    // has since gone green kept reading an older failed pipeline and could
    // never open. Prefer the mirror recorded for the current head, and fall
    // back to the newest row only when nothing matches the head.
    const pipelineMirrors = await deps.providerProjects.listMirrorsForColony({
      colony_id: task.id,
      entity_kind: "pipeline",
    });
    const decodedPipelines: Array<{
      status: PipelineStatusValue | null;
      commit_sha: string | null;
    }> = [];
    for (const mirror of pipelineMirrors) {
      if (!mirror.source_version) continue;
      try {
        const decoded = JSON.parse(mirror.source_version) as {
          readonly status?: PipelineStatusValue;
          readonly commit_sha?: string;
        };
        decodedPipelines.push({
          status: decoded.status ?? null,
          commit_sha: decoded.commit_sha ?? null,
        });
      } catch {
        // ignore malformed mirror payload
      }
    }
    const selectedPipeline =
      (head_commit_sha === ""
        ? undefined
        : decodedPipelines.find(
            (value) => value.commit_sha === head_commit_sha,
          )) ??
      decodedPipelines[decodedPipelines.length - 1] ??
      null;
    const pipeline_status: PipelineStatusValue | null =
      selectedPipeline?.status ?? null;
    const pipeline_commit_sha: string | null =
      selectedPipeline?.commit_sha ?? null;

    const evaluation = evaluateMrGate({
      task,
      artifact,
      gate,
      head_commit_sha,
      approvals,
      pipeline_status,
      pipeline_commit_sha,
      allow_service_approval: input.allow_service_approval,
    });

    if (!evaluation.open) {
      const needs_re_review = isReReviewEligible({
        missing: evaluation.missing,
        head_commit_sha,
        pipeline_status,
        pipeline_commit_sha,
      });
      return {
        checked: true,
        task_id: task.id,
        final_state: task.state,
        gate_open: false,
        reasons: evaluation.reasons,
        missing: evaluation.missing,
        needs_re_review,
        review_attempts: Math.max(0, reviews.length - 1),
        head_commit_sha,
        pipeline_status,
        pipeline_commit_sha,
      };
    }

    const transitioned = await deps.repo.updateTaskState(
      task.id,
      task.state_version,
      "merge_ready",
      {
        actor: SUPERVISOR_ACTOR,
        capability: "task.assign",
        reason: "gate_evaluation_passed",
      },
    );
    await deps.reviewGate.setGateStatus(gate.id, "open");
    await deps.repo.recordEvent({
      scope_id: task.scope_id,
      task_id: task.id,
      kind: "gate_opened",
      actor: SUPERVISOR_ACTOR,
      payload: {
        gate_id: gate.id,
        approvals: approvals.length,
        pipeline_status,
      },
    });
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: SUPERVISOR_ACTOR,
      action: "gate.evaluate.open",
      capability: "task.assign",
      target_kind: "gate",
      target_id: gate.id,
      reason: "gate_evaluation_passed",
      evidence: {
        approvals: approvals.length,
        pipeline_status,
        head_commit_sha,
      },
    });
    return {
      checked: true,
      task_id: task.id,
      final_state: transitioned.state,
      gate_open: true,
      reasons: [],
      missing: [],
    };
  };
}
