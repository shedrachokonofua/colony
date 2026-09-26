import {
  OpenReviewFindingV1,
  type CodeReviewRoundV1,
  type ReviewerVerdictV2,
} from "@colony/schemas";
import { retryBackoffMs, type Run, type Store, type Task } from "@colony/core";
import { z } from "zod";
import { SERVICE_ACTOR } from "../context.js";
import { retryResetAt } from "../fault-budget.js";

/**
 * The code review loop's policy: what each review must account for, what a
 * rejection does next, and what an approval leaves behind.
 *
 * Each review verifies the findings the previous one left open, and severity
 * decides what can hold a change back:
 *   blocker       always
 *   open finding  while it still holds, if it was blocking when raised
 *   new major     only in the first MAJOR_BLOCKING_REVIEWS reviews of an
 *                 epoch; later majors approve and become a follow-up task
 *   minor         never
 * The loop stops and asks the operator when
 *   operator  the latest review filed a blocker only the operator can settle
 *   stalled   a blocking finding stayed open for CODE_REVIEW_STALL_REVIEWS
 *             reviews in a row
 *   cap       MAX_CONSECUTIVE_REVIEW_REJECTIONS rejections in a row
 * An operator reset (a blocked or canceled task requeued by a person) starts
 * a new epoch: stall ages and the rejection count restart, and new majors
 * can block again for the first reviews.
 *
 * 2026-09-26: brink col-7548de26.3 was rejected 8 times, each review finding
 * new majors in code earlier reviews had passed; resurf col-d6ca6aa2.2 kept
 * re-raising a relay binding no change in the repository could supply.
 */

/** Reviews per epoch in which a new major can still hold a change back. */
export const MAJOR_BLOCKING_REVIEWS = 2;

/** Reviews in a row a blocking finding may stay open before the loop stops. */
export const CODE_REVIEW_STALL_REVIEWS = 3;

/** Hard ceiling on consecutive rejections in one epoch. */
export const MAX_CONSECUTIVE_REVIEW_REJECTIONS = 10;

export type CodeReviewBlockKind = "operator" | "stalled" | "cap";

const StoredFinding = z.object({
  severity: z.string().optional(),
  file: z.string().optional(),
  note: z.string().optional(),
  owner: z.string().optional(),
});

const StoredReviewEvidence = z.object({
  verdict: z.string().optional(),
  findings: z.array(StoredFinding).optional(),
  open_findings: z.array(OpenReviewFindingV1).optional(),
});

type StoredReviewEvidence = z.infer<typeof StoredReviewEvidence>;

