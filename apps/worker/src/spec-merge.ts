import { ProviderProjectRepository, TaskGraphRepository } from "@colony/db";
import {
  isScopeId,
  type ActorId,
  type ProviderMirror,
  type ScopeId,
} from "@colony/domain";
import type {
  ProviderAdapter,
  ProviderMergeRequest,
  ProviderProjectRef,
} from "@colony/provider";

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

export interface MergeSpecMergeRequestInput {
  readonly scope_id: string;
  readonly proposal_id?: string;
}

export type MergeSpecMergeRequestResult =
  | {
      readonly merged: false;
      readonly scope_id?: string;
      readonly mr_id?: string;
      readonly reason: string;
      readonly detailed_merge_status?: string;
    }
  | {
      readonly merged: true;
      readonly scope_id: string;
      readonly mr_id?: string;
      readonly already_merged?: boolean;
      readonly already_closed?: boolean;
    };

export interface MergeSpecMergeRequestDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly providerAdapter: ProviderAdapter;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMergeSpecMergeRequest(
  deps: MergeSpecMergeRequestDependencies,
) {
  return async function mergeSpecMergeRequest(
    input: MergeSpecMergeRequestInput,
  ): Promise<MergeSpecMergeRequestResult> {
    if (!isScopeId(input.scope_id)) {
      return {
        merged: false,
        scope_id: input.scope_id,
        reason: "invalid_scope_id",
      };
    }

    const proposals = await deps.repo.listDecompositionProposals(
      input.scope_id,
    );
    const proposal = input.proposal_id
      ? proposals.find((candidate) => candidate.id === input.proposal_id)
      : proposals[0];
    const evidence = {
      envelope_hash: proposal?.envelope_hash ?? null,
      reviewer_result: proposal?.reviewer_result ?? null,
      proposal_id: proposal?.id ?? input.proposal_id ?? null,
    };

    const mrMirror = (
      await deps.providerProjects.listMirrorsForColony({
        colony_id: input.scope_id,
        entity_kind: "mr_pr",
      })
    )[0];
    if (!mrMirror) {
      await deps.repo.writeAudit({
        scope_id: input.scope_id,
        actor: SUPERVISOR_ACTOR,
        action: "architect.spec_mr.merge_failed",
        capability: "provider.mr.merge",
        target_kind: "decomposition_proposal",
        target_id: proposal?.id ?? input.scope_id,
        reason: "spec_mr_mirror_not_found",
        evidence,
      });
      return {
        merged: false,
        scope_id: input.scope_id,
        reason: "spec_mr_mirror_not_found",
      };
    }

    const project = await resolveProject(deps, mrMirror, input.scope_id);
    if (!project) {
      await writeMergeFailureAudit(
        deps.repo,
        input.scope_id,
        mrMirror,
        "provider_project_not_found",
        evidence,
      );
      return {
        merged: false,
        scope_id: input.scope_id,
        mr_id: mrMirror.provider_id,
        reason: "provider_project_not_found",
      };
    }
    if (project.provider !== deps.providerAdapter.provider) {
      await writeMergeFailureAudit(
        deps.repo,
        input.scope_id,
        mrMirror,
        "provider_adapter_mismatch",
        { ...evidence, provider: project.provider },
      );
      return {
        merged: false,
        scope_id: input.scope_id,
        mr_id: mrMirror.provider_id,
        reason: "provider_adapter_mismatch",
      };
    }

    const projectRef: ProviderProjectRef = {
      id: project.provider_id,
      path: project.path,
    };
    let currentMr: ProviderMergeRequest;
    try {
      currentMr = await deps.providerAdapter.mergeRequests.get(
        projectRef,
        mrMirror.provider_id,
      );
    } catch (error) {
      const reason = `provider_mr_get_failed:${errorReason(error)}`;
      await writeMergeFailureAudit(
        deps.repo,
        input.scope_id,
        mrMirror,
        reason,
        {
          ...evidence,
          provider: project.provider,
          provider_project_id: project.id,
        },
      );
      return {
        merged: false,
        scope_id: input.scope_id,
        mr_id: mrMirror.provider_id,
        reason,
      };
    }

    // Closed and merged MRs are terminal. Never call merge/close/reopen for
    // these states: Temporal retries must be safe and unattended replays must
    // not mutate an already-terminal provider artifact.
    if (currentMr.state === "merged" || currentMr.merged === true) {
      return {
        merged: true,
        scope_id: input.scope_id,
        mr_id: mrMirror.provider_id,
        already_merged: true,
      };
    }
    if (currentMr.state === "closed") {
      return {
        merged: true,
        scope_id: input.scope_id,
        mr_id: mrMirror.provider_id,
        already_closed: true,
      };
    }

    let mergeResult: ProviderMergeRequest;
    try {
      // The adapter owns mergeability preflight and bounded polling. Do not
      // retry provider 405/409 responses here; preserve its typed reason.
      mergeResult = await deps.providerAdapter.mergeRequests.merge(
        projectRef,
        mrMirror.provider_id,
      );
    } catch (error) {
      const reason = `provider_mr_merge_error:${errorReason(error)}`;
      await writeMergeFailureAudit(
        deps.repo,
        input.scope_id,
        mrMirror,
        reason,
        {
          ...evidence,
          provider: project.provider,
          provider_project_id: project.id,
          commit_sha: currentMr.head_commit_sha,
        },
      );
      return {
        merged: false,
        scope_id: input.scope_id,
        mr_id: mrMirror.provider_id,
        reason,
      };
    }

    if (mergeResult.merged === true || mergeResult.state === "merged") {
      await deps.repo.writeAudit({
        scope_id: input.scope_id,
        actor: SUPERVISOR_ACTOR,
        action: "architect.spec_mr.merged",
        capability: "provider.mr.merge",
        target_kind: "merge_request",
        target_id: mrMirror.provider_id,
        reason: "spec_mr_merged_after_dag_commit",
        evidence: {
          ...evidence,
          provider: project.provider,
          provider_project_id: project.id,
          commit_sha: mergeResult.head_commit_sha ?? currentMr.head_commit_sha,
          detailed_merge_status: mergeResult.detailed_merge_status,
        },
      });
      return {
        merged: true,
        scope_id: input.scope_id,
        mr_id: mrMirror.provider_id,
      };
    }

    const reason =
      mergeResult.reason ??
      mergeResult.detailed_merge_status ??
      "merge_not_completed";
    await writeMergeFailureAudit(deps.repo, input.scope_id, mrMirror, reason, {
      ...evidence,
      provider: project.provider,
      provider_project_id: project.id,
      commit_sha: mergeResult.head_commit_sha ?? currentMr.head_commit_sha,
      detailed_merge_status: mergeResult.detailed_merge_status,
    });
    return {
      merged: false,
      scope_id: input.scope_id,
      mr_id: mrMirror.provider_id,
      reason,
      detailed_merge_status: mergeResult.detailed_merge_status,
    };
  };
}

async function resolveProject(
  deps: MergeSpecMergeRequestDependencies,
  mirror: ProviderMirror,
  scope_id: string,
) {
  if (mirror.provider_project_id) {
    const project = await deps.providerProjects.getProject(
      mirror.provider_project_id,
    );
    if (project) return project;
  }
  const targets = await deps.providerProjects.listScopeTargets(
    scope_id as ScopeId,
  );
  for (const target of targets) {
    const project = await deps.providerProjects.getProject(
      target.provider_project_id,
    );
    if (project) return project;
  }
  return null;
}

async function writeMergeFailureAudit(
  repo: TaskGraphRepository,
  scope_id: string,
  mirror: ProviderMirror,
  reason: string,
  evidence: Readonly<Record<string, unknown>>,
): Promise<void> {
  await repo.writeAudit({
    scope_id: scope_id as ScopeId,
    actor: SUPERVISOR_ACTOR,
    action: "architect.spec_mr.merge_failed",
    capability: "provider.mr.merge",
    target_kind: "merge_request",
    target_id: mirror.provider_id,
    reason,
    evidence,
  });
}
