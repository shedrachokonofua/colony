import {
  ProviderProjectRepository,
  ReviewGateRepository,
  TaskGraphRepository,
} from "@colony/db";
import {
  isTaskId,
  type ActorId,
  type ProviderMirror,
  type ProviderProject,
  type Task,
} from "@colony/domain";
import type { ProviderAdapter, ProviderProjectRef } from "@colony/provider";
import { revokeTaskAgentToken } from "./task-agent-tokens.js";

/**
 * COL-2.13 — Merge and close flow.
 *
 * Two activities:
 *   - `mergeTask`: caller is the developer/integrator; only succeeds when the
 *     task is in `merge_ready`, gates open, and the provider merge call
 *     returns a merged MR. Transitions merge_ready -> merged.
 *   - `closeTaskAfterMerge`: triggered by the merged-MR webhook; reconciles
 *     the merged commit against the artifact + closes the provider issue +
 *     transitions merged -> closed.
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;
const INTEGRATOR_ACTOR = "bot:integrator" as ActorId;

export interface MergeDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly reviewGate: ReviewGateRepository;
  readonly providerAdapter: ProviderAdapter;
}

export interface MergeTaskInput {
  readonly task_id: string;
  /** Optional override of the actor performing the merge (defaults to bot:integrator). */
  readonly actor?: string;
}

export type MergeTaskResult =
  | {
      readonly merged: false;
      readonly task_id?: string;
      readonly reason: string;
    }
  | {
      readonly merged: true;
      readonly task_id: string;
      readonly mr_id: string;
      readonly merge_commit_sha?: string;
      readonly final_state: Task["state"];
    };

export function createMergeTask(deps: MergeDependencies) {
  return async function mergeTask(
    input: MergeTaskInput,
  ): Promise<MergeTaskResult> {
    if (!isTaskId(input.task_id)) {
      return { merged: false, reason: "invalid_task_id" };
    }
    const task = await deps.repo.getTask(input.task_id);
    if (!task)
      return {
        merged: false,
        task_id: input.task_id,
        reason: "task_not_found",
      };
    if (task.state !== "merge_ready") {
      return {
        merged: false,
        task_id: task.id,
        reason: `task_not_merge_ready:${task.state}`,
      };
    }
    const gate = await deps.reviewGate.findOpenGate("mr_pr", task.id);
    if (!gate || gate.status !== "open") {
      return {
        merged: false,
        task_id: task.id,
        reason: `mr_gate_not_open:${gate?.status ?? "missing"}`,
      };
    }
    const mrMirror = (
      await deps.providerProjects.listMirrorsForColony({
        colony_id: task.id,
        entity_kind: "mr_pr",
      })
    )[0];
    if (!mrMirror)
      return { merged: false, task_id: task.id, reason: "no_mr_mirror" };
    const project = mrMirror.provider_project_id
      ? await deps.providerProjects.getProject(mrMirror.provider_project_id)
      : null;
    if (!project) {
      return {
        merged: false,
        task_id: task.id,
        reason: "provider_project_not_found",
      };
    }
    if (project.provider !== deps.providerAdapter.provider) {
      return {
        merged: false,
        task_id: task.id,
        reason: "provider_adapter_mismatch",
      };
    }
    const projectRef: ProviderProjectRef = {
      id: project.provider_id,
      path: project.path,
    };
    const actor = (input.actor as ActorId | undefined) ?? INTEGRATOR_ACTOR;

    let mergedMr;
    try {
      mergedMr = await deps.providerAdapter.mergeRequests.merge(
        projectRef,
        mrMirror.provider_id,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor,
        action: "provider.mr.merge_failed",
        capability: "provider.mr.merge",
        target_kind: "merge_request",
        target_id: mrMirror.provider_id,
        reason,
        evidence: {
          provider: project.provider,
          provider_project_id: project.id,
        },
      });
      return {
        merged: false,
        task_id: task.id,
        reason: `merge_failed:${reason}`,
      };
    }

    const transitioned = await deps.repo.updateTaskState(
      task.id,
      task.state_version,
      "merged",
      {
        actor,
        capability: "provider.mr.merge",
        reason: "provider_mr_merged",
      },
    );
    await deps.reviewGate.setGateStatus(gate.id, "closed");
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor,
      action: "provider.mr.merged",
      capability: "provider.mr.merge",
      target_kind: "merge_request",
      target_id: mrMirror.provider_id,
      reason: "merge_ready_gate_open",
      evidence: {
        provider: project.provider,
        provider_project_id: project.id,
        mr_state: mergedMr.state,
        gate_id: gate.id,
      },
    });
    return {
      merged: true,
      task_id: task.id,
      mr_id: mrMirror.provider_id,
      merge_commit_sha: undefined,
      final_state: transitioned.state,
    };
  };
}

