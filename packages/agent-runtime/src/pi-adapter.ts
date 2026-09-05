import {
  beginAgentRun,
  type AgentMetricAttributes,
} from "@colony/observability";
import type { Context } from "@opentelemetry/api";
import type {
  AgentRunEnvironment,
  AgentRunResumeEnvironment,
  AgentRuntimeAdapter,
  AgentRuntimePacket,
  AgentRunMetadata,
  AgentRunOutput,
} from "./adapter.js";
import {
  hashEnvelope,
  hashPacket,
  parseEnvelope,
  truncate,
} from "./adapter.js";
import {
  packetRepo,
  resolvePacketCloneUrl,
  sanitizeSecret,
} from "./pi-runner-common.js";
import { resumeRun, type ResumeSpan } from "./run-resume.js";
import type { SandboxHandle } from "@colony/sandbox";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent";

export interface PiRunRequest {
  readonly runId: string;
  readonly packet: AgentRuntimePacket;
  /** environment.traceContext carries the run root span context when set. */
  readonly environment: AgentRunEnvironment;
}

export interface PiRunResult {
  readonly sandboxId: string;
  readonly envelope: unknown;
  readonly reason?: string;
}

export interface PiRunResumeRequest extends PiRunRequest {
  /** The surviving sandbox, already re-attached by the caller. */
  readonly handle: SandboxHandle;
  /** The run's reloaded session journal. */
  readonly sessionManager: SessionManager;
  /** The fixed steer that opens the resumed segment. */
  readonly steerPrompt: string;
  /** Reports the resumed loop live, once its first prompt is driving. */
  readonly onRunning?: () => void;
  /** The segment's FRESH root span context; never the pre-restart trace. */
  readonly traceContext?: Context;
}

export interface PiRunner {
  readonly kind:
    | "pi-coding-agent"
    | "pi-architect"
    | "pi-reviewer"
    | "pi-plan-reviewer";
  run(request: PiRunRequest): Promise<PiRunResult>;
  cancel?(runId: string): Promise<void>;
  /**
   * Continues a reloaded session on a re-attached sandbox. Optional: a
   * runner without it cannot adopt a run, and the adapter reports that
   * rather than pretending the continuation happened.
   */
  resume?(request: PiRunResumeRequest): Promise<PiRunResult>;
}

export interface PiAdapterTelemetry {
  readonly provider: string;
  readonly model: string;
}

/**
 * Observability seam for the resume path: run events and the fresh root span.
 * Injected, not imported, so the adapter stays testable without tracing.
 */
export interface PiResumeTelemetry {
  readonly onRunEvent?: (
    runId: string,
    event: "run_resumed" | "run_resume_failed",
    detail: Record<string, unknown>,
  ) => void;
  /** Supplies a `startColonyRunSpan`-shaped FRESH root span for the segment. */
  readonly startSpan?: (run: {
    runId: string;
    role: string;
  }) => ResumeSpan | undefined;
}

export class PiAgentRuntimeAdapter implements AgentRuntimeAdapter {
  private nextId = 1;
  private readonly runs = new Map<
    string,
    AgentRunMetadata & { readonly output?: AgentRunOutput }
  >();

  constructor(
    private readonly runner: PiRunner,
    private readonly telemetry: PiAdapterTelemetry = {
      provider: "unknown",
      model: "unknown",
    },
    private readonly resumeTelemetry: PiResumeTelemetry = {},
  ) {}

