import type { TaskGraphRepository } from "@colony/db";
import { isTaskId, type ActorId, type TaskState } from "@colony/domain";
import { blockedEnvelopeSchema, type BlockedEnvelope } from "@colony/schemas";

/**
 * COL-3.5a — Blocker ingestion + requeue.
 *
 * Two activities:
 *
 *   ingestBlockedEnvelope({ task_id, envelope, actor }) — accepts a
 *     `BlockedEnvelope` from a developer or reviewer run, transitions
 *     the task to `blocked`, and records the blocker class, expected
 *     unblock signal, referenced artifacts, and run rationale on the
 *     audit row. Source-of-truth lookup for "why is this task stuck?".
 *
 *   requeueBlockedTask({ task_id, action, actor, reason }) — moves a
 *     task out of `blocked`. Mirrors resolveTaskConflict actions:
 *     requeue_ready (-> ready, supervisor reclaims),
 *     requeue_in_progress (-> in_progress, resume current run),
 *     cancel (-> canceled, drop the task).
 *
 * The /unblock command path lands here too: webhook dispatcher tags the
 * comment as command_kind=unblock with command_target=task; supervisor
 * dispatches to requeueBlockedTask.
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

const ALLOWED_FROM_STATES: ReadonlyArray<TaskState> = [
  "claimed",
  "in_progress",
  "review_requested",
  "changes_requested",
  "merge_ready",
];

export interface BlockerIngestDeps {
  readonly repo: TaskGraphRepository;
}

export interface IngestBlockedEnvelopeInput {
  readonly task_id: string;
  readonly envelope: unknown;
  readonly actor?: string;
  readonly run_id?: string;
}

export type IngestBlockedEnvelopeResult =
  | {
      readonly applied: false;
      readonly task_id?: string;
      readonly reason: string;
    }
  | {
      readonly applied: true;
      readonly task_id: string;
      readonly previous_state: TaskState;
      readonly new_state: "blocked";
      readonly blocker_class: BlockedEnvelope["role_specific"]["blocker_class"];
      readonly needs_human: boolean;
    };

export function createIngestBlockedEnvelope(deps: BlockerIngestDeps) {
  return async function ingestBlockedEnvelope(
    input: IngestBlockedEnvelopeInput,
  ): Promise<IngestBlockedEnvelopeResult> {
    if (!isTaskId(input.task_id)) {
      return { applied: false, reason: "invalid_task_id" };
    }
    const parsed = blockedEnvelopeSchema.safeParse(input.envelope);
    if (!parsed.success) {
      return {
        applied: false,
        task_id: input.task_id,
        reason: `invalid_blocked_envelope:${parsed.error.message.slice(0, 200)}`,
      };
    }
    if (parsed.data.task_id !== input.task_id) {
      return {
        applied: false,
        task_id: input.task_id,
        reason: "envelope_task_id_mismatch",
      };
    }
    const task = await deps.repo.getTask(input.task_id);
    if (!task) {
      return {
        applied: false,
        task_id: input.task_id,
        reason: "task_not_found",
      };
    }
    if (task.state === "blocked") {
      // Already blocked — record an "observed" audit so we know the
      // signal repeated, but don't double-transition.
      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor: (input.actor ?? SUPERVISOR_ACTOR) as ActorId,
        action: "task.blocked.observed",
        capability: "task.assign",
        target_kind: "task",
        target_id: task.id,
        reason: parsed.data.role_specific.description,
        evidence: {
          blocker_class: parsed.data.role_specific.blocker_class,
          needs_human: parsed.data.role_specific.needs_human,
          referenced_artifacts: parsed.data.role_specific.referenced_artifacts,
          run_id: input.run_id,
        },
      });
      return {
        applied: true,
        task_id: task.id,
        previous_state: task.state,
        new_state: "blocked",
        blocker_class: parsed.data.role_specific.blocker_class,
        needs_human: parsed.data.role_specific.needs_human,
      };
    }
    if (!ALLOWED_FROM_STATES.includes(task.state)) {
      return {
        applied: false,
        task_id: task.id,
        reason: `task_not_blockable:${task.state}`,
      };
    }
    await deps.repo.updateTaskState(task.id, task.state_version, "blocked", {
      actor: (input.actor ?? SUPERVISOR_ACTOR) as ActorId,
      capability: "task.assign",
      reason: parsed.data.role_specific.description,
    });
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: (input.actor ?? SUPERVISOR_ACTOR) as ActorId,
      action: "task.blocked.recorded",
      capability: "task.assign",
      target_kind: "task",
      target_id: task.id,
      previous_state: task.state,
      new_state: "blocked",
      reason: parsed.data.role_specific.description,
      evidence: {
        blocker_class: parsed.data.role_specific.blocker_class,
        needs_human: parsed.data.role_specific.needs_human,
        expected_unblock: parsed.data.role_specific.expected_unblock,
        referenced_artifacts: parsed.data.role_specific.referenced_artifacts,
        rationale: parsed.data.rationale,
        confidence: parsed.data.confidence,
        run_id: input.run_id,
      },
    });
    return {
      applied: true,
      task_id: task.id,
      previous_state: task.state,
      new_state: "blocked",
      blocker_class: parsed.data.role_specific.blocker_class,
      needs_human: parsed.data.role_specific.needs_human,
    };
  };
}

export type RequeueAction = "requeue_ready" | "requeue_in_progress" | "cancel";

export interface RequeueBlockedTaskInput {
  readonly task_id: string;
  readonly action: RequeueAction;
  readonly actor: string;
  readonly reason?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export type RequeueBlockedTaskResult =
  | {
      readonly applied: false;
      readonly task_id?: string;
      readonly reason: string;
    }
  | {
      readonly applied: true;
      readonly task_id: string;
      readonly previous_state: "blocked";
      readonly new_state: TaskState;
    };

const ACTION_TARGET: Record<RequeueAction, TaskState> = {
  requeue_ready: "ready",
  requeue_in_progress: "in_progress",
  cancel: "canceled",
};

export function createRequeueBlockedTask(deps: BlockerIngestDeps) {
  return async function requeueBlockedTask(
    input: RequeueBlockedTaskInput,
  ): Promise<RequeueBlockedTaskResult> {
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
    if (task.state !== "blocked") {
      return {
        applied: false,
        task_id: task.id,
        reason: `task_not_blocked:${task.state}`,
      };
    }
    const target = ACTION_TARGET[input.action];
    if (!target) {
      return {
        applied: false,
        task_id: task.id,
        reason: `invalid_action:${input.action}`,
      };
    }
    const final = await deps.repo.updateTaskState(
      task.id,
      task.state_version,
      target,
      {
        actor: input.actor as ActorId,
        capability: "task.assign",
        reason: input.reason ?? `unblock:${input.action}`,
      },
    );
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: input.actor as ActorId,
      action: "task.unblocked",
      capability: "task.assign",
      target_kind: "task",
      target_id: task.id,
      previous_state: "blocked",
      new_state: final.state,
      reason: input.reason ?? `unblock:${input.action}`,
      evidence: { action: input.action, ...(input.evidence ?? {}) },
    });
    return {
      applied: true,
      task_id: task.id,
      previous_state: "blocked",
      new_state: final.state,
    };
  };
}