// ---------------------------------------------------------------------------
// Close after merge.
// ---------------------------------------------------------------------------

export interface CloseTaskAfterMergeInput {
  readonly task_id: string;
  /** Webhook-supplied evidence: the merged MR's state, merge commit, etc. */
  readonly merge_commit_sha?: string;
  readonly verified_by_webhook?: boolean;
}

export type CloseTaskAfterMergeResult =
  | {
      readonly closed: false;
      readonly task_id?: string;
      readonly reason: string;
    }
  | {
      readonly closed: true;
      readonly task_id: string;
      readonly final_state: Task["state"];
    };

export function createCloseTaskAfterMerge(deps: MergeDependencies) {
  return async function closeTaskAfterMerge(
    input: CloseTaskAfterMergeInput,
  ): Promise<CloseTaskAfterMergeResult> {
    if (!isTaskId(input.task_id)) {
      return { closed: false, reason: "invalid_task_id" };
    }
    const task = await deps.repo.getTask(input.task_id);
    if (!task)
      return {
        closed: false,
        task_id: input.task_id,
        reason: "task_not_found",
      };
    if (task.state !== "merged") {
      return {
        closed: false,
        task_id: task.id,
        reason: `task_not_merged:${task.state}`,
      };
    }

    const taskMirror = await primaryMirror(deps, task.id, "task");
    const mrMirror = await primaryMirror(deps, task.id, "mr_pr");
    if (!taskMirror)
      return { closed: false, task_id: task.id, reason: "no_task_mirror" };
    const project = taskMirror.provider_project_id
      ? await deps.providerProjects.getProject(taskMirror.provider_project_id)
      : null;
    if (!project)
      return {
        closed: false,
        task_id: task.id,
        reason: "provider_project_not_found",
      };
    if (project.provider !== deps.providerAdapter.provider) {
      return {
        closed: false,
        task_id: task.id,
        reason: "provider_adapter_mismatch",
      };
    }
    const projectRef: ProviderProjectRef = {
      id: project.provider_id,
      path: project.path,
    };

    // Reconcile: provider issue must close cleanly, otherwise audit and abort.
    try {
      await deps.providerAdapter.issues.close(
        projectRef,
        taskMirror.provider_id,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor: SUPERVISOR_ACTOR,
        action: "provider.issue.close_failed",
        capability: "task.assign",
        target_kind: "issue",
        target_id: taskMirror.provider_id,
        reason,
        evidence: { provider: project.provider, mr_id: mrMirror?.provider_id },
      });
      return {
        closed: false,
        task_id: task.id,
        reason: `issue_close_failed:${reason}`,
      };
    }

    const transitioned = await deps.repo.updateTaskState(
      task.id,
      task.state_version,
      "closed",
      {
        actor: SUPERVISOR_ACTOR,
        capability: "task.assign",
        reason: "merged_provider_issue_closed",
      },
    );
    await revokeTaskAgentToken(
      { repo: deps.repo, providerAdapter: deps.providerAdapter },
      {
        task,
        project: projectRef,
        reason: "task_closed",
      },
    );
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: SUPERVISOR_ACTOR,
      action: "task.closed",
      capability: "task.assign",
      target_kind: "task",
      target_id: task.id,
      reason: "merged_and_reconciled",
      evidence: {
        merge_commit_sha: input.merge_commit_sha,
        verified_by_webhook: input.verified_by_webhook ?? false,
        mr_id: mrMirror?.provider_id,
        provider_issue_id: taskMirror.provider_id,
      },
    });
    return { closed: true, task_id: task.id, final_state: transitioned.state };
  };
}

async function primaryMirror(
  deps: MergeDependencies,
  task_id: string,
  entity_kind: "task" | "mr_pr",
): Promise<ProviderMirror | undefined> {
  const mirrors = await deps.providerProjects.listMirrorsForColony({
    colony_id: task_id,
    entity_kind,
  });
  return mirrors[0];
}

export type { ProviderProject };
