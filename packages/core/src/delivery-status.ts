import type { Run, Task } from "./store.js";
import type { RepairIntentRow } from "./store.js";
import type { ScopeApprovals } from "./store.js";

/** How the scheduler treats review, mirroring the config value. */
export type ReviewMode = "off" | "required";

/**
 * The delivery stage of one task: where its MR actually is on the way to
 * `merged`. The scheduler owns the facts; every consumer renders this value
 * and never infers a stage from an audit string or a task state.
 */
export type DeliveryStage =
  | "provider_head_pending"
  | "pipeline_pending"
  | "pipeline_running"
  | "ci_failed"
  | "repair_pending"
  | "repair_running"
  | "repair_failed"
  | "awaiting_review"
  | "reviewing"
  | "changes_requested"
  | "awaiting_human_approval"
  | "merge_gate_pending"
  | "merge_gate_running"
  | "merge_gate_failed"
  | "merge_conflict"
  | "ready_to_merge"
  | "merging"
  | "merged"
  | "blocked";

/** Every stage, in derivation-precedence order the console can rely on. */
export const DELIVERY_STAGES: readonly DeliveryStage[] = [
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
];

/** Provider pipeline facts for the task's CURRENT MR head only. A pipeline
 *  observed at any other head says nothing about this one. */
export interface DeliveryPipelineFacts {
  readonly status: "pending" | "running" | "success" | "failed" | "canceled";
  readonly pipelineUrl?: string;
  readonly observedAt?: string;
}

/** One human-readable reason the stage is what it is, with its link. */
export interface DeliveryEvidence {
  readonly kind: string;
  readonly text: string;
  readonly url?: string;
}

export interface DeliveryStatus {
  readonly stage: DeliveryStage;
  /** ISO timestamp of the newest fact behind the stage. */
  readonly since: string;
  readonly evidence: readonly DeliveryEvidence[];
  readonly run_ids: readonly string[];
}

export interface DeriveDeliveryStatusInput {
  readonly task: Task;
  readonly runs: readonly Run[];
  readonly latestGate?: Run | null;
  readonly reviews?: readonly Run[];
  readonly providerHeadSha?: string | null;
  readonly mrHeadSha?: string | null;
  readonly approvalsMode?: ScopeApprovals;
  readonly mergeApprovedSha?: string | null;
  readonly repairIntents?: readonly RepairIntentRow[];
  readonly providerHeadLagging?: boolean;
  readonly pipeline?: DeliveryPipelineFacts | null;
  /** Configured review mode; defaults to "off" like the config default. */
  readonly reviewMode?: ReviewMode;
}

/** Evidence is bounded so a task's status stays a summary, never a log. */
const MAX_EVIDENCE = 5;
const MAX_EVIDENCE_TEXT = 300;

/** Gate evidence reasons the derivation reads. Loose on purpose: the
 *  evidence blob is written by the gate, not by this module. */
interface GateEvidence {
  readonly reason?: string;
  readonly head_sha?: string;
  readonly error?: string;
  /** Review runs only: 'approve' | 'request_changes'. */
  readonly verdict?: string;
}

function parseEvidence(json: string | null | undefined): GateEvidence {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as GateEvidence)
      : {};
  } catch {
    return {};
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_EVIDENCE_TEXT
    ? `${flat.slice(0, MAX_EVIDENCE_TEXT - 1)}…`
    : flat;
}

/**
 * Every stage carries at least one evidence entry; the newest fact wins the
 * timestamp so `since` always answers "how long has it been like this".
 */
function status(
  stage: DeliveryStage,
  since: string,
  evidence: readonly DeliveryEvidence[],
  runIds: readonly string[] = [],
): DeliveryStatus {
  const bounded = evidence.slice(0, MAX_EVIDENCE).map((entry) => ({
    ...entry,
    text: clip(entry.text),
  }));
  const fallback =
    bounded.length > 0
      ? bounded
      : [{ kind: "stage", text: stage.replace(/_/g, " ") }];
  return {
    stage,
    since,
    evidence: fallback,
    run_ids: [...new Set(runIds)],
  };
}

function newest(candidates: readonly (string | null | undefined)[]): string {
  const times = candidates.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return times.length > 0 ? times.reduce((a, b) => (a > b ? a : b)) : "";
}

/** The newest repair intent, i.e. the one the task is currently living. */
function newestIntent(
  intents: readonly RepairIntentRow[],
): RepairIntentRow | null {
  return intents.length > 0 ? intents[intents.length - 1]! : null;
}

function triggerHead(intent: RepairIntentRow): string | null {
  try {
    const parsed = JSON.parse(intent.trigger_json) as {
      source_head_sha?: unknown;
    };
    return typeof parsed.source_head_sha === "string"
      ? parsed.source_head_sha
      : null;
  } catch {
    return null;
  }
}

