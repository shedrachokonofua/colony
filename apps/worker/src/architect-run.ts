import {
  buildArchitectPacket,
  prepareSandboxToolEnvironment,
  selectRuntimeBinding,
  type AgentRunEnvironment,
  type AgentRuntimeAdapter,
  type DeployerRuntimeBinding,
} from "@colony/agent-runtime";
import {
  architectDecompositionEnvelopeSchema,
  type ArchitectDecompositionEnvelope,
  type ArchitectTargetProject,
  type Freshness,
} from "@colony/schemas";
import {
  type ProviderProjectRepository,
  type TaskGraphRepository,
} from "@colony/db";
import {
  isScopeId,
  type ActorId,
  type ProviderProject,
  type Scope,
  type TaskId,
} from "@colony/domain";
import type { ProviderAdapter } from "@colony/provider";

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;
const ARCHITECT_ACTOR = "bot:architect" as ActorId;

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

export interface ArchitectRunDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly providerAdapter: ProviderAdapter;
  readonly agentRuntime: AgentRuntimeAdapter;
  readonly buildRunEnvironment?: (
    scope: Scope,
  ) => Promise<AgentRunEnvironment> | AgentRunEnvironment;
}

export interface StartArchitectRunInput {
  readonly scope_id: string;
  readonly actor?: string;
}

export type StartArchitectRunResult =
  | {
      readonly started: false;
      readonly scope_id?: string;
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly scope_id: string;
      readonly run_id: string;
      readonly envelope_status: "succeeded" | "envelope_rejected" | "failed";
      readonly proposal_id?: string;
      readonly reason?: string;
    };