  async startRun(
    packet: AgentRuntimePacket,
    runEnvironment: AgentRunEnvironment,
  ): Promise<AgentRunMetadata> {
    const runId =
      runEnvironment.runId ?? `${this.runner.kind}-${this.nextId++}`;
    const finishMetrics = beginAgentRun({
      role: runEnvironment.role,
      provider: this.telemetry.provider,
      model: this.telemetry.model,
    } satisfies AgentMetricAttributes);
    const running: AgentRunMetadata = {
      runId,
      sandboxId: `pending-${runId}`,
      role: runEnvironment.role,
      status: "running",
      packetHash: hashPacket(packet),
    };
    this.runs.set(runId, running);

    try {
      const result = await this.runner.run({
        runId,
        packet,
        environment: runEnvironment,
      });
      const current = this.runs.get(runId);
      if (current?.status === "canceled") {
        finishMetrics(current.status, current.rejectionReason);
        return withoutOutput(current);
      }
      const parsed = parseEnvelope(
        runEnvironment.role,
        result.envelope,
        packet,
      );
      const unfinished =
        result.envelope &&
        typeof result.envelope === "object" &&
        "__unfinished" in result.envelope;
      const failureReason = result.reason
        ? redactPacketSecret(result.reason, packet)
        : unfinished
          ? "finalize_no_submission"
          : undefined;
      const output =
        parsed.ok && !failureReason
          ? {
              envelope: parsed.envelope,
              envelopeHash: hashEnvelope(parsed.envelope),
            }
          : undefined;
      const metadata: AgentRunMetadata = {
        runId,
        sandboxId: result.sandboxId,
        role: runEnvironment.role,
        status: failureReason
          ? "failed"
          : parsed.ok
            ? "succeeded"
            : "envelope_rejected",
        packetHash: running.packetHash,
        outputEnvelopeHash: output?.envelopeHash,
        rejectionReason: failureReason
          ? truncate(failureReason, 800)
          : parsed.ok
            ? undefined
            : truncate(describeRejection(result.envelope, parsed.reason), 800),
      };
      this.runs.set(runId, { ...metadata, output });
      finishMetrics(metadata.status, metadata.rejectionReason);
      return metadata;
    } catch (err) {
      const current = this.runs.get(runId);
      const metadata: AgentRunMetadata = {
        ...running,
        sandboxId: current?.sandboxId ?? running.sandboxId,
        status: current?.status === "canceled" ? "canceled" : "failed",
        rejectionReason:
          current?.status === "canceled"
            ? undefined
            : redactPacketSecret(
                err instanceof Error ? err.message : String(err),
                packet,
              ),
      };
      this.runs.set(runId, metadata);
      finishMetrics(metadata.status, metadata.rejectionReason);
      return metadata;
    }
  }

  getRunStatus(runId: string): Promise<AgentRunMetadata | null> {
    const run = this.runs.get(runId);
    return Promise.resolve(run ? withoutOutput(run) : null);
  }

  getRunOutput(runId: string): Promise<AgentRunOutput | null> {
    return Promise.resolve(this.runs.get(runId)?.output ?? null);
  }

