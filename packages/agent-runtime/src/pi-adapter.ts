import {
  beginAgentRun,
  type AgentMetricAttributes,
} from "@colony/observability";
import type {
  AgentRunEnvironment,
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

export interface PiRunRequest {
  readonly runId: string;
  readonly packet: AgentRuntimePacket;
  readonly environment: AgentRunEnvironment;
}

export interface PiRunResult {
  readonly sandboxId: string;
  readonly envelope: unknown;
  readonly reason?: string;
}

export interface PiRunner {
  readonly kind: "pi-coding-agent" | "pi-architect";
  run(request: PiRunRequest): Promise<PiRunResult>;
  cancel?(runId: string): Promise<void>;
}

export interface PiAdapterTelemetry {
  readonly provider: string;
  readonly model: string;
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
      const parsed = parseEnvelope(runEnvironment.role, result.envelope);
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
