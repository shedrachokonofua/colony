import {
  FakeAgentRuntimeAdapter,
  buildReviewPacket,
  hashEnvelope,
  prepareSandboxToolEnvironment,
  selectRuntimeBinding,
  type AgentRunEnvironment,
  type AgentRunMetadata,
  type AgentRuntimeAdapter,
  type DeployerRuntimeBinding,
} from "@colony/agent-runtime";
import {
  reviewerReviewEnvelopeSchema,
  type DeveloperCompletionEnvelope,
  type Freshness,
  type ReviewerReviewEnvelope,
} from "@colony/schemas";
import {
  ProviderProjectRepository,
  ReviewGateRepository,
  TaskGraphRepository,
} from "@colony/db";
import {
  isTaskId,
  type ActorId,
  type ArtifactId,
  type ProviderMirror,
  type ProviderProject,
  type Task,
} from "@colony/domain";
import type {
  ProviderAdapter,
  ProviderMergeRequest,
  ProviderProjectRef,
} from "@colony/provider";
import {
  mintTaskAgentToken,
  revokeTaskAgentToken,
} from "./task-agent-tokens.js";

/**
 * COL-2.11 Reviewer execution flow.
 *
 * Triggered after the developer flow has moved a task to `review_requested`
 * and has opened an MR mirror. Builds a ReviewPacket, runs the Reviewer
 * agent, posts a provider comment with approval / changes-requested, and
 * persists a `reviews` row plus (on approval) an `approvals` row keyed to
 * the MR artifact. Task transitions:
 *   review_requested -> changes_requested  (envelope.result = changes_requested)
 *   review_requested stays                 (envelope.result = approved; gate still
 *                                            needs human approval + green pipeline
 *                                            before merge_ready)
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

const DEFAULT_REVIEWER_BINDING: DeployerRuntimeBinding = {
  name: "local-permissive",
  environment: "local",
  networkPosture: "permissive",
  env: [],
  configMounts: [],
  credentialBindings: [
    {
      name: "git-provider",
      capability: "provider.mr.comment",
      env: "COLONY_TOOL_GATEWAY_TOKEN",
      broker: "tool-gateway",
    },
  ],
  egress: [
    { name: "tool-gateway", kind: "service", target: "colony-tool-gateway" },
  ],
  serviceAccount: {
    name: "colony-sandbox-local",
    automountToken: true,
    rbacProfile: "none",
  },
};

export interface ReviewerRunDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly reviewGate: ReviewGateRepository;
  readonly providerAdapter: ProviderAdapter;
  readonly agentRuntime: AgentRuntimeAdapter;
  readonly buildRunEnvironment?: (
    task: Task,
  ) => Promise<AgentRunEnvironment> | AgentRunEnvironment;
}

export interface StartReviewerRunInput {
  readonly task_id: string;
  readonly reviewer: string;
  /** Latest developer completion envelope; needed for the review packet. */
  readonly developer_envelope: DeveloperCompletionEnvelope;
}

export type StartReviewerRunResult =
  | {
      readonly started: false;
      readonly task_id?: string;
      readonly envelope_status?: "failed";
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly task_id: string;
      readonly run_id: string;
      readonly review_id: string;
      readonly envelope_status: "succeeded" | "envelope_rejected" | "failed";
      readonly outcome?:
        | "approved"
        | "changes_requested"
        | "blocked"
        | "escalate";
      readonly review_result?:
        | "approved"
        | "changes_requested"
        | "blocked"
        | "escalate";
      readonly final_state: Task["state"];
      readonly comment_id?: string;
      readonly reason?: string;
    };

