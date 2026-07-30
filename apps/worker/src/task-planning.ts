import { createHash } from "node:crypto";
import {
  buildPlanReviewPacket,
  buildTaskPacket,
  prepareSandboxToolEnvironment,
  selectRuntimeBinding,
  type AgentRunEnvironment,
  type AgentRunMetadata,
  type AgentRuntimeAdapter,
  type DeployerRuntimeBinding,
} from "@colony/agent-runtime";
import {
  developerPlanEnvelopeSchema,
  planReviewEnvelopeSchema,
  reviewerReviewEnvelopeSchema,
  type DeveloperPlanEnvelope,
  type PlanReviewEnvelope,
  type ReviewerReviewEnvelope,
  type TaskPacket,
} from "@colony/schemas";
import { isTaskId, type ActorId, type Task } from "@colony/domain";
import type {
  ProviderProjectRepository,
  TaskGraphRepository,
} from "@colony/db";
import type { ProviderAdapter, ProviderProjectRef } from "@colony/provider";
import { buildPlanReviewerPrompt } from "./prompts/plan-reviewer.js";
import {
  mintEphemeralProjectAgentToken,
  revokeEphemeralProjectAgentToken,
  type EphemeralProjectAgentToken,
} from "./task-agent-tokens.js";

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;
const PLAN_REVIEW_LOOP_CAP_DEFAULT = 50;

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

export interface TaskPlanningDependencies {
  readonly repo: TaskGraphRepository;
  readonly agentRuntime: AgentRuntimeAdapter;
  readonly providerProjects?: ProviderProjectRepository;
  readonly providerAdapter?: ProviderAdapter;
  readonly buildRunEnvironment?: (
    task: Task,
    role: "developer_planner" | "plan_reviewer",
  ) => Promise<AgentRunEnvironment> | AgentRunEnvironment;
}

export interface StartDeveloperPlanRunInput {
  readonly task_id: string;
  readonly assignee: string;
}

export type StartDeveloperPlanRunResult =
  | {
      readonly started: false;
      readonly task_id?: string;
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly task_id: string;
      readonly run_id?: string;
      readonly envelope_status: "succeeded" | "envelope_rejected" | "failed";
      readonly outcome?: "done" | "blocked" | "escalate";
      readonly final_state: Task["state"];
      readonly developer_plan?: DeveloperPlanEnvelope;
      readonly reason?: string;
    };

export interface StartPlanReviewRunInput {
  readonly task_id: string;
  readonly reviewer: string;
  readonly developer_plan: unknown;
  readonly plan_review_loop_cap?: number;
}

export type StartPlanReviewRunResult =
  | {
      readonly started: false;
      readonly task_id?: string;
      readonly reason: string;
    }
  | {
      readonly started: true;
      readonly task_id: string;
      readonly run_id?: string;
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
      readonly plan_review?: PlanReviewEnvelope;
      readonly reason?: string;
    };

