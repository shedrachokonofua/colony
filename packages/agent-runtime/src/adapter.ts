import {
  type ArchitectDecompositionV2,
  type ImplementerCompletionV2,
  type ReviewerVerdictV2,
  PlanReviewVerdictV1,
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
  ImplementerCompletionV2 as implementerCompletionV2Schema,
  ReviewerVerdictV2 as reviewerVerdictV2Schema,
} from "@colony/schemas";
import {
  ArchitectExtensionEnvelope,
  type ArchitectExtensionEnvelope as ArchitectExtensionEnvelopeType,
  isArchitectExtensionPacket,
} from "./architect-extension.js";
import type { Context } from "@opentelemetry/api";
import type { SandboxHandle } from "@colony/sandbox";
import { sha256Json } from "./hashing.js";

/**
 * V2 packet shape. Structurally open: colonyd supplies `goal`/`task_id`,
 * `body` (the markdown spec), `repo` (workspace ref), and optional context
 * such as `previous_gate_failure`. Helpers cast defensively.
 */
export interface AgentRuntimePacket {
  readonly [key: string]: unknown;
}

export type AgentRuntimeEnvelope =
  | ArchitectDecompositionV2
  | ArchitectExtensionEnvelopeType
  | ImplementerCompletionV2
  | ReviewerVerdictV2
  | PlanReviewVerdictV1;

export type AgentRuntimeRole =
  | "architect"
  | "developer"
  | "reviewer"
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
  /** Caller-supplied run id; adapters use it so cancelRun(runId) addresses the same run. */
  readonly runId?: string;
  /**
   * Dispatch-time model choice when the primary has no free slot. Runners
   * rotate their configured chain so this model leads while preserving the
   * remaining configured order.
   */
  readonly startModelId?: string;
  /**
   * Caller-bound span context (the colony.run root span). When set, runners
   * activate it around prompts so the SDK's GenAI spans nest under it.
   */
  readonly traceContext?: Context;
}