export function createReviewerRun(deps: ReviewerRunDependencies) {
  return async function startReviewerRun(
    input: StartReviewerRunInput,
  ): Promise<StartReviewerRunResult> {
    if (!isTaskId(input.task_id)) {
      return { started: false, reason: "invalid_task_id" };
    }
    const task = await deps.repo.getTask(input.task_id);
    if (!task) {
      return {
        started: false,
        task_id: input.task_id,
        reason: "task_not_found",
      };
    }
    if (task.state !== "review_requested") {
      return {
        started: false,
        task_id: task.id,
        reason: `task_not_in_review:${task.state}`,
      };
    }

    const taskMirror = await primaryMirror(deps, task.id, "task");
    const mrMirror = await primaryMirror(deps, task.id, "mr_pr");
    if (!mrMirror) {
      return {
        started: false,
        task_id: task.id,
        reason: "task_has_no_mr_mirror",
      };
    }
    if (!taskMirror?.provider_project_id) {
      return {
        started: false,
        task_id: task.id,
        reason: "task_has_no_provider_mirror",
      };
    }
    const project = await deps.providerProjects.getProject(
      taskMirror.provider_project_id,
    );
    if (!project) {
      return {
        started: false,
        task_id: task.id,
        reason: "provider_project_not_found",
      };
    }
    if (project.provider !== deps.providerAdapter.provider) {
      return {
        started: false,
        task_id: task.id,
        reason: "provider_adapter_mismatch",
      };
    }

    const projectRef: ProviderProjectRef = {
      id: project.provider_id,
      path: project.path,
    };
    let agentToken: Awaited<ReturnType<typeof mintTaskAgentToken>> | null =
      null;
    let taskForTokenCleanup: Task | null = null;
    let persistedRunId: string | undefined;
    let terminalStatus: "succeeded" | "failed" | "envelope_rejected" = "failed";
    let terminalEnvelopeHash: string | undefined;
    try {
      agentToken = await mintTaskAgentToken(
        {
          repo: deps.repo,
          providerAdapter: deps.providerAdapter,
        },
        {
          task,
          project: projectRef,
          options: {
            purpose: "reader",
            reason: "reviewer_run_token_minted",
          },
        },
      );
      if (agentToken) {
        taskForTokenCleanup = {
          ...task,
          agent_token_project_id: agentToken.provider_project_id,
          agent_token_id: agentToken.token_id,
          agent_token_expires_at: agentToken.expires_at,
          agent_token_revoked_at: undefined,
        };
      }
    } catch (err) {
      return {
        started: false,
        task_id: task.id,
        reason: `agent_token_mint_failed:${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      let mr: ProviderMergeRequest;
      try {
        mr = await deps.providerAdapter.mergeRequests.get(
          projectRef,
          mrMirror.provider_id,
        );
      } catch (err) {
        await deps.repo.writeAudit({
          scope_id: task.scope_id,
          task_id: task.id,
          actor: SUPERVISOR_ACTOR,
          action: "reviewer.mr.fetch_failed",
          capability: "provider.commits.read",
          target_kind: "merge_request",
          target_id: mrMirror.provider_id,
          reason: "mr_fetch_failed",
          evidence: {
            provider: project.provider,
            message: err instanceof Error ? err.message : String(err),
          },
        });
        return {
          started: false,
          task_id: task.id,
          envelope_status: "failed",
          reason: "mr_fetch_failed",
        };
      }
      const commit_sha = developerCommitFromEnvelope(input.developer_envelope);

      // Persist (or upsert) the MR artifact so reviews/approvals can hang off it.
      const artifact = await deps.reviewGate.upsertArtifact({
        kind: "mr",
        provider: project.provider,
        provider_id: mrMirror.provider_id,
        uri: `${project.path}/merge_requests/${mrMirror.provider_id}`,
        scope_id: task.scope_id,
        task_id: task.id,
        hash: commit_sha,
      });

      const review = await deps.reviewGate.createReview({
        task_id: task.id,
        artifact_id: artifact.id,
        reviewer: input.reviewer as ActorId,
      });
      await deps.repo.recordEvent({
        scope_id: task.scope_id,
        task_id: task.id,
        kind: "review_requested",
        actor: SUPERVISOR_ACTOR,
        payload: {
          review_id: review.id,
          reviewer: input.reviewer,
          mr_id: mrMirror.provider_id,
        },
      });

      const freshness = freshnessFor(task, project, input.developer_envelope);
      let diff_summary: string;
      try {
        diff_summary = await fetchDiffSummary(
          deps.providerAdapter,
          { id: project.provider_id, path: project.path },
          mrMirror.provider_id,
        );
      } catch (err) {
        await deps.repo.writeAudit({
          scope_id: task.scope_id,
          task_id: task.id,
          actor: SUPERVISOR_ACTOR,
          action: "reviewer.diff.fetch_failed",
          capability: "provider.commits.read",
          target_kind: "merge_request",
          target_id: mrMirror.provider_id,
          reason: "diff_fetch_failed",
          evidence: {
            provider: project.provider,
            message: err instanceof Error ? err.message : String(err),
          },
        });
        return {
          started: false,
          task_id: task.id,
          envelope_status: "failed",
          reason: "diff_fetch_failed",
        };
      }

      const packet = buildReviewPacket({
        scope_id: task.scope_id,
        task_id: task.id,
        provider_issue: {
          kind: "issue",
          id: taskMirror.provider_id,
          uri: taskMirror.provider_project_path
            ? `${taskMirror.provider_project_path}/issues/${taskMirror.provider_id}`
            : taskMirror.provider_id,
        },
        repo: {
          url: project.path,
          branch: mr?.source_branch || project.default_branch,
          base_commit: commit_sha,
          ...(agentToken ? { credentials: { token: agentToken.token } } : {}),
        },
        goal: task.title,
        acceptance_criteria: task.acceptance_criteria,
        non_goals: task.non_goals,
        dependencies: [],
        provider_context: {
          provider: project.provider,
          issue_id: taskMirror.provider_id,
          issue_url: taskMirror.provider_project_path
            ? `${taskMirror.provider_project_path}/issues/${taskMirror.provider_id}`
            : taskMirror.provider_id,
          labels: ["agent:reviewer", "state:review_requested"],
          recent_comments: [],
        },
        memory_bundle: {
          decisions: [],
          semantic: [],
          procedural: [],
          policy: [],
        },
        policy: {
          constraints: ["Stay inside the task acceptance criteria."],
          protected_paths: [],
          security_labels: [],
          always_human_review: false,
          review_loop_cap: 3,
        },
        capabilities: ["provider.mr.comment", "provider.mr.approve"],
        required_outputs: [
          {
            kind: "review_envelope",
            description: "approval or changes-requested review envelope",
          },
        ],
        tool_permissions: ["git"],
        sandbox_profile: "reviewer-default",
        known_risks: [],
        time_budget_minutes: 30,
        mr_id: mrMirror.provider_id,
        commit_sha,
        diff_summary,
        developer_envelope: input.developer_envelope,
        pipeline_artifacts: [],
        freshness,
      });

      const runEnvironment =
        (await deps.buildRunEnvironment?.(task)) ??
        (await defaultReviewerEnvironment());
      const persistedRun = await deps.repo.startAgentRun({
        task_id: task.id,
        review_id: review.id,
        role: "reviewer",
        packet_hash: packet.freshness.packet_hash,
      });
      persistedRunId = persistedRun.id;
      let metadata: AgentRunMetadata;
      try {
        metadata = await deps.agentRuntime.startRun(packet, runEnvironment);
      } finally {
        if (taskForTokenCleanup) {
          await revokeTaskAgentToken(
            {
              repo: deps.repo,
              providerAdapter: deps.providerAdapter,
            },
            {
              task: taskForTokenCleanup,
              project: projectRef,
              reason: "reviewer_run_finished",
            },
          );
        }
      }
      if (metadata.status !== "succeeded") {
        terminalStatus =
          metadata.status === "envelope_rejected"
            ? "envelope_rejected"
            : "failed";
        await deps.repo.writeAudit({
          scope_id: task.scope_id,
          task_id: task.id,
          actor: SUPERVISOR_ACTOR,
          action: "reviewer.run.rejected",
          capability: "task.assign",
          target_kind: "agent_run",
          target_id: metadata.runId,
          reason: metadata.rejectionReason ?? "envelope_rejected",
          evidence: {
            run_id: metadata.runId,
            status: metadata.status,
            packet_hash: metadata.packetHash,
            review_id: review.id,
            rejection_reason: metadata.rejectionReason,
          },
        });
        return {
          started: true,
          task_id: task.id,
          run_id: metadata.runId,
          review_id: review.id,
          envelope_status:
            metadata.status === "envelope_rejected"
              ? "envelope_rejected"
              : "failed",
          final_state: task.state,
          reason: metadata.rejectionReason ?? `agent_run_${metadata.status}`,
        };
      }

      const output = await deps.agentRuntime.getRunOutput(metadata.runId);
      const envelope = parseReviewerEnvelope(output?.envelope);
      if (!output || !envelope || envelope.task_id !== task.id) {
        terminalStatus = "envelope_rejected";
        await deps.repo.writeAudit({
          scope_id: task.scope_id,
          task_id: task.id,
          actor: SUPERVISOR_ACTOR,
          action: "reviewer.envelope.rejected",
          capability: "task.assign",
          target_kind: "agent_run",
          target_id: metadata.runId,
          reason: "envelope_missing_or_mismatched",
          evidence: { run_id: metadata.runId, review_id: review.id },
        });
        return {
          started: true,
          task_id: task.id,
          run_id: metadata.runId,
          review_id: review.id,
          envelope_status: "envelope_rejected",
          final_state: task.state,
          reason: "envelope_missing_or_mismatched",
        };
      }
      if (envelope.freshness.packet_hash !== packet.freshness.packet_hash) {
        terminalStatus = "envelope_rejected";
        await deps.repo.writeAudit({
          scope_id: task.scope_id,
          task_id: task.id,
          actor: SUPERVISOR_ACTOR,
          action: "reviewer.envelope.stale",
          capability: "task.assign",
          target_kind: "agent_run",
          target_id: metadata.runId,
          reason: "freshness_mismatch",
          evidence: {
            run_id: metadata.runId,
            packet_hash: metadata.packetHash,
            envelope_packet_hash: envelope.freshness.packet_hash,
            review_id: review.id,
          },
        });
        return {
          started: true,
          task_id: task.id,
          run_id: metadata.runId,
          review_id: review.id,
          envelope_status: "envelope_rejected",
          final_state: task.state,
          reason: "envelope_freshness_mismatch",
        };
      }

      const reviewResult = mapEnvelopeResult(envelope.result);
      const envelopeHash = output.envelopeHash ?? hashEnvelope(envelope);
      await deps.reviewGate.resolveReview({
        id: review.id,
        result: reviewResult,
        envelope_hash: envelopeHash,
      });
      await deps.repo.recordCodeReview(
        {
          task_id: task.id,
          envelope_hash: envelopeHash,
          result: reviewResult,
          envelope,
        },
        {
          actor: input.reviewer as ActorId,
          capability: "task.assign",
          reason: "reviewer_review",
        },
      );
      await deps.repo.recordEvent({
        scope_id: task.scope_id,
        task_id: task.id,
        kind: "review_resolved",
        actor: SUPERVISOR_ACTOR,
        payload: {
          review_id: review.id,
          result: reviewResult,
          envelope_hash: envelopeHash,
          finding_count: envelope.role_specific.findings.length,
        },
      });

      const comment = await postReviewComment({
        adapter: deps.providerAdapter,
        project: projectRef,
        mrId: mrMirror.provider_id,
        envelope,
      });

      let nextState: Task["state"] = task.state;
      if (reviewResult === "changes_requested") {
        const transitioned = await deps.repo.updateTaskState(
          task.id,
          task.state_version,
          "changes_requested",
          {
            actor: SUPERVISOR_ACTOR,
            capability: "task.assign",
            reason: "reviewer_changes_requested",
          },
        );
        nextState = transitioned.state;
        await deps.reviewGate.invalidateApprovals({
          artifact_id: artifact.id,
          reason: "changes_requested",
        });
      } else if (reviewResult === "approved") {
        // Record reviewer approval against the MR artifact at the developer head.
        await deps.reviewGate.recordApproval({
          artifact_id: artifact.id,
          actor: input.reviewer as ActorId,
          commit_sha,
        });
        // Mirror the approval to the provider's MR so the GitLab UI shows
        // the approval count, not just the comment thread. Best-effort:
        // the colony-side approval is the source of truth for the gate.
        await deps.providerAdapter.mergeRequests
          .approve(projectRef, mrMirror.provider_id)
          .catch((err) => {
            void deps.repo.writeAudit({
              scope_id: task.scope_id,
              task_id: task.id,
              actor: SUPERVISOR_ACTOR,
              action: "review.provider_approve_failed",
              capability: "task.assign",
              target_kind: "merge_request",
              target_id: mrMirror.provider_id,
              reason: err instanceof Error ? err.message : String(err),
              evidence: {
                provider: project.provider,
                mr_id: mrMirror.provider_id,
              },
            });
          });
      }

      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor: SUPERVISOR_ACTOR,
        action:
          reviewResult === "changes_requested"
            ? "review.changes_requested"
            : reviewResult === "blocked"
              ? "review.blocked"
              : reviewResult === "escalate"
                ? "review.escalated"
                : "review.approved",
        capability: "task.assign",
        target_kind: "review",
        target_id: review.id,
        reason: `reviewer_envelope_${reviewResult}`,
        evidence: {
          run_id: metadata.runId,
          envelope_hash: envelopeHash,
          review_id: review.id,
          artifact_id: artifact.id,
          comment_id: comment?.id,
          finding_count: envelope.role_specific.findings.length,
        },
      });
      terminalStatus = "succeeded";
      terminalEnvelopeHash = envelopeHash;

      return {
        started: true,
        task_id: task.id,
        run_id: metadata.runId,
        review_id: review.id,
        envelope_status: "succeeded",
        outcome: reviewResult,
        review_result: reviewResult,
        final_state: nextState,
        comment_id: comment?.id,
      };
    } finally {
      if (persistedRunId) {
        await deps.repo.finishAgentRun({
          id: persistedRunId,
          status: terminalStatus,
          envelope_hash: terminalEnvelopeHash,
        });
      }
    }
  };
}

async function fetchDiffSummary(
  adapter: ProviderAdapter,
  project: ProviderProjectRef,
  mrId: string,
): Promise<string> {
  const diff = await adapter.mergeRequests.diff(project, mrId);
  if (!diff || diff.length === 0) {
    return `No textual diff available for MR ${mrId}.`;
  }
  const MAX = 12_000;
  const parts: string[] = [`MR ${mrId} diff (${diff.length} files):`];
  let used = parts[0].length;
  for (const file of diff) {
    const path =
      (file["new_path"] as string | undefined) ??
      (file["old_path"] as string | undefined) ??
      "<unknown>";
    const body =
      (file["diff"] as string | undefined) ??
      (file["patch"] as string | undefined) ??
      "";
    const block = `\n--- ${path} ---\n${body.length > 4000 ? body.slice(0, 4000) + "\n[truncated]" : body}`;
    if (used + block.length > MAX) {
      parts.push(
        `\n[diff truncated; ${diff.length - parts.length + 1} files omitted]`,
      );
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join("");
}

async function primaryMirror(
  deps: ReviewerRunDependencies,
  task_id: string,
  entity_kind: "task" | "mr_pr",
): Promise<ProviderMirror | undefined> {
  const mirrors = await deps.providerProjects.listMirrorsForColony({
    colony_id: task_id,
    entity_kind,
  });
  return mirrors[0];
}

function developerCommitFromEnvelope(
  envelope: DeveloperCompletionEnvelope,
): string {
  const commit = envelope.artifacts.find((a) => a.kind === "commit");
  return commit?.hash ?? commit?.id ?? envelope.freshness.commit_sha;
}

interface PostReviewCommentArgs {
  readonly adapter: ProviderAdapter;
  readonly project: ProviderProjectRef;
  readonly mrId: string;
  readonly envelope: ReviewerReviewEnvelope;
}

async function postReviewComment(args: PostReviewCommentArgs) {
  const authored = args.envelope.role_specific.mr_comment_body?.trim();
  if (authored) {
    return args.adapter.mergeRequests.comment(
      args.project,
      args.mrId,
      authored.slice(0, 6000),
    );
  }

  const result = mapEnvelopeResult(args.envelope.result);
  const lines: string[] = [];
  if (result === "approved") {
    lines.push("Reviewer agent: **approved**.");
  } else if (result === "changes_requested") {
    lines.push("Reviewer agent: **changes requested**.");
  } else {
    lines.push(`Reviewer agent: ${result}.`);
  }
  if (args.envelope.role_specific.summary) {
    lines.push("", args.envelope.role_specific.summary);
  }
  for (const finding of args.envelope.role_specific.findings) {
    lines.push(
      "",
      `- **[${finding.severity}]** (confidence ${finding.confidence.toFixed(2)})`,
      `  - ${finding.evidence}`,
    );
    if (finding.acceptance_criterion_ref) {
      lines.push(`  - AC: ${finding.acceptance_criterion_ref}`);
    }
    if (finding.suggested_fix) {
      lines.push(`  - Suggestion: ${finding.suggested_fix}`);
    }
  }
  lines.push("", `> rationale: ${args.envelope.rationale}`);

  return args.adapter.mergeRequests.comment(
    args.project,
    args.mrId,
    lines.join("\n"),
  );
}

function mapEnvelopeResult(
  result: ReviewerReviewEnvelope["result"],
): "approved" | "changes_requested" | "blocked" | "escalate" {
  if (result === "approved") return "approved";
  if (result === "changes_requested") return "changes_requested";
  if (result === "blocked") return "blocked";
  return "escalate";
}

function freshnessFor(
  task: Task,
  project: ProviderProject,
  developer: DeveloperCompletionEnvelope,
): Freshness {
  return {
    task_graph_version: `task:${task.state_version}`,
    provider_event_ts: new Date(0).toISOString(),
    commit_sha: developerCommitFromEnvelope(developer),
    policy_version: developer.freshness.policy_version,
    memory_bundle_version: developer.freshness.memory_bundle_version,
    packet_hash: "sha256:packet-hash-uncomputed",
  };
}

function parseReviewerEnvelope(value: unknown): ReviewerReviewEnvelope | null {
  const result = reviewerReviewEnvelopeSchema.safeParse(value);
  return result.success ? result.data : null;
}

async function defaultReviewerEnvironment(): Promise<AgentRunEnvironment> {
  const tools = await prepareSandboxToolEnvironment(
    {
      skillMounts: [],
      cliTools: [],
      nixProfile: {
        flakeRef: "github:shdrch/colony-agent-tools#reviewer",
        packages: [{ name: "git", ref: "nixpkgs#git" }],
      },
    },
    {
      kind: "fallback",
      resolveTools: () => ({
        pathEntries: ["/colony/run-tools/bin"],
        profileHash: "sha256:reviewer-tool-profile",
        toolVersions: { git: "2.51.0" },
      }),
    },
  );
  return {
    role: "reviewer",
    sandboxProfile: "reviewer-default",
    runtimeBinding: selectRuntimeBinding(DEFAULT_REVIEWER_BINDING),
    runExtensions: { skillMounts: [], cliTools: [] },
    tools,
  };
}

export function createDefaultReviewerRuntime(): AgentRuntimeAdapter {
  return new FakeAgentRuntimeAdapter();
}

// Re-export for activities-side imports.
export type { ArtifactId };
