import {
  buildArchitectPacket,
  type AgentRunEnvironment,
  type AgentRunMetadata,
  type AgentRuntimeAdapter,
} from "@colony/agent-runtime";
import {
  architectDecompositionEnvelopeSchema,
  type ArchitectDecompositionEnvelope,
} from "@colony/schemas";
import type {
  ProviderProjectRepository,
  SupersedeTaskWithReplacementsInput,
  TaskGraphRepository,
} from "@colony/db";
import {
  isScopeId,
  isTaskId,
  type ActorId,
  type Scope,
  type ScopeId,
  type TaskId,
} from "@colony/domain";
import type { ProviderAdapter } from "@colony/provider";
import {
  mintEphemeralProjectAgentToken,
  revokeEphemeralProjectAgentToken,
} from "./task-agent-tokens.js";
import { defaultArchitectEnvironment } from "./architect-run.js";

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;
const ARCHITECT_ACTOR = "bot:architect" as ActorId;

export interface RequestArchitectReplanInput {
  readonly scope_id: string;
  readonly task_id: string;
  readonly reason: string;
  readonly attempt: number;
}

export interface RequestArchitectReplanResult {
  readonly replanned: boolean;
  readonly reason?: string;
  readonly task_ids?: readonly string[];
}

export interface ArchitectReplanDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly providerAdapter: ProviderAdapter;
  readonly agentRuntime: AgentRuntimeAdapter;
  readonly buildRunEnvironment?: (
    scope: Scope,
  ) => Promise<AgentRunEnvironment> | AgentRunEnvironment;
}

function providerArtifactUri(
  projectPath: string | undefined,
  providerId: string,
): string {
  return projectPath ? `${projectPath}/issues/${providerId}` : providerId;
}

