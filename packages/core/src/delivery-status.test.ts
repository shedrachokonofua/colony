import { describe, expect, it } from "bun:test";
import { scopeId, taskId } from "@colony/domain";
import {
  DELIVERY_STAGES,
  deriveDeliveryStatus,
  type DeliveryStage,
  type DeliveryStatus,
  type DeriveDeliveryStatusInput,
} from "./delivery-status.js";
import type { RepairIntentRow, Run, Task } from "./store.js";

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const T = "2026-09-01T00:00:00.000Z";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId("col-wxyz.1"),
    scope_id: scopeId("col-wxyz"),
    title: "Task",
    spec: "spec",
    state: "mr_open",
    state_version: 3,
    branch: "colony/col-x.1",
    mr_iid: 7,
    attempt: 1,
    next_retry_at: null,
    blocked_reason: null,
    created_at: T,
    updated_at: T,
    merge_approved_sha: null,
    human_feedback: null,
    cost_prediction_json: null,
    ...overrides,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    scope_id: scopeId("col-wxyz"),
    task_id: taskId("col-wxyz.1"),
    kind: "merge_gate",
    status: "succeeded",
    lease_expires_at: T,
    base_sha: null,
    head_sha: HEAD,
    workspace_path: null,
    sandbox_id: null,
    adopted: 1,
    envelope_json: null,
    evidence_json: null,
    token_id: null,
    model_id: null,
    trace_id: null,
    error: null,
    last_progress_at: null,
    active_tool: null,
    active_tool_detail: null,
    active_tool_started_at: null,
    fault_json: null,
    started_at: T,
    finished_at: T,
    ...overrides,
  };
}

function intent(overrides: Partial<RepairIntentRow> = {}): RepairIntentRow {
  return {
    fingerprint: "fp-1",
    task_id: "col-x.1",
    trigger_kind: "ci_failure",
    trigger_json: JSON.stringify({ source_head_sha: HEAD }),
    created_at: T,
    claimed_at: T,
    run_id: null,
    resolved_head_sha: null,
    ...overrides,
  };
}

/** The facts a test supplies; everything else defaults to "not known". */
type Overrides = Partial<DeriveDeliveryStatusInput>;

/** Input with every optional field defaulted to "no facts known". */
function input(overrides: Overrides): DeriveDeliveryStatusInput {
  return {
    task: overrides.task ?? task(),
    runs: overrides.runs ?? [],
    latestGate:
      overrides.latestGate === undefined ? null : overrides.latestGate,
    reviews: overrides.reviews ?? [],
    providerHeadSha: overrides.providerHeadSha ?? null,
    // An explicitly null head is a fact, not an absent override.
    mrHeadSha: "mrHeadSha" in overrides ? (overrides.mrHeadSha ?? null) : HEAD,
    approvalsMode: overrides.approvalsMode ?? "auto",
    mergeApprovedSha: overrides.mergeApprovedSha ?? null,
    repairIntents: overrides.repairIntents ?? [],
    providerHeadLagging: overrides.providerHeadLagging ?? false,
    pipeline: overrides.pipeline ?? null,
    reviewMode: overrides.reviewMode ?? "off",
  };
}

/** Derives without assuming an outcome: null is a legal result. */
function deriveOrNull(overrides: Overrides): DeliveryStatus | null {
  return deriveDeliveryStatus(input(overrides));
}

/** Derives a task that has a stage; a null outcome fails the caller. */
function derive(overrides: Overrides): DeliveryStatus {
  const status = deriveOrNull(overrides);
  if (!status) throw new Error("expected a delivery status, got null");
  return status;
}

describe("DELIVERY_STAGES", () => {
  it("lists every stage the console can be asked to render", () => {
    expect(DELIVERY_STAGES).toEqual([
      "provider_head_pending",
      "pipeline_pending",
      "pipeline_running",
      "ci_failed",
      "repair_pending",
      "repair_running",
      "repair_failed",
      "awaiting_review",
      "reviewing",
      "changes_requested",
      "awaiting_human_approval",
      "merge_gate_pending",
      "merge_gate_running",
      "merge_gate_failed",
      "merge_conflict",
      "ready_to_merge",
      "merging",
      "merged",
      "blocked",
    ]);
    expect(new Set(DELIVERY_STAGES).size).toBe(DELIVERY_STAGES.length);
  });
});

