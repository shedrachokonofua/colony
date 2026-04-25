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

    // Capability check: human must hold `policy.override` (which doubles as
    // the gate-approve capability for HITL approvals in Phase 2; tightened
    // policy in COL-4.4 splits these). Refusing without capability ensures a
    // /approve from an unauthorized commenter never closes a gate.
    const capability: Capability = "policy.override";
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
      action: "approval.record",
      capability,
      target_kind: "approval",
      target_id: approval.id,
      reason: "human_approve_command",
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
    const role = roleForApprover(approval.actor);
    if (role) matchedRoles.add(role);
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

function roleForApprover(actor: ActorId): Role | null {
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

// ---------------------------------------------------------------------------
// Public driver: evaluate the gate; promote task to merge_ready when open.
// ---------------------------------------------------------------------------

export interface CheckMrGateInput {
  readonly task_id: string;
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
    const review = await deps.reviewGate.latestResolvedReview(task.id);
    const head_commit_sha =
      approvals.find((a) => a.commit_sha)?.commit_sha ??
      artifact.hash ??
      review?.envelope_hash ??
      "";

    const pipelineMirror = (
      await deps.providerProjects.listMirrorsForColony({
        colony_id: task.id,
        entity_kind: "pipeline",
      })
    )[0];
    let pipeline_status: PipelineStatusValue | null = null;
    let pipeline_commit_sha: string | null = null;
    if (pipelineMirror?.source_version) {
      try {
        const decoded = JSON.parse(pipelineMirror.source_version) as {
          readonly status?: PipelineStatusValue;
          readonly commit_sha?: string;
        };
        pipeline_status = decoded.status ?? null;
        pipeline_commit_sha = decoded.commit_sha ?? null;
      } catch {
        // ignore malformed mirror payload
      }
    }

    const evaluation = evaluateMrGate({
      task,
      artifact,
      gate,
      head_commit_sha,
      approvals,
      pipeline_status,
      pipeline_commit_sha,
    });

    if (!evaluation.open) {
      return {
        checked: true,
        task_id: task.id,
        final_state: task.state,
        gate_open: false,
        reasons: evaluation.reasons,
        missing: evaluation.missing,
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