export interface AgentRunMetadata {
  readonly runId: string;
  readonly sandboxId: string;
  readonly role: AgentRunEnvironment["role"];
  readonly status: AgentRunRuntimeStatus;
  readonly packetHash: string;
  readonly outputEnvelopeHash?: string;
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

/** What a resumed run needs beyond a fresh one: its surviving sandbox. */
export interface AgentRunResumeEnvironment extends AgentRunEnvironment {
  readonly sandboxId: string;
  readonly sessionsDir: string;
  readonly connect: (id: string) => Promise<SandboxHandle>;
}

export interface AgentRuntimeAdapter {
  startRun(
    packet: AgentRuntimePacket,
    runEnvironment: AgentRunEnvironment,
  ): Promise<AgentRunMetadata>;
  getRunStatus(runId: string): Promise<AgentRunMetadata | null>;
  getRunOutput(runId: string): Promise<AgentRunOutput | null>;
  cancelRun(runId: string): Promise<AgentRunMetadata | null>;
  /**
   * Continues a checkpointed run on its surviving sandbox. Optional: an
   * adapter without durable sessions cannot resume and need not implement
   * it.
   */
  resumeRun?(
    packet: AgentRuntimePacket,
    runEnvironment: AgentRunResumeEnvironment,
  ): Promise<AgentRunMetadata>;
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
  /**
   * Envelope returned by a resumed run; unset means the same envelope a fresh
   * run would produce. Integration tests that drive adoption supply the
   * continuation here.
   */
  readonly envelopeForResume?: (
    packet: AgentRuntimePacket,
    environment: AgentRunResumeEnvironment,
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
    const runId = runEnvironment.runId ?? `run-${this.nextId++}`;
    const sandboxId = `sandbox-${runId}`;
    const packetHash = hashPacket(packet);
    const rawEnvelope =
      this.options.envelopeForRun?.(packet, runEnvironment) ??
      defaultEnvelope(packet, runEnvironment.role);
    const parsed = parseEnvelope(runEnvironment.role, rawEnvelope, packet);
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

  async resumeRun(
    packet: AgentRuntimePacket,
    runEnvironment: AgentRunResumeEnvironment,
  ): Promise<AgentRunMetadata> {
    const runId = runEnvironment.runId ?? `run-${this.nextId++}`;
    // A resumed run must prove the surviving sandbox is really there: the
    // handle is what the continuation runs against, so connect first and let
    // a dead sandbox reject here rather than after the run is marked live.
    const handle = await runEnvironment.connect(runEnvironment.sandboxId);
    const probe = await handle.exec({ command: "true" }, () => undefined);
    if (probe.exitCode !== 0) {
      const failed: AgentRunMetadata = {
        runId,
        sandboxId: runEnvironment.sandboxId,
        role: runEnvironment.role,
        status: "failed",
        packetHash: hashPacket(packet),
        rejectionReason: "resume_sandbox_unusable",
      };
      this.runs.set(runId, failed);
      return failed;
    }
    const rawEnvelope =
      this.options.envelopeForResume?.(packet, runEnvironment) ??
      this.options.envelopeForRun?.(packet, runEnvironment) ??
      defaultEnvelope(packet, runEnvironment.role);
    const parsed = parseEnvelope(runEnvironment.role, rawEnvelope, packet);
    const output = parsed.ok
      ? {
          envelope: parsed.envelope,
          envelopeHash: hashEnvelope(parsed.envelope),
        }
      : undefined;
    const metadata: AgentRunMetadata = {
      runId,
      sandboxId: runEnvironment.sandboxId,
      role: runEnvironment.role,
      status: parsed.ok ? "succeeded" : "envelope_rejected",
      packetHash: hashPacket(packet),
      outputEnvelopeHash: output?.envelopeHash,
      rejectionReason: parsed.ok ? undefined : truncate(parsed.reason),
    };
    this.runs.set(runId, { ...metadata, output });
    return metadata;
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
  packet?: AgentRuntimePacket,
): EnvelopeParseResult {
  const schema =
    role === "architect"
      ? isArchitectExtensionPacket(packet)
        ? ArchitectExtensionEnvelope
        : architectDecompositionV2Schema
      : role === "reviewer"
        ? reviewerVerdictV2Schema
        : role === "plan_reviewer"
          ? PlanReviewVerdictV1
          : implementerCompletionV2Schema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.message };
  }
  return { ok: true, envelope: parsed.data as AgentRuntimeEnvelope };
}

export function hashPacket(packet: AgentRuntimePacket): string {
  return sha256Json(packet);
}

export function hashEnvelope(envelope: unknown): string {
  return sha256Json(envelope);
}

function defaultEnvelope(
  packet: AgentRuntimePacket,
  role: AgentRuntimeRole,
): AgentRuntimeEnvelope {
  if (role === "architect") {
    return architectDecompositionV2Schema.parse({
      kind: "architect_decomposition",
      summary: "Fake architect run proposed a single-task decomposition.",
      requirements: [
        { id: "R1", text: "The fake scope goal is met.", tasks: [0] },
      ],
      journey: [{ after_task: 0, working_state: "The fake scope goal holds." }],
      acceptance: [{ description: "Fake scope goal is met.", command: "true" }],
      tasks: [
        {
          title: "Initial scope task",
          spec: "Placeholder task produced by fake architect run.",
          depends_on: [],
          files: ["src/main.ts"],
          evidence: ["true"],
        },
      ],
    });
  }

  if (role === "plan_reviewer") {
    return PlanReviewVerdictV1.parse({
      kind: "plan_review_verdict",
      verdict: "approve",
      summary:
        "Approved: every task lands alone, the evidence commands prove each one, and the journey reaches the goal.",
      findings: [],
      inspected: [{ file: "src/main.ts", note: "checked against the plan" }],
    });
  }

  if (role === "reviewer") {
    return reviewerVerdictV2Schema.parse({
      kind: "reviewer_verdict",
      verdict: "approve",
      summary:
        "Approved: the diff implements the spec end to end; acceptance commands run and pass, no regressions found.",
      findings: [],
      inspected: [
        { file: "src/main.ts", note: "checked against the task spec" },
      ],
      head_sha:
        typeof packet.head_sha === "string" ? packet.head_sha : "a".repeat(40),
    });
  }

  const taskId = typeof packet.task_id === "string" ? packet.task_id : "task";
  return implementerCompletionV2Schema.parse({
    kind: "implementer_completion",
    status: "complete",
    summary: "Fake developer run completed.",
    branch: `colony/${taskId}`,
    head_sha: "a".repeat(40),
    commands: [],
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
    rejectionReason: run.rejectionReason,
  };
}