export function createStartDeveloperPlanRun(deps: TaskPlanningDependencies) {
  return async function startDeveloperPlanRun(
    input: StartDeveloperPlanRunInput,
  ): Promise<StartDeveloperPlanRunResult> {
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
    if (
      task.state !== "claimed" &&
      task.state !== "changes_requested" &&
      task.state !== "plan_proposed"
    ) {
      return {
        started: false,
        task_id: task.id,
        reason: `task_not_ready_for_plan:${task.state}`,
      };
    }
    if (task.assignee !== (input.assignee as ActorId)) {
      return { started: false, task_id: task.id, reason: "assignee_mismatch" };
    }

    const context = await planningProviderContext(
      deps,
      task,
      "developer-planner",
    );
    const planningContext = planningContextFor(task);
    const packet = buildTaskPacket({
      scope_id: task.scope_id,
      task_id: task.id,
      provider_issue: context.providerIssue,
      repo: context.repo,
      goal: task.title,
      acceptance_criteria: task.acceptance_criteria,
      non_goals: task.non_goals,
      dependencies: [],
      provider_context: context.providerContext,
      memory_bundle: {
        decisions: [],
        semantic: [],
        procedural: [],
        policy: [],
      },
      policy: {
        constraints: ["Prepare a bounded implementation plan before coding."],
        protected_paths: [],
        security_labels: [],
        always_human_review: false,
        review_loop_cap: PLAN_REVIEW_LOOP_CAP_DEFAULT,
      },
      capabilities: ["graph.read"],
      required_outputs: [
        {
          kind: "review_envelope",
          description: "developer_plan envelope",
        },
      ],
      tool_permissions: [],
      sandbox_profile: "developer-planner-default",
      known_risks: planningContext?.code_review
        ? planningContext.code_review.role_specific.findings.map(
            (finding) => finding.evidence,
          )
        : [],
      planning_context: planningContext,
      time_budget_minutes: 10,
      freshness: freshnessFor(task),
    });
    const runEnvironment =
      (await deps.buildRunEnvironment?.(task, "developer_planner")) ??
      (await defaultPlanningEnvironment("developer_planner"));
    let metadata: AgentRunMetadata;
    try {
      metadata = await deps.agentRuntime.startRun(packet, runEnvironment);
    } finally {
      await revokePlanningContext(deps, context, "developer_plan_run_finished");
    }
    if (metadata.status !== "succeeded") {
      await writePlanningRunRejectedAudit(
        deps.repo,
        task,
        metadata,
        "developer",
      );
      return {
        started: true,
        task_id: task.id,
        run_id: metadata.runId,
        envelope_status:
          metadata.status === "envelope_rejected"
            ? "envelope_rejected"
            : "failed",
        final_state: task.state,
        reason: metadata.rejectionReason ?? `agent_run_${metadata.status}`,
      };
    }
    const output = await deps.agentRuntime.getRunOutput(metadata.runId);
    const envelope = parseDeveloperPlanEnvelope(output?.envelope);

    if (!output || !envelope || envelope.task_id !== task.id) {
      await writePlanningEnvelopeRejectedAudit(
        deps.repo,
        task,
        metadata,
        "developer",
        "developer_plan_missing_or_mismatched",
      );
      return {
        started: true,
        task_id: task.id,
        run_id: metadata.runId,
        envelope_status: "envelope_rejected",
        final_state: task.state,
        reason: "developer_plan_missing_or_mismatched",
      };
    }
    if (envelope.freshness.packet_hash !== packet.freshness.packet_hash) {
      await writePlanningEnvelopeStaleAudit(
        deps.repo,
        task,
        metadata,
        envelope.freshness.packet_hash,
        packet.freshness.packet_hash,
        "developer",
      );
      return {
        started: true,
        task_id: task.id,
        run_id: metadata.runId,
        envelope_status: "envelope_rejected",
        final_state: task.state,
        reason: "envelope_freshness_mismatch",
      };
    }
    if (envelope.result === "blocked" || envelope.result === "escalate") {
      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor: input.assignee as ActorId,
        action:
          envelope.result === "blocked"
            ? "task.developer_plan.blocked"
            : "task.developer_plan.escalated",
        capability: "task.assign",
        target_kind: "agent_run",
        target_id: metadata.runId,
        reason: `developer_plan_${envelope.result}`,
        evidence: { run_id: metadata.runId, envelope_result: envelope.result },
      });
      return {
        started: true,
        task_id: task.id,
        run_id: metadata.runId,
        envelope_status: "succeeded",
        outcome: envelope.result,
        final_state: task.state,
        developer_plan: envelope,
      };
    }

    const recorded = await deps.repo.recordDeveloperPlan(
      {
        task_id: task.id,
        envelope_hash: hashJson(envelope),
        envelope,
      },
      {
        actor: input.assignee as ActorId,
        capability: "task.assign",
        reason: "developer_plan",
      },
    );
    await postPlanningIssueComment(
      deps,
      context,
      task,
      "task.plan.comment_posted",
      renderDeveloperPlanDigest(task, envelope),
    );
    // First plan from claimed/changes_requested transitions into plan_proposed.
    // A rework run is invoked when state is already plan_proposed (after plan
    // reviewer requested changes) and only refreshes the envelope.
    const planned =
      task.state === "plan_proposed"
        ? recorded
        : await deps.repo.updateTaskState(
            task.id,
            recorded.state_version,
            "plan_proposed",
            {
              actor: SUPERVISOR_ACTOR,
              capability: "task.assign",
              reason: "developer_plan_proposed",
            },
          );
    return {
      started: true,
      task_id: task.id,
      run_id: metadata.runId,
      envelope_status: "succeeded",
      outcome: "done",
      final_state: planned.state,
      developer_plan: envelope,
    };
  };
}