describe("terminal and blocked stages", () => {
  it("merged is merged", () => {
    const status = derive({ task: task({ state: "merged" }) });
    expect(status.stage).toBe("merged");
  });

  it("blocked is blocked with its reason as the first evidence", () => {
    const status = derive({
      task: task({
        state: "blocked",
        blocked_reason: "review model exhausted",
      }),
    });
    expect(status.stage).toBe("blocked");
    expect(status.evidence[0]?.kind).toBe("blocked_reason");
    expect(status.evidence[0]?.text).toContain("review model exhausted");
  });

  it("blocked without a reason carries the generic blocked line", () => {
    const status = derive({ task: task({ state: "blocked" }) });
    expect(status.stage).toBe("blocked");
    expect(status.evidence[0]?.text).toBe("Task is blocked.");
  });
});

describe("tasks with no delivery facts have no stage", () => {
  it("a never-run queued task is null, never provider_head_pending", () => {
    expect(deriveOrNull({ task: task({ state: "queued" }) })).toBeNull();
  });

  it("a queued task with a head and pipeline facts is still null", () => {
    const implemented = run({ kind: "implement", status: "succeeded" });
    expect(
      deriveOrNull({
        task: task({ state: "queued" }),
        runs: [implemented],
        mrHeadSha: HEAD,
        pipeline: { status: "success" },
      }),
    ).toBeNull();
  });

  it("a running task with no live run is null", () => {
    expect(
      deriveOrNull({
        task: task({ state: "running" }),
        runs: [run({ kind: "implement", status: "failed" })],
      }),
    ).toBeNull();
  });

  it("a canceled task is null, whatever its head, pipeline and gate say", () => {
    const gate = run({
      id: "run-gate",
      status: "succeeded",
      evidence_json: JSON.stringify({
        reason: "merge_accepted",
        head_sha: HEAD,
      }),
    });
    for (const facts of [
      {},
      { mrHeadSha: HEAD, pipeline: { status: "failed" as const } },
      { latestGate: gate, runs: [gate], reviews: [gate] },
    ]) {
      expect(
        deriveOrNull({ task: task({ state: "canceled" }), ...facts }),
      ).toBeNull();
    }
  });

  it("a queued task with a repair intent is repair_pending", () => {
    const status = derive({
      task: task({ state: "queued" }),
      repairIntents: [intent()],
    });
    expect(status?.stage).toBe("repair_pending");
  });

  it("a running task with a live implement run is pipeline_pending", () => {
    const implement = run({
      id: "run-impl",
      kind: "implement",
      status: "running",
    });
    const status = derive({
      task: task({ state: "running" }),
      runs: [implement],
    });
    expect(status?.stage).toBe("pipeline_pending");
    expect(status?.run_ids).toEqual(["run-impl"]);
  });
});

describe("repair stages from repair_intents", () => {
  it("a claimed intent with a running repair run is repair_running", () => {
    const repair = run({
      id: "run-repair",
      kind: "implement",
      status: "running",
    });
    const status = derive({
      runs: [repair],
      repairIntents: [intent({ run_id: "run-repair" })],
    });
    expect(status.stage).toBe("repair_running");
    expect(status.run_ids).toEqual(["run-repair"]);
  });

  it("a claimed intent with no run is repair_pending", () => {
    const status = derive({ repairIntents: [intent()] });
    expect(status.stage).toBe("repair_pending");
  });

  it("a failed repair run is repair_failed", () => {
    const repair = run({
      id: "run-repair",
      kind: "implement",
      status: "failed",
      error: "boom",
    });
    const status = derive({
      runs: [repair],
      repairIntents: [intent({ run_id: "run-repair" })],
    });
    expect(status.stage).toBe("repair_failed");
    expect(status.evidence.some((e) => e.text.includes("boom"))).toBe(true);
  });

  it("a repair that succeeded without moving the head is repair_failed", () => {
    const repair = run({
      id: "run-repair",
      kind: "implement",
      status: "succeeded",
    });
    const status = derive({
      runs: [repair],
      repairIntents: [
        intent({ run_id: "run-repair", resolved_head_sha: HEAD }),
      ],
    });
    expect(status.stage).toBe("repair_failed");
  });

  it("a repair that moved the head is no longer the task's stage", () => {
    const repair = run({
      id: "run-repair",
      kind: "implement",
      status: "succeeded",
    });
    const status = derive({
      runs: [repair],
      repairIntents: [
        intent({ run_id: "run-repair", resolved_head_sha: OLD_HEAD }),
      ],
    });
    expect(status.stage).not.toBe("repair_failed");
    expect(status.stage).not.toBe("repair_running");
  });
});

