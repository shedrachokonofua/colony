import {
  FakeAgentRuntimeAdapter,
  buildTaskPacket,
  hashEnvelope,
  prepareSandboxToolEnvironment,
  selectRuntimeBinding,
  type AgentRunEnvironment,
  type AgentRunMetadata,
  type AgentRuntimeAdapter,
  type DeployerRuntimeBinding,
} from "@colony/agent-runtime";
import {
  developerCompletionEnvelopeSchema,
  type DeveloperCompletionEnvelope,
} from "@colony/schemas";
import {
  ProviderProjectRepository,
  TaskGraphRepository,
  type Pool,
} from "@colony/db";
import {
  isTaskId,
  type ActorId,
  type ProviderMirror,
  type ProviderProject,
  type Task,
} from "@colony/domain";
import type { ProviderAdapter, ProviderProjectRef } from "@colony/provider";
import type { Freshness } from "@colony/schemas";

/**
 * COL-2.9 Developer execution flow.
 *
 * The activity assumes a task has already been claimed (state=`claimed`,
 * assignee set). It builds a TaskPacket, runs the agent, ingests the
 * completion envelope, opens the MR through the Provider Adapter from the
 * agent-pushed branch, mirrors the MR into `provider_mirrors`, and advances
 * the task `claimed -> in_progress -> review_requested`. Branch creation
 * (push) is the agent's responsibility inside the prepared sandbox; this
 * activity only wires the supervisor side.
 */

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;

