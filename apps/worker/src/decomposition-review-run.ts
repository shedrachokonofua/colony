import {
  buildTaskPacket,
  prepareSandboxToolEnvironment,
  selectRuntimeBinding,
  type AgentRunEnvironment,
  type AgentRuntimeAdapter,
  type DeployerRuntimeBinding,
} from "@colony/agent-runtime";
import {
  reviewerReviewEnvelopeSchema,
  type Freshness,
  type ReviewerReviewEnvelope,
} from "@colony/schemas";
import type {
  ProviderProjectRepository,
  TaskGraphRepository,
} from "@colony/db";
import {
  isScopeId,
  type ActorId,
  type ProviderProject,
  type Scope,
  type TaskId,
} from "@colony/domain";

/**
 * COL-3.0a Reviewer spec/DAG run.
 *
 * After Architect submits a decomposition proposal (status=`proposed`,
 * scope state=`decomposition_proposed`), this activity drives a fresh
 * Reviewer run against the proposal and records the verdict via
 * `repo.recordDecompositionReview`. Approved -> proposal moves to
 * `review_approved` (still gated by human approval before commit).
 * Changes requested -> proposal moves to `changes_requested` and the
 * scope returns to `draft` so a new architect run can be triggered.
 *
 * Packet shape: we reuse `TaskPacket` with a synthetic task_id of
 * `<scope_id>.0` (task numbers in real proposals start at .1, so .0 is
 * unambiguously a placeholder for "the spec/DAG itself"). The
 * proposed_tasks + proposed_dependencies are serialized into the goal /
 * acceptance_criteria so the Reviewer agent reads them as quoted
 * subject-under-review content. Output envelope validates against
 * `reviewerReviewEnvelopeSchema` with task_id matching the synthetic ID.
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;
const REVIEWER_ACTOR = "bot:reviewer" as ActorId;

const DEFAULT_DEPLOYER_BINDING: DeployerRuntimeBinding = {
  name: "local-permissive",
  environment: "local",
  networkPosture: "permissive",
  env: [],
  configMounts: [],
  credentialBindings: [],
  egress: [],
  serviceAccount: {
    name: "colony-sandbox-local",
    automountToken: true,
    rbacProfile: "none",
  },
};

export interface DecompositionReviewRunDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly agentRuntime: AgentRuntimeAdapter;
  readonly buildRunEnvironment?: (
    scope: Scope,
  ) => Promise<AgentRunEnvironment> | AgentRunEnvironment;
}

export interface StartDecompositionReviewRunInput {
  readonly scope_id: string;
  readonly proposal_id: string;
  readonly reviewer?: string;
}

export type StartDecompositionReviewRunResult =
  | {
      readonly started: false;
      readonly scope_id?: string;
      readonly proposal_id?: string;
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly scope_id: string;
      readonly proposal_id: string;
      readonly run_id: string;
      readonly envelope_status: "succeeded" | "envelope_rejected" | "failed";
      readonly review_result?:
        | "approved"
        | "changes_requested"
        | "blocked"
        | "escalate";
      readonly reason?: string;
    };

export function createDecompositionReviewRun(
  deps: DecompositionReviewRunDependencies,
) {
  return async function startDecompositionReviewRun(
    input: StartDecompositionReviewRunInput,
  ): Promise<StartDecompositionReviewRunResult> {
    if (!isScopeId(input.scope_id)) {
      return { started: false, reason: "invalid_scope_id" };
    }
    const scopeId = input.scope_id;
    const proposalId = input.proposal_id;
    const proposal = await deps.repo.getDecompositionProposal(
      scopeId,
      proposalId,
    );
    if (!proposal) {
      return {
        started: false,
        scope_id: scopeId,
        proposal_id: proposalId,
        reason: "proposal_not_found",
      };
    }
    if (proposal.status !== "proposed") {
      return {
        started: false,
        scope_id: scopeId,
        proposal_id: proposalId,
        reason: `proposal_not_awaiting_review:${proposal.status}`,
      };
    }
    const scope = await deps.repo.getScope(scopeId);
    if (!scope) {
      return {
        started: false,
        scope_id: scopeId,
        proposal_id: proposalId,
        reason: "scope_not_found",
      };
    }

    const targets = await deps.providerProjects.listScopeTargets(scopeId);
    const projects: ProviderProject[] = [];
    for (const target of targets) {
      const project = await deps.providerProjects.getProject(
        target.provider_project_id,
      );
      if (project) projects.push(project);
    }
    const primary = projects[0];

    const scopeMirrors = await deps.providerProjects.listMirrorsForColony({
      colony_id: scopeId,
      entity_kind: "scope",
    });
    const scopeMirror = scopeMirrors[0];

    const synthTaskId = `${scopeId}.0` as TaskId;
    const freshness = freshnessFor(scope, primary);

    const packet = buildTaskPacket({
      scope_id: scopeId,
      task_id: synthTaskId,
      provider_issue: scopeMirror
        ? {
            kind: "issue",
            id: scopeMirror.provider_id,
            uri: providerArtifactUri(
              scopeMirror.provider_project_path,
              scopeMirror.provider_id,
            ),
          }
        : { kind: "issue", id: scopeId, uri: scopeId },
      repo: {
        url: primary?.path ?? "internal",
        branch: primary?.default_branch ?? "main",
        base_commit: primary?.default_branch ?? "main",
      },
      goal: buildReviewGoal(scope, proposal),
      acceptance_criteria: SPEC_DAG_ACCEPTANCE_CRITERIA,
      non_goals: [
        "Do not propose new tasks; only evaluate the existing proposal.",
        "Do not write code; the reviewer's job is to flag DAG issues.",
      ],
      dependencies: [],
      provider_context: {
        provider: primary?.provider ?? "internal",
        issue_id: scopeMirror?.provider_id ?? scopeId,
        issue_url: scopeMirror
          ? providerArtifactUri(
              scopeMirror.provider_project_path,
              scopeMirror.provider_id,
            )
          : scopeId,
        labels: ["state:decomposition_proposed"],
        recent_comments: [
          {
            author: "bot:architect",
            posted_at: proposal.created_at,
            provider_id: `proposal:${proposal.id}`,
            body: serializeProposalForReview(proposal),
          },
        ],
      },
      memory_bundle: {
        decisions: [],
        semantic: [],
        procedural: [],
        policy: [],
      },
      policy: {
        constraints: [
          "Spec/DAG review: evaluate the proposed task list and dependency graph for completeness, soundness, and alignment with the scope brief.",
          'If the DAG is acceptable, set result="approved" with empty findings.',
          'If any task is missing, miswired, or has unverifiable acceptance criteria, set result="changes_requested" with one finding per issue.',
        ],
        protected_paths: [],
        security_labels: [],
        always_human_review: true,
        review_loop_cap: 3,
      },
      capabilities: ["graph.read"],
      required_outputs: [
        {
          kind: "review_envelope",
          description:
            "reviewer_review envelope for the spec/DAG (task_id must equal the synthetic <scope_id>.0)",
        },
      ],
      tool_permissions: [],
      sandbox_profile: "reviewer-default",
      known_risks: [],
      time_budget_minutes: 20,
      freshness,
    });

    const runEnvironment =
      (await deps.buildRunEnvironment?.(scope)) ??
      (await defaultReviewerEnvironment());

    const metadata = await deps.agentRuntime.startRun(packet, runEnvironment);
    if (metadata.status !== "succeeded") {
      await deps.repo.writeAudit({
        scope_id: scopeId,
        actor: SUPERVISOR_ACTOR,
        action: "decomposition.review.run_rejected",
        capability: "graph.write",
        target_kind: "agent_run",
        target_id: metadata.runId,
        reason: metadata.rejectionReason ?? `agent_run_${metadata.status}`,
        evidence: {
          run_id: metadata.runId,
          status: metadata.status,
          packet_hash: metadata.packetHash,
          rejection_reason: metadata.rejectionReason,
          proposal_id: proposalId,
        },
      });
      return {
        started: true,
        scope_id: scopeId,
        proposal_id: proposalId,
        run_id: metadata.runId,
        envelope_status:
          metadata.status === "envelope_rejected"
            ? "envelope_rejected"
            : "failed",
        reason: `agent_run_${metadata.status}`,
      };
    }

    const output = await deps.agentRuntime.getRunOutput(metadata.runId);
    const envelope = parseReviewerEnvelope(output?.envelope);
    if (!output || !envelope || envelope.task_id !== synthTaskId) {
      await deps.repo.writeAudit({
        scope_id: scopeId,
        actor: SUPERVISOR_ACTOR,
        action: "decomposition.review.envelope_rejected",
        capability: "graph.write",
        target_kind: "agent_run",
        target_id: metadata.runId,
        reason: "envelope_missing_or_mismatched",
        evidence: {
          run_id: metadata.runId,
          proposal_id: proposalId,
          envelope_task_id:
            (output?.envelope as { task_id?: string } | undefined)?.task_id ??
            null,
          expected_task_id: synthTaskId,
        },
      });
      return {
        started: true,
        scope_id: scopeId,
        proposal_id: proposalId,
        run_id: metadata.runId,
        envelope_status: "envelope_rejected",
        reason: "envelope_missing_or_mismatched",
      };
    }
    if (envelope.freshness.packet_hash !== packet.freshness.packet_hash) {
      await deps.repo.writeAudit({
        scope_id: scopeId,
        actor: SUPERVISOR_ACTOR,
        action: "decomposition.review.envelope_stale",
        capability: "graph.write",
        target_kind: "agent_run",
        target_id: metadata.runId,
        reason: "freshness_mismatch",
        evidence: {
          run_id: metadata.runId,
          proposal_id: proposalId,
          packet_hash: metadata.packetHash,
          envelope_packet_hash: envelope.freshness.packet_hash,
        },
      });
      return {
        started: true,
        scope_id: scopeId,
        proposal_id: proposalId,
        run_id: metadata.runId,
        envelope_status: "envelope_rejected",
        reason: "envelope_freshness_mismatch",
      };
    }

    const reviewer = (input.reviewer ?? REVIEWER_ACTOR) as ActorId;
    const reviewResult = mapReviewerResult(envelope.result);
    await deps.repo.recordDecompositionReview(
      {
        scope_id: scopeId,
        proposal_id: proposalId,
        envelope_hash: proposal.envelope_hash,
        reviewer,
        result: reviewResult,
      },
      {
        actor: reviewer,
        capability: "graph.write",
        reason: "decomposition_review_run",
      },
    );

    return {
      started: true,
      scope_id: scopeId,
      proposal_id: proposalId,
      run_id: metadata.runId,
      envelope_status: "succeeded",
      review_result: reviewResult,
    };
  };
}

const SPEC_DAG_ACCEPTANCE_CRITERIA: readonly string[] = [
  "Each proposed task has a unique proposed_task_id of the form <scope_id>.<n> with n >= 1.",
  "Acceptance criteria for each proposed task are specific and testable.",
  "Dependencies form a DAG with no cycles.",
  "The proposed decomposition covers the scope's stated goal and acceptance criteria.",
  "Open questions and assumptions are realistic and not load-bearing without human resolution.",
];

function buildReviewGoal(
  scope: Scope,
  proposal: NonNullable<
    Awaited<ReturnType<TaskGraphRepository["getDecompositionProposal"]>>
  >,
): string {
  return [
    `Review the proposed decomposition for scope ${scope.id} ("${scope.title}").`,
    `Proposal id: ${proposal.id}.`,
    "Approve when the proposed_tasks + proposed_dependencies form a sound, complete plan that matches the scope brief.",
    "Request changes when any task is missing, ambiguous, miswired, or has unverifiable acceptance criteria.",
  ].join(" ");
}

function serializeProposalForReview(
  proposal: NonNullable<
    Awaited<ReturnType<TaskGraphRepository["getDecompositionProposal"]>>
  >,
): string {
  return [
    `proposal_id: ${proposal.id}`,
    `scope_brief_version: ${proposal.scope_brief_version}`,
    "",
    "proposed_tasks:",
    JSON.stringify(proposal.proposed_tasks, null, 2),
    "",
    "proposed_dependencies:",
    JSON.stringify(proposal.proposed_dependencies, null, 2),
    "",
    "target_project_mapping:",
    JSON.stringify(proposal.target_project_mapping, null, 2),
    "",
    "architect_assumptions:",
    JSON.stringify(proposal.assumptions, null, 2),
    "",
    "architect_open_questions:",
    JSON.stringify(proposal.open_questions, null, 2),
  ].join("\n");
}

function parseReviewerEnvelope(
  envelope: unknown,
): ReviewerReviewEnvelope | null {
  const result = reviewerReviewEnvelopeSchema.safeParse(envelope);
  return result.success ? result.data : null;
}

function mapReviewerResult(
  envelopeResult: ReviewerReviewEnvelope["result"],
): "approved" | "changes_requested" | "blocked" | "escalate" {
  if (envelopeResult === "approved") return "approved";
  if (envelopeResult === "blocked") return "blocked";
  if (envelopeResult === "escalate") return "escalate";
  return "changes_requested";
}

function freshnessFor(
  scope: Scope,
  project: ProviderProject | undefined,
): Freshness {
  return {
    task_graph_version: `scope:${scope.state_version}`,
    provider_event_ts: new Date(0).toISOString(),
    commit_sha: project?.default_branch ?? "main",
    policy_version: "policy:1",
    memory_bundle_version: "memory:1",
    packet_hash: "sha256:packet-hash-uncomputed",
  };
}

function providerArtifactUri(
  projectPath: string | undefined,
  providerId: string,
): string {
  if (projectPath) return `${projectPath}/issues/${providerId}`;
  return providerId;
}

async function defaultReviewerEnvironment(): Promise<AgentRunEnvironment> {
  const tools = await prepareSandboxToolEnvironment(
    { skillMounts: [], cliTools: [] },
    {
      kind: "fallback",
      resolveTools: () => ({
        pathEntries: ["/colony/run-tools/bin"],
        profileHash: "sha256:tool-profile-decomp-review",
        toolVersions: {},
      }),
    },
  );
  return {
    role: "reviewer",
    sandboxProfile: "reviewer-default",
    runtimeBinding: selectRuntimeBinding(DEFAULT_DEPLOYER_BINDING),
    runExtensions: { skillMounts: [], cliTools: [] },
    tools,
  };
}