export function createArchitectRun(deps: ArchitectRunDependencies) {
  return async function startArchitectRun(
    input: StartArchitectRunInput,
  ): Promise<StartArchitectRunResult> {
    if (!isScopeId(input.scope_id)) {
      return { started: false, reason: "invalid_scope_id" };
    }
    const scope = await deps.repo.getScope(input.scope_id);
    if (!scope) {
      return {
        started: false,
        scope_id: input.scope_id,
        reason: "scope_not_found",
      };
    }
    if (scope.state !== "draft") {
      return {
        started: false,
        scope_id: scope.id,
        reason: `scope_not_draft:${scope.state}`,
      };
    }

    const targets = await deps.providerProjects.listScopeTargets(scope.id);
    if (targets.length === 0) {
      return {
        started: false,
        scope_id: scope.id,
        reason: "scope_has_no_target_projects",
      };
    }
    const targetProjects: Array<{
      readonly role: string;
      readonly project: ProviderProject;
    }> = [];
    for (const target of targets) {
      const project = await deps.providerProjects.getProject(
        target.provider_project_id,
      );
      if (project) targetProjects.push({ role: target.role, project });
    }
    if (targetProjects.length === 0) {
      return {
        started: false,
        scope_id: scope.id,
        reason: "no_target_projects_resolvable",
      };
    }

    const scopeMirrors = await deps.providerProjects.listMirrorsForColony({
      colony_id: scope.id,
      entity_kind: "scope",
    });
    const scopeMirror = scopeMirrors[0];
    if (!scopeMirror) {
      return {
        started: false,
        scope_id: scope.id,
        reason: "scope_has_no_provider_mirror",
      };
    }

    const primary =
      targetProjects.find((t) => t.role === "primary") ?? targetProjects[0];
    const primaryProject = primary.project;

    const existingTasks = await deps.repo.listTasks(scope.id);

    const freshness = freshnessFor(scope, primaryProject);
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
        url: primaryProject.path,
        branch: primaryProject.default_branch,
        base_commit: primaryProject.default_branch,
      },
      scope_goal: scope.title,
      scope_acceptance_criteria: deriveAcceptanceCriteria(scope.description),
      scope_non_goals: [],
      scope_brief_version: `scope:${scope.state_version}`,
      target_projects: targetProjects.map(toArchitectTargetProject),
      existing_tasks: existingTasks.map((t) => ({
        task_id: t.id,
        title: t.title,
        state: t.state,
      })),
      provider_context: {
        provider: primaryProject.provider,
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
          "Each proposed_task_id must be `<scope_id>.<n>` and unique within the proposal.",
          "Prefer small, independently mergeable tasks over a single large task.",
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
          description: "architect decomposition envelope",
        },
      ],
      tool_permissions: [],
      sandbox_profile: "architect-default",
      known_risks: [],
      time_budget_minutes: 60,
      freshness,
    });

    const runEnvironment =
      (await deps.buildRunEnvironment?.(scope)) ??
      (await defaultArchitectEnvironment());

    const metadata = await deps.agentRuntime.startRun(packet, runEnvironment);

    if (metadata.status !== "succeeded") {
      await deps.repo.writeAudit({
        scope_id: scope.id,
        actor: SUPERVISOR_ACTOR,
        action: "architect.run.rejected",
        capability: "graph.write",
        target_kind: "agent_run",
        target_id: metadata.runId,
        reason: metadata.rejectionReason ?? `agent_run_${metadata.status}`,
        evidence: {
          run_id: metadata.runId,
          status: metadata.status,
          packet_hash: metadata.packetHash,
          runtime_binding_hash: metadata.runtimeBindingHash,
          rejection_reason: metadata.rejectionReason,
        },
      });
      return {
        started: true,
        scope_id: scope.id,
        run_id: metadata.runId,
        envelope_status:
          metadata.status === "envelope_rejected"
            ? "envelope_rejected"
            : "failed",
        reason: `agent_run_${metadata.status}`,
      };
    }

    const output = await deps.agentRuntime.getRunOutput(metadata.runId);
    const envelope = parseArchitectEnvelope(output?.envelope);
    if (!output || !envelope || envelope.scope_id !== scope.id) {
      return {
        started: true,
        scope_id: scope.id,
        run_id: metadata.runId,
        envelope_status: "envelope_rejected",
        reason: "envelope_missing_or_mismatched",
      };
    }
    if (envelope.freshness.packet_hash !== packet.freshness.packet_hash) {
      await deps.repo.writeAudit({
        scope_id: scope.id,
        actor: SUPERVISOR_ACTOR,
        action: "architect.envelope.stale",
        capability: "graph.write",
        target_kind: "agent_run",
        target_id: metadata.runId,
        reason: "freshness_mismatch",
        evidence: {
          run_id: metadata.runId,
          packet_hash: metadata.packetHash,
          envelope_packet_hash: envelope.freshness.packet_hash,
        },
      });
      return {
        started: true,
        scope_id: scope.id,
        run_id: metadata.runId,
        envelope_status: "envelope_rejected",
        reason: "envelope_freshness_mismatch",
      };
    }

    const actor = (input.actor ?? ARCHITECT_ACTOR) as ActorId;
    const proposedTasks = envelope.role_specific.proposed_tasks.map((task) => ({
      proposed_task_id: task.proposed_task_id as TaskId,
      title: task.title,
      description: task.description,
      acceptance_criteria: task.acceptance_criteria,
      non_goals: task.non_goals,
      suggested_role: task.suggested_role,
      suggested_capabilities: task.suggested_capabilities,
      estimated_effort_minutes: task.estimated_effort_minutes,
    }));
    const proposal = await deps.repo.submitDecompositionProposal(
      {
        scope_id: scope.id,
        scope_state_version: scope.state_version,
        scope_brief_version: packet.scope_brief_version,
        proposed_tasks: proposedTasks,
        proposed_dependencies: envelope.role_specific.proposed_dependencies.map(
          (dep) => ({
            from_task_id: dep.from_task_id as TaskId,
            to_task_id: dep.to_task_id as TaskId,
            kind: dep.kind,
          }),
        ),
        target_project_mapping: defaultTaskTargetMapping(
          proposedTasks,
          primaryProject,
        ),
        assumptions: envelope.role_specific.assumptions,
        open_questions: envelope.role_specific.open_questions,
        packet_hash: packet.freshness.packet_hash,
        envelope_hash: output.envelopeHash,
        envelope,
      },
      {
        actor,
        capability: "graph.write",
        reason: "architect_run_submission",
      },
    );

    return {
      started: true,
      scope_id: scope.id,
      run_id: metadata.runId,
      envelope_status: "succeeded",
      proposal_id: proposal.id,
    };
  };
}