export function createStartPlanReviewRun(deps: TaskPlanningDependencies) {
  return async function startPlanReviewRun(
    input: StartPlanReviewRunInput,
  ): Promise<StartPlanReviewRunResult> {
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
    if (task.state !== "plan_proposed" && task.state !== "plan_review") {
      return {
        started: false,
        task_id: task.id,
        reason: `task_not_ready_for_plan_review:${task.state}`,
      };
    }
    const plan = developerPlanEnvelopeSchema.safeParse(input.developer_plan);

    if (!plan.success || plan.data.task_id !== task.id) {
      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor: SUPERVISOR_ACTOR,
        action: "task.plan_review.input_envelope_rejected",
        capability: "task.assign",
        target_kind: "task",
        target_id: task.id,
        reason: "developer_plan_missing_or_mismatched",
        evidence: { task_id: task.id },
      });
      return {
        started: true,
        task_id: task.id,
        envelope_status: "envelope_rejected",
        final_state: task.state,
        reason: "developer_plan_missing_or_mismatched",
      };
    }

    const cap = input.plan_review_loop_cap ?? PLAN_REVIEW_LOOP_CAP_DEFAULT;
    const reviewCount = await countPlanReviewAudits(deps.repo, task);
    if (reviewCount >= cap) {
      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor: SUPERVISOR_ACTOR,
        action: "task.plan_review.loop_cap_exceeded",
        capability: "task.assign",
        target_kind: "task",
        target_id: task.id,
        reason: `plan_review_loop_cap_exceeded:${reviewCount}/${cap}`,
        evidence: { review_count: reviewCount, cap },
      });
      return {
        started: false,
        task_id: task.id,
        reason: `loop_cap_exceeded:${reviewCount}/${cap}`,
      };
    }

    if (task.state !== "plan_review") {
      await deps.repo.updateTaskState(
        task.id,
        task.state_version,
        "plan_review",
        {
          actor: input.reviewer as ActorId,
          capability: "task.assign",
          reason: "plan_review_started",
        },
      );
    }
    const prompt = buildPlanReviewerPrompt({
      task: {
        id: task.id,
        scope_id: task.scope_id,
        title: task.title,
        description: task.description,
        acceptance_criteria: task.acceptance_criteria,
        non_goals: task.non_goals,
      },
      developerPlan: plan.data,
      reviewCount,
      loopCap: cap,
    });
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: input.reviewer as ActorId,
      action: "task.plan_review.prompt_prepared",
      capability: "task.assign",
      target_kind: "task",
      target_id: task.id,
      reason: "plan_review_started",
      evidence: {
        system_prompt_hash: hashJson(prompt.system),
        user_prompt_hash: hashJson(prompt.user),
      },
    });

    const context = await planningProviderContext(deps, task, "plan-reviewer");
    const packet = buildPlanReviewPacket({
      scope_id: task.scope_id,
      task_id: task.id,
      provider_issue: context.providerIssue,
      repo: context.repo,
      goal: task.title,
      acceptance_criteria: task.acceptance_criteria,
      non_goals: task.non_goals,
      dependencies: [],
      provider_context: {
        ...context.providerContext,
        labels: ["state:plan_proposed"],
      },
      memory_bundle: {
        decisions: [],
        semantic: [],
        procedural: [],
        policy: [],
      },
      policy: {
        constraints: [
          "Review the developer plan before implementation starts.",
        ],
        protected_paths: [],
        security_labels: [],
        always_human_review: false,
        review_loop_cap: cap,
      },
      capabilities: ["graph.read"],
      required_outputs: [
        { kind: "review_envelope", description: "plan_review envelope" },
      ],
      tool_permissions: [],
      sandbox_profile: "plan-reviewer-default",
      known_risks: [],
      time_budget_minutes: 10,
      freshness: {
        task_graph_version: `task:${task.state_version}`,
        provider_event_ts: plan.data.freshness.provider_event_ts,
        commit_sha: plan.data.freshness.commit_sha,
        policy_version: plan.data.freshness.policy_version,
        memory_bundle_version: plan.data.freshness.memory_bundle_version,
      },
      developer_plan: plan.data,
      review_count: reviewCount,
      loop_cap: cap,
    });
    const runEnvironment =
      (await deps.buildRunEnvironment?.(task, "plan_reviewer")) ??
      (await defaultPlanningEnvironment("plan_reviewer"));
    let metadata: AgentRunMetadata;
    try {
      metadata = await deps.agentRuntime.startRun(packet, runEnvironment);
    } finally {
      await revokePlanningContext(deps, context, "plan_review_run_finished");
    }
    if (metadata.status !== "succeeded") {
      await writePlanningRunRejectedAudit(
        deps.repo,
        task,
        metadata,
        "plan_review",
      );
      return {
        started: true,
        task_id: task.id,
        run_id: metadata.runId,
        envelope_status:
          metadata.status === "envelope_rejected"
            ? "envelope_rejected"
            : "failed",
        final_state: "plan_review",
        reason: metadata.rejectionReason ?? `agent_run_${metadata.status}`,
      };
    }
    const output = await deps.agentRuntime.getRunOutput(metadata.runId);
    const review = parsePlanReviewEnvelope(output?.envelope);

    if (!output || !review || review.task_id !== task.id) {
      await writePlanningEnvelopeRejectedAudit(
        deps.repo,
        task,
        metadata,
        "plan_review",
        "plan_review_missing_or_mismatched",
      );
      return {
        started: true,
        task_id: task.id,
        run_id: metadata.runId,
        envelope_status: "envelope_rejected",
        final_state: "plan_review",
        reason: "plan_review_missing_or_mismatched",
      };
    }
    if (review.freshness.packet_hash !== packet.freshness.packet_hash) {
      await writePlanningEnvelopeStaleAudit(
        deps.repo,
        task,
        metadata,
        review.freshness.packet_hash,
        packet.freshness.packet_hash,
        "plan_review",
      );
      return {
        started: true,
        task_id: task.id,
        run_id: metadata.runId,
        envelope_status: "envelope_rejected",
        final_state: "plan_review",
        reason: "envelope_freshness_mismatch",
      };
    }
    const reviewResult = mapPlanReviewResult(review.result);
    const recorded = await deps.repo.recordPlanReview(
      {
        task_id: task.id,
        envelope_hash: hashJson(review),
        result: reviewResult,
        envelope: review,
      },
      {
        actor: input.reviewer as ActorId,
        capability: "task.assign",
        reason: "plan_review",
      },
    );
    await postPlanningIssueComment(
      deps,
      context,
      task,
      "task.plan_review.comment_posted",
      renderPlanReviewDigest(task, review),
    );
    if (reviewResult === "blocked" || reviewResult === "escalate") {
      await deps.repo.writeAudit({
        scope_id: task.scope_id,
        task_id: task.id,
        actor: input.reviewer as ActorId,
        action:
          reviewResult === "blocked"
            ? "task.plan_review.blocked"
            : "task.plan_review.escalated",
        capability: "task.assign",
        target_kind: "task",
        target_id: task.id,
        reason: `plan_review_${reviewResult}`,
        evidence: { run_id: metadata.runId, envelope_hash: hashJson(review) },
      });
    }
    const final =
      reviewResult === "approved"
        ? await deps.repo.updateTaskState(
            task.id,
            recorded.state_version,
            "in_progress",
            {
              actor: SUPERVISOR_ACTOR,
              capability: "task.assign",
              reason: "plan_review_approved",
            },
          )
        : reviewResult === "changes_requested"
          ? await deps.repo.updateTaskState(
              task.id,
              recorded.state_version,
              "plan_proposed",
              {
                actor: SUPERVISOR_ACTOR,
                capability: "task.assign",
                reason: "plan_review_changes_requested",
              },
            )
          : { state: "plan_review" as Task["state"] };
    return {
      started: true,
      task_id: task.id,
      run_id: metadata.runId,
      envelope_status: "succeeded",
      outcome: reviewResult,
      review_result: reviewResult,
      final_state: final.state,
      plan_review: review,
    };
  };
}

