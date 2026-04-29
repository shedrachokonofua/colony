import {
  createPool,
  PolicyRepository,
  ProviderProjectRepository,
  ReviewGateRepository,
  TaskGraphRepository,
  type Pool,
} from "@colony/db";
import {
  createDeveloperRun,
  type StartDeveloperRunInput,
  type StartDeveloperRunResult,
} from "./developer-run.js";
import {
  createReviewerRun,
  type StartReviewerRunInput,
  type StartReviewerRunResult,
} from "./reviewer-run.js";
import {
  createArchitectRun,
  type StartArchitectRunInput,
  type StartArchitectRunResult,
} from "./architect-run.js";
import {
  createDecompositionReviewRun,
  type StartDecompositionReviewRunInput,
  type StartDecompositionReviewRunResult,
} from "./decomposition-review-run.js";
import {
  createApplyDecompositionCommand,
  type ApplyDecompositionCommandInput,
  type ApplyDecompositionCommandResult,
} from "./decomposition-command.js";
import {
  createRequestTaskRework,
  type RequestTaskReworkInput,
  type RequestTaskReworkResult,
} from "./task-rework.js";
import {
  createCheckProviderHealth,
  createMarkScopePendingSync,
  type CheckProviderHealthInput,
  type CheckProviderHealthResult,
  type MarkScopePendingSyncInput,
  type MarkScopePendingSyncResult,
} from "./provider-outage.js";
import {
  createRecordTaskConflict,
  createResolveTaskConflict,
  type RecordTaskConflictInput,
  type RecordTaskConflictResult,
  type ResolveTaskConflictInput,
  type ResolveTaskConflictResult,
} from "./task-conflict.js";
import {
  createCheckMrGate,
  createOpenMrGate,
  createRecordHumanApproval,
  createRecordPipelineStatus,
  type CheckMrGateInput,
  type CheckMrGateResult,
  type OpenMrGateInput,
  type OpenMrGateResult,
  type RecordHumanApprovalInput,
  type RecordHumanApprovalResult,
  type RecordPipelineStatusInput,
  type RecordPipelineStatusResult,
} from "./gate-evaluation.js";
import {
  createCloseTaskAfterMerge,
  createMergeTask,
  type CloseTaskAfterMergeInput,
  type CloseTaskAfterMergeResult,
  type MergeTaskInput,
  type MergeTaskResult,
} from "./merge-flow.js";
import {
  createReconcileScope,
  type ReconcileReport,
  type ReconcileScopeInput,
} from "./reconciliation.js";
import type { AgentRuntimeAdapter } from "@colony/agent-runtime";
import { env } from "@colony/config";
import {
  createAgentRuntimeWiring,
  type AgentRuntimeWiring,
} from "./agent-runtime-factory.js";
import {
  isScopeId,
  isTaskId,
  type ActorId,
  type EventKind,
  type ProviderMirror,
  type ProviderProject,
  type ScopeId as DomainScopeId,
  type TaskId,
} from "@colony/domain";
import type { ProviderAdapter } from "@colony/provider";
import { GitLabProviderAdapter } from "@colony/provider-gitlab";
import type {
  ClaimReadyTaskInput,
  ClaimReadyTaskResult,
  RecordWorkflowEventInput,
  RecordWorkflowEventResult,
  ScopeStateSnapshot,
  ScopeId,
} from "@colony/workflows";

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

let pool: Pool | undefined;
let repo: TaskGraphRepository | undefined;
let providerProjects: ProviderProjectRepository | undefined;
let policyRepo: PolicyRepository | undefined;
let reviewGateRepo: ReviewGateRepository | undefined;
let providerAdapter: ProviderAdapter | undefined;
let agentRuntimeWiring: AgentRuntimeWiring | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = createPool({
      connectionString: env().DATABASE_URL,
      role: "colony_writer",
    });
  }
  return pool;
}

function getRepository(): TaskGraphRepository {
  if (!repo) {
    repo = new TaskGraphRepository(getPool());
  }
  return repo;
}

function getProviderProjects(): ProviderProjectRepository {
  if (!providerProjects) {
    providerProjects = new ProviderProjectRepository(getPool());
  }
  return providerProjects;
}

function getPolicyRepository(): PolicyRepository {
  if (!policyRepo) {
    policyRepo = new PolicyRepository(getPool());
  }
  return policyRepo;
}

function getProviderAdapter(): ProviderAdapter {
  if (!providerAdapter) {
    providerAdapter = new GitLabProviderAdapter({
      baseUrl: env().GITLAB_BASE_URL,
      token: env().GITLAB_TOKEN,
    });
  }
  return providerAdapter;
}

async function getAgentRuntime(
  role: "developer" | "reviewer" | "architect",
): Promise<AgentRuntimeAdapter> {
  agentRuntimeWiring ??= await createAgentRuntimeWiring(env());
  return agentRuntimeWiring[role];
}

export async function initializeAgentRuntime(): Promise<void> {
  agentRuntimeWiring ??= await createAgentRuntimeWiring(env());
}

