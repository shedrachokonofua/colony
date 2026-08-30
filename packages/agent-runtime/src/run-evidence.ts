import type { RunAuditSink } from "./audit-sink.js";
import { redactText, redactValue } from "./redact.js";

/**
 * Rich run evidence, aggregated in the runner: one `tool_call` row per tool
 * call, an extended `pi_usage` per completed assistant turn,
 * `completion_rejected` for submit calls the tool refused, and `run_summary`
 * at run end. Rows are appended through the run's audit sink only — never as
 * logger messages, because colonyd's `roleLogger` already mirrors logger
 * output into `run_events` under the logger's own message string.
 */

/** The persisted `tool_call` detail; all strings are redacted before here. */
export interface ToolCallDetail {
  readonly tool_call_id: string;
  readonly tool: string;
  readonly intent?: string;
  readonly args?: unknown;
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_ms: number;
  readonly is_error: boolean;
  readonly result_summary: string;
  readonly result_ref?: string;
  readonly error_detail?: string;
}

/**
 * Extended `pi_usage` row: the fields the legacy logger-fed row carried
 * (`inputTokens`…`turnDurationSeconds`) plus the new evidence keys. The row is
 * sink-emitted; the logger line was renamed (`pi_turn_usage`) so this event
 * has exactly one path into `run_events`.
 */
export interface PiUsageDetail {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  /** This turn's cost and the run's cumulative cost, in USD. */
  readonly messageUsd: number | undefined;
  readonly usdSpent: number | undefined;
  /** Wall clock since the previous assistant message, computed by guards. */
  readonly turnDurationSeconds: number | undefined;
  readonly total_tokens: number | undefined;
  readonly context_tokens: number | undefined;
  readonly reasoning_tokens: number | undefined;
  readonly cost_input: number | undefined;
  readonly cost_output: number | undefined;
  readonly cost_cache_read: number | undefined;
  readonly cost_cache_write: number | undefined;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly request_duration_ms: number | undefined;
  readonly ttft_ms: number | undefined;
  readonly stop_reason: string | undefined;
  readonly error_message: string | undefined;
}

/** `run_summary` aggregates over one run's completed turns and tool calls. */
export interface RunSummaryDetail {
  readonly turns: number;
  readonly tool_calls: number;
  readonly tool_errors: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly total_tokens: number;
  readonly cost_input: number;
  readonly cost_output: number;
  readonly cost_cache_read: number;
  readonly cost_cache_write: number;
  readonly cost_total: number;
  readonly per_tool: Record<
    string,
    { calls: number; errors: number; p50_ms: number; p95_ms: number }
  >;
}

/**
 * Truncation limits. The row keeps a bounded summary; anything longer goes to
 * the artifact sink whole and is referenced by `result_ref`.
 */
export const RESULT_SUMMARY_CHARS = 2000;
/** Same cut for the `completion_rejected` message (no artifact path). */
export const REJECTION_SUMMARY_CHARS = 4000;

/** The part of a completed assistant message a usage row reads. */
export interface UsageMessageSlice {
  readonly usage?:
    | {
        readonly input?: number;
        readonly output?: number;
        readonly cacheRead?: number;
        readonly cacheWrite?: number;
        readonly totalTokens?: number;
        readonly contextTokens?: number;
        readonly reasoningTokens?: number;
        readonly cost?: {
          readonly input?: number;
          readonly output?: number;
          readonly cacheRead?: number;
          readonly cacheWrite?: number;
          readonly total?: number;
        };
      }
    | undefined;
  readonly provider?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  /** Provider request wall clock in ms (AssistantMessage.duration). */
  readonly duration?: number;
  /** Time to first token in ms (AssistantMessage.ttft). */
  readonly ttft?: number;
  /** Inter-message wall clock, computed by the guard subscription. */
  readonly turnDurationSeconds?: number;
}

/** One `tool_execution_end` observation, before any persistence decision. */
export interface ToolCallObserved {
  readonly toolCallId: string;
  readonly tool: string;
  /** Fallback when no paired start observation exists (blocked/aborted calls). */
  readonly args?: unknown;
  readonly isError: boolean;
  /** Fallback start time when no paired `toolStart` was observed. */
  readonly startedAtMs?: number;
  readonly endedAtMs: number;
  /** Raw textual result BEFORE truncation; overflow goes to the artifact sink. */
  readonly resultText: string;
  /** Thrown/structured validation message when the result is an error. */
  readonly errorText?: string;
}

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const rank = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length - Number.EPSILON),
  );
  return Math.round(sorted[Math.max(0, rank)]!);
};

/**
 * Per-run evidence state. Pure state machine — everything it emits goes
 * through the caller's sink, which is contractually best-effort, so no path
 * here can break the run.
 */