function parseEvidence(json: string | null): StoredReviewEvidence | null {
  if (!json) return null;
  try {
    const parsed = StoredReviewEvidence.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** One recorded verdict, reduced to what the loop reads. */
interface ReviewVerdictRecord {
  readonly run: Run;
  /** 1-based position among the task's verdicts. */
  readonly round: number;
  readonly verdict: "approve" | "request_changes";
  readonly openFindings: readonly OpenReviewFindingV1[];
  readonly operatorNotes: readonly string[];
}

/**
 * A verdict recorded before the ledger existed left its blockers and majors
 * open, all blocking: that is what it asked the implementer to fix.
 */
function legacyOpenFindings(
  findings: StoredReviewEvidence["findings"],
  round: number,
): OpenReviewFindingV1[] {
  return (findings ?? []).flatMap((finding) =>
    (finding.severity === "blocker" || finding.severity === "major") &&
    finding.note
      ? [
          {
            severity: finding.severity,
            ...(finding.file ? { file: finding.file } : {}),
            note: finding.note,
            blocking: true,
            since_round: round,
          },
        ]
      : [],
  );
}

/** The task's recorded verdicts, oldest first. */
function reviewVerdicts(
  store: Pick<Store, "runsForTask">,
  taskId: string,
): ReviewVerdictRecord[] {
  const records: ReviewVerdictRecord[] = [];
  for (const run of store.runsForTask(taskId)) {
    if (run.kind !== "review" || run.status !== "succeeded") continue;
    const evidence = parseEvidence(run.evidence_json);
    const verdict = evidence?.verdict;
    if (verdict !== "approve" && verdict !== "request_changes") continue;
    const round = records.length + 1;
    records.push({
      run,
      round,
      verdict,
      openFindings:
        evidence!.open_findings ??
        legacyOpenFindings(evidence!.findings, round),
      operatorNotes: (evidence!.findings ?? []).flatMap((finding) =>
        finding.owner === "operator" && finding.note ? [finding.note] : [],
      ),
    });
  }
  return records;
}

/** The first round of the current epoch: after the latest operator reset. */
function epochStartRound(
  store: Pick<Store, "listAudit">,
  taskId: string,
  records: readonly ReviewVerdictRecord[],
): number {
  const since = retryResetAt(store, "task", taskId);
  if (since === undefined) return 1;
  const first = records.find((record) => record.run.started_at > since);
  return first ? first.round : records.length + 1;
}

/** Where the next review stands in the loop. */
export interface ReviewLoopPosition {
  readonly round: CodeReviewRoundV1;
  /** The first round of the current epoch. */
  readonly epochStart: number;
}

/**
 * What the task's next review must account for: its round, whether new
 * majors still block, and the findings the latest rejection left open.
 */
export function nextReviewRound(
  store: Pick<Store, "runsForTask" | "listAudit">,
  taskId: string,
): ReviewLoopPosition {
  const records = reviewVerdicts(store, taskId);
  const epochStart = epochStartRound(store, taskId, records);
  const round = records.length + 1;
  const latest = records.at(-1);
  return {
    round: {
      round,
      majors_block: round < epochStart + MAJOR_BLOCKING_REVIEWS,
      open_findings:
        latest?.verdict === "request_changes" ? [...latest.openFindings] : [],
    },
    epochStart,
  };
}

/**
 * The findings left open after `verdict`: the previous ones it found still
 * holding, then its own blockers and majors. A new major blocks only while
 * majors block; minors are never carried.
 */
export function openFindingsAfter(
  round: CodeReviewRoundV1,
  verdict: ReviewerVerdictV2,
): OpenReviewFindingV1[] {
  const status = new Map(
    (verdict.previous_findings ?? []).map((entry) => [
      entry.finding,
      entry.status,
    ]),
  );
  const carried = round.open_findings.filter(
    (_, index) => status.get(index + 1) === "open",
  );
  const raised = verdict.findings.flatMap((finding) =>
    finding.severity === "minor"
      ? []
      : [
          {
            severity: finding.severity,
            ...(finding.file ? { file: finding.file } : {}),
            note: finding.note,
            blocking: finding.severity === "blocker" || round.majors_block,
            since_round: round.round,
          },
        ],
  );
  return [...carried, ...raised];
}

export type ReviewLoopDecision =
  | { readonly action: "requeue" }
  | {
      readonly action: "block";
      readonly kind: CodeReviewBlockKind;
      readonly reason: string;
    };

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Send a rejection back to the implementer, or stop for the operator. */
export function decideReviewLoop(input: {
  /** Consecutive rejections in the epoch, the latest included. */
  readonly rejections: number;
  /** The latest rejection's round. */
  readonly round: number;
  readonly epochStart: number;
  /** What the latest rejection left open. */
  readonly openFindings: readonly OpenReviewFindingV1[];
  readonly operatorNotes: readonly string[];
}): ReviewLoopDecision {
  const count = input.rejections;
  const after = `after ${count} rejection${count === 1 ? "" : "s"}`;
  if (input.operatorNotes.length > 0) {
    const more =
      input.operatorNotes.length > 1
        ? ` (+${input.operatorNotes.length - 1} more)`
        : "";
    return {
      action: "block",
      kind: "operator",
      reason: `code review needs an operator decision ${after}: ${excerpt(input.operatorNotes[0]!, 240)}${more}`,
    };
  }
  const stuck = input.openFindings.find(
    (finding) =>
      finding.blocking &&
      input.round - Math.max(finding.since_round, input.epochStart) + 1 >=
        CODE_REVIEW_STALL_REVIEWS,
  );
  if (stuck) {
    return {
      action: "block",
      kind: "stalled",
      reason: `code review stalled ${after}: a ${stuck.severity} raised in review ${stuck.since_round} is still open after ${CODE_REVIEW_STALL_REVIEWS} reviews: ${excerpt(stuck.note, 200)}`,
    };
  }
  if (count >= MAX_CONSECUTIVE_REVIEW_REJECTIONS) {
    return {
      action: "block",
      kind: "cap",
      reason: `code review rejected ${count} consecutive times`,
    };
  }
  return { action: "requeue" };
}

/**
 * Act on the task's latest rejection while its MR is open: requeue the
 * implementer, or block for the operator. Idempotent; the tick also calls it
 * to self-heal a handler that died between recording the verdict and this.
 */
export function reconcileRejectedReview(store: Store, task: Task): void {
  const current = store.getTask(task.id);
  if (!current || current.state !== "mr_open") return;
  const records = reviewVerdicts(store, current.id);
  const latest = records.at(-1);
  if (latest?.verdict !== "request_changes") return;
  const epochStart = epochStartRound(store, current.id, records);
  let rejections = 0;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]!;
    if (record.round < epochStart || record.verdict !== "request_changes")
      break;
    rejections += 1;
  }
  const decision = decideReviewLoop({
    rejections,
    round: latest.round,
    epochStart,
    openFindings: latest.openFindings,
    operatorNotes: latest.operatorNotes,
  });
  if (decision.action === "block") {
    store.transitionTask(
      current.id,
      current.state_version,
      "blocked",
      SERVICE_ACTOR,
      { blocked_reason: decision.reason },
    );
    store.audit(SERVICE_ACTOR, "review.loop_blocked", {
      scope_id: current.scope_id,
      task_id: current.id,
      run_id: latest.run.id,
      detail: { kind: decision.kind, rejections, round: latest.round },
    });
    return;
  }
  const attempt = current.attempt + 1;
  store.transitionTask(
    current.id,
    current.state_version,
    "queued",
    SERVICE_ACTOR,
    {
      attempt,
      next_retry_at: new Date(
        Date.now() + retryBackoffMs(attempt),
      ).toISOString(),
    },
  );
}

