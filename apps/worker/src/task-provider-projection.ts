import { ProviderProjectRepository, TaskGraphRepository } from "@colony/db";
import {
  isScopeId,
  type ActorId,
  type ScopeId,
  type Task,
} from "@colony/domain";
import type { ProviderAdapter } from "@colony/provider";

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

export interface SyncCommittedTasksToProviderInput {
  readonly scope_id: string;
}

export interface SyncCommittedTasksToProviderResult {
  readonly scope_id?: ScopeId;
  readonly projected: number;
  readonly skipped: number;
  readonly failed: number;
  readonly failures: readonly string[];
}

export interface SyncCommittedTasksToProviderDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly providerAdapter: ProviderAdapter;
}

function renderTaskIssueDescription(
  task: Task,
  blockedBy: readonly string[],
): string {
  const lines = [
    `Colony task: ${task.id}`,
    "",
    task.description,
    "",
    "## Acceptance criteria",
  ];
  if (task.acceptance_criteria.length === 0) {
    lines.push("- (none specified)");
  } else {
    for (const criterion of task.acceptance_criteria) {
      lines.push(`- ${criterion}`);
    }
  }
  if (task.non_goals.length > 0) {
    lines.push("", "## Non-goals");
    for (const nonGoal of task.non_goals) lines.push(`- ${nonGoal}`);
  }
  if (blockedBy.length > 0) {
    lines.push("", "## Blocked by");
    for (const blocker of blockedBy) lines.push(`- ${blocker}`);
  }
  return lines.join("\n");
}

export function createSyncCommittedTasksToProvider(
  deps: SyncCommittedTasksToProviderDependencies,
) {
  return async function syncCommittedTasksToProvider(
    input: SyncCommittedTasksToProviderInput,
  ): Promise<SyncCommittedTasksToProviderResult> {
    if (!isScopeId(input.scope_id)) {
      return {
        projected: 0,
        skipped: 0,
        failed: 0,
        failures: [],
      };
    }

    const scope_id = input.scope_id;
    const tasks = await deps.repo.listTasks(scope_id);
    let projected = 0;
    let skipped = 0;
    let failed = 0;
    const failures: string[] = [];

    for (const task of tasks) {
      try {
        const existing = (
          await deps.providerProjects.listMirrorsForColony({
            colony_id: task.id,
            entity_kind: "task",
          })
        )[0];
        if (existing) {
          skipped += 1;
          continue;
        }
        const target =
          (await deps.providerProjects.getPrimaryTaskTarget(task.id)) ??
          (await deps.providerProjects.getPrimaryScopeTarget(scope_id));
        if (!target) throw new Error("task_has_no_provider_target");

        const project = await deps.providerProjects.getProject(
          target.provider_project_id,
        );
        if (!project) throw new Error("provider_project_not_found");

        // Commit normally creates this link. Re-establish it here as well so
        // recovery can repair a partial commit/projection attempt.
        await deps.providerProjects.linkTaskTarget({
          task_id: task.id,
          provider_project_id: project.id,
          role: "primary",
        });

        const { blocked_by } = await deps.repo.getTaskDependencies(task.id);
        const issue = await deps.providerAdapter.issues.create(
          { id: project.provider_id, path: project.path },
          {
            title: task.title,
            description: renderTaskIssueDescription(task, blocked_by),
            labels: [
              "colony:task",
              blocked_by.length > 0 ? "state:blocked" : "state:ready",
              `scope:${scope_id}`,
            ],
          },
        );
        const mirror = await deps.providerProjects.upsertMirror({
          colony_id: task.id,
          entity_kind: "task",
          provider: project.provider,
          provider_id: issue.id,
          provider_project_id: project.id,
          provider_project_path: project.path,
        });
        await deps.repo.writeAudit({
          scope_id,
          task_id: task.id,
          actor: SUPERVISOR_ACTOR,
          action: "provider.task.issue_projected",
          capability: "provider.issues.create",
          target_kind: "provider_mirror",
          target_id: mirror.id,
          reason: "decomposition_commit_eager_sync",
          evidence: {
            provider_id: issue.id,
            provider_project_id: project.id,
            provider_project_path: project.path,
            blocked_by,
          },
        });
        projected += 1;
      } catch (error) {
        failed += 1;
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${task.id}:${reason}`);
        await deps.repo.writeAudit({
          scope_id,
          task_id: task.id,
          actor: SUPERVISOR_ACTOR,
          action: "provider.task.issue_projection_failed",
          capability: "provider.issues.create",
          target_kind: "task",
          target_id: task.id,
          reason,
          evidence: { reason: "decomposition_commit_eager_sync" },
        });
      }
    }

    return { scope_id, projected, skipped, failed, failures };
  };
}
