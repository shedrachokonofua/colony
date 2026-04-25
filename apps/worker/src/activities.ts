import { createPool, TaskGraphRepository, type Pool } from "@colony/db";
import { env } from "@colony/config";
import {
  isScopeId,
  isTaskId,
  type ActorId,
  type EventKind,
  type TaskId,
} from "@colony/domain";
import type {
  RecordWorkflowEventInput,
  RecordWorkflowEventResult,
  ScopeStateSnapshot,
  ScopeId,
} from "@colony/workflows";

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

let pool: Pool | undefined;
let repo: TaskGraphRepository | undefined;

function getRepository(): TaskGraphRepository {
  if (!repo) {
    pool = createPool({
      connectionString: env().DATABASE_URL,
      role: "colony_writer",
    });
    repo = new TaskGraphRepository(pool);
  }
  return repo;
}

export async function readScopeState(input: {
  readonly scope_id: ScopeId;
}): Promise<ScopeStateSnapshot> {
  if (!isScopeId(input.scope_id)) {
    return { scope: null, tasks: [] };
  }

  const repository = getRepository();
  const scope = await repository.getScope(input.scope_id);
  if (!scope) {
    return { scope: null, tasks: [] };
  }

  const tasks = await repository.listTasks(input.scope_id);
  return {
    scope: {
      id: scope.id,
      state: scope.state,
      state_version: scope.state_version,
    },
    tasks: tasks.map((task) => ({
      id: task.id,
      state: task.state,
      state_version: task.state_version,
      claim_version: task.claim_version,
      assignee: task.assignee,
    })),
  };
}

export async function recordWorkflowEvent(
  input: RecordWorkflowEventInput,
): Promise<RecordWorkflowEventResult> {
  if (!isScopeId(input.scope_id)) {
    return { recorded: false, reason: "invalid_scope_id" };
  }
  if (input.task_id && !isTaskId(input.task_id)) {
    return { recorded: false, reason: "invalid_task_id" };
  }

  const repository = getRepository();
  const scope_id = input.scope_id;
  const scope = await repository.getScope(scope_id);
  if (!scope) {
    return { recorded: false, reason: "scope_not_found" };
  }

  const task_id = input.task_id as TaskId | undefined;
  if (task_id) {
    const task = await repository.getTask(task_id);
    if (!task || task.scope_id !== scope_id) {
      return { recorded: false, reason: "task_not_found" };
    }
  }

  const event = await repository.withTransaction(async (tx) => {
    const ev = await tx.recordEvent({
      scope_id,
      task_id,
      kind: input.kind as EventKind,
      actor: (input.actor as ActorId | undefined) ?? SUPERVISOR_ACTOR,
      payload: {
        signal: input.signal,
        signal_seq: input.signal_seq,
        workflow_id: input.workflow_id,
        run_id: input.run_id,
        ...input.payload,
      },
    });
    const audit_id = await tx.writeAudit({
      scope_id,
      task_id,
      actor: SUPERVISOR_ACTOR,
      action: "event.record",
      capability: "graph.write",
      target_kind: "event",
      target_id: ev.id,
      reason: "supervisor_signal",
      evidence: {
        signal: input.signal,
        signal_seq: input.signal_seq,
        kind: input.kind,
        workflow_id: input.workflow_id,
        run_id: input.run_id,
      },
    });
    return { ev, audit_id };
  });

  return {
    recorded: true,
    event_id: event.ev.id,
    audit_id: event.audit_id,
  };
}

export const activities = {
  readScopeState,
  recordWorkflowEvent,
};
