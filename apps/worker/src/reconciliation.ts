import {
  ProviderProjectRepository,
  ReviewGateRepository,
  TaskGraphRepository,
} from "@colony/db";
import {
  isScopeId,
  type ActorId,
  type Approval,
  type ProviderMirror,
  type ProviderProject,
  type ScopeId,
  type Task,
  type TaskState,
} from "@colony/domain";
import type {
  ProviderAdapter,
  ProviderIssue,
  ProviderMergeRequest,
  ProviderProjectRef,
} from "@colony/provider";

/**
 * COL-3.1 — reconciliation engine.
 *
 * This is intentionally read-heavy and conservative: it detects drift across
 * Task Graph, provider mirrors, gates, approvals, and provider artifacts.
 * Only projection drift that Colony owns (currently state labels) is
 * auto-corrected here. Gate/merge/close disagreements are reported and
 * audited; COL-3.4 owns conflict state transitions and human resolution.
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

const STATE_LABELS = [
  "state:ready",
  "state:claimed",
  "state:in_progress",
  "state:review_requested",
  "state:changes_requested",
  "state:merge_ready",
  "state:merged",
  "state:blocked",
  "state:conflict",
  "state:pending_sync",
] as const;

export type ReconcileFindingKind =
  | "provider_adapter_mismatch"
  | "provider_project_not_found"
  | "provider_read_failed"
  | "label_drift"
  | "stale_commit_approval"
  | "provider_issue_closed_mr_open";

export type ReconcileFindingSeverity = "info" | "warning" | "conflict";

export interface ReconcileFinding {
  readonly kind: ReconcileFindingKind;
  readonly severity: ReconcileFindingSeverity;
  readonly task_id?: string;
  readonly provider?: string;
  readonly provider_project_id?: string;
  readonly provider_id?: string;
  readonly artifact_id?: string;
  readonly approval_id?: string;
  readonly expected?: Readonly<Record<string, unknown>>;
  readonly actual?: Readonly<Record<string, unknown>>;
  readonly action: "detected" | "auto_corrected";
}

export interface ReconcileTaskReport {
  readonly task_id: string;
  readonly state: TaskState;
  readonly findings: readonly ReconcileFinding[];
}

export interface ReconcileReport {
  readonly scope_id: string;
  readonly idempotency_key?: string;
  readonly checked_at: string;
  readonly ok: boolean;
  readonly auto_corrected: number;
  readonly conflicts: number;
  readonly warnings: number;
  readonly tasks: readonly ReconcileTaskReport[];
  readonly findings: readonly ReconcileFinding[];
}

export interface ReconciliationDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly reviewGate: ReviewGateRepository;
  readonly providerAdapter: ProviderAdapter;
}

export interface ReconcileScopeInput {
  readonly scope_id: string;
  readonly idempotency_key?: string;
}

export function createReconcileScope(deps: ReconciliationDependencies) {
  return async function reconcileScope(
    input: ReconcileScopeInput,
  ): Promise<ReconcileReport> {
    if (!isScopeId(input.scope_id)) {
      return emptyReport(input.scope_id, input.idempotency_key, [
        {
          kind: "provider_read_failed",
          severity: "warning",
          action: "detected",
          actual: { reason: "invalid_scope_id" },
        },
      ]);
    }

    const scope = await deps.repo.getScope(input.scope_id);
    if (!scope) {
      return emptyReport(input.scope_id, input.idempotency_key, [
        {
          kind: "provider_read_failed",
          severity: "warning",
          action: "detected",
          actual: { reason: "scope_not_found" },
        },
      ]);
    }

    const tasks = await deps.repo.listTasks(scope.id);
    const taskReports: ReconcileTaskReport[] = [];
    const allFindings: ReconcileFinding[] = [];

    for (const task of tasks) {
      const findings = await reconcileTask(deps, task);
      taskReports.push({
        task_id: task.id,
        state: task.state,
        findings,
      });
      allFindings.push(...findings);
    }

    return report(scope.id, input.idempotency_key, taskReports, allFindings);
  };
}

async function reconcileTask(
  deps: ReconciliationDependencies,
  task: Task,
): Promise<ReconcileFinding[]> {
  const findings: ReconcileFinding[] = [];
  const taskMirror = await primaryMirror(deps, task.id, "task");
  const mrMirror = await primaryMirror(deps, task.id, "mr_pr");

  let issue: ProviderIssue | null = null;
  let mr: ProviderMergeRequest | null = null;
  let project: ProviderProject | null = null;

  if (taskMirror?.provider_project_id) {
    project = await deps.providerProjects.getProject(
      taskMirror.provider_project_id,
    );
    if (!project) {
      findings.push({
        kind: "provider_project_not_found",
        severity: "warning",
        task_id: task.id,
        provider: taskMirror.provider,
        provider_project_id: taskMirror.provider_project_id,
        provider_id: taskMirror.provider_id,
        action: "detected",
      });
    } else if (project.provider !== deps.providerAdapter.provider) {
      findings.push({
        kind: "provider_adapter_mismatch",
        severity: "warning",
        task_id: task.id,
        provider: project.provider,
        provider_project_id: project.id,
        provider_id: taskMirror.provider_id,
        action: "detected",
        expected: { provider: deps.providerAdapter.provider },
        actual: { provider: project.provider },
      });
    } else {
      const projectRef = providerProjectRef(project);
      issue = await readProvider(
        findings,
        task.id,
        project,
        taskMirror,
        "issue",
        () =>
          deps.providerAdapter.issues.get(projectRef, taskMirror.provider_id),
      );
      if (issue) {
        const labelFinding = await reconcileStateLabels({
          deps,
          task,
          project,
          projectRef,
          mirror: taskMirror,
          issue,
        });
        if (labelFinding) findings.push(labelFinding);
      }

      if (mrMirror) {
        mr = await readProvider(
          findings,
          task.id,
          project,
          mrMirror,
          "mr_pr",
          () =>
            deps.providerAdapter.mergeRequests.get(
              projectRef,
              mrMirror.provider_id,
            ),
        );
      }
    }
  }

  if (issue?.state === "closed" && mr?.state === "opened") {
    const finding: ReconcileFinding = {
      kind: "provider_issue_closed_mr_open",
      severity: "conflict",
      task_id: task.id,
      provider: project?.provider,
      provider_project_id: project?.id,
      provider_id: issue.id,
      action: "detected",
      expected: { issue_state: "opened or task closed", mr_state: "not open" },
      actual: { issue_state: issue.state, mr_state: mr.state, mr_id: mr.id },
    };
    findings.push(finding);
    await writeFindingAudit(deps, task, finding);
    await deps.repo.recordEvent({
      scope_id: task.scope_id,
      task_id: task.id,
      kind: "conflict_detected",
      actor: SUPERVISOR_ACTOR,
      payload: findingPayload(finding),
    });
  }

  if (mrMirror && project) {
    const artifact = await deps.reviewGate.getArtifactByProviderRef({
      provider: project.provider,
      kind: "mr",
      provider_id: mrMirror.provider_id,
    });
    const headSha = currentHeadSha(mr, mrMirror, artifact?.hash);
    if (artifact && headSha) {
      const approvals = await deps.reviewGate.listActiveApprovals(artifact.id);
      for (const approval of approvals) {
        if (approval.commit_sha && approval.commit_sha !== headSha) {
          const finding: ReconcileFinding = staleApprovalFinding({
            task,
            project,
            mrMirror,
            artifact_id: artifact.id,
            approval,
            headSha,
          });
          findings.push(finding);
          await writeFindingAudit(deps, task, finding);
        }
      }
    }
  }

  return findings;
}

async function reconcileStateLabels(input: {
  readonly deps: ReconciliationDependencies;
  readonly task: Task;
  readonly project: ProviderProject;
  readonly projectRef: ProviderProjectRef;
  readonly mirror: ProviderMirror;
  readonly issue: ProviderIssue;
}): Promise<ReconcileFinding | null> {
  const expected = stateLabel(input.task.state);
  const actualStateLabels = input.issue.labels.filter((label) =>
    STATE_LABELS.includes(label as (typeof STATE_LABELS)[number]),
  );
  const needsAdd = expected && !actualStateLabels.includes(expected);
  const toRemove = actualStateLabels.filter((label) => label !== expected);
  if (!needsAdd && toRemove.length === 0) return null;

  let current = input.issue;
  for (const label of toRemove) {
    current = await input.deps.providerAdapter.issues.removeLabel(
      input.projectRef,
      input.mirror.provider_id,
      label,
    );
  }
  if (needsAdd && expected) {
    current = await input.deps.providerAdapter.issues.addLabel(
      input.projectRef,
      input.mirror.provider_id,
      expected,
    );
  }
  await input.deps.providerProjects.upsertMirror({
    colony_id: input.task.id,
    entity_kind: "task",
    provider: input.project.provider,
    provider_id: input.mirror.provider_id,
    provider_project_id: input.project.id,
    provider_project_path: input.project.path,
    source_version: JSON.stringify({
      issue_state: current.state,
      labels: current.labels,
    }),
  });

  const finding: ReconcileFinding = {
    kind: "label_drift",
    severity: "info",
    task_id: input.task.id,
    provider: input.project.provider,
    provider_project_id: input.project.id,
    provider_id: input.issue.id,
    action: "auto_corrected",
    expected: { labels: expected ? [expected] : [] },
    actual: { labels: actualStateLabels },
  };
  await writeFindingAudit(input.deps, input.task, finding);
  return finding;
}

async function readProvider<T>(
  findings: ReconcileFinding[],
  task_id: string,
  project: ProviderProject,
  mirror: ProviderMirror,
  kind: "issue" | "mr_pr",
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    findings.push({
      kind: "provider_read_failed",
      severity: "warning",
      task_id,
      provider: project.provider,
      provider_project_id: project.id,
      provider_id: mirror.provider_id,
      action: "detected",
      actual: {
        kind,
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}

function staleApprovalFinding(input: {
  readonly task: Task;
  readonly project: ProviderProject;
  readonly mrMirror: ProviderMirror;
  readonly artifact_id: string;
  readonly approval: Approval;
  readonly headSha: string;
}): ReconcileFinding {
  return {
    kind: "stale_commit_approval",
    severity: "conflict",
    task_id: input.task.id,
    provider: input.project.provider,
    provider_project_id: input.project.id,
    provider_id: input.mrMirror.provider_id,
    artifact_id: input.artifact_id,
    approval_id: input.approval.id,
    action: "detected",
    expected: { commit_sha: input.headSha },
    actual: { commit_sha: input.approval.commit_sha },
  };
}

async function writeFindingAudit(
  deps: ReconciliationDependencies,
  task: Task,
  finding: ReconcileFinding,
): Promise<void> {
  const action =
    finding.kind === "label_drift"
      ? "reconcile.label_drift.corrected"
      : finding.kind === "provider_issue_closed_mr_open"
        ? "reconcile.conflict.detected"
        : "reconcile.stale_commit_approval";
  await deps.repo.writeAudit({
    scope_id: task.scope_id,
    task_id: task.id,
    actor: SUPERVISOR_ACTOR,
    action,
    capability: "task.assign",
    target_kind: "reconcile_finding",
    target_id: finding.provider_id,
    reason: finding.kind,
    evidence: findingPayload(finding),
  });
}

function findingPayload(
  finding: ReconcileFinding,
): Readonly<Record<string, unknown>> {
  return { ...finding };
}

async function primaryMirror(
  deps: ReconciliationDependencies,
  task_id: string,
  entity_kind: "task" | "mr_pr",
): Promise<ProviderMirror | undefined> {
  return (
    await deps.providerProjects.listMirrorsForColony({
      colony_id: task_id,
      entity_kind,
    })
  )[0];
}

function providerProjectRef(project: ProviderProject): ProviderProjectRef {
  return { id: project.provider_id, path: project.path };
}

function stateLabel(state: TaskState): string | null {
  if (state === "created" || state === "closed" || state === "failed") {
    return null;
  }
  return `state:${state}`;
}

function currentHeadSha(
  mr: ProviderMergeRequest | null,
  mrMirror: ProviderMirror,
  artifactHash?: string,
): string | null {
  if (mr?.head_commit_sha) return mr.head_commit_sha;
  const source = parseMirrorSource(mrMirror.source_version);
  if (typeof source.head_commit_sha === "string") return source.head_commit_sha;
  if (typeof source.commit_sha === "string") return source.commit_sha;
  return artifactHash ?? null;
}

function parseMirrorSource(
  sourceVersion: string | undefined,
): Readonly<Record<string, unknown>> {
  if (!sourceVersion) return {};
  try {
    const decoded = JSON.parse(sourceVersion) as unknown;
    return decoded && typeof decoded === "object"
      ? (decoded as Readonly<Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
}

function emptyReport(
  scope_id: string,
  idempotency_key: string | undefined,
  findings: readonly ReconcileFinding[],
): ReconcileReport {
  return report(scope_id, idempotency_key, [], findings);
}

function report(
  scope_id: string,
  idempotency_key: string | undefined,
  tasks: readonly ReconcileTaskReport[],
  findings: readonly ReconcileFinding[],
): ReconcileReport {
  const conflicts = findings.filter((f) => f.severity === "conflict").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  return {
    scope_id,
    idempotency_key,
    checked_at: new Date().toISOString(),
    ok: conflicts === 0 && warnings === 0,
    auto_corrected: findings.filter((f) => f.action === "auto_corrected")
      .length,
    conflicts,
    warnings,
    tasks,
    findings,
  };
}
