import { describe, expect, it } from "bun:test";

import type { ToolCallDetail } from "./run-evidence.js";
import { RunEvidenceCollector, toolResultText } from "./run-evidence.js";

interface RecordedEvent {
  event: string;
  detail: Record<string, unknown>;
}

/** Capturing sink shaped exactly like RunAuditSink (putArtifact never rejects). */
function recordingSink() {
  const events: RecordedEvent[] = [];
  const artifacts: { kind: string; key: string; bytes: number; text: string }[] =
    [];
  return {
    events,
    artifacts,
    sink: {
      appendEvent(
        runId: string,
        event: string,
        detail: Record<string, unknown>,
      ): void {
        events.push({ event, detail });
      },
      putArtifact(
        runId: string,
        kind: string,
        key: string,
        data: Uint8Array,
      ): Promise<{ ref: string; bytes: number; sha256: string } | undefined> {
        artifacts.push({
          kind,
          key,
          bytes: data.byteLength,
          text: new TextDecoder().decode(data),
        });
        return Promise.resolve({
          ref: `stored/${key}`,
          bytes: data.byteLength,
          sha256: "0".repeat(64),
        });
      },
      recordArtifactRef(): void {},
    },
  };
}

const toolDetail = (row: RecordedEvent | undefined): ToolCallDetail =>
  row?.detail as ToolCallDetail;