describe("provider head", () => {
  it("a lagging provider head is provider_head_pending", () => {
    const status = derive({
      providerHeadLagging: true,
      pipeline: { status: "success" },
    });
    expect(status.stage).toBe("provider_head_pending");
  });

  it("an unknown head is provider_head_pending and never a pipeline stage", () => {
    for (const pipelineStatus of ["failed", "pending", "running"] as const) {
      const status = derive({
        mrHeadSha: null,
        providerHeadSha: null,
        pipeline: { status: pipelineStatus },
      });
      expect(status.stage).toBe("provider_head_pending");
    }
  });
});

describe("pipeline facts", () => {
  it("implementation still running pre-push is pipeline_pending with the run link", () => {
    const implement = run({
      id: "run-impl",
      kind: "implement",
      status: "running",
    });
    const status = derive({ runs: [implement] });
    expect(status.stage).toBe("pipeline_pending");
    expect(status.run_ids).toEqual(["run-impl"]);
  });

  it("a failed pipeline at the current head is ci_failed", () => {
    const status = derive({
      mrHeadSha: HEAD,
      pipeline: {
        status: "failed",
        pipelineUrl: "https://ci.example/pipelines/9",
      },
    });
    expect(status.stage).toBe("ci_failed");
    expect(
      status.evidence.some((e) => e.url === "https://ci.example/pipelines/9"),
    ).toBe(true);
  });

  it("a canceled pipeline at the current head is ci_failed", () => {
    const status = derive({ pipeline: { status: "canceled" } });
    expect(status.stage).toBe("ci_failed");
  });

  it("a pending pipeline is pipeline_pending, a running one pipeline_running", () => {
    expect(derive({ pipeline: { status: "pending" } }).stage).toBe(
      "pipeline_pending",
    );
    expect(derive({ pipeline: { status: "running" } }).stage).toBe(
      "pipeline_running",
    );
  });

  it("a successful pipeline falls through to the head-independent ladder", () => {
    const status = derive({ pipeline: { status: "success" } });
    expect(status.stage).not.toBe("ci_failed");
    expect(status.stage).toBe("ready_to_merge");
  });

  it("absent pipeline facts never yield a pipeline stage", () => {
    // The succeeded-implement / no-observation case: the browser must not
    // read this as CI success or failure either way.
    const implemented = run({
      id: "run-impl",
      kind: "implement",
      status: "succeeded",
      head_sha: HEAD,
    });
    for (const pipeline of [null, undefined]) {
      const status = derive({ runs: [implemented], pipeline });
      expect([
        "ci_failed",
        "pipeline_pending",
        "pipeline_running",
      ]).not.toContain(status.stage);
    }
  });
});

