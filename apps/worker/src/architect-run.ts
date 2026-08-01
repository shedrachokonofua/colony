import {
  buildArchitectPacket,
  prepareSandboxToolEnvironment,
  selectRuntimeBinding,
  type AgentRunEnvironment,
  type AgentRunMetadata,
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
import { format } from "prettier";
import {
  mintEphemeralProjectAgentToken,
  revokeEphemeralProjectAgentToken,
} from "./task-agent-tokens.js";

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
      readonly spec_mr?: { readonly id: string; readonly url?: string };
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
    let scopeMirror = scopeMirrors[0];
    if (!scopeMirror) {
      // Self-bootstrap: scopes created via the API don't get an
      // automatic provider issue. Project the scope as a GitLab issue
      // on the primary target so the architect has an anchor to
      // attach the spec MR + child task issues to. Recovery (heartbeat)
      // hits this same path.
      const bootstrapPrimary =
        targetProjects.find((t) => t.role === "primary") ?? targetProjects[0];
      const bootstrapProject = bootstrapPrimary.project;
      const issue = await deps.providerAdapter.issues.create(
        {
          id: bootstrapProject.provider_id,
          path: bootstrapProject.path,
        },
        {
          title: scope.title,
          description: scope.description,
          labels: ["state:draft", "scope:parent"],
        },
      );
      scopeMirror = await deps.providerProjects.upsertMirror({
        colony_id: scope.id,
        entity_kind: "scope",
        provider: bootstrapProject.provider,
        provider_id: issue.id,
        provider_project_id: bootstrapProject.id,
        provider_project_path: bootstrapProject.path,
      });
      await deps.repo.writeAudit({
        scope_id: scope.id,
        actor: SUPERVISOR_ACTOR,
        action: "provider.scope.issue_projected",
        capability: "provider.issues.create",
        target_kind: "issue",
        target_id: issue.id,
        reason: "architect_run_bootstrap",
        evidence: {
          provider_project_id: bootstrapProject.id,
          provider_project_path: bootstrapProject.path,
        },
      });
    }

    const primary =
      targetProjects.find((t) => t.role === "primary") ?? targetProjects[0];
    const primaryProject = primary.project;
    const primaryProjectRef = {
      id: primaryProject.provider_id,
      path: primaryProject.path,
    };

    let agentToken: Awaited<
      ReturnType<typeof mintEphemeralProjectAgentToken>
    > | null = null;
    try {
      agentToken = await mintEphemeralProjectAgentToken(
        {
          repo: deps.repo,
          providerAdapter: deps.providerAdapter,
        },
        {
          project: primaryProjectRef,
          audit: {
            scope_id: scope.id,
            actor: SUPERVISOR_ACTOR,
            capability: "graph.read",
            reason: "architect_run_token_minted",
            purpose: "architect",
          },
        },
      );
    } catch (err) {
      return {
        started: false,
        scope_id: scope.id,
        reason: `agent_token_mint_failed:${err instanceof Error ? err.message : String(err)}`,
      };
    }

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
        ...(agentToken ? { credentials: { token: agentToken.token } } : {}),
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
          ...scopeSpecificArchitectConstraints(scope.description),
          "Each proposed_task_id must be `<scope_id>.<n>` and unique within the proposal.",
          "Honor explicit task-count constraints in the scope brief. If the scope asks for one task, propose one task; otherwise prefer small, independently mergeable tasks.",
          "For proposed_dependencies with kind=blocks, from_task_id is the prerequisite/blocker that must land first and to_task_id is the dependent task that is blocked.",
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
      tool_permissions: ["git"],
      sandbox_profile: "architect-default",
      known_risks: [],
      time_budget_minutes: 60,
      freshness,
    });

    const runEnvironment =
      (await deps.buildRunEnvironment?.(scope)) ??
      (await defaultArchitectEnvironment());
    let metadata: AgentRunMetadata;
    let persistedRunId: string | undefined;
    let terminalStatus: "succeeded" | "failed" | "envelope_rejected" = "failed";
    let terminalEnvelopeHash: string | undefined;
    try {
      const persistedRun = await deps.repo.startAgentRun({
        scope_id: scope.id,
        role: "architect",
        packet_hash: packet.freshness.packet_hash,
      });
      persistedRunId = persistedRun.id;
      try {
        metadata = await deps.agentRuntime.startRun(packet, runEnvironment);
      } finally {
        await revokeEphemeralProjectAgentToken(
          {
            repo: deps.repo,
            providerAdapter: deps.providerAdapter,
          },
          {
            project: primaryProjectRef,
            token: agentToken,
            audit: {
              scope_id: scope.id,
              actor: SUPERVISOR_ACTOR,
              capability: "graph.read",
              reason: "architect_run_finished",
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
        terminalStatus = "envelope_rejected";
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
        terminalStatus = "envelope_rejected";
        return {
          started: true,
          scope_id: scope.id,
          run_id: metadata.runId,
          envelope_status: "envelope_rejected",
          reason: "envelope_missing_or_mismatched",
        };
      }
      if (envelope.freshness.packet_hash !== packet.freshness.packet_hash) {
        terminalStatus = "envelope_rejected";
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
      const proposedTasks = envelope.role_specific.proposed_tasks.map(
        (task) => ({
          proposed_task_id: task.proposed_task_id as TaskId,
          title: task.title,
          description: task.description,
          acceptance_criteria: task.acceptance_criteria,
          non_goals: task.non_goals,
          suggested_role: task.suggested_role,
          suggested_capabilities: task.suggested_capabilities,
          estimated_effort_minutes: task.estimated_effort_minutes,
        }),
      );
      const proposal = await deps.repo.submitDecompositionProposal(
        {
          scope_id: scope.id,
          scope_state_version: scope.state_version,
          scope_brief_version: packet.scope_brief_version,
          proposed_tasks: proposedTasks,
          proposed_dependencies:
            envelope.role_specific.proposed_dependencies.map((dep) => ({
              from_task_id: dep.from_task_id as TaskId,
              to_task_id: dep.to_task_id as TaskId,
              kind: dep.kind,
            })),
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

      // Open or update a spec MR carrying the proposal so reviewers
      // (agent + human) can read the architect's output as a real GitLab
      // MR diff and post /approve or /changes via comments. The
      // webhook-dispatcher's mirror lookup picks this up as
      // `entity_kind=mr_pr` linked to the *scope* (not a task), and the
      // supervisor workflow's command_target=scope_decomposition routing
      // fires the existing applyDecompositionCommand path. Best-effort:
      // if the provider adapter doesn't support commit/MR open we return
      // success on the proposal alone — the API path still exposes the
      // proposal for direct approval.
      //
      // Rework semantics: when an architect run produces a fresh
      // proposal for a scope that already has an open spec MR (e.g.
      // reviewer requested changes and the architect re-decomposed),
      // push a new commit to the same branch and update the existing
      // mirror instead of opening a parallel MR. One MR thread per
      // scope = one place for review comments.
      const existingSpecMrMirror = (
        await deps.providerProjects.listMirrorsForColony({
          colony_id: scope.id,
          entity_kind: "mr_pr",
        })
      )[0];
      let architectMr:
        | { readonly id: string; readonly url?: string }
        | undefined;
      try {
        architectMr = await openOrUpdateSpecMergeRequest({
          adapter: deps.providerAdapter,
          primaryProject,
          scope,
          proposal,
          proposedTasks,
          proposedDependencies: envelope.role_specific.proposed_dependencies,
          assumptions: envelope.role_specific.assumptions,
          openQuestions: envelope.role_specific.open_questions,
          existingMrId: existingSpecMrMirror?.provider_id,
        });
        if (architectMr) {
          await deps.providerProjects.upsertMirror({
            colony_id: scope.id,
            entity_kind: "mr_pr",
            provider: primaryProject.provider,
            provider_id: architectMr.id,
            provider_project_id: primaryProject.id,
            provider_project_path: primaryProject.path,
            source_version: proposal.envelope_hash,
          });
          await deps.repo.writeAudit({
            scope_id: scope.id,
            actor,
            action: existingSpecMrMirror
              ? "architect.spec_mr.updated"
              : "architect.spec_mr.opened",
            capability: "graph.write",
            target_kind: "merge_request",
            target_id: architectMr.id,
            reason: existingSpecMrMirror
              ? "architect_rework_submission"
              : "architect_run_submission",
            evidence: {
              proposal_id: proposal.id,
              mr_url: architectMr.url,
              provider: primaryProject.provider,
              provider_project_id: primaryProject.id,
            },
          });
        }
      } catch (err) {
        await deps.repo.writeAudit({
          scope_id: scope.id,
          actor: SUPERVISOR_ACTOR,
          action: "architect.spec_mr.failed",
          capability: "graph.write",
          target_kind: "decomposition_proposal",
          target_id: proposal.id,
          reason: "spec_mr_open_failed",
          evidence: {
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }

      terminalStatus = "succeeded";
      terminalEnvelopeHash = output.envelopeHash;
      return {
        started: true,
        scope_id: scope.id,
        run_id: metadata.runId,
        envelope_status: "succeeded",
        proposal_id: proposal.id,
        spec_mr: architectMr,
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

async function openOrUpdateSpecMergeRequest(args: {
  readonly adapter: ProviderAdapter;
  readonly primaryProject: ProviderProject;
  readonly scope: Scope;
  readonly proposal: { readonly id: string; readonly envelope_hash: string };
  readonly proposedTasks: ReadonlyArray<{
    readonly proposed_task_id: TaskId;
    readonly title: string;
    readonly description: string;
    readonly acceptance_criteria: readonly string[];
    readonly non_goals?: readonly string[];
    readonly suggested_role?: string;
  }>;
  readonly proposedDependencies: ReadonlyArray<{
    readonly from_task_id: string;
    readonly to_task_id: string;
    readonly kind: string;
  }>;
  readonly assumptions: readonly string[];
  readonly openQuestions: readonly string[];
  readonly existingMrId?: string;
}): Promise<{ readonly id: string; readonly url?: string } | undefined> {
  const projectRef = {
    id: args.primaryProject.provider_id,
    path: args.primaryProject.path,
  };
  // Stable branch per scope so reworks land as new commits on the
  // same branch instead of spawning parallel MRs.
  const branchName = `colony/spec-${args.scope.id}`;
  let branchExisted = true;
  try {
    await args.adapter.branches.create(
      projectRef,
      branchName,
      args.primaryProject.default_branch,
    );
    branchExisted = false;
  } catch {
    // Branch already exists — we'll push an update commit. Use
    // action=update so GitLab finds the existing files on the branch.
  }
  const fileAction = branchExisted ? "update" : "create";
  const commitMessage = branchExisted
    ? `feat(scope): refine decomposition ${args.proposal.id}`
    : `feat(scope): propose decomposition ${args.proposal.id}`;
  const specMarkdown = await format(renderSpecMarkdown(args), {
    parser: "markdown",
  });
  const decompositionJson = await format(
    JSON.stringify({
      proposal_id: args.proposal.id,
      envelope_hash: args.proposal.envelope_hash,
      proposed_tasks: args.proposedTasks,
      proposed_dependencies: args.proposedDependencies,
      assumptions: args.assumptions,
      open_questions: args.openQuestions,
    }),
    { parser: "json" },
  );
  await args.adapter.commits.create(projectRef, {
    branch: branchName,
    message: commitMessage,
    actions: [
      {
        action: fileAction,
        file_path: `colony/scopes/${args.scope.id}/SPEC.md`,
        content: specMarkdown,
      },
      {
        action: fileAction,
        file_path: `colony/scopes/${args.scope.id}/decomposition.json`,
        content: decompositionJson,
      },
    ],
  });
  if (args.existingMrId) {
    // Reuse the open MR. The new commit shows up automatically; we
    // just refresh the description to point at the latest proposal id.
    try {
      const refreshed = await args.adapter.mergeRequests.get(
        projectRef,
        args.existingMrId,
      );
      return { id: refreshed.id, url: refreshed.metadata?.web_url };
    } catch {
      // MR was closed/deleted out of band — fall through to open a
      // fresh one so the chain doesn't stall.
    }
  }
  const mr = await args.adapter.mergeRequests.open(projectRef, {
    title: `[SPEC] ${args.scope.title}`,
    description: renderMrDescription(args),
    source_branch: branchName,
    target_branch: args.primaryProject.default_branch,
  });
  return { id: mr.id, url: mr.metadata?.web_url };
}

function renderSpecMarkdown(args: {
  readonly scope: Scope;
  readonly proposal: { readonly id: string };
  readonly proposedTasks: ReadonlyArray<{
    readonly proposed_task_id: TaskId;
    readonly title: string;
    readonly description: string;
    readonly acceptance_criteria: readonly string[];
    readonly non_goals?: readonly string[];
    readonly suggested_role?: string;
  }>;
  readonly proposedDependencies: ReadonlyArray<{
    readonly from_task_id: string;
    readonly to_task_id: string;
    readonly kind: string;
  }>;
  readonly assumptions: readonly string[];
  readonly openQuestions: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push(`# Spec: ${args.scope.title}`);
  lines.push("");
  lines.push(`Scope: \`${args.scope.id}\``);
  lines.push(`Proposal: \`${args.proposal.id}\``);
  lines.push("");
  lines.push("## Brief");
  lines.push(args.scope.description);
  lines.push("");
  lines.push("## Proposed tasks");
  for (const task of args.proposedTasks) {
    lines.push("");
    lines.push(`### \`${task.proposed_task_id}\` ${task.title}`);
    lines.push("");
    lines.push(task.description);
    if (task.acceptance_criteria.length > 0) {
      lines.push("");
      lines.push("Acceptance criteria:");
      for (const c of task.acceptance_criteria) lines.push(`- ${c}`);
    }
    if (task.non_goals && task.non_goals.length > 0) {
      lines.push("");
      lines.push("Non-goals:");
      for (const ng of task.non_goals) lines.push(`- ${ng}`);
    }
    if (task.suggested_role) {
      lines.push("");
      lines.push(`Suggested role: \`${task.suggested_role}\``);
    }
  }
  if (args.proposedDependencies.length > 0) {
    lines.push("");
    lines.push("## Dependencies");
    for (const dep of args.proposedDependencies) {
      lines.push(`- \`${dep.from_task_id}\` ${dep.kind} \`${dep.to_task_id}\``);
    }
  }
  if (args.assumptions.length > 0) {
    lines.push("");
    lines.push("## Assumptions");
    for (const a of args.assumptions) lines.push(`- ${a}`);
  }
  if (args.openQuestions.length > 0) {
    lines.push("");
    lines.push("## Open questions");
    for (const q of args.openQuestions) lines.push(`- ${q}`);
  }
  return lines.join("\n") + "\n";
}

function renderMrDescription(args: {
  readonly scope: Scope;
  readonly proposal: { readonly id: string };
  readonly proposedTasks: ReadonlyArray<unknown>;
  readonly openQuestions: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push(`Spec MR for scope \`${args.scope.id}\`.`);
  lines.push("");
  lines.push(`- proposal: \`${args.proposal.id}\``);
  lines.push(`- proposed tasks: ${args.proposedTasks.length}`);
  if (args.openQuestions.length > 0) {
    lines.push("");
    lines.push("**Open questions** (resolve before approving):");
    for (const q of args.openQuestions) lines.push(`- ${q}`);
  }
  lines.push("");
  lines.push(
    "Comment `/approve` to lock this decomposition in for DAG commit, or `/changes <prose>` to send the architect back to the brief.",
  );
  return lines.join("\n");
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

function scopeSpecificArchitectConstraints(description: string): string[] {
  if (/exactly\s+one\s+implementation\s+task/i.test(description)) {
    return [
      "Hard scope constraint: propose exactly one implementation task and no task dependencies. More than one proposed task fails decomposition review.",
    ];
  }
  return [];
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
  for (const constraint of scopeSpecificArchitectConstraints(description)) {
    if (!bullets.includes(constraint)) bullets.unshift(constraint);
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

export async function defaultArchitectEnvironment(): Promise<AgentRunEnvironment> {
  // Pi's built-in read-only tools inspect the cloned repository. No
  // additional CLI extensions or Nix profile are required.
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