const DEFAULT_DEPLOYER_BINDING: DeployerRuntimeBinding = {
  name: "local-permissive",
  environment: "local",
  networkPosture: "permissive",
  env: [],
  configMounts: [],
  credentialBindings: [
    {
      name: "git-provider",
      capability: "provider.branches.push",
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

export interface DeveloperRunDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly providerAdapter: ProviderAdapter;
  readonly agentRuntime: AgentRuntimeAdapter;
  readonly buildRunEnvironment?: (
    task: Task,
  ) => Promise<AgentRunEnvironment> | AgentRunEnvironment;
}

export interface StartDeveloperRunInput {
  readonly task_id: string;
  readonly assignee: string;
}

export type StartDeveloperRunResult =
  | {
      readonly started: false;
      readonly task_id?: string;
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly task_id: string;
      readonly run_id: string;
      readonly envelope_status: "succeeded" | "envelope_rejected" | "failed";
      readonly final_state: Task["state"];
      readonly mr?: {
        readonly id: string;
        readonly source_branch: string;
        readonly target_branch: string;
        readonly url?: string;
      };
      readonly reason?: string;
    };

export function createDeveloperRun(deps: DeveloperRunDependencies) {
  return async function startDeveloperRun(
    input: StartDeveloperRunInput,
  ): Promise<StartDeveloperRunResult> {
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
    if (task.state !== "claimed") {
      return {
        started: false,
        task_id: task.id,
        reason: `task_not_claimed:${task.state}`,
      };
    }
    if (task.assignee !== (input.assignee as ActorId)) {
      return {
        started: false,
        task_id: task.id,
        reason: "assignee_mismatch",
      };
    }

    const scope = await deps.repo.getScope(task.scope_id);
    if (!scope) {
      return {
        started: false,
        task_id: task.id,
        reason: "scope_not_found",
      };
    }

    const mirror = await primaryTaskMirror(deps, task.id);
    if (!mirror?.provider_project_id) {
      return {
        started: false,
        task_id: task.id,
        reason: "task_has_no_provider_mirror",
      };
    }
    const project = await deps.providerProjects.getProject(
      mirror.provider_project_id,
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

    const sourceBranch = developerBranchName(task.id);
    const freshness = freshnessFor(task, project);
    const packet = buildTaskPacket({
      scope_id: task.scope_id,
      task_id: task.id,
      provider_issue: {
        kind: "issue",
        id: mirror.provider_id,
        uri: mirror.provider_project_path
          ? `${mirror.provider_project_path}/issues/${mirror.provider_id}`
          : mirror.provider_id,
      },
      repo: {
        url: project.path,
        branch: sourceBranch,
        base_commit: freshness.commit_sha,
      },
      goal: task.title,
      acceptance_criteria: task.acceptance_criteria,
      non_goals: task.non_goals,
      dependencies: [],
      provider_context: {
        provider: project.provider,
        issue_id: mirror.provider_id,
        issue_url: mirror.provider_project_path
          ? `${mirror.provider_project_path}/issues/${mirror.provider_id}`
          : mirror.provider_id,
        labels: ["agent:developer", "state:claimed"],
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
      capabilities: ["tool.cli.execute", "provider.branches.push"],
      required_outputs: [
        { kind: "commit", description: "head commit on the work branch" },
        { kind: "mr", description: "merge request to the default branch" },
      ],
      tool_permissions: ["git"],
      sandbox_profile: "developer-default",
      known_risks: [],
      time_budget_minutes: 30,
      freshness,
    });

    const runEnvironment =
      (await deps.buildRunEnvironment?.(task)) ??
      (await defaultRunEnvironment());

    const metadata = await deps.agentRuntime.startRun(packet, runEnvironment);

    if (metadata.status !== "succeeded") {
      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor: SUPERVISOR_ACTOR,
        action: "developer.run.rejected",
        capability: "task.assign",
        target_kind: "agent_run",
        target_id: metadata.runId,
        reason: "envelope_rejected",
        evidence: {
          run_id: metadata.runId,
          status: metadata.status,
          packet_hash: metadata.packetHash,
          runtime_binding_hash: metadata.runtimeBindingHash,
        },
      });
      return {
        started: true,
        task_id: task.id,
        run_id: metadata.runId,
        envelope_status:
          metadata.status === "envelope_rejected"
            ? "envelope_rejected"
            : "failed",
        final_state: task.state,
        reason: `agent_run_${metadata.status}`,
      };
    }

    const output = await deps.agentRuntime.getRunOutput(metadata.runId);
    const developerEnvelope = parseDeveloperEnvelope(output?.envelope);
    if (
      !output ||
      !developerEnvelope ||
      developerEnvelope.task_id !== task.id
    ) {
      return {
        started: true,
        task_id: task.id,
        run_id: metadata.runId,
        envelope_status: "envelope_rejected",
        final_state: task.state,
        reason: "envelope_missing_or_mismatched",
      };
    }
    if (
      developerEnvelope.freshness.packet_hash !== packet.freshness.packet_hash
    ) {
      await writeStaleEnvelopeAudit(deps, task, metadata, developerEnvelope);
      return {
        started: true,
        task_id: task.id,
        run_id: metadata.runId,
        envelope_status: "envelope_rejected",
        final_state: task.state,
        reason: "envelope_freshness_mismatch",
      };
    }

    // Promote claimed -> in_progress.
    const inProgress = await deps.repo.updateTaskState(
      task.id,
      task.state_version,
      "in_progress",
      {
        actor: SUPERVISOR_ACTOR,
        capability: "task.assign",
        reason: "developer_run_started",
      },
    );

    const projectRef: ProviderProjectRef = {
      id: project.provider_id,
      path: project.path,
    };

    const mr = await openOrFindMergeRequest({
      adapter: deps.providerAdapter,
      project: projectRef,
      title: task.title,
      description: developerMrDescription(
        task,
        metadata,
        developerEnvelope,
        packet.freshness.packet_hash,
      ),
      source_branch: sourceBranch,
      target_branch: project.default_branch,
    });

    await deps.providerProjects.upsertMirror({
      colony_id: task.id,
      entity_kind: "mr_pr",
      provider: project.provider,
      provider_id: mr.id,
      provider_project_id: project.id,
      provider_project_path: project.path,
      source_version: hashEnvelope(developerEnvelope),
    });

    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: SUPERVISOR_ACTOR,
      action: "provider.mr.opened",
      capability: "provider.mr.open",
      target_kind: "merge_request",
      target_id: mr.id,
      reason: "developer_run_completed",
      evidence: {
        run_id: metadata.runId,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        provider: project.provider,
        provider_project_id: project.id,
        envelope_hash: output.envelopeHash,
      },
    });

    const finalTask = await deps.repo.updateTaskState(
      task.id,
      inProgress.state_version,
      "review_requested",
      {
        actor: SUPERVISOR_ACTOR,
        capability: "task.assign",
        reason: "developer_envelope_request_review",
      },
    );

    return {
      started: true,
      task_id: task.id,
      run_id: metadata.runId,
      envelope_status: "succeeded",
      final_state: finalTask.state,
      mr: {
        id: mr.id,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        url: mr.metadata.web_url,
      },
    };
  };
}

async function primaryTaskMirror(
  deps: DeveloperRunDependencies,
  task_id: string,
): Promise<ProviderMirror | undefined> {
  const mirrors = await deps.providerProjects.listMirrorsForColony({
    colony_id: task_id,
    entity_kind: "task",
  });
  return mirrors[0];
}

interface OpenMergeRequestArgs {
  readonly adapter: ProviderAdapter;
  readonly project: ProviderProjectRef;
  readonly title: string;
  readonly description: string;
  readonly source_branch: string;
  readonly target_branch: string;
}