describe("review ladder", () => {
  it("a running review run is reviewing", () => {
    const review = run({ id: "run-rev", kind: "review", status: "running" });
    const status = derive({ runs: [review], reviews: [review] });
    expect(status.stage).toBe("reviewing");
    expect(status.run_ids).toEqual(["run-rev"]);
  });

  it("request_changes at the head is changes_requested", () => {
    const review = run({
      id: "run-rev",
      kind: "review",
      status: "succeeded",
      evidence_json: JSON.stringify({
        verdict: "request_changes",
        head_sha: HEAD,
      }),
    });
    const status = derive({ runs: [review], reviews: [review] });
    expect(status.stage).toBe("changes_requested");
  });

  it("review history without an approval at the head is awaiting_review", () => {
    const review = run({
      id: "run-rev",
      kind: "review",
      status: "succeeded",
      evidence_json: JSON.stringify({
        verdict: "request_changes",
        head_sha: OLD_HEAD,
      }),
    });
    const status = derive({ runs: [review], reviews: [review] });
    expect(status.stage).toBe("awaiting_review");
  });

  it("required review mode with no review run yet is awaiting_review", () => {
    const implemented = run({
      id: "run-impl",
      kind: "implement",
      status: "succeeded",
      head_sha: HEAD,
    });
    const status = derive({
      runs: [implemented],
      reviews: [],
      reviewMode: "required",
    });
    expect(status.stage).toBe("awaiting_review");
  });

  it("required review mode is satisfied by an approval at the head", () => {
    const review = run({
      id: "run-rev",
      kind: "review",
      status: "succeeded",
      evidence_json: JSON.stringify({ verdict: "approve", head_sha: HEAD }),
    });
    const status = derive({
      runs: [review],
      reviews: [review],
      reviewMode: "required",
    });
    expect(status.stage).toBe("ready_to_merge");
  });

  it("an approval at the head clears the review ladder", () => {
    const review = run({
      id: "run-rev",
      kind: "review",
      status: "succeeded",
      evidence_json: JSON.stringify({ verdict: "approve", head_sha: HEAD }),
    });
    const status = derive({ runs: [review], reviews: [review] });
    expect(status.stage).toBe("ready_to_merge");
  });

  it("manual approvals without an approval at the head is awaiting_human_approval", () => {
    const status = derive({
      approvalsMode: "manual",
      mergeApprovedSha: OLD_HEAD,
    });
    expect(status.stage).toBe("awaiting_human_approval");
  });

  it("manual approvals at the head are satisfied", () => {
    const status = derive({
      approvalsMode: "manual",
      mergeApprovedSha: HEAD,
    });
    expect(status.stage).toBe("ready_to_merge");
  });
});

describe("merge gate ladder", () => {
  it("a running gate is merge_gate_running", () => {
    const gate = run({ id: "run-gate", status: "running" });
    const status = derive({ runs: [gate], latestGate: gate });
    expect(status.stage).toBe("merge_gate_running");
  });

  it("a conflicted gate is merge_conflict", () => {
    const gate = run({
      id: "run-gate",
      status: "failed",
      evidence_json: JSON.stringify({ reason: "merge_conflict" }),
    });
    const status = derive({ runs: [gate], latestGate: gate });
    expect(status.stage).toBe("merge_conflict");
  });

  it("a command failure is merge_gate_failed", () => {
    const gate = run({
      id: "run-gate",
      status: "failed",
      evidence_json: JSON.stringify({
        reason: "command_failed",
        error: "bun test exited 1",
      }),
    });
    const status = derive({ runs: [gate], latestGate: gate });
    expect(status.stage).toBe("merge_gate_failed");
    expect(
      status.evidence.some((e) => e.text.includes("bun test exited 1")),
    ).toBe(true);
  });

  it("a transient refusal is merge_gate_pending", () => {
    const gate = run({
      id: "run-gate",
      status: "failed",
      evidence_json: JSON.stringify({
        reason: "merge_refused:merge_http_409",
      }),
    });
    const status = derive({ runs: [gate], latestGate: gate });
    expect(status.stage).toBe("merge_gate_pending");
  });

  it("a gate that succeeded at the head is merging", () => {
    const gate = run({
      id: "run-gate",
      status: "succeeded",
      evidence_json: JSON.stringify({
        reason: "merge_accepted",
        head_sha: HEAD,
      }),
    });
    const status = derive({ runs: [gate], latestGate: gate });
    expect(status.stage).toBe("merging");
  });

  it("a gate that succeeded at an older head is not merging", () => {
    const gate = run({
      id: "run-gate",
      status: "succeeded",
      evidence_json: JSON.stringify({
        reason: "merge_accepted",
        head_sha: OLD_HEAD,
      }),
    });
    const status = derive({ runs: [gate], latestGate: gate });
    expect(status.stage).not.toBe("merging");
    expect(status.stage).toBe("ready_to_merge");
  });

  it("no gate at all is ready_to_merge", () => {
    expect(derive({}).stage).toBe("ready_to_merge");
  });
});

