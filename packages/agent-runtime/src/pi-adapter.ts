import type {
  AgentRunEnvironment,
  AgentRuntimeAdapter,
  AgentRuntimePacket,
  AgentRunMetadata,
  AgentRunOutput,
} from "./adapter.js";
import { parseEnvelope, truncate } from "./adapter.js";
import { hashEnvelope, hashPacket } from "./packet-builders.js";

export interface PiRunRequest {
  readonly runId: string;
  readonly packet: AgentRuntimePacket;
  readonly environment: AgentRunEnvironment;
}

export interface PiRunResult {
  readonly sandboxId: string;
  readonly envelope: unknown;
}

export interface PiRunner {
  readonly kind: "pi-coding-agent" | "pi-mono" | "pi-architect";
  run(request: PiRunRequest): Promise<PiRunResult>;
  cancel?(runId: string): Promise<void>;
}

export class PiAgentRuntimeAdapter implements AgentRuntimeAdapter {
  private nextId = 1;
  private readonly runs = new Map<
    string,
    AgentRunMetadata & { readonly output?: AgentRunOutput }
  >();

  constructor(private readonly runner: PiRunner) {}

  async startRun(
    packet: AgentRuntimePacket,
    runEnvironment: AgentRunEnvironment,
  ): Promise<AgentRunMetadata> {
    const runId = `${this.runner.kind}-${this.nextId++}`;
    const running: AgentRunMetadata = {
      runId,
      sandboxId: `pending-${runId}`,
      role: runEnvironment.role,
      status: "running",
      packetHash: hashPacket(packet),
      runtimeBindingName: runEnvironment.runtimeBinding.binding.name,
      runtimeBindingHash: runEnvironment.runtimeBinding.hash,
      toolProfileHash: runEnvironment.tools.manifest.profileHash,
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
        return withoutOutput(current);
      }
      const parsed = parseEnvelope(runEnvironment.role, result.envelope);
      const output = parsed.ok
        ? {
            envelope: parsed.envelope,
            envelopeHash: hashEnvelope(parsed.envelope),
          }
        : undefined;
      const metadata: AgentRunMetadata = {
        runId,
        sandboxId: result.sandboxId,
        role: runEnvironment.role,
        status: parsed.ok ? "succeeded" : "envelope_rejected",
        packetHash: running.packetHash,
        outputEnvelopeHash: output?.envelopeHash,
        runtimeBindingName: runEnvironment.runtimeBinding.binding.name,
        runtimeBindingHash: runEnvironment.runtimeBinding.hash,
        toolProfileHash: runEnvironment.tools.manifest.profileHash,
        rejectionReason: parsed.ok
          ? undefined
          : truncate(describeRejection(result.envelope, parsed.reason), 800),
      };
      this.runs.set(runId, { ...metadata, output });
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
            : truncate(err instanceof Error ? err.message : String(err)),
      };
      this.runs.set(runId, metadata);
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
    await this.runner.cancel?.(runId);
    const run = this.runs.get(runId);
    if (!run) return null;
    const canceled = { ...run, status: "canceled" as const };
    this.runs.set(runId, canceled);
    return withoutOutput(canceled);
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
    runtimeBindingName: run.runtimeBindingName,
    runtimeBindingHash: run.runtimeBindingHash,
    toolProfileHash: run.toolProfileHash,
    rejectionReason: run.rejectionReason,
  };
}

function describeRejection(envelope: unknown, reason: string): string {
  if (envelope && typeof envelope === "object" && "__unfinished" in envelope) {
    return "agent did not call its terminal submit_* envelope tool before terminating";
  }
  return reason;
}