async function openOrFindMergeRequest(args: OpenMergeRequestArgs) {
  return args.adapter.mergeRequests.open(args.project, {
    title: args.title,
    description: args.description,
    source_branch: args.source_branch,
    target_branch: args.target_branch,
  });
}

function developerBranchName(task_id: string): string {
  // Stable per-task branch so re-runs land on the same MR; agent push and
  // supervisor MR-open use the same name without coordination beyond the
  // task ID.
  return `colony/${task_id.replace(/[^a-zA-Z0-9._/-]/g, "-")}`;
}

function developerMrDescription(
  task: Task,
  metadata: AgentRunMetadata,
  envelope: DeveloperCompletionEnvelope,
  packetHash: string,
): string {
  const commit = envelope.artifacts.find((a) => a.kind === "commit");
  const lines = [
    `Colony task: ${task.id}`,
    "",
    task.description,
    "",
    `> Opened automatically by Colony supervisor after developer run \`${metadata.runId}\`.`,
    `> Envelope rationale: ${envelope.rationale}`,
    `> Packet hash: ${packetHash}`,
    `> Runtime binding: ${metadata.runtimeBindingName} (${metadata.runtimeBindingHash})`,
  ];
  if (commit) {
    lines.push(`> Head commit: ${commit.hash ?? commit.id}`);
  }
  return lines.join("\n");
}

function parseDeveloperEnvelope(
  envelope: unknown,
): DeveloperCompletionEnvelope | null {
  const result = developerCompletionEnvelopeSchema.safeParse(envelope);
  return result.success ? result.data : null;
}

function freshnessFor(task: Task, project: ProviderProject): Freshness {
  // Activities run outside workflow determinism so wall-clock reads here are
  // fine. The packet builder will recompute `packet_hash` over the canonical
  // packet; the placeholder below is replaced before validation.
  return {
    task_graph_version: `task:${task.state_version}`,
    provider_event_ts: new Date(0).toISOString(),
    commit_sha: project.default_branch,
    policy_version: "policy:1",
    memory_bundle_version: "memory:1",
    packet_hash: "sha256:packet-hash-uncomputed",
  };
}

async function writeStaleEnvelopeAudit(
  deps: DeveloperRunDependencies,
  task: Task,
  metadata: AgentRunMetadata,
  envelope: DeveloperCompletionEnvelope,
): Promise<void> {
  await deps.repo.writeAudit({
    scope_id: task.scope_id,
    task_id: task.id,
    actor: SUPERVISOR_ACTOR,
    action: "developer.envelope.stale",
    capability: "task.assign",
    target_kind: "agent_run",
    target_id: metadata.runId,
    reason: "freshness_mismatch",
    evidence: {
      run_id: metadata.runId,
      packet_hash: metadata.packetHash,
      envelope_packet_hash: envelope.freshness.packet_hash,
      envelope_task_id: envelope.task_id,
    },
  });
}

async function defaultRunEnvironment(): Promise<AgentRunEnvironment> {
  const tools = await prepareSandboxToolEnvironment(
    {
      skillMounts: [],
      cliTools: [
        {
          name: "git",
          executable: "git",
          resolver: "nix",
          packageRef: "nixpkgs#git",
          requiredCapabilities: ["tool.cli.execute"],
          envAllowlist: [],
        },
      ],
      nixProfile: {
        flakeRef: "github:shdrch/colony-agent-tools#developer",
        packages: [{ name: "git", ref: "nixpkgs#git" }],
      },
    },
    {
      kind: "fallback",
      resolveTools: () => ({
        pathEntries: ["/colony/run-tools/bin"],
        profileHash: "sha256:tool-profile",
        toolVersions: { git: "2.51.0" },
      }),
    },
  );
  return {
    role: "developer",
    sandboxProfile: "developer-default",
    runtimeBinding: selectRuntimeBinding(DEFAULT_DEPLOYER_BINDING),
    runExtensions: {
      skillMounts: [],
      cliTools: [
        {
          name: "git",
          executable: "git",
          resolver: "nix",
          packageRef: "nixpkgs#git",
          requiredCapabilities: ["tool.cli.execute"],
          envAllowlist: [],
        },
      ],
    },
    tools,
  };
}

export function createDefaultAgentRuntime(): AgentRuntimeAdapter {
  // Phase 2 ships against the FakeAgentRuntimeAdapter; pi-coding-agent
  // wiring lives behind a deployer-supplied adapter once integration is
  // available.
  return new FakeAgentRuntimeAdapter();
}

export type { Pool };