function parseEnvelope(value: unknown): ArchitectDecompositionEnvelope | null {
  const parsed = architectDecompositionEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRequestArchitectReplan(
  deps: ArchitectReplanDependencies,
) {
  return async function requestArchitectReplan(
    input: RequestArchitectReplanInput,
  ): Promise<RequestArchitectReplanResult> {
    if (!isScopeId(input.scope_id))
      return { replanned: false, reason: "invalid_scope_id" };
    if (!isTaskId(input.task_id))
      return { replanned: false, reason: "invalid_task_id" };
    if (!Number.isInteger(input.attempt) || input.attempt < 1) {
      return { replanned: false, reason: "invalid_attempt" };
    }

    const scope = await deps.repo.getScope(input.scope_id);
    const task = await deps.repo.getTask(input.task_id);
    if (!scope) return { replanned: false, reason: "scope_not_found" };
    if (!task || task.scope_id !== scope.id) {
      return { replanned: false, reason: "task_not_found" };
    }
    if (task.state === "merged" || task.state === "closed") {
      return { replanned: false, reason: `task_terminal:${task.state}` };
    }

    const targets = await deps.providerProjects.listScopeTargets(scope.id);
    const targetProjects: Array<{
      readonly role: string;
      readonly project: NonNullable<
        Awaited<ReturnType<ProviderProjectRepository["getProject"]>>
      >;
    }> = [];
    for (const target of targets) {
      const project = await deps.providerProjects.getProject(
        target.provider_project_id,
      );
      if (project) targetProjects.push({ role: target.role, project });
    }
    const primary =
      targetProjects.find((target) => target.role === "primary") ??
      targetProjects[0];
    if (!primary)
      return { replanned: false, reason: "no_target_projects_resolvable" };
    const scopeMirror = (
      await deps.providerProjects.listMirrorsForColony({
        colony_id: scope.id,
        entity_kind: "scope",
      })
    )[0];
    if (!scopeMirror)
      return { replanned: false, reason: "scope_provider_artifact_missing" };

    let agentToken: Awaited<
      ReturnType<typeof mintEphemeralProjectAgentToken>
    > | null = null;
    try {
      agentToken = await mintEphemeralProjectAgentToken(
        { repo: deps.repo, providerAdapter: deps.providerAdapter },
        {
          project: {
            id: primary.project.provider_id,
            path: primary.project.path,
          },
          audit: {
            scope_id: scope.id,
            task_id: task.id,
            actor: SUPERVISOR_ACTOR,
            capability: "graph.read",
            reason: "architect_replan_token_minted",
            purpose: "architect",
          },
        },
      );
    } catch (error) {
      return await recordFailure(
        deps.repo,
        scope.id,
        task.id,
        input,
        `agent_token_mint_failed:${failureReason(error)}`,
      );
    }

    const tasks = await deps.repo.listTasks(scope.id);
    const dependencySummary = await Promise.all(
      tasks.map(async (candidate) => ({
        task_id: candidate.id,
        ...(await deps.repo.getTaskDependencies(candidate.id)),
      })),
    );
    const priorTaskContext = tasks.map((candidate) => ({
      task_id: candidate.id,
      developer_plan: candidate.developer_plan_envelope,
      plan_review: candidate.plan_review_envelope,
      plan_review_result: candidate.plan_review_result,
      code_review: candidate.last_code_review_envelope,
    }));
    const failingTaskContext = {
      task_id: task.id,
      title: task.title,
      description: task.description,
      state: task.state,
      developer_plan: task.developer_plan_envelope,
      plan_review: task.plan_review_envelope,
      plan_review_result: task.plan_review_result,
      code_review: task.last_code_review_envelope,
    };
    const packet = buildArchitectPacket({
      scope_id: scope.id,
      provider_scope_artifact: {
        kind: "issue",
        id: scopeMirror.provider_id,
        uri: providerArtifactUri(
          scopeMirror.provider_project_path,
          scopeMirror.provider_id,
        ),
      },
      repo: {
        url: primary.project.path,
        branch: primary.project.default_branch,
        base_commit: primary.project.default_branch,
        ...(agentToken ? { credentials: { token: agentToken.token } } : {}),
      },
      scope_goal: [
        "ARCHITECT RE-DECOMPOSITION (NOT FRESH WORK).",
        `A failing task (${task.id}) escalated after refinement: ${input.reason}`,
        "Supersede the failing task additively only; do not modify merged or closed tasks.",
        "Consider whether proposed tasks are separable in the filesystem, not merely conceptually. Concurrent edits to one file are a structural conflict.",
        `FAILING_TASK_CONTEXT=${JSON.stringify(failingTaskContext)}`,
        `PRIOR_TASK_PLANS_AND_REVIEWS=${JSON.stringify(priorTaskContext)}`,
        `SIBLING_TASKS_AND_DEPENDENCY_EDGES=${JSON.stringify(dependencySummary)}`,
      ].join("\n"),
      scope_acceptance_criteria: [
        "Produce a safe replacement DAG for the failing task.",
      ],
      scope_non_goals: [],
      scope_brief_version: `scope:${scope.state_version}:replan:${input.attempt}`,
      target_projects: targetProjects.map((target) => ({
        role: target.role,
        provider: target.project.provider,
        project_id: target.project.provider_id,
        project_path: target.project.path,
        default_branch: target.project.default_branch,
      })),
      existing_tasks: tasks.map((candidate) => ({
        task_id: candidate.id,
        title: candidate.title,
        state: candidate.state,
      })),
      provider_context: {
        provider: primary.project.provider,
        issue_id: scopeMirror.provider_id,
        issue_url: providerArtifactUri(
          scopeMirror.provider_project_path,
          scopeMirror.provider_id,
        ),
        labels: [],
        recent_comments: [],
      },
      memory_bundle: {
        decisions: [],
        semantic: [],
        procedural: [],
        policy: [],
      },
      policy: {
        constraints: [
          "This is a failing-task re-decomposition, not fresh scope planning.",
          "Return replacement tasks with fresh ids; do not reuse ids of merged or closed tasks.",
          "Re-evaluate filesystem ownership and shared-file conflicts before splitting work.",
          "Keep replacements independently mergeable and preserve required dependency ordering.",
        ],
        protected_paths: [],
        security_labels: [],
        always_human_review: true,
        review_loop_cap: 3,
      },
      capabilities: ["graph.read"],
      required_outputs: [
        {
          kind: "decomposition_envelope",
          description: "architect re-decomposition envelope",
        },
      ],
      tool_permissions: ["git"],
      sandbox_profile: "architect-default",
      known_risks: [
        `escalation_reason:${input.reason}`,
        `attempt:${input.attempt}`,
        `prior_plans_and_reviews:${JSON.stringify(priorTaskContext)}`,
        `dependency_edges:${JSON.stringify(dependencySummary)}`,
      ],
      time_budget_minutes: 60,
      freshness: {
        task_graph_version: `scope:${scope.state_version}`,
        provider_event_ts: scope.updated_at,
        commit_sha: primary.project.default_branch,
        policy_version: "architect-replan-v1",
        memory_bundle_version: "none",
      },
    });

    let persistedRunId: string | undefined;
    let terminalStatus: "succeeded" | "failed" | "envelope_rejected" = "failed";
    let terminalEnvelopeHash: string | undefined;
    try {
      const persisted = await deps.repo.startAgentRun({
        scope_id: scope.id,
        role: "architect",
        packet_hash: packet.freshness.packet_hash,
      });
      persistedRunId = persisted.id;
      let metadata: AgentRunMetadata;
      try {
        metadata = await deps.agentRuntime.startRun(
          packet,
          (await deps.buildRunEnvironment?.(scope)) ??
            (await defaultArchitectEnvironment()),
        );
      } finally {
        await revokeEphemeralProjectAgentToken(
          { repo: deps.repo, providerAdapter: deps.providerAdapter },
          {
            project: {
              id: primary.project.provider_id,
              path: primary.project.path,
            },
            token: agentToken,
            audit: {
              scope_id: scope.id,
              task_id: task.id,
              actor: SUPERVISOR_ACTOR,
              capability: "graph.read",
              reason: "architect_replan_run_finished",
              purpose: "architect",
            },
          },
        );
      }
      if (metadata.status !== "succeeded") {
        terminalStatus =
          metadata.status === "envelope_rejected"
            ? "envelope_rejected"
            : "failed";
        return await recordFailure(
          deps.repo,
          scope.id,
          task.id,
          input,
          metadata.rejectionReason ?? `agent_run_${metadata.status}`,
        );
      }
      const output = await deps.agentRuntime.getRunOutput(metadata.runId);
      const envelope = parseEnvelope(output?.envelope);
      if (
        !output ||
        !envelope ||
        envelope.scope_id !== scope.id ||
        envelope.freshness.packet_hash !== packet.freshness.packet_hash
      ) {
        terminalStatus = "envelope_rejected";
        return await recordFailure(
          deps.repo,
          scope.id,
          task.id,
          input,
          "envelope_missing_mismatched_or_stale",
        );
      }
      if (
        envelope.result !== "done" ||
        envelope.next_action !== "propose_decomposition"
      ) {
        terminalStatus = "succeeded";
        terminalEnvelopeHash = output.envelopeHash;
        return await recordFailure(
          deps.repo,
          scope.id,
          task.id,
          input,
          `architect_declined:${envelope.result}:${envelope.next_action}`,
        );
      }
      // Build mutable locals; the input type exposes them as readonly.
      const replacements: SupersedeTaskWithReplacementsInput["replacements"][number][] =
        [];
      for (const proposed of envelope.role_specific.proposed_tasks) {
        if (!isTaskId(proposed.proposed_task_id)) {
          terminalStatus = "envelope_rejected";
          return await recordFailure(
            deps.repo,
            scope.id,
            task.id,
            input,
            "envelope_replacement_id_invalid",
          );
        }
        replacements.push({
          id: proposed.proposed_task_id,
          scope_id: scope.id,
          title: proposed.title,
          description: proposed.description,
          acceptance_criteria: proposed.acceptance_criteria,
          non_goals: proposed.non_goals,
        });
      }
      const dependencies: SupersedeTaskWithReplacementsInput["dependencies"][number][] =
        [];
      for (const dependency of envelope.role_specific.proposed_dependencies) {
        if (
          !isTaskId(dependency.from_task_id) ||
          !isTaskId(dependency.to_task_id)
        ) {
          terminalStatus = "envelope_rejected";
          return await recordFailure(
            deps.repo,
            scope.id,
            task.id,
            input,
            "envelope_dependency_id_invalid",
          );
        }
        dependencies.push({
          from_task_id: dependency.from_task_id,
          to_task_id: dependency.to_task_id,
          kind: dependency.kind,
        });
      }
      const applied = await deps.repo.supersedeTaskWithReplacements(
        {
          scope_id: scope.id,
          task_id: task.id,
          replacements,
          dependencies,
          attempt: input.attempt,
        },
        {
          actor: ARCHITECT_ACTOR,
          capability: "graph.write",
          reason: `${input.reason};tier=3;attempt=${input.attempt}`,
        },
      );
      terminalStatus = "succeeded";
      terminalEnvelopeHash = output.envelopeHash;
      return {
        replanned: true,
        task_ids: applied.map((replacement) => replacement.id),
      };
    } catch (error) {
      return await recordFailure(
        deps.repo,
        scope.id,
        task.id,
        input,
        `replan_apply_failed:${failureReason(error)}`,
      );
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

async function recordFailure(
  repo: TaskGraphRepository,
  scope_id: ScopeId,
  task_id: TaskId,
  input: RequestArchitectReplanInput,
  reason: string,
): Promise<RequestArchitectReplanResult> {
  await repo.writeAudit({
    scope_id,
    task_id,
    actor: SUPERVISOR_ACTOR,
    action: "task.replan.failed",
    capability: "graph.write",
    target_kind: "task",
    target_id: task_id,
    reason,
    evidence: {
      tier: 3,
      attempt: input.attempt,
      escalation_reason: input.reason,
    },
  });
  return { replanned: false, reason };
}