describe("evidence contract", () => {
  it("every stage carries at least one bounded evidence entry", () => {
    const seen = new Set<DeliveryStage>();
    // Each stage's minimal input; `merged`/`blocked` come from task state.
    const inputs: Record<DeliveryStage, Parameters<typeof derive>[0]> = {
      provider_head_pending: { mrHeadSha: null, providerHeadSha: null },
      pipeline_pending: {
        runs: [run({ kind: "implement", status: "running" })],
      },
      pipeline_running: { pipeline: { status: "running" } },
      ci_failed: { pipeline: { status: "failed" } },
      repair_pending: { repairIntents: [intent()] },
      repair_running: {
        runs: [run({ kind: "implement", status: "running", id: "r" })],
        repairIntents: [intent({ run_id: "r" })],
      },
      repair_failed: {
        runs: [run({ kind: "implement", status: "failed", id: "r" })],
        repairIntents: [intent({ run_id: "r" })],
      },
      awaiting_review: {
        reviews: [run({ kind: "review", status: "succeeded" })],
      },
      reviewing: {
        reviews: [run({ kind: "review", status: "running", id: "r2" })],
        runs: [run({ kind: "review", status: "running", id: "r2" })],
      },
      changes_requested: {
        reviews: [
          run({
            kind: "review",
            status: "succeeded",
            evidence_json: JSON.stringify({
              verdict: "request_changes",
              head_sha: HEAD,
            }),
          }),
        ],
      },
      awaiting_human_approval: { approvalsMode: "manual" },
      merge_gate_pending: {
        latestGate: run({
          status: "failed",
          evidence_json: JSON.stringify({
            reason: "merge_refused:merge_http_405",
          }),
        }),
      },
      merge_gate_running: { latestGate: run({ status: "running" }) },
      merge_gate_failed: {
        latestGate: run({
          status: "failed",
          evidence_json: JSON.stringify({ reason: "command_failed" }),
        }),
      },
      merge_conflict: {
        latestGate: run({
          status: "failed",
          evidence_json: JSON.stringify({ reason: "merge_conflict" }),
        }),
      },
      ready_to_merge: {},
      merging: {
        latestGate: run({
          status: "succeeded",
          evidence_json: JSON.stringify({
            reason: "merge_accepted",
            head_sha: HEAD,
          }),
        }),
      },
      merged: { task: task({ state: "merged" }) },
      blocked: { task: task({ state: "blocked" }) },
    };
    for (const [stage, overrides] of Object.entries(inputs) as [
      DeliveryStage,
      Parameters<typeof derive>[0],
    ][]) {
      const status = derive(overrides);
      expect(status.stage).toBe(stage);
      seen.add(status.stage);
      expect(status.evidence.length).toBeGreaterThan(0);
      expect(status.evidence.length).toBeLessThanOrEqual(5);
      for (const entry of status.evidence) {
        expect(entry.text.length).toBeLessThanOrEqual(300);
        expect(typeof entry.kind).toBe("string");
      }
      expect(typeof status.since).toBe("string");
    }
    // The table above covers every stage the console must render.
    expect([...seen].sort()).toEqual([...DELIVERY_STAGES].sort());
  });

  it("clips overlong evidence text", () => {
    const gate = run({
      status: "failed",
      evidence_json: JSON.stringify({
        reason: "command_failed",
        error: "x".repeat(1000),
      }),
    });
    const status = derive({ runs: [gate], latestGate: gate });
    expect(status.evidence[0]!.text.length).toBeLessThanOrEqual(300);
  });

  it("is deterministic: the same input yields the same status", () => {
    const input = {
      runs: [run({ id: "run-1", kind: "implement" as const })],
      pipeline: { status: "failed" as const },
    };
    expect(derive(input)).toEqual(derive(input));
  });
});