export class RunEvidenceCollector {
  private readonly toolStarts = new Map<
    string,
    { at: number; args: unknown; intent?: string }
  >();
  /** toolCallIds whose tool_call row was already booked — dedups double-end. */
  private readonly completed = new Set<string>();
  private readonly perTool = new Map<string, number[]>();
  private readonly perToolErrors = new Map<string, number>();
  private toolTotal = 0;
  private toolErrorTotal = 0;
  private turns = 0;
  /** Serializes async emits so `run_summary` cannot overtake a `tool_call`. */
  private emitChain: Promise<void> = Promise.resolve();
  private totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
  };

  constructor(
    private readonly runId: string,
    private readonly sink: RunAuditSink | undefined,
    private readonly secrets: readonly string[],
  ) {}

  /**
   * Observe `tool_execution_start`: wall clock, validated args, and intent.
   * The end event carries none of these, so the pairing lives here.
   */
  toolStart(toolCallId: string, args: unknown, intent?: string): void {
    this.toolStarts.set(toolCallId, {
      at: Date.now(),
      args,
      ...(intent !== undefined ? { intent: intent } : {}),
    });
  }

  /**
   * Observe `tool_execution_end` and append the run's single `tool_call` row.
   * Both the loop's subscribe stream and its `afterToolCall` hook fire per
   * call; only the end event carries the result, so this keyed entry point
   * (one call per end observation, duplicates refused) keeps exactly one row
   * per call no matter how many seams observe it.
   */
  async toolEnd(input: ToolCallObserved): Promise<void> {
    if (this.completed.has(input.toolCallId)) return;
    this.completed.add(input.toolCallId);
    const start = this.toolStarts.get(input.toolCallId);
    this.toolStarts.delete(input.toolCallId);
    const startedAtMs = start?.at ?? input.startedAtMs ?? input.endedAtMs;
    this.toolTotal += 1;
    if (input.isError) {
      this.toolErrorTotal += 1;
      const errors = this.perToolErrors.get(input.tool) ?? 0;
      this.perToolErrors.set(input.tool, errors + 1);
    }
    // A tool that threw still owns its latency window even though the loop
    // does not timestamp it.
    const durations = this.perTool.get(input.tool) ?? [];
    durations.push(Math.max(0, input.endedAtMs - startedAtMs));
    this.perTool.set(input.tool, durations);

    this.emitChain = this.emitChain.then(() =>
      this.persistToolCall(input, start, startedAtMs),
    );
    return this.emitChain;
  }

  /**
   * Book one `tool_call` row; runs serialized on the emit chain because the
   * artifact storage await must not reorder rows between calls.
   */
  private async persistToolCall(
    input: ToolCallObserved,
    start: { at: number; args: unknown; intent?: string } | undefined,
    startedAtMs: number,
  ): Promise<void> {
    let resultRef: string | undefined;
    if (this.sink && input.resultText.length > RESULT_SUMMARY_CHARS) {
      try {
        // The artifact carries the whole result, so it gets the same
        // redaction as the summary row: the 2000-char cut must not turn
        // into a verbatim storage bypass for provider tokens.
        const safeText = redactText(input.resultText, this.secrets);
        // putArtifact stores the bytes AND records the run_artifacts row;
        // a missing row always means missing bytes, never half a record.
        const stored = await this.sink.putArtifact(
          this.runId,
          "tool_result",
          `${this.runId}/tool-result-${input.toolCallId}.txt`,
          new TextEncoder().encode(safeText),
          "text/plain",
        );
        resultRef = stored?.ref;
      } catch {
        // putArtifact is contractually non-rejecting; a sink that still
        // throws must not take the run down — the row simply has no ref.
      }
    }
    const detail: ToolCallDetail = {
      tool_call_id: input.toolCallId,
      tool: input.tool,
      ...(start?.intent ? { intent: start.intent } : {}),
      args: redactValue(start?.args ?? input.args, this.secrets),
      started_at: new Date(startedAtMs).toISOString(),
      ended_at: new Date(input.endedAtMs).toISOString(),
      duration_ms: Math.max(0, input.endedAtMs - startedAtMs),
      is_error: input.isError,
      result_summary: redactText(
        input.resultText.slice(0, RESULT_SUMMARY_CHARS),
        this.secrets,
      ),
      ...(resultRef ? { result_ref: resultRef } : {}),
      ...(input.errorText
        ? { error_detail: redactText(input.errorText, this.secrets) }
        : {}),
    };
    this.emit("tool_call", detail);
  }

  /** Observe one completed assistant message: extended usage row + totals. */
  usage(message: UsageMessageSlice): void {
    this.turns += 1;
    const usage = message.usage;
    const cost = usage?.cost;
    this.totals = {
      input: this.totals.input + (usage?.input ?? 0),
      output: this.totals.output + (usage?.output ?? 0),
      cacheRead: this.totals.cacheRead + (usage?.cacheRead ?? 0),
      cacheWrite: this.totals.cacheWrite + (usage?.cacheWrite ?? 0),
      totalTokens: this.totals.totalTokens + (usage?.totalTokens ?? 0),
      costInput: this.totals.costInput + (cost?.input ?? 0),
      costOutput: this.totals.costOutput + (cost?.output ?? 0),
      costCacheRead: this.totals.costCacheRead + (cost?.cacheRead ?? 0),
      costCacheWrite: this.totals.costCacheWrite + (cost?.cacheWrite ?? 0),
      costTotal: this.totals.costTotal + (cost?.total ?? 0),
    };
    const detail: PiUsageDetail = {
      inputTokens: usage?.input,
      outputTokens: usage?.output,
      cacheReadTokens: usage?.cacheRead,
      cacheWriteTokens: usage?.cacheWrite,
      messageUsd: cost?.total,
      usdSpent: this.totals.costTotal,
      turnDurationSeconds: message.turnDurationSeconds,
      total_tokens: usage?.totalTokens,
      context_tokens: usage?.contextTokens,
      reasoning_tokens: usage?.reasoningTokens,
      cost_input: cost?.input,
      cost_output: cost?.output,
      cost_cache_read: cost?.cacheRead,
      cost_cache_write: cost?.cacheWrite,
      model: message.model,
      provider: message.provider,
      request_duration_ms: message.duration,
      ttft_ms: message.ttft,
      stop_reason: message.stopReason,
      error_message: message.errorMessage
        ? redactText(message.errorMessage, this.secrets)
        : undefined,
    };
    this.emit("pi_usage", detail);
  }

  /** A submit call was refused (throw or structured validation failure). */
  completionRejected(message: string, tool: string): void {
    this.emit("completion_rejected", {
      tool,
      message: redactText(
        message.slice(0, REJECTION_SUMMARY_CHARS),
        this.secrets,
      ),
    });
  }

  /** Aggregates since run start; the caller emits it exactly once at the end. */
  summary(): RunSummaryDetail {
    const perTool: RunSummaryDetail["per_tool"] = {};
    for (const [tool, durations] of this.perTool) {
      const sorted = [...durations].sort((a, b) => a - b);
      perTool[tool] = {
        calls: durations.length,
        errors: this.perToolErrors.get(tool) ?? 0,
        p50_ms: percentile(sorted, 50),
        p95_ms: percentile(sorted, 95),
      };
    }
    return {
      turns: this.turns,
      tool_calls: this.toolTotal,
      tool_errors: this.toolErrorTotal,
      input_tokens: this.totals.input,
      output_tokens: this.totals.output,
      cache_read_tokens: this.totals.cacheRead,
      cache_write_tokens: this.totals.cacheWrite,
      total_tokens: this.totals.totalTokens,
      cost_input: this.totals.costInput,
      cost_output: this.totals.costOutput,
      cost_cache_read: this.totals.costCacheRead,
      cost_cache_write: this.totals.costCacheWrite,
      cost_total: this.totals.costTotal,
      per_tool: perTool,
    };
  }

  /** Append the run's single `run_summary` row once every earlier row is in. */
  runSummary(): void {
    this.emitChain = this.emitChain.then(() => {
      this.emit("run_summary", this.summary());
    });
  }

  /**
   * Drain all pending emits; the guard unsubscribe calls this right before
   * run finalization reads the feed. Resolves even when a sink threw.
   */
  async settle(): Promise<void> {
    await this.emitChain.catch(() => {});
  }

  private emit(event: string, detail: object): void {
    try {
      this.sink?.appendEvent(
        this.runId,
        event,
        detail as Record<string, unknown>,
      );
    } catch {
      // appendEvent is contractually non-throwing; a foreign sink that does
      // must still never reach the run path.
    }
  }
}

/**
 * Flatten a tool result to its textual form for the summary/artifact split.
 * Text blocks join with newlines; non-text blocks note their kind so the
 * summary still shows something at that position.
 */
export function toolResultText(result: unknown): {
  text: string;
  isErrorText: boolean;
} {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return { text: "", isErrorText: false };
  const pieces: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      pieces.push((block as { text: string }).text);
      continue;
    }
    const kind =
      block && typeof block === "object"
        ? String((block as { type?: unknown }).type ?? "unknown")
        : "unknown";
    pieces.push(`[${kind}]`);
  }
  const isError =
    (result as { isError?: unknown } | undefined)?.isError === true;
  return {
    text: pieces.length > 0 ? pieces.join("\n") : "",
    isErrorText: isError,
  };
}
