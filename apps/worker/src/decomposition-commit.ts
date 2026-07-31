import { TaskGraphRepository } from "@colony/db";
import { isScopeId, type ActorId } from "@colony/domain";

export interface CommitDecompositionProposalInput {
  readonly scope_id: string;
  readonly proposal_id: string;
  readonly actor: string;
  readonly reason?: string;
}

export type CommitDecompositionProposalResult =
  | {
      readonly committed: false;
      readonly scope_id?: string;
      readonly proposal_id?: string;
      readonly reason: string;
    }
  | {
      readonly committed: true;
      readonly scope_id: string;
      readonly proposal_id: string;
      readonly task_count: number;
      readonly dependency_count: number;
      readonly already_committed?: boolean;
    };

export interface CommitDecompositionProposalDependencies {
  readonly repo: TaskGraphRepository;
}

export function createCommitDecompositionProposal(
  deps: CommitDecompositionProposalDependencies,
) {
  return async function commitDecompositionProposal(
    input: CommitDecompositionProposalInput,
  ): Promise<CommitDecompositionProposalResult> {
    if (!isScopeId(input.scope_id)) {
      return {
        committed: false,
        scope_id: input.scope_id,
        proposal_id: input.proposal_id,
        reason: "invalid_scope_id",
      };
    }
    const proposal = await deps.repo.getDecompositionProposal(
      input.scope_id,
      input.proposal_id,
    );
    if (!proposal) {
      return {
        committed: false,
        scope_id: input.scope_id,
        proposal_id: input.proposal_id,
        reason: "proposal_not_found",
      };
    }
    if (proposal.status === "committed") {
      return {
        committed: true,
        scope_id: input.scope_id,
        proposal_id: proposal.id,
        task_count: proposal.proposed_tasks.length,
        dependency_count: proposal.proposed_dependencies.length,
        already_committed: true,
      };
    }
    const scope = await deps.repo.getScope(input.scope_id);
    if (!scope) {
      return {
        committed: false,
        scope_id: input.scope_id,
        proposal_id: input.proposal_id,
        reason: "scope_not_found",
      };
    }
    try {
      const result = await deps.repo.commitDecompositionProposal(
        {
          scope_id: input.scope_id,
          proposal_id: proposal.id,
          expected_scope_state_version: scope.state_version,
          envelope_hash: proposal.envelope_hash,
        },
        {
          actor: input.actor as ActorId,
          capability: "graph.write",
          reason: input.reason ?? "decomposition_commit",
        },
      );
      return {
        committed: true,
        scope_id: input.scope_id,
        proposal_id: result.proposal.id,
        task_count: result.tasks.length,
        dependency_count: result.dependencies.length,
      };
    } catch (error) {
      return {
        committed: false,
        scope_id: input.scope_id,
        proposal_id: input.proposal_id,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