function getReviewGateRepository(): ReviewGateRepository {
  if (!reviewGateRepo) {
    reviewGateRepo = new ReviewGateRepository(getPool());
  }
  return reviewGateRepo;
}

export async function startDeveloperRun(
  input: StartDeveloperRunInput,
): Promise<StartDeveloperRunResult> {
  const run = createDeveloperRun({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    providerAdapter: getProviderAdapter(),
    agentRuntime: await getAgentRuntime("developer"),
  });
  return run(input);
}

export async function startReviewerRun(
  input: StartReviewerRunInput,
): Promise<StartReviewerRunResult> {
  const run = createReviewerRun({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    reviewGate: getReviewGateRepository(),
    providerAdapter: getProviderAdapter(),
    agentRuntime: await getAgentRuntime("reviewer"),
  });
  return run(input);
}

export async function startArchitectRun(
  input: StartArchitectRunInput,
): Promise<StartArchitectRunResult> {
  const run = createArchitectRun({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    providerAdapter: getProviderAdapter(),
    agentRuntime: await getAgentRuntime("architect"),
  });
  return run(input);
}

export async function startDecompositionReviewRun(
  input: StartDecompositionReviewRunInput,
): Promise<StartDecompositionReviewRunResult> {
  const run = createDecompositionReviewRun({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    agentRuntime: await getAgentRuntime("reviewer"),
  });
  return run(input);
}

export async function applyDecompositionCommand(
  input: ApplyDecompositionCommandInput,
): Promise<ApplyDecompositionCommandResult> {
  const run = createApplyDecompositionCommand({
    repo: getRepository(),
  });
  return run(input);
}

export async function requestTaskRework(
  input: RequestTaskReworkInput,
): Promise<RequestTaskReworkResult> {
  const run = createRequestTaskRework({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    reviewGate: getReviewGateRepository(),
  });
  return run(input);
}

export async function checkProviderHealth(
  input: CheckProviderHealthInput,
): Promise<CheckProviderHealthResult> {
  const run = createCheckProviderHealth({
    providerAdapter: getProviderAdapter(),
  });
  return run(input);
}

export async function markScopePendingSync(
  input: MarkScopePendingSyncInput,
): Promise<MarkScopePendingSyncResult> {
  const run = createMarkScopePendingSync({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
  });
  return run(input);
}

export async function recordTaskConflict(
  input: RecordTaskConflictInput,
): Promise<RecordTaskConflictResult> {
  const run = createRecordTaskConflict({ repo: getRepository() });
  return run(input);
}

export async function resolveTaskConflict(
  input: ResolveTaskConflictInput,
): Promise<ResolveTaskConflictResult> {
  const run = createResolveTaskConflict({ repo: getRepository() });
  return run(input);
}

export async function openMrGate(
  input: OpenMrGateInput,
): Promise<OpenMrGateResult> {
  return createOpenMrGate({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    reviewGate: getReviewGateRepository(),
    policy: getPolicyRepository(),
  })(input);
}

export async function recordHumanApproval(
  input: RecordHumanApprovalInput,
): Promise<RecordHumanApprovalResult> {
  return createRecordHumanApproval({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    reviewGate: getReviewGateRepository(),
    policy: getPolicyRepository(),
  })(input);
}

export async function recordPipelineStatus(
  input: RecordPipelineStatusInput,
): Promise<RecordPipelineStatusResult> {
  return createRecordPipelineStatus({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    reviewGate: getReviewGateRepository(),
    policy: getPolicyRepository(),
  })(input);
}

export async function checkMrGate(
  input: CheckMrGateInput,
): Promise<CheckMrGateResult> {
  return createCheckMrGate({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    reviewGate: getReviewGateRepository(),
    policy: getPolicyRepository(),
  })(input);
}

export async function mergeTask(
  input: MergeTaskInput,
): Promise<MergeTaskResult> {
  return createMergeTask({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    reviewGate: getReviewGateRepository(),
    providerAdapter: getProviderAdapter(),
  })(input);
}

export async function closeTaskAfterMerge(
  input: CloseTaskAfterMergeInput,
): Promise<CloseTaskAfterMergeResult> {
  return createCloseTaskAfterMerge({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    reviewGate: getReviewGateRepository(),
    providerAdapter: getProviderAdapter(),
  })(input);
}

export async function reconcileScope(
  input: ReconcileScopeInput,
): Promise<ReconcileReport> {
  return createReconcileScope({
    repo: getRepository(),
    providerProjects: getProviderProjects(),
    reviewGate: getReviewGateRepository(),
    providerAdapter: getProviderAdapter(),
  })(input);
}

function providerProjectRef(project: ProviderProject) {
  return { id: project.provider_id, path: project.path };
}