describe("RunEvidenceCollector: tool_call rows", () => {
  it("emits exactly one tool_call row per call with redacted args and paired duration", async () => {
    const { events, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-1", sink, ["glpat-abc-secret"]);
    evidence.toolStart("t1", { command: "echo glpat-abc-secret" }, "prove it");
    await evidence.toolEnd({
      toolCallId: "t1",
      tool: "bash",
      isError: false,
      endedAtMs: Date.now() + 42,
      resultText: "ok",
    });
    const rows = events.filter((e) => e.event === "tool_call");
    expect(rows).toHaveLength(1);
    const detail = toolDetail(rows[0]);
    expect(detail.tool_call_id).toBe("t1");
    expect(detail.tool).toBe("bash");
    expect(detail.intent).toBe("prove it");
    expect(JSON.stringify(detail.args)).not.toContain("glpat-abc-secret");
    expect(JSON.stringify(detail.args)).toContain("[REDACTED]");
    expect(detail.duration_ms).toBe(42);
    expect(detail.started_at < detail.ended_at).toBe(true);
    expect(detail.is_error).toBe(false);
    expect(detail.result_summary).toBe("ok");
    expect(detail.result_ref).toBeUndefined();
    expect(detail.error_detail).toBeUndefined();
  });

  it("records the artifact via putArtifact and sets result_ref on overflow", async () => {
    const { events, artifacts, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-2", sink, []);
    const long = "x".repeat(2001);
    await evidence.toolEnd({
      toolCallId: "big",
      tool: "bash",
      isError: false,
      endedAtMs: Date.now(),
      resultText: long,
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: "tool_result",
      key: "run-2/tool-result-big.txt",
      bytes: 2001,
      text: long,
    });
    const detail = toolDetail(events.find((e) => e.event === "tool_call"));
    expect(detail.result_ref).toBe("stored/run-2/tool-result-big.txt");
    expect(detail.result_summary).toHaveLength(2000);
  });

  it("keeps no result_ref under the threshold and redacts error_detail", async () => {
    const { events, artifacts, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-3", sink, []);
    await evidence.toolEnd({
      toolCallId: "err",
      tool: "read",
      isError: true,
      endedAtMs: Date.now(),
      resultText: "failed",
      errorText: "sk-12345678 exploded",
    });
    expect(artifacts).toHaveLength(0);
    const detail = toolDetail(events[0]);
    expect(detail.is_error).toBe(true);
    expect(detail.error_detail).toBe("[REDACTED] exploded");
    expect(detail.result_summary).toBe("failed");
    expect(detail.result_ref).toBeUndefined();
  });
});

describe("RunEvidenceCollector: extended pi_usage", () => {
  it("emits every extended usage key on the completed turn", () => {
    const { events, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-4", sink, []);
    evidence.usage({
      usage: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 20,
        totalTokens: 180,
        contextTokens: 170,
        reasoningTokens: 12,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002 },
      },
      provider: "test-gateway",
      model: "m1",
      stopReason: "toolUse",
      duration: 1234,
      ttft: 321,
    });
    const [usage] = events;
    expect(usage?.event).toBe("pi_usage");
    expect(usage?.detail).toEqual({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 20,
      total_tokens: 180,
      context_tokens: 170,
      reasoning_tokens: 12,
      cost_input: 0.01,
      cost_output: 0.02,
      cost_cache_read: 0.001,
      cost_cache_write: 0.002,
      model: "m1",
      provider: "test-gateway",
      request_duration_ms: 1234,
      ttft_ms: 321,
      stop_reason: "toolUse",
      error_message: undefined,
    });
  });

  it("redacts provider errors on the usage row", () => {
    const { events, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-4b", sink, ["tok-xyz"]);
    evidence.usage({
      stopReason: "error",
      errorMessage: "auth failed for tok-xyz",
    });
    expect(events[0]?.detail.error_message).toBe("auth failed for [REDACTED]");
    expect(events[0]?.detail.stop_reason).toBe("error");
  });
});

describe("RunEvidenceCollector: completion_rejected", () => {
  it("records the rejection message verbatim, truncated at 4000 chars", () => {
    const { events, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-6", sink, []);
    const fiveThousand = "r".repeat(5000);
    evidence.completionRejected(fiveThousand, "submit_implementer_completion");
    const row = events.find((e) => e.event === "completion_rejected");
    expect(row?.detail.message).toHaveLength(4000);
    expect(row?.detail.tool).toBe("submit_implementer_completion");
  });

  it("does not truncate messages under the cap", () => {
    const { events, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-6b", sink, []);
    evidence.completionRejected(
      "Submission rejected: bad branch",
      "submit_implementer_completion",
    );
    expect(events[0]?.detail.message).toBe(
      "Submission rejected: bad branch",
    );
  });
});

describe("RunEvidenceCollector: run_summary aggregation", () => {
  it("aggregates counts, cost, and per-tool latency percentiles", async () => {
    const { events, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-7", sink, []);
    evidence.usage({
      usage: {
        input: 30,
        output: 12,
        totalTokens: 42,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1.0 },
      },
    });
    let now = 10_000;
    for (const ms of [100, 200, 300]) {
      now += ms;
      await evidence.toolEnd({
        toolCallId: `t-${ms}`,
        tool: "bash",
        isError: false,
        startedAtMs: now - ms,
        endedAtMs: now,
        resultText: "ok",
      });
    }
    await evidence.toolEnd({
      toolCallId: "t-boom",
      tool: "bash",
      isError: true,
      startedAtMs: 0,
      endedAtMs: 5000,
      resultText: "boom",
    });
    evidence.runSummary();
    const summary = events.find((e) => e.event === "run_summary");
    expect(summary?.detail.turns).toBe(1);
    expect(summary?.detail.tool_calls).toBe(4);
    expect(summary?.detail.tool_errors).toBe(1);
    expect(summary?.detail.input_tokens).toBe(30);
    expect(summary?.detail.output_tokens).toBe(12);
    expect(summary?.detail.total_tokens).toBe(42);
    expect(summary?.detail.cost_input).toBe(0.1);
    expect(summary?.detail.cost_total).toBe(1);
    expect(summary?.detail.per_tool.bash).toEqual({
      calls: 4,
      errors: 1,
      p50_ms: 200,
      p95_ms: 5000,
    });
  });
});

describe("toolResultText", () => {
  it("joins text blocks, marks foreign blocks, and honors isError", () => {
    const flat = toolResultText({
      content: [
        { type: "text", text: "line one" },
        { type: "image", data: "..." },
        { type: "text", text: "line two" },
      ],
    });
    expect(flat.text).toBe("line one\n[image]\nline two");
    expect(flat.isErrorText).toBe(false);
    const failed = toolResultText({
      content: [{ type: "text", text: " kaboom " }],
      isError: true,
    });
    expect(failed.isErrorText).toBe(true);
  });
});