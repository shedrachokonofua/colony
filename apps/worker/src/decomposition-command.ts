import type { TaskGraphRepository } from "@colony/db";
import { isScopeId, type ActorId } from "@colony/domain";

/**
 * COL-3.0a scope-level command application.
 *
 * The webhook dispatcher tags valid `/approve` and `/changes` comments
 * posted on a scope-level issue with `command_target=scope_decomposition`.
 * The Supervisor workflow forwards those commands here. We resolve them
 * to the right proposal lifecycle action:
 *
 *   /approve on a `proposed` proposal -> reject (architect output must be
 *     reviewer-approved before a human can sign off). The /approve was
 *     posted prematurely.
 *
 *   /approve on a `review_approved` proposal -> human approval; transitions
 *     to `human_approved` and primes the proposal for DAG commit.
 *
 *   /changes on a `proposed` proposal -> records a changes_requested review
 *     by the commenting human (treating the human as a reviewer of record);
 *     scope returns to `draft`.
 *
 *   /changes on a `review_approved` proposal -> human-side rejection;
 *     records a fresh review with the human's actor; scope back to draft.
 *
 *   /approve or /changes on a `committed` or already-`changes_requested`
 *     proposal -> noop; nothing to act on.
 *
 * Always idempotent in the sense that re-applying the same command on a
 * proposal already in the target state is a noop.
 */

export interface DecompositionCommandRunDependencies {
  readonly repo: TaskGraphRepository;
}

export interface ApplyDecompositionCommandInput {
  readonly scope_id: string;
  readonly action: "approve" | "changes";
  readonly actor: string;
  readonly reason?: string;
}

export type ApplyDecompositionCommandResult =
  | { readonly applied: false; readonly reason: string }
  | {
      readonly applied: true;
      readonly proposal_id: string;
      readonly action:
        | "review_recorded"
        | "human_approved"
        | "changes_requested";
    };

export function createApplyDecompositionCommand(
  deps: DecompositionCommandRunDependencies,
) {
  return async function applyDecompositionCommand(
    input: ApplyDecompositionCommandInput,
  ): Promise<ApplyDecompositionCommandResult> {
    if (!isScopeId(input.scope_id)) {
      return { applied: false, reason: "invalid_scope_id" };
    }
    const scopeId = input.scope_id;
    const proposal = await deps.repo.getLatestDecompositionProposal(scopeId);
    if (!proposal) {
      return { applied: false, reason: "no_active_proposal" };
    }
    const actor = input.actor as ActorId;

    if (input.action === "approve") {
      if (proposal.status === "review_approved") {
        // approveDecompositionProposal validates against the *live* scope
        // state_version, not the proposal's recorded value (the scope
        // moved on when the architect run flipped it to
        // `decomposition_proposed`).
        const scope = await deps.repo.getScope(scopeId);
        if (!scope) {
          return { applied: false, reason: "scope_not_found" };
        }
        const result = await deps.repo.approveDecompositionProposal(
          {
            scope_id: scopeId,
            proposal_id: proposal.id,
            expected_scope_state_version: scope.state_version,
            envelope_hash: proposal.envelope_hash,
          },
          {
            actor,
            capability: "graph.write",
            reason: input.reason ?? "scope_command_approve",
          },
        );
        return {
          applied: true,
          proposal_id: result.proposal.id,
          action: "human_approved",
        };
      }
      if (proposal.status === "human_approved") {
        return {
          applied: true,
          proposal_id: proposal.id,
          action: "human_approved",
        };
      }
      return {
        applied: false,
        reason: `proposal_not_human_approvable:${proposal.status}`,
      };
    }

    // changes — repo only allows status=proposed; tighten the gate here.
    if (proposal.status !== "proposed") {
      return {
        applied: false,
        reason: `proposal_not_open_to_changes:${proposal.status}`,
      };
    }
    await deps.repo.recordDecompositionReview(
      {
        scope_id: scopeId,
        proposal_id: proposal.id,
        envelope_hash: proposal.envelope_hash,
        reviewer: actor,
        result: "changes_requested",
      },
      {
        actor,
        capability: "graph.write",
        reason: input.reason ?? "scope_command_changes",
      },
    );
    return {
      applied: true,
      proposal_id: proposal.id,
      action: "changes_requested",
    };
  };
}