/**
 * Record a verdict the reviewer submitted for `headSha`, then act on it: a
 * rejection requeues or blocks; an approval files what it left open as a
 * follow-up task.
 */
export function recordReviewVerdict(
  store: Store,
  task: Task,
  runId: string,
  headSha: string,
  verdict: ReviewerVerdictV2,
  position: ReviewLoopPosition,
): void {
  const round = position.round.round;
  const open = openFindingsAfter(position.round, verdict);
  store.finishRun(runId, "succeeded", {
    head_sha: headSha,
    envelope_json: JSON.stringify(verdict),
    evidence_json: JSON.stringify({
      verdict: verdict.verdict,
      head_sha: headSha,
      round,
      findings: verdict.findings,
      ...(verdict.previous_findings
        ? { previous_findings: verdict.previous_findings }
        : {}),
      open_findings: open,
      dimensions: verdict.dimensions,
      challenged: verdict.challenged,
    }),
  });
  const refs = { scope_id: task.scope_id, task_id: task.id, run_id: runId };
  if (verdict.verdict === "approve") {
    store.audit(SERVICE_ACTOR, "review.approved", {
      ...refs,
      detail: {
        head_sha: headSha,
        round,
        left_open: open.length,
        dimensions: verdict.dimensions,
        challenged: verdict.challenged,
      },
    });
    fileReviewFollowUp(store, task, runId, round, open);
    return;
  }
  store.audit(SERVICE_ACTOR, "review.changes_requested", {
    ...refs,
    detail: {
      head_sha: headSha,
      round,
      findings_count: verdict.findings.length,
      blocking: open.filter((finding) => finding.blocking).length,
      dimensions: verdict.dimensions,
      challenged: verdict.challenged,
    },
  });
  reconcileRejectedReview(store, task);
}

// ---------------------------------------------------------------------------
// Follow-up tasks
// ---------------------------------------------------------------------------

const FOLLOW_UP_TITLE = /^Review follow-up for (\S+?):/;

/** The task a review follow-up was filed for, or null for any other task. */
export function followUpOf(task: Pick<Task, "title">): string | null {
  return FOLLOW_UP_TITLE.exec(task.title)?.[1] ?? null;
}

