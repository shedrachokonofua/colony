import { describe, expect, it } from "bun:test";

import type { RunSummaryDetail, ToolCallDetail } from "./run-evidence.js";
import { installRunGuards } from "./pi-runner-common.js";
import { RunEvidenceCollector, toolResultText } from "./run-evidence.js";

interface RecordedEvent {
  event: string;
  detail: Record<string, unknown>;
}

/** Capturing sink shaped exactly like RunAuditSink (putArtifact never rejects). */
function recordingSink() {
  const events: RecordedEvent[] = [];
  const artifacts: {
    kind: string;
    key: string;
    bytes: number;
    text: string;
  }[] = [];
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
  row?.detail as unknown as ToolCallDetail;

/** Minimal Agent seam: subscribe + abort, driven manually by the test. */
function fakeAgent() {
  const listeners = new Set<(e: unknown) => void>();
  return {
    subscribe(fn: (e: unknown) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    abort() {},
    emit(event: unknown) {
      for (const fn of listeners) fn(event);
    },
  };
}

describe("RunEvidenceCollector: tool_call rows", () => {
  it("emits exactly one tool_call row per call with redacted args and paired duration", async () => {
    const { events, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-1", sink, [
      "glpat-abc-secret",
    ]);
    evidence.toolStart("t1", { command: "echo glpat-abc-secret" }, "prove it");
    const startedAt = Date.now();
    await evidence.toolEnd({
      toolCallId: "t1",
      tool: "bash",
      isError: false,
      endedAtMs: startedAt + 42,
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
    // toolStart stamps its own clock; a ms tick between it and this test's
    // Date.now() reference skews the pair by 1-2ms on slow machines.
    expect(detail.duration_ms).toBeGreaterThanOrEqual(42);
    expect(detail.duration_ms).toBeLessThan(100);
    expect(detail.started_at < detail.ended_at).toBe(true);
    expect(detail.is_error).toBe(false);
    expect(detail.result_summary).toBe("ok");
    expect(detail.result_ref).toBeUndefined();
    expect(detail.error_detail).toBeUndefined();
  });

  it("records the artifact via putArtifact and sets result_ref on overflow", async () => {
    const { events, artifacts, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-2", sink, [
      "exact-run-secret-1",
    ]);
    // Secrets past the 2000-char summary cut still reach the artifact: both
    // a pattern match and the run's exact token must be redacted there.
    const long =
      "x".repeat(2000) +
      " token glpat-zzzsecret123456 end token exact-run-secret-1 end";
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
    });
    expect(artifacts[0].text).not.toContain("glpat-zzzsecret123456");
    expect(artifacts[0].text).not.toContain("exact-run-secret-1");
    expect(artifacts[0].text.match(/\[REDACTED\]/g)).toHaveLength(2);
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
  it("emits the legacy fields plus every extended usage key on the completed turn", () => {
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
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0.001,
          cacheWrite: 0.002,
          total: 0.033,
        },
      },
      provider: "test-gateway",
      model: "m1",
      stopReason: "toolUse",
      duration: 1234,
      ttft: 321,
      turnDurationSeconds: 4.5,
    });
    const [usage] = events;
    expect(usage?.event).toBe("pi_usage");
    expect(usage?.detail).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 20,
      messageUsd: 0.033,
      usdSpent: 0.033,
      turnDurationSeconds: 4.5,
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
    expect(events[0]?.detail.message).toBe("Submission rejected: bad branch");
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
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0.3,
          cacheWrite: 0.4,
          total: 1.0,
        },
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
    await evidence.settle();
    const summary = events.find((e) => e.event === "run_summary")
      ?.detail as unknown as RunSummaryDetail;
    expect(summary.turns).toBe(1);
    expect(summary.tool_calls).toBe(4);
    expect(summary.tool_errors).toBe(1);
    expect(summary.input_tokens).toBe(30);
    expect(summary.output_tokens).toBe(12);
    expect(summary.total_tokens).toBe(42);
    expect(summary.cost_input).toBe(0.1);
    expect(summary.cost_total).toBe(1);
    expect(summary.per_tool.bash).toEqual({
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
describe("installRunGuards evidence wiring", () => {
  it("feeds the collector from the guard subscription: one row per call, usage, summary", async () => {
    const { events, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-8", sink, []);
    const agent = fakeAgent();
    const unsubscribe = installRunGuards(agent as never, "run-8", {
      abort: () => agent.abort(),
      evidence,
      rejectionToolName: "submit_implementer_completion",
      livenessTimeoutMs: 0,
      maxTurns: 100,
    });
    agent.emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "echo hi" },
      intent: "probe",
    });
    agent.emit({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "hi" }] },
      isError: false,
    });
    agent.emit({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "hi" }] },
      isError: false,
    });
    agent.emit({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "test-gateway",
        model: "m",
        stopReason: "toolUse",
        usage: { input: 5, output: 3, cost: { total: 0.5 } },
      },
    });
    agent.emit({ type: "agent_end", messages: [] });
    unsubscribe();
    await evidence.settle();
    const toolRows = events.filter((e) => e.event === "tool_call");
    expect(toolRows).toHaveLength(1);
    expect(toolDetail(toolRows[0])).toMatchObject({
      tool_call_id: "c1",
      tool: "bash",
      intent: "probe",
    });
    expect(toolDetail(toolRows[0]).args).toEqual({ command: "echo hi" });
    expect(typeof toolDetail(toolRows[0]).duration_ms).toBe("number");
    expect(events.some((e) => e.event === "pi_usage")).toBe(true);
    expect(events.some((e) => e.event === "run_summary")).toBe(true);
  });

  it("emits one final summary aggregated across continuation segments", async () => {
    const { events, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-segments", sink, []);
    const agent = fakeAgent();
    const unsubscribe = installRunGuards(agent as never, "run-segments", {
      abort: () => agent.abort(),
      evidence,
      livenessTimeoutMs: 0,
      maxTurns: 100,
    });
    for (const [toolCallId, output] of [
      ["segment-1", 2],
      ["segment-2", 4],
    ] as const) {
      agent.emit({
        type: "tool_execution_start",
        toolCallId,
        toolName: "bash",
        args: { command: `echo ${output}` },
      });
      agent.emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: "bash",
        result: { content: [{ type: "text", text: String(output) }] },
        isError: output === 4,
      });
      agent.emit({
        type: "message_end",
        message: {
          role: "assistant",
          usage: {
            input: output,
            output: 1,
            totalTokens: output + 1,
            cost: { total: 0 },
          },
        },
      });
      agent.emit({ type: "agent_end", messages: [] });
    }
    unsubscribe();
    await evidence.settle();

    const summaries = events.filter((e) => e.event === "run_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.detail).toMatchObject({
      turns: 2,
      tool_calls: 2,
      tool_errors: 1,
      input_tokens: 6,
      output_tokens: 2,
      total_tokens: 8,
      per_tool: { bash: { calls: 2, errors: 1 } },
    });
  });

  it("emits completion_rejected from the end event for rejected submit calls", async () => {
    const { events, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-9", sink, []);
    const agent = fakeAgent();
    const unsubscribe = installRunGuards(agent as never, "run-9", {
      abort: () => agent.abort(),
      evidence,
      rejectionToolName: "submit_implementer_completion",
      livenessTimeoutMs: 0,
      maxTurns: 100,
    });
    agent.emit({
      type: "tool_execution_start",
      toolCallId: "s1",
      toolName: "submit_implementer_completion",
      args: { branch: "main" },
    });
    agent.emit({
      type: "tool_execution_end",
      toolCallId: "s1",
      toolName: "submit_implementer_completion",
      result: {
        content: [
          {
            type: "text",
            text: "Envelope failed schema validation:\n  - head_sha: required",
          },
        ],
      },
      isError: true,
    });
    // A failed non-submit tool call must not emit a rejection row.
    agent.emit({
      type: "tool_execution_start",
      toolCallId: "b1",
      toolName: "bash",
      args: { command: "make" },
    });
    agent.emit({
      type: "tool_execution_end",
      toolCallId: "b1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "make: *** No rule" }] },
      isError: true,
    });
    unsubscribe();
    await evidence.settle();
    const rejections = events.filter((e) => e.event === "completion_rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.detail).toMatchObject({
      tool: "submit_implementer_completion",
      message: "Envelope failed schema validation:\n  - head_sha: required",
    });
  });

  it("orders run_summary after every tool_call row without timers", async () => {
    const { events, sink } = recordingSink();
    const evidence = new RunEvidenceCollector("run-10", sink, []);
    const agent = fakeAgent();
    const unsubscribe = installRunGuards(agent as never, "run-10", {
      abort: () => agent.abort(),
      evidence,
      livenessTimeoutMs: 0,
      maxTurns: 100,
    });
    // An overflowing result makes toolEnd await the (already resolved)
    // artifact promise; without the serialized emit chain run_summary would
    // overtake the tool_call row in the feed.
    agent.emit({
      type: "tool_execution_start",
      toolCallId: "big",
      toolName: "bash",
      args: { command: "dump" },
    });
    agent.emit({
      type: "tool_execution_end",
      toolCallId: "big",
      toolName: "bash",
      result: { content: [{ type: "text", text: "x".repeat(2500) }] },
      isError: false,
    });
    agent.emit({ type: "agent_end", messages: [] });
    unsubscribe();
    await evidence.settle();
    const order = events.map((e) => e.event);
    expect(order.indexOf("run_summary")).toBeGreaterThan(
      order.indexOf("tool_call"),
    );
  });
});