  /**
   * Continues a checkpointed run on the sandbox that survived the restart.
   *
   * Failures are reported, not thrown: colonyd fails and requeues the run on
   * a rejected adoption, so the metadata carries the reason and the caller
   * decides. A resumed run is never left without a driver - either the
   * runner took the session over, or this run is marked failed and requeued.
   */
  async resumeRun(
    packet: AgentRuntimePacket,
    runEnvironment: AgentRunResumeEnvironment,
  ): Promise<AgentRunMetadata> {
    const runId =
      runEnvironment.runId ?? `${this.runner.kind}-${this.nextId++}`;
    const finishMetrics = beginAgentRun({
      role: runEnvironment.role,
      provider: this.telemetry.provider,
      model: this.telemetry.model,
    } satisfies AgentMetricAttributes);

    const record = (
      status: AgentRunMetadata["status"],
      reason?: string,
      output?: AgentRunOutput,
    ) => {
      const metadata: AgentRunMetadata = {
        runId,
        sandboxId: runEnvironment.sandboxId,
        role: runEnvironment.role,
        status,
        packetHash: hashPacket(packet),
        ...(reason === undefined
          ? {}
          : {
              rejectionReason: truncate(
                redactPacketSecret(reason, packet),
                800,
              ),
            }),
        ...(output === undefined
          ? {}
          : { outputEnvelopeHash: output.envelopeHash }),
      };
      // The resumed envelope must be stored, not just counted: without it
      // getRunOutput stays null for every adopted run.
      this.runs.set(
        runId,
        output === undefined ? metadata : { ...metadata, output },
      );
      finishMetrics(status, metadata.rejectionReason);
      return metadata;
    };

    const emitEvent = (
      event: "run_resumed" | "run_resume_failed",
      detail: Record<string, unknown>,
    ): void => {
      this.resumeTelemetry.onRunEvent?.(runId, event, detail);
    };

    try {
      return await resumeRun({
        runId,
        sandboxId: runEnvironment.sandboxId,
        sessionsDir: runEnvironment.sessionsDir,
        packet,
        connect: runEnvironment.connect,
        emitEvent,
        // A FRESH root span: the pre-restart trace belongs to a process
        // that no longer exists.
        startSpan: () =>
          this.resumeTelemetry.startSpan?.({
            runId,
            role: runEnvironment.role,
          }),
        drive: async (session) => {
          if (this.runner.resume === undefined) {
            throw new Error(
              `${this.runner.kind} runner cannot resume a run (no durable session support)`,
            );
          }
          const runResult = await this.runner.resume({
            runId,
            packet,
            environment: runEnvironment,
            handle: session.handle,
            sessionManager: session.sessionManager,
            steerPrompt: session.steerPrompt,
            onRunning: session.onRunning,
            ...(session.traceContext
              ? { traceContext: session.traceContext }
              : {}),
          });
          // An unfinished segment is one the agent never submitted, whatever
          // its reason: `startRun` classifies the same shape as a failure and
          // a resumed run must not be scored more generously than a fresh one.
          const unfinished =
            typeof runResult.envelope === "object" &&
            runResult.envelope !== null &&
            "__unfinished" in runResult.envelope;
          if (unfinished || runResult.reason !== undefined) {
            return record("failed", runResult.reason ?? "resume_no_submission");
          }
          const parsed = parseEnvelope(
            runEnvironment.role,
            runResult.envelope,
            packet,
          );
          if (!parsed.ok) {
            return record(
              "envelope_rejected",
              describeRejection(runResult.envelope, parsed.reason),
            );
          }
          return record("succeeded", undefined, {
            envelope: parsed.envelope,
            envelopeHash: hashEnvelope(parsed.envelope),
          });
        },
      });
    } catch (err) {
      return record("failed", err instanceof Error ? err.message : String(err));
    }
  }

  async cancelRun(runId: string): Promise<AgentRunMetadata | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (
      run.status === "canceled" ||
      run.status === "succeeded" ||
      run.status === "failed" ||
      run.status === "envelope_rejected"
    ) {
      return withoutOutput(run);
    }
    await this.runner.cancel?.(runId);
    const current = this.runs.get(runId);
    if (!current) return null;
    if (
      current.status === "canceled" ||
      current.status === "succeeded" ||
      current.status === "failed" ||
      current.status === "envelope_rejected"
    ) {
      return withoutOutput(current);
    }

    const canceled = { ...current, status: "canceled" as const };
    this.runs.set(runId, canceled);
    return withoutOutput(canceled);
  }
}

function redactPacketSecret(
  reason: string,
  packet: AgentRuntimePacket,
): string {
  const repo = packetRepo(packet);
  if (!repo) return reason;
  try {
    return sanitizeSecret(
      reason,
      resolvePacketCloneUrl(repo.url, repo.credentials?.token).secret,
    );
  } catch {
    return sanitizeSecret(reason, repo.credentials?.token);
  }
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

function describeRejection(envelope: unknown, reason: string): string {
  if (envelope && typeof envelope === "object" && "__unfinished" in envelope) {
    return "agent did not call its terminal submit_* envelope tool before terminating";
  }
  return reason;
}