/**
 * Derive one task's delivery stage. Pure: no I/O, no clock, deterministic in
 * its input, shared by every read surface so the browser never guesses.
 *
 * Returns null when the task has no stage to report: a never-dispatched
 * queued task has no head, no pipeline and no gate, so every stage would be
 * a guess, and a canceled task is terminal, so any in-flight stage would
 * contradict it. Callers omit the field rather than inventing a stage.
 *
 * Precedence: terminal states, then the repair the task is living, then the
 * provider head, then the persisted pipeline facts for the CURRENT head (an
 * absent or stale-head observation degrades to the head-independent ladder
 * and can never yield a pipeline stage), then review, then the merge gate.
 */
export function deriveDeliveryStatus(
  input: DeriveDeliveryStatusInput,
): DeliveryStatus | null {
  const task = input.task;
  const runs = input.runs ?? [];
  const reviews = input.reviews ?? [];
  const intents = input.repairIntents ?? [];
  const latestGate = input.latestGate ?? null;
  const mrHeadSha = input.mrHeadSha ?? input.providerHeadSha ?? null;
  const approvalsMode = input.approvalsMode ?? "auto";
  const reviewMode = input.reviewMode ?? "off";

  if (task.state === "merged") {
    return status(
      "merged",
      newest([task.updated_at, latestGate?.finished_at]),
      [{ kind: "task", text: "Merged onto the target branch." }],
      latestGate ? [latestGate.id] : [],
    );
  }

  if (task.state === "blocked") {
    return status(
      "blocked",
      task.updated_at,
      [
        {
          kind: "blocked_reason",
          text: task.blocked_reason ?? "Task is blocked.",
        },
      ],
      [],
    );
  }

  // Canceled is terminal (state-machine.ts): no head, pipeline or gate fact
  // can make it in-flight again, so there is nothing honest to report.
  if (task.state === "canceled") return null;

  // --- Repair ladder: an intent outlives the run it dispatched -----------
  const intent = newestIntent(intents);
  if (intent) {
    const run = intent.run_id
      ? (runs.find((candidate) => candidate.id === intent.run_id) ?? null)
      : null;
    const evidenceBase = [
      {
        kind: `repair_${intent.trigger_kind}`,
        text: `${intent.trigger_kind.replace(/_/g, " ")} repair claimed${intent.created_at ? ` at ${intent.created_at}` : ""}.`,
      },
    ];
    if (run?.status === "running") {
      return status(
        "repair_running",
        run.started_at,
        [
          ...evidenceBase,
          { kind: "run", text: `Repair run ${run.id} is running.` },
        ],
        [run.id],
      );
    }
    // A repair that ended without moving the head did not fix anything.
    const movedHead =
      intent.resolved_head_sha !== null &&
      intent.resolved_head_sha !== triggerHead(intent);
    if (
      run?.status === "failed" ||
      (run?.status === "succeeded" && !movedHead)
    ) {
      return status(
        "repair_failed",
        newest([run.finished_at, intent.created_at]),
        [
          ...evidenceBase,
          {
            kind: "run",
            text:
              run.status === "failed"
                ? `Repair run ${run.id} failed${run.error ? `: ${run.error}` : "."}`
                : `Repair run ${run.id} finished without a new head.`,
          },
        ],
        [run.id],
      );
    }
    if (!intent.run_id) {
      return status("repair_pending", intent.created_at, [
        ...evidenceBase,
        { kind: "repair", text: "Repair is queued for dispatch." },
      ]);
    }
  }

  // An implement run that has not pushed yet has no head and no pipeline:
  // CI has not started, so the honest stage is "pipeline pending", with the
  // run link as its evidence.
  const liveImplement = runs.find(
    (run) => run.kind === "implement" && run.status === "running",
  );
  if (liveImplement) {
    return status(
      "pipeline_pending",
      liveImplement.started_at,
      [{ kind: "run", text: `Implement run ${liveImplement.id} is running.` }],
      [liveImplement.id],
    );
  }

  // A task that has not pushed yet has no head because nothing has been
  // pushed: waiting on a provider head would blame the provider for work
  // that has not started. An mr_open task without a head is a different
  // case — the push happened, so the provider owes us the head.
  if (task.state === "queued" || task.state === "running") return null;

  // --- Provider head ------------------------------------------------------
  // A lagging head means the provider has not caught up with the push; an
  // unknown head means the MR has not been read. Either way no downstream
  // fact (pipeline, gate, review) can be trusted for THIS head.
  if (input.providerHeadLagging || !mrHeadSha) {
    const implementRun = [...runs]
      .reverse()
      .find((run) => run.kind === "implement");
    return status(
      "provider_head_pending",
      newest([task.updated_at, implementRun?.finished_at]),
      [
        {
          kind: "provider",
          text: mrHeadSha
            ? `Waiting for the provider to report the pushed head ${mrHeadSha}.`
            : "Waiting for the provider to report the new head.",
        },
      ],
      implementRun ? [implementRun.id] : [],
    );
  }

  // --- Persisted pipeline facts for this exact head -----------------------
  const pipeline = input.pipeline ?? null;
  if (pipeline) {
    const base = [
      {
        kind: "pipeline",
        text: `Pipeline ${pipeline.status} at ${mrHeadSha}.`,
        ...(pipeline.pipelineUrl ? { url: pipeline.pipelineUrl } : {}),
      },
    ];
    if (pipeline.status === "failed" || pipeline.status === "canceled") {
      return status(
        "ci_failed",
        newest([pipeline.observedAt, task.updated_at]),
        base,
        [],
      );
    }
    if (pipeline.status === "pending") {
      return status(
        "pipeline_pending",
        newest([pipeline.observedAt, task.updated_at]),
        base,
        [],
      );
    }
    if (pipeline.status === "running") {
      return status(
        "pipeline_running",
        newest([pipeline.observedAt, task.updated_at]),
        base,
        [],
      );
    }
  }

  // --- Head-independent ladder -------------------------------------------
  const gateEvidence = parseEvidence(latestGate?.evidence_json);

  if (approvalsMode === "manual" && input.mergeApprovedSha !== mrHeadSha) {
    return status(
      "awaiting_human_approval",
      newest([task.updated_at, latestGate?.finished_at]),
      [
        {
          kind: "approval",
          text: `Merge request is waiting for human approval of ${mrHeadSha}.`,
        },
      ],
      [],
    );
  }

  const activeReview = reviews.find((run) => run.status === "running");
  if (activeReview) {
    return status(
      "reviewing",
      activeReview.started_at,
      [{ kind: "run", text: `Review run ${activeReview.id} is running.` }],
      [activeReview.id],
    );
  }

  const latestReview = reviews.length > 0 ? reviews[reviews.length - 1]! : null;
  const latestReviewEvidence = parseEvidence(latestReview?.evidence_json);
  if (
    latestReview?.status === "succeeded" &&
    latestReviewEvidence.verdict === "request_changes" &&
    latestReviewEvidence.head_sha === mrHeadSha
  ) {
    return status(
      "changes_requested",
      newest([latestReview.finished_at, task.updated_at]),
      [
        {
          kind: "review",
          text: `Review requested changes at ${mrHeadSha}.`,
        },
      ],
      [latestReview.id],
    );
  }

  const approvedAtHead = reviews.some(
    (run) =>
      run.status === "succeeded" &&
      parseEvidence(run.evidence_json).verdict === "approve" &&
      parseEvidence(run.evidence_json).head_sha === mrHeadSha,
  );
  // Review is required by config, or the task already has review history: a
  // task that has never been reviewed is not silently exempt. The window
  // before the first review dispatch is awaiting_review, not ready_to_merge.
  if ((reviewMode === "required" || reviews.length > 0) && !approvedAtHead) {
    return status(
      "awaiting_review",
      newest([latestReview?.finished_at, task.updated_at]),
      [
        {
          kind: "review",
          text: `Waiting for a review of ${mrHeadSha}.`,
        },
      ],
      latestReview ? [latestReview.id] : [],
    );
  }

  if (latestGate?.status === "running") {
    return status(
      "merge_gate_running",
      latestGate.started_at,
      [{ kind: "run", text: `Merge gate run ${latestGate.id} is running.` }],
      [latestGate.id],
    );
  }

  if (latestGate?.status === "failed") {
    const reason = gateEvidence.reason;
    const when = newest([latestGate.finished_at]);
    if (reason === "merge_conflict") {
      return status(
        "merge_conflict",
        when,
        [
          {
            kind: "gate",
            text: `Merge gate found a conflict at ${mrHeadSha}.`,
          },
        ],
        [latestGate.id],
      );
    }
    if (reason === "command_failed" || reason === "secret_scan") {
      return status(
        "merge_gate_failed",
        when,
        [
          {
            kind: "gate",
            text: `Merge gate failed at ${mrHeadSha}${gateEvidence.error ? `: ${gateEvidence.error}` : "."}`,
          },
        ],
        [latestGate.id],
      );
    }
    // A transient provider refusal or a platform fault: the gate re-runs.
    return status(
      "merge_gate_pending",
      when,
      [
        {
          kind: "gate",
          text: `Merge gate was refused at ${mrHeadSha} and will re-gate.`,
        },
      ],
      [latestGate.id],
    );
  }

  // `merging` only once the gate accepted THIS head: a gate that succeeded
  // at an older head did not merge the commit the provider shows.
  if (
    latestGate?.status === "succeeded" &&
    gateEvidence.head_sha === mrHeadSha
  ) {
    return status(
      "merging",
      newest([latestGate.finished_at]),
      [
        {
          kind: "gate",
          text: `Merge gate accepted ${mrHeadSha}; waiting for the provider to confirm the merge.`,
        },
      ],
      [latestGate.id],
    );
  }

  return status(
    "ready_to_merge",
    newest([task.updated_at, latestGate?.finished_at]),
    [
      {
        kind: "gate",
        text: `Ready to merge ${mrHeadSha}.`,
      },
    ],
    latestGate ? [latestGate.id] : [],
  );
}
