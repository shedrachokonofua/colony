import type { Role } from "@colony/domain";
import {
  type ArchitectDecompositionEnvelope,
  type ArchitectPacket,
  type DeveloperCompletionEnvelope,
  type DeveloperPlanEnvelope,
  type PlanReviewEnvelope,
  type PlanReviewPacket,
  type ReviewPacket,
  type ReviewerReviewEnvelope,
  type TaskPacket,
  architectDecompositionEnvelopeSchema,
  developerCompletionEnvelopeSchema,
  developerPlanEnvelopeSchema,
  planReviewEnvelopeSchema,
  reviewerReviewEnvelopeSchema,
} from "@colony/schemas";
import type { SandboxRunExtensions } from "./run-extensions.js";
import type { RuntimeBindingSelection } from "./runtime-bindings.js";
import type { PreparedSandboxToolEnvironment } from "./tool-materialization.js";
import { hashEnvelope, hashPacket } from "./packet-builders.js";

export type AgentRuntimePacket =
  | TaskPacket
  | PlanReviewPacket
  | ReviewPacket
  | ArchitectPacket;
export type AgentRuntimeEnvelope =
  | DeveloperPlanEnvelope
  | PlanReviewEnvelope
  | DeveloperCompletionEnvelope
  | ReviewerReviewEnvelope
  | ArchitectDecompositionEnvelope;

export type AgentRuntimeRole =
  | Extract<Role, "developer" | "reviewer" | "architect">
  | "developer_planner"
  | "plan_reviewer";

export type AgentRunRuntimeStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "envelope_rejected";

export interface AgentRunEnvironment {
  readonly role: AgentRuntimeRole;
  readonly sandboxProfile: string;
  readonly runtimeBinding: RuntimeBindingSelection;
  readonly runExtensions: SandboxRunExtensions;
  readonly tools: PreparedSandboxToolEnvironment;
}

export interface AgentRunMetadata {
  readonly runId: string;
  readonly sandboxId: string;
  readonly role: AgentRunEnvironment["role"];
  readonly status: AgentRunRuntimeStatus;
  readonly packetHash: string;
  readonly outputEnvelopeHash?: string;
  readonly runtimeBindingName: string;
  readonly runtimeBindingHash: string;
  readonly toolProfileHash: string;
  /**
   * Populated when status is `envelope_rejected` or `failed` — short reason
   * suitable for audit evidence. Truncated to a few hundred characters.
   */
  readonly rejectionReason?: string;
}

export interface AgentRunOutput {
  readonly envelope: AgentRuntimeEnvelope;
  readonly envelopeHash: string;
}

export interface AgentRuntimeAdapter {
  startRun(
    packet: AgentRuntimePacket,
    runEnvironment: AgentRunEnvironment,
  ): Promise<AgentRunMetadata>;
  getRunStatus(runId: string): Promise<AgentRunMetadata | null>;
  getRunOutput(runId: string): Promise<AgentRunOutput | null>;
  cancelRun(runId: string): Promise<AgentRunMetadata | null>;
}

export function start_run(
  adapter: AgentRuntimeAdapter,
  packet: AgentRuntimePacket,
  run_environment: AgentRunEnvironment,
): Promise<AgentRunMetadata> {
  return adapter.startRun(packet, run_environment);
}

export function get_run_status(
  adapter: AgentRuntimeAdapter,
  run_id: string,
): Promise<AgentRunMetadata | null> {
  return adapter.getRunStatus(run_id);
}

export function get_run_output(
  adapter: AgentRuntimeAdapter,
  run_id: string,
): Promise<AgentRunOutput | null> {
  return adapter.getRunOutput(run_id);
}

export function cancel_run(
  adapter: AgentRuntimeAdapter,
  run_id: string,
): Promise<AgentRunMetadata | null> {
  return adapter.cancelRun(run_id);
}

export interface FakeAgentRuntimeOptions {
  readonly envelopeForRun?: (
    packet: AgentRuntimePacket,
    environment: AgentRunEnvironment,
  ) => unknown;
}

export class FakeAgentRuntimeAdapter implements AgentRuntimeAdapter {
  private nextId = 1;
  private readonly runs = new Map<
    string,
    AgentRunMetadata & { readonly output?: AgentRunOutput }
  >();

  constructor(private readonly options: FakeAgentRuntimeOptions = {}) {}

  startRun(
    packet: AgentRuntimePacket,
    runEnvironment: AgentRunEnvironment,
  ): Promise<AgentRunMetadata> {
    const runId = `run-${this.nextId++}`;
    const sandboxId = `sandbox-${runId}`;
    const packetHash = hashPacket(packet);
    const rawEnvelope =
      this.options.envelopeForRun?.(packet, runEnvironment) ??
      defaultEnvelope(packet, runEnvironment.role);
    const parsed = parseEnvelope(runEnvironment.role, rawEnvelope);
    const status: AgentRunRuntimeStatus = parsed.ok
      ? "succeeded"
      : "envelope_rejected";
    const output = parsed.ok
      ? {
          envelope: parsed.envelope,
          envelopeHash: hashEnvelope(parsed.envelope),
        }
      : undefined;
    const metadata: AgentRunMetadata = {
      runId,
      sandboxId,
      role: runEnvironment.role,
      status,
      packetHash,
      outputEnvelopeHash: output?.envelopeHash,
      runtimeBindingName: runEnvironment.runtimeBinding.binding.name,
      runtimeBindingHash: runEnvironment.runtimeBinding.hash,
      toolProfileHash: runEnvironment.tools.manifest.profileHash,
      rejectionReason: parsed.ok ? undefined : truncate(parsed.reason),
    };
    this.runs.set(runId, { ...metadata, output });
    return Promise.resolve(metadata);
  }