function freshnessFor(task: Task): DeveloperPlanEnvelope["freshness"] {
  return {
    task_graph_version: `task:${task.state_version}`,
    provider_event_ts: new Date(0).toISOString(),
    commit_sha: "plan",
    policy_version: "policy:1",
    memory_bundle_version: "memory:1",
    packet_hash: "sha256:packet-hash-uncomputed",
  };
}

function parseDeveloperPlanEnvelope(
  envelope: unknown,
): DeveloperPlanEnvelope | null {
  const result = developerPlanEnvelopeSchema.safeParse(envelope);
  return result.success ? result.data : null;
}

function parsePlanReviewEnvelope(envelope: unknown): PlanReviewEnvelope | null {
  const result = planReviewEnvelopeSchema.safeParse(envelope);
  return result.success ? result.data : null;
}

function parseReviewerReviewEnvelope(
  envelope: unknown,
): ReviewerReviewEnvelope | null {
  const result = reviewerReviewEnvelopeSchema.safeParse(envelope);
  return result.success ? result.data : null;
}

function planningContextFor(
  task: Task,
): TaskPacket["planning_context"] | undefined {
  if (task.state !== "plan_proposed" && task.state !== "changes_requested") {
    return undefined;
  }
  const context: NonNullable<TaskPacket["planning_context"]> = {};
  const previousDeveloperPlan = parseDeveloperPlanEnvelope(
    task.developer_plan_envelope,
  );
  if (previousDeveloperPlan) {
    context.previous_developer_plan = previousDeveloperPlan;
  }
  const previousPlanReview = parsePlanReviewEnvelope(task.plan_review_envelope);
  if (previousPlanReview) {
    context.previous_plan_review = previousPlanReview;
  }
  const codeReview = parseReviewerReviewEnvelope(
    task.last_code_review_envelope,
  );
  if (codeReview) {
    context.code_review = codeReview;
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

function mapPlanReviewResult(
  result: PlanReviewEnvelope["result"],
): "approved" | "changes_requested" | "blocked" | "escalate" {
  if (result === "approved") return "approved";
  if (result === "blocked") return "blocked";
  if (result === "escalate") return "escalate";
  return "changes_requested";
}

async function countPlanReviewAudits(
  repo: TaskGraphRepository,
  task: Task,
): Promise<number> {
  const audit = await repo.listAuditForScope(task.scope_id, {
    task_id: task.id,
    limit: 500,
  });
  return audit.filter((a) => a.action === "task.plan_review.recorded").length;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function defaultPlanningEnvironment(
  role: "developer_planner" | "plan_reviewer",
): Promise<AgentRunEnvironment> {
  const tools = await prepareSandboxToolEnvironment(
    { skillMounts: [], cliTools: [] },
    {
      kind: "fallback",
      resolveTools: () => ({
        pathEntries: ["/colony/run-tools/bin"],
        profileHash: `sha256:tool-profile-${role}`,
        toolVersions: {},
      }),
    },
  );
  return {
    role,
    sandboxProfile: `${role}-default`,
    runtimeBinding: selectRuntimeBinding(DEFAULT_DEPLOYER_BINDING),
    runExtensions: { skillMounts: [], cliTools: [] },
    tools,
  };
}

interface PlanningProviderContext {
  readonly repo: TaskPacket["repo"];
  readonly providerIssue: TaskPacket["provider_issue"];
  readonly providerContext: TaskPacket["provider_context"];
  readonly projectRef?: ProviderProjectRef;
  readonly token: EphemeralProjectAgentToken | null;
  readonly purpose: string;
  readonly scopeId: Task["scope_id"];
  readonly taskId: Task["id"];
}

async function planningProviderContext(
  deps: TaskPlanningDependencies,
  task: Task,
  purpose: string,
): Promise<PlanningProviderContext> {
  const fallback = internalPlanningContext(task, purpose);
  if (!deps.providerProjects || !deps.providerAdapter) return fallback;

  const mirrors = await deps.providerProjects.listMirrorsForColony({
    colony_id: task.id,
    entity_kind: "task",
  });
  const mirror = mirrors[0];
  if (!mirror?.provider_project_id) return fallback;

  const project = await deps.providerProjects.getProject(
    mirror.provider_project_id,
  );
  if (!project || project.provider !== deps.providerAdapter.provider) {
    return fallback;
  }

  const projectRef: ProviderProjectRef = {
    id: project.provider_id,
    path: project.path,
  };
  const token = await mintEphemeralProjectAgentToken(
    {
      repo: deps.repo,
      providerAdapter: deps.providerAdapter,
    },
    {
      project: projectRef,
      audit: {
        scope_id: task.scope_id,
        task_id: task.id,
        actor: SUPERVISOR_ACTOR,
        capability: "graph.read",
        reason: `${purpose}_token_minted`,
        purpose,
      },
    },
  );

  return {
    repo: {
      url: project.path,
      branch: project.default_branch,
      base_commit: project.default_branch,
      ...(token ? { credentials: { token: token.token } } : {}),
    },
    providerIssue: {
      kind: "issue",
      id: mirror.provider_id,
      uri: mirror.provider_project_path
        ? `${mirror.provider_project_path}/issues/${mirror.provider_id}`
        : mirror.provider_id,
    },
    providerContext: {
      provider: project.provider,
      issue_id: mirror.provider_id,
      issue_url: mirror.provider_project_path
        ? `${mirror.provider_project_path}/issues/${mirror.provider_id}`
        : mirror.provider_id,
      labels: ["state:claimed"],
      recent_comments: [],
    },
    projectRef,
    token,
    purpose,
    scopeId: task.scope_id,
    taskId: task.id,
  };
}

function internalPlanningContext(
  task: Task,
  purpose: string,
): PlanningProviderContext {
  return {
    repo: {
      url: "internal",
      branch: "plan",
      base_commit: "plan",
    },
    providerIssue: { kind: "issue", id: task.id, uri: task.id },
    providerContext: {
      provider: "internal",
      issue_id: task.id,
      issue_url: task.id,
      labels: ["state:claimed"],
      recent_comments: [],
    },
    token: null,
    purpose,
    scopeId: task.scope_id,
    taskId: task.id,
  };
}

async function revokePlanningContext(
  deps: TaskPlanningDependencies,
  context: PlanningProviderContext,
  reason: string,
): Promise<void> {
  if (!deps.providerAdapter || !context.projectRef) return;
  await revokeEphemeralProjectAgentToken(
    {
      repo: deps.repo,
      providerAdapter: deps.providerAdapter,
    },
    {
      project: context.projectRef,
      token: context.token,
      audit: {
        scope_id: context.scopeId,
        task_id: context.taskId,
        actor: SUPERVISOR_ACTOR,
        capability: "graph.read",
        reason,
        purpose: context.purpose,
      },
    },
  );
}

async function postPlanningIssueComment(
  deps: TaskPlanningDependencies,
  context: PlanningProviderContext,
  task: Task,
  action: string,
  body: string,
): Promise<void> {
  if (!deps.providerAdapter || !context.projectRef) return;
  try {
    const comment = await deps.providerAdapter.issues.comment(
      context.projectRef,
      context.providerIssue.id,
      body.slice(0, 6000),
    );
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: SUPERVISOR_ACTOR,
      action,
      capability: "provider.issues.comment",
      target_kind: "issue_comment",
      target_id: comment.id,
      reason: "planning_digest_posted",
      evidence: {
        provider_issue_id: context.providerIssue.id,
      },
    });
  } catch (err) {
    await deps.repo.writeAudit({
      scope_id: task.scope_id,
      task_id: task.id,
      actor: SUPERVISOR_ACTOR,
      action: `${action}.failed`,
      capability: "provider.issues.comment",
      target_kind: "issue",
      target_id: context.providerIssue.id,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function renderDeveloperPlanDigest(
  task: Task,
  envelope: DeveloperPlanEnvelope,
): string {
  return [
    `[colony:${task.id}] Developer plan proposed`,
    "",
    `**Result:** ${envelope.result}`,
    `**Confidence:** ${envelope.confidence.toFixed(2)}`,
    `**Risk:** ${envelope.risk_level}`,
    "",
    "**Approach**",
    envelope.role_specific.approach,
    "",
    "**Files to touch**",
    renderList(envelope.role_specific.files_to_touch),
    "",
    "**Verification**",
    renderList(envelope.role_specific.tests_to_add),
    "",
    "**Risks**",
    renderList(envelope.role_specific.risks),
    "",
    `**Rationale:** ${envelope.rationale}`,
  ].join("\n");
}

function renderPlanReviewDigest(
  task: Task,
  envelope: PlanReviewEnvelope,
): string {
  const notes = [
    envelope.rationale,
    ...envelope.policy_flags.map((flag) => `Policy: ${flag}`),
  ].filter((note) => note.trim().length > 0);
  return [
    `[colony:${task.id}] Plan review ${envelope.result}`,
    "",
    `**Next action:** ${envelope.next_action}`,
    `**Confidence:** ${envelope.confidence.toFixed(2)}`,
    `**Risk:** ${envelope.risk_level}`,
    "",
    "**Reviewer notes**",
    renderList(notes),
  ].join("\n");
}

function renderList(items: readonly string[]): string {
  if (items.length === 0) return "- (none)";
  return items.map((item) => `- ${item}`).join("\n");
}

async function writePlanningRunRejectedAudit(
  repo: TaskGraphRepository,
  task: Task,
  metadata: AgentRunMetadata,
  kind: "developer" | "plan_review",
): Promise<void> {
  await repo.writeAudit({
    scope_id: task.scope_id,
    task_id: task.id,
    actor: SUPERVISOR_ACTOR,
    action: `task.${kind}.run_rejected`,
    capability: "task.assign",
    target_kind: "agent_run",
    target_id: metadata.runId,
    reason: metadata.rejectionReason ?? `agent_run_${metadata.status}`,
    evidence: {
      run_id: metadata.runId,
      status: metadata.status,
      packet_hash: metadata.packetHash,
      rejection_reason: metadata.rejectionReason,
    },
  });
}

async function writePlanningEnvelopeStaleAudit(
  repo: TaskGraphRepository,
  task: Task,
  metadata: AgentRunMetadata,
  envelopePacketHash: string,
  packetHash: string,
  kind: "developer" | "plan_review",
): Promise<void> {
  await repo.writeAudit({
    scope_id: task.scope_id,
    task_id: task.id,
    actor: SUPERVISOR_ACTOR,
    action: `task.${kind}.envelope_stale`,
    capability: "task.assign",
    target_kind: "agent_run",
    target_id: metadata.runId,
    reason: "freshness_mismatch",
    evidence: {
      run_id: metadata.runId,
      packet_hash: packetHash,
      envelope_packet_hash: envelopePacketHash,
    },
  });
}

async function writePlanningEnvelopeRejectedAudit(
  repo: TaskGraphRepository,
  task: Task,
  metadata: AgentRunMetadata,
  kind: "developer" | "plan_review",
  reason: string,
): Promise<void> {
  await repo.writeAudit({
    scope_id: task.scope_id,
    task_id: task.id,
    actor: SUPERVISOR_ACTOR,
    action: `task.${kind}.envelope_rejected`,
    capability: "task.assign",
    target_kind: "agent_run",
    target_id: metadata.runId,
    reason,
    evidence: { run_id: metadata.runId, status: metadata.status },
  });
}