async function writeProviderProjectionAudit(input: {
  readonly scope_id: DomainScopeId;
  readonly task_id: TaskId;
  readonly mirror: ProviderMirror;
  readonly status: "synced" | "failed";
  readonly assignee: ActorId;
  readonly provider_assignee_id?: string;
  readonly error?: string;
}): Promise<void> {
  await getRepository().writeAudit({
    scope_id: input.scope_id,
    task_id: input.task_id,
    actor: SUPERVISOR_ACTOR,
    action: "provider.project.task_assignment",
    capability: "task.assign",
    target_kind: "provider_mirror",
    target_id: input.mirror.id,
    reason: "supervisor_ready_loop",
    evidence: {
      status: input.status,
      assignee: input.assignee,
      provider: input.mirror.provider,
      provider_id: input.mirror.provider_id,
      provider_project_id: input.mirror.provider_project_id,
      provider_assignee_id: input.provider_assignee_id,
      labels: ["state:claimed"],
      error: input.error,
    },
  });
}

async function projectClaimToProvider(input: {
  readonly task_id: TaskId;
  readonly scope_id: DomainScopeId;
  readonly assignee: ActorId;
}): Promise<ClaimReadyTaskResult["provider_projection"]> {
  const mirrors = await getProviderProjects().listMirrorsForColony({
    colony_id: input.task_id,
    entity_kind: "task",
  });
  const mirror = mirrors[0];
  if (!mirror?.provider_project_id) {
    return { status: "skipped", reason: "task_has_no_provider_mirror" };
  }

  const project = await getProviderProjects().getProject(
    mirror.provider_project_id,
  );
  if (!project) {
    return {
      status: "skipped",
      provider: mirror.provider,
      provider_id: mirror.provider_id,
      provider_project_id: mirror.provider_project_id,
      reason: "provider_project_not_found",
    };
  }

  try {
    const adapter = getProviderAdapter();
    if (project.provider !== adapter.provider) {
      return {
        status: "skipped",
        provider: mirror.provider,
        provider_id: mirror.provider_id,
        provider_project_id: mirror.provider_project_id,
        reason: "provider_adapter_mismatch",
      };
    }
    const projectRef = providerProjectRef(project);
    await adapter.issues.removeLabel(
      projectRef,
      mirror.provider_id,
      "state:ready",
    );
    await adapter.issues.addLabel(
      projectRef,
      mirror.provider_id,
      "state:claimed",
    );

    const identity = await getPolicyRepository().getProviderIdentity(
      input.assignee,
      project.provider,
    );
    if (identity) {
      await adapter.issues.setAssignees(projectRef, mirror.provider_id, [
        identity.provider_user_id,
      ]);
    }

    await writeProviderProjectionAudit({
      scope_id: input.scope_id,
      task_id: input.task_id,
      mirror,
      status: "synced",
      assignee: input.assignee,
      provider_assignee_id: identity?.provider_user_id,
    });

    return {
      status: "synced",
      provider: mirror.provider,
      provider_id: mirror.provider_id,
      provider_project_id: mirror.provider_project_id,
      ...(identity ? {} : { reason: "provider_identity_not_found" }),
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await writeProviderProjectionAudit({
      scope_id: input.scope_id,
      task_id: input.task_id,
      mirror,
      status: "failed",
      assignee: input.assignee,
      error: reason,
    });
    return {
      status: "failed",
      provider: mirror.provider,
      provider_id: mirror.provider_id,
      provider_project_id: mirror.provider_project_id,
      reason,
    };
  }
}

export async function claimReadyTask(
  input: ClaimReadyTaskInput,
): Promise<ClaimReadyTaskResult> {
  if (!isScopeId(input.scope_id)) {
    return { claimed: false, reason: "invalid_scope_id" };
  }
  if (!input.assignee) {
    return { claimed: false, reason: "missing_assignee" };
  }

  const repository = getRepository();
  const ready = await repository.readyTasks(input.scope_id);
  const candidate = ready[0];
  if (!candidate) {
    return { claimed: false, reason: "no_ready_tasks" };
  }

  const assignee = input.assignee as ActorId;
  const claimed = await repository.claimTask(
    candidate.id,
    assignee,
    candidate.state_version,
    {
      actor: SUPERVISOR_ACTOR,
      capability: "task.claim",
      reason: "supervisor_ready_loop",
    },
  );
  if (!claimed) {
    return { claimed: false, task_id: candidate.id, reason: "claim_lost" };
  }

  const provider_projection = await projectClaimToProvider({
    task_id: claimed.id,
    scope_id: claimed.scope_id,
    assignee,
  });
  return {
    claimed: true,
    task_id: claimed.id,
    assignee: claimed.assignee,
    provider_projection,
  };
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
  claimReadyTask,
  readScopeState,
  recordWorkflowEvent,
  applyDecompositionCommand,
  checkProviderHealth,
  markScopePendingSync,
  recordTaskConflict,
  requestTaskRework,
  resolveTaskConflict,
  startArchitectRun,
  startDecompositionReviewRun,
  startDeveloperRun,
  startReviewerRun,
  openMrGate,
  recordHumanApproval,
  recordPipelineStatus,
  checkMrGate,
  mergeTask,
  closeTaskAfterMerge,
  reconcileScope,
};