function followUpSpec(
  task: Task,
  round: number,
  findings: readonly OpenReviewFindingV1[],
): string {
  return [
    "## Goal",
    `Resolve the review findings left open when task ${task.id} ("${task.title}") was approved in review round ${round}. That change lands on the default branch before this task starts: fix the findings in place.`,
    "",
    "## Findings",
    ...findings.map(
      (finding, i) =>
        `${i + 1}. [${finding.severity}]${finding.file ? ` \`${finding.file}\`` : ""}: ${finding.note} (raised in review round ${finding.since_round})`,
    ),
    "",
    "## Required evidence",
    "- For each finding: a test or probe that fails on the default branch before the fix and passes after it; or, when the finding does not hold there, one line in the completion summary saying why.",
    "",
    "## Invariants",
    `- Change only what these findings need; the behavior task ${task.id} delivered stays intact.`,
  ].join("\n");
}

/**
 * File the findings an approval left open as one task that depends on the
 * approved one. A follow-up's own leftovers are recorded, not filed again,
 * so follow-ups cannot chain.
 */
function fileReviewFollowUp(
  store: Store,
  task: Task,
  runId: string,
  round: number,
  findings: readonly OpenReviewFindingV1[],
): void {
  if (findings.length === 0) return;
  const refs = { scope_id: task.scope_id, task_id: task.id, run_id: runId };
  const existing = store
    .listTasks(task.scope_id)
    .find((candidate) => followUpOf(candidate) === task.id);
  if (followUpOf(task) !== null || existing) {
    store.audit(SERVICE_ACTOR, "review.follow_up_skipped", {
      ...refs,
      detail: {
        reason: existing ? "follow-up already filed" : "task is a follow-up",
        ...(existing ? { follow_up_task_id: existing.id } : {}),
        findings,
      },
    });
    return;
  }
  try {
    const followUp = store.addTask(
      task.scope_id,
      {
        title: `Review follow-up for ${task.id}: ${task.title}`,
        spec: followUpSpec(task, round, findings),
        depends_on: [task.id],
      },
      SERVICE_ACTOR,
      { follow_up_of: task.id, review_run_id: runId },
    );
    store.audit(SERVICE_ACTOR, "review.follow_up_filed", {
      ...refs,
      detail: { follow_up_task_id: followUp.id, findings: findings.length },
    });
  } catch (err) {
    store.audit(SERVICE_ACTOR, "review.follow_up_failed", {
      ...refs,
      detail: {
        error: err instanceof Error ? err.message : String(err),
        findings,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function findingLine(finding: {
  readonly severity?: string;
  readonly file?: string;
  readonly note?: string;
}): string {
  const file = finding.file ? ` \`${finding.file}\`` : "";
  return `- **${finding.severity ?? "note"}**${file}: ${finding.note ?? ""}`;
}

/**
 * A rejection's findings as the implementer reads them: what holds the change
 * back, what is tracked, what is optional. Null when the evidence carries no
 * findings to render.
 */
export function formatRejectionForRepair(evidenceJson: string): string | null {
  const evidence = parseEvidence(evidenceJson);
  if (!evidence) return null;
  const minors = (evidence.findings ?? []).filter(
    (finding) => finding.severity === "minor",
  );
  if (!evidence.open_findings) {
    const findings = evidence.findings ?? [];
    return findings.length === 0 ? null : findings.map(findingLine).join("\n");
  }
  const blocking = evidence.open_findings.filter((f) => f.blocking);
  const tracked = evidence.open_findings.filter((f) => !f.blocking);
  const sections: string[] = [];
  if (blocking.length > 0) {
    sections.push(
      "Blocking - the next review holds the change back until each is fixed:",
      ...blocking.map(findingLine),
    );
  }
  if (tracked.length > 0) {
    sections.push(
      "Tracked, not blocking - fix them when they are in reach; whatever still holds at approval becomes a follow-up task:",
      ...tracked.map(findingLine),
    );
  }
  if (minors.length > 0) {
    sections.push("Minor - optional:", ...minors.map(findingLine));
  }
  return sections.length === 0 ? null : sections.join("\n");
}

/** The review packet's section for its round. */
export function reviewRoundSection(round: CodeReviewRoundV1): string {
  const lines = [`## Review round ${round.round}`];
  if (round.open_findings.length === 0) {
    lines.push("The previous review left no finding open.");
  } else {
    lines.push(
      "Findings the previous review left open. Verify each against the current head and give every number a status in previous_findings (resolved or open):",
      ...round.open_findings.map(
        (finding, i) =>
          `${i + 1}. [${finding.severity}${finding.blocking ? "" : ", not blocking"}]${finding.file ? ` \`${finding.file}\`` : ""}: ${finding.note} (raised in review ${finding.since_round})`,
      ),
    );
  }
  lines.push(
    round.majors_block
      ? "A new major can still hold this change back: request_changes needs a blocker, a major, or a blocking finding above that still holds."
      : "New majors no longer hold this change back: request_changes needs a blocker or a blocking finding above that still holds. Approve with new majors listed; colonyd files them as a follow-up task.",
  );
  return lines.join("\n");
}