  getRunStatus(runId: string): Promise<AgentRunMetadata | null> {
    const run = this.runs.get(runId);
    return Promise.resolve(run ? withoutOutput(run) : null);
  }

  getRunOutput(runId: string): Promise<AgentRunOutput | null> {
    return Promise.resolve(this.runs.get(runId)?.output ?? null);
  }

  cancelRun(runId: string): Promise<AgentRunMetadata | null> {
    const run = this.runs.get(runId);
    if (!run) return Promise.resolve(null);
    const canceled = { ...run, status: "canceled" as const };
    this.runs.set(runId, canceled);
    return Promise.resolve(withoutOutput(canceled));
  }
}

export function truncate(value: string, max = 400): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export type EnvelopeParseResult =
  | { readonly ok: true; readonly envelope: AgentRuntimeEnvelope }
  | { readonly ok: false; readonly reason: string };

export function parseEnvelope(
  role: AgentRuntimeRole,
  value: unknown,
): EnvelopeParseResult {
  const schema =
    role === "developer_planner"
      ? developerPlanEnvelopeSchema
      : role === "plan_reviewer"
        ? planReviewEnvelopeSchema
        : role === "developer"
          ? developerCompletionEnvelopeSchema
          : role === "reviewer"
            ? reviewerReviewEnvelopeSchema
            : architectDecompositionEnvelopeSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.message };
  }
  return { ok: true, envelope: parsed.data };
}

function defaultEnvelope(
  packet: AgentRuntimePacket,
  role: AgentRuntimeRole,
): AgentRuntimeEnvelope {
  if (role === "architect") {
    const scopeId = packet.scope_id;
    return architectDecompositionEnvelopeSchema.parse({
      version: 1,
      result: "done",
      confidence: 0.7,
      requires_human: true,
      risk_level: "medium",
      artifacts: [],
      policy_flags: [],
      next_action: "propose_decomposition",
      freshness: packet.freshness,
      rationale: "Fake architect run proposed a single-task decomposition.",
      scope_id: scopeId,
      role_specific: {
        proposed_tasks: [
          {
            proposed_task_id: `${scopeId}.1`,
            title: "Initial scope task",
            description: "Placeholder task produced by fake architect run.",
            acceptance_criteria: ["scope produces at least one task"],
            non_goals: [],
            suggested_role: "developer",
            suggested_capabilities: [],
          },
        ],
        proposed_dependencies: [],
        open_questions: [],
        assumptions: [],
      },
    });
  }

  // Both developer and reviewer envelopes carry task_id; only task/review
  // packets reach this branch, and both expose `task_id`.
  const taskId = (packet as TaskPacket).task_id;

  if (role === "developer_planner") {
    return developerPlanEnvelopeSchema.parse({
      version: 1,
      result: "done",
      confidence: 0.75,
      requires_human: false,
      risk_level: "medium",
      artifacts: [],
      policy_flags: [],
      next_action: "request_review",
      freshness: packet.freshness,
      rationale: "Fake developer planner prepared an implementation plan.",
      task_id: taskId,
      role_specific: {
        approach:
          "Inspect the existing implementation, make the smallest scoped change, and run the relevant verification.",
        files_to_touch: [],
        tests_to_add: ["Run the narrowest relevant test or check."],
        risks: [],
      },
    });
  }

  if (role === "plan_reviewer") {
    return planReviewEnvelopeSchema.parse({
      version: 1,
      result: "approved",
      confidence: 0.8,
      requires_human: false,
      risk_level: "medium",
      artifacts: [],
      policy_flags: [],
      next_action: "open_gate",
      freshness: packet.freshness,
      rationale: "Fake plan reviewer approved the implementation plan.",
      task_id: taskId,
      role_specific: {
        findings: [],
        summary: "Plan approved.",
      },
    });
  }

  if (role === "developer") {
    return developerCompletionEnvelopeSchema.parse({
      version: 1,
      result: "done",
      confidence: 0.8,
      requires_human: false,
      risk_level: "medium",
      artifacts: [
        {
          kind: "commit",
          id: "fake-commit",
          uri: "fake://commit",
          hash: "abc123",
        },
        { kind: "mr", id: "fake-mr", uri: "fake://mr/1" },
      ],
      policy_flags: [],
      next_action: "request_review",
      freshness: packet.freshness,
      rationale: "Fake developer run completed.",
      task_id: taskId,
      role_specific: {
        tests_added: [],
        self_review_notes: "Fake run.",
      },
    });
  }

  return reviewerReviewEnvelopeSchema.parse({
    version: 1,
    result: "approved",
    confidence: 0.8,
    requires_human: false,
    risk_level: "medium",
    artifacts: [{ kind: "mr", id: "fake-mr", uri: "fake://mr/1" }],
    policy_flags: [],
    next_action: "merge",
    freshness: packet.freshness,
    rationale: "Fake reviewer run approved.",
    task_id: taskId,
    role_specific: {
      findings: [],
      summary: "No findings.",
      mr_comment_body:
        "Reviewer agent approved the change. No findings were reported.",
    },
  });
}

function withoutOutput(
  run: AgentRunMetadata & { readonly output?: AgentRunOutput },
): AgentRunMetadata {
  return {
    runId: run.runId,
    sandboxId: run.sandboxId,
    role: run.role,
    status: run.status,
    packetHash: run.packetHash,
    outputEnvelopeHash: run.outputEnvelopeHash,
    runtimeBindingName: run.runtimeBindingName,
    runtimeBindingHash: run.runtimeBindingHash,
    toolProfileHash: run.toolProfileHash,
    rejectionReason: run.rejectionReason,
  };
}
