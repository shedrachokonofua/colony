import {
  ProviderProjectRepository,
  ReviewGateRepository,
  TaskGraphRepository,
} from "@colony/db";
import { isTaskId, type ActorId } from "@colony/domain";

/**
 * COL-3.1a task rework activity.
 *
 * When a `/changes` command lands on a task-level MR comment, the
 * supervisor workflow needs to:
 *   1. Move the task back to `in_progress` (state machine: review_requested
 *      -> changes_requested -> in_progress is the canonical refinement
 *      loop).
 *   2. Invalidate every still-active approval on the task's MR — fresh
 *      review must be earned on the new head commit. This prevents a
 *      stale approval from sliding through after the developer rewrites
 *      the diff.
 *   3. Bump a per-task rework counter so the supervisor can enforce the
 *      `review_loop_cap` policy (default 3) and stop the loop with a
 *      blocked state when the cap is hit.
 *
 * Idempotent: a duplicate `/changes` arriving while the task is already
 * `in_progress` returns `applied:false reason="task_not_open_to_rework"`.
 *
 * Returns enough context for the workflow loop to decide whether to
 * rerun the developer or escalate to a human-blocked state.
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;
const REVIEW_LOOP_CAP_DEFAULT = 3;

export interface TaskReworkRunDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly reviewGate: ReviewGateRepository;
}

export interface RequestTaskReworkInput {
  readonly task_id: string;
  readonly actor: string;
  readonly reason?: string;
  /**
   * Optional cap. Defaults to 3 (matches policy.review_loop_cap default
   * baked into all activity-side packets today). Once a task's cumulative
   * rework count exceeds the cap, the activity refuses and surfaces
   * `loop_cap_exceeded` so the workflow can park the task as blocked
   * instead of looping forever.
   */
  readonly review_loop_cap?: number;
}

export type RequestTaskReworkResult =
  | {
      readonly applied: false;
      readonly task_id?: string;
      readonly reason: string;
    }
  | {
      readonly applied: true;
      readonly task_id: string;
      readonly previous_state: string;
      readonly new_state: "in_progress";
      readonly invalidated_approvals: number;
      readonly rework_count: number;
    };

export function createRequestTaskRework(deps: TaskReworkRunDependencies) {
  return async function requestTaskRework(
    input: RequestTaskReworkInput,
  ): Promise<RequestTaskReworkResult> {
    if (!isTaskId(input.task_id)) {
      return { applied: false, reason: "invalid_task_id" };
    }
    const task = await deps.repo.getTask(input.task_id);
    if (!task) {
      return {
        applied: false,
        task_id: input.task_id,
        reason: "task_not_found",
      };
    }
    const allowedFromStates = new Set([
      "review_requested",
      "changes_requested",
    ]);
    if (!allowedFromStates.has(task.state)) {
      return {
        applied: false,
        task_id: task.id,
        reason: `task_not_open_to_rework:${task.state}`,
      };
    }
    const cap = input.review_loop_cap ?? REVIEW_LOOP_CAP_DEFAULT;
    const reworkCount = await countReworkAudits(deps.repo, task.id);
    if (reworkCount >= cap) {
      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor: SUPERVISOR_ACTOR,
        action: "task.rework.loop_cap_exceeded",
        capability: "task.assign",
        target_kind: "task",
        target_id: task.id,
        reason: input.reason ?? "review_loop_cap_exceeded",
        evidence: {
          rework_count: reworkCount,
          cap,
          requested_by: input.actor,
        },
      });
      return {
        applied: false,
        task_id: task.id,
        reason: `loop_cap_exceeded:${reworkCount}/${cap}`,
      };
    }

    // Bridge through changes_requested if we're still at review_requested.
    let workingState = task.state;
    let workingVersion = task.state_version;
    if (workingState === "review_requested") {
      const transitioned = await deps.repo.updateTaskState(
        task.id,
        workingVersion,
        "changes_requested",
        {
          actor: input.actor as ActorId,
          capability: "task.assign",
          reason: input.reason ?? "command_changes_requested",
        },
      );
      workingState = transitioned.state;
      workingVersion = transitioned.state_version;
    }

    // Invalidate every active approval on the task's MR — fresh review
    // required on whatever the developer pushes next.
    let invalidated = 0;
    const mrMirror = await primaryMrMirror(deps.providerProjects, task.id);
    if (mrMirror) {
      const artifact = await deps.reviewGate.getArtifactByProviderRef({
        provider: mrMirror.provider,
        kind: "mr",
        provider_id: mrMirror.provider_id,
      });
      if (artifact) {
        invalidated = await deps.reviewGate.invalidateApprovals({
          artifact_id: artifact.id,
          reason: input.reason ?? "command_changes_requested",
        });
      }
    }

    const final = await deps.repo.updateTaskState(
      task.id,
      workingVersion,
      "in_progress",
      {
        actor: SUPERVISOR_ACTOR,
        capability: "task.assign",
        reason: input.reason ?? "rework_kickoff",
      },
    );

    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: SUPERVISOR_ACTOR,
      action: "task.rework.kicked_off",
      capability: "task.assign",
      target_kind: "task",
      target_id: task.id,
      previous_state: task.state,
      new_state: final.state,
      reason: input.reason ?? "rework_kickoff",
      evidence: {
        rework_count: reworkCount + 1,
        cap,
        invalidated_approvals: invalidated,
        requested_by: input.actor,
      },
    });

    return {
      applied: true,
      task_id: task.id,
      previous_state: task.state,
      new_state: "in_progress",
      invalidated_approvals: invalidated,
      rework_count: reworkCount + 1,
    };
  };
}

async function countReworkAudits(
  repo: TaskGraphRepository,
  taskId: string,
): Promise<number> {
  const audit = await repo.listAuditForScope(
    (await repo.getTask(taskId as never))!.scope_id,
    { task_id: taskId as never, limit: 500 },
  );
  return audit.filter((a) => a.action === "task.rework.kicked_off").length;
}

async function primaryMrMirror(
  providerProjects: ProviderProjectRepository,
  task_id: string,
): Promise<{
  readonly id: string;
  readonly provider: string;
  readonly provider_id: string;
} | null> {
  const mirrors = await providerProjects.listMirrorsForColony({
    colony_id: task_id,
    entity_kind: "mr_pr",
  });
  const mirror = mirrors[0];
  if (!mirror) return null;
  return {
    id: mirror.id,
    provider: mirror.provider,
    provider_id: mirror.provider_id,
  };
}