function parseArchitectEnvelope(
  envelope: unknown,
): ArchitectDecompositionEnvelope | null {
  const result = architectDecompositionEnvelopeSchema.safeParse(envelope);
  return result.success ? result.data : null;
}

function freshnessFor(scope: Scope, project: ProviderProject): Freshness {
  return {
    task_graph_version: `scope:${scope.state_version}`,
    provider_event_ts: new Date(0).toISOString(),
    commit_sha: project.default_branch,
    policy_version: "policy:1",
    memory_bundle_version: "memory:1",
    packet_hash: "sha256:packet-hash-uncomputed",
  };
}

function toArchitectTargetProject(input: {
  readonly role: string;
  readonly project: ProviderProject;
}): ArchitectTargetProject {
  return {
    role: input.role,
    provider: input.project.provider,
    project_id: input.project.provider_id,
    project_path: input.project.path,
    default_branch: input.project.default_branch,
  };
}

function defaultTaskTargetMapping(
  proposedTasks: ReadonlyArray<{ readonly proposed_task_id: TaskId }>,
  primaryProject: ProviderProject,
): Record<string, string> {
  // Repository-level validator (`validateDecomposition`) requires every key
  // in `target_project_mapping` to be a proposed_task_id. The *value* must
  // be a Colony provider_projects.id (UUID) since
  // commitDecompositionProposal feeds it straight into linkTaskTarget,
  // which has a FK constraint against provider_projects.id. Using the
  // provider's numeric id (e.g. GitLab "49") fails the FK at commit
  // time. Architect output doesn't carry a per-task project hint yet,
  // so default every task to the scope's primary provider project;
  // richer per-task target inference can come from envelope role_specific
  // in a later iteration.
  const mapping: Record<string, string> = {};
  for (const task of proposedTasks) {
    mapping[task.proposed_task_id] = primaryProject.id;
  }
  return mapping;
}

function deriveAcceptanceCriteria(description: string): string[] {
  // Scopes do not yet carry first-class acceptance criteria; surface
  // bullet-prefixed lines from the description when present so the architect
  // has at least the human-authored criteria as bounded context. Empty
  // result is acceptable per the schema.
  const lines = description.split(/\r?\n/);
  const bullets: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const m = /^[-*]\s+(.+)$/.exec(trimmed);
    if (m) bullets.push(m[1].trim());
  }
  return bullets;
}

function providerArtifactUri(
  projectPath: string | undefined,
  providerId: string,
): string {
  if (projectPath) return `${projectPath}/issues/${providerId}`;
  return providerId;
}

async function defaultArchitectEnvironment(): Promise<AgentRunEnvironment> {
  // Architect runs don't require any CLI tools — they read the packet,
  // produce an envelope. Skip the nix profile entirely.
  const tools = await prepareSandboxToolEnvironment(
    {
      skillMounts: [],
      cliTools: [],
    },
    {
      kind: "fallback",
      resolveTools: () => ({
        pathEntries: ["/colony/run-tools/bin"],
        profileHash: "sha256:tool-profile-architect",
        toolVersions: {},
      }),
    },
  );
  return {
    role: "architect",
    sandboxProfile: "architect-default",
    runtimeBinding: selectRuntimeBinding(DEFAULT_DEPLOYER_BINDING),
    runExtensions: { skillMounts: [], cliTools: [] },
    tools,
  };
}
