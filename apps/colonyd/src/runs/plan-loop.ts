import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type ArchitectDecompositionV2,
  ArchitectDecompositionV2 as architectDecompositionV2Schema,
  StoredPlanReviewVerdictV1,
} from "@colony/schemas";
import type { AuditRow, Project, ProjectFile, Run, Scope } from "@colony/core";
import { formatPlanReviewFeedback } from "@colony/agent-runtime";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";

/**
 * The plan loop's policy: which review a plan revises, what counts against the
 * loop's budget, and when a rejected plan goes back to the architect versus
 * when the scope stops and asks the operator.
 *
 * The loop stops for the operator in three cases, all worded so the escape
 * endpoints and the console recognise them (PLAN_REVIEW_BLOCK_REASON):
 *   operator  the latest review filed a blocker only the operator can settle
 *   stalled   the same task was blocked in each of the last few reviews, or
 *             the blocker count did not fall across them
 *   cap       the hard ceiling on rejections
 * A stall is the usual stop: a loop that keeps finding new blockers for the
 * same work is not converging, and more rounds only burn review time
 * (col-d6ca6aa2: 45 rejections before its first approval, flat blocker counts).
 */

/** Hard ceiling on rejections in one budget epoch. The stall rule usually stops the loop first. */
export const MAX_PLAN_REVIEW_ROUNDS = 20;

/** Rejections the stall rule looks back over. */
export const PLAN_REVIEW_STALL_WINDOW = 4;

/** Rejections kept as history for the architect, beyond the latest one. */
const REVISION_HISTORY_LIMIT = 6;

/** Actions after which earlier rejections stop counting against the budget. */
export const BUDGET_EPOCH_ACTIONS: Record<string, true> = {
  "scope.plan_review_continued": true,
  "scope.plan_review_replanned": true,
  "scope.unblocked": true,
};

export type PlanReviewBlockKind = "operator" | "stalled" | "cap";

export const PLAN_REVIEW_BLOCK_REASON =
  /^plan review (?:rejected (\d+) consecutive times$|stalled after (\d+) rejections?:|needs an operator decision after (\d+) rejections?:)/;

/** The loop block a scope's blocked_reason records, or null for any other block. */
export function parsePlanReviewBlockReason(
  reason: string | null,
): { readonly kind: PlanReviewBlockKind; readonly rejections: number } | null {
  const match = reason?.match(PLAN_REVIEW_BLOCK_REASON);
  if (!match) return null;
  if (match[1] !== undefined)
    return { kind: "cap", rejections: Number(match[1]) };
  if (match[2] !== undefined) {
    return { kind: "stalled", rejections: Number(match[2]) };
  }
  return { kind: "operator", rejections: Number(match[3]) };
}

export function planHash(planJson: string): string {
  return createHash("sha256").update(planJson).digest("hex");
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// Goal inputs: what the operator told Colony the goal is.
// ---------------------------------------------------------------------------

const GOAL_INPUT_LABELS = {
  scope_goal: "scope goal",
  directives: "operator planning directives",
  project_context: "project background",
  project_files: "project reference files",
} as const;

const GOAL_INPUT_KEYS = [
  "scope_goal",
  "directives",
  "project_context",
  "project_files",
] as const;

const GoalInputs = z.object({
  scope_goal: z.string(),
  directives: z.string(),
  project_context: z.string(),
  project_files: z.string(),
});
export type GoalInputs = z.infer<typeof GoalInputs>;

/**
 * Content fingerprints of the goal inputs a plan and its review read. A
 * rejection recorded under different inputs judged a different goal: it does
 * not count against the budget, and the architect is told what changed.
 */
export function goalInputs(
  scope: Pick<Scope, "goal" | "plan_directives">,
  project: Pick<Project, "context_doc"> | null,
  files: readonly Pick<ProjectFile, "filename" | "content">[],
): GoalInputs {
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex").slice(0, 16);
  const sortedFiles = [...files].sort((a, b) =>
    a.filename.localeCompare(b.filename),
  );
  return {
    scope_goal: digest(scope.goal),
    directives: digest(scope.plan_directives),
    project_context: digest(project?.context_doc ?? ""),
    project_files: digest(
      sortedFiles
        .map((file) => `${file.filename}\0${file.content}`)
        .join("\0\0"),
    ),
  };
}

export function currentGoalInputs(
  ctx: ColonydContext,
  scope: Scope,
): GoalInputs {
  const project = scope.project_name
    ? (ctx.store.getProject(scope.project_name) ?? null)
    : null;
  const files = scope.project_name
    ? ctx.store.listProjectFiles(scope.project_name)
    : [];
  return goalInputs(scope, project, files);
}

/** Labels of the inputs that differ. Unknown (legacy) inputs compare equal. */
export function changedGoalInputs(
  before: GoalInputs | null,
  after: GoalInputs,
): string[] {
  if (!before) return [];
  return GOAL_INPUT_KEYS.filter((key) => before[key] !== after[key]).map(
    (key) => GOAL_INPUT_LABELS[key],
  );
}

// ---------------------------------------------------------------------------
// Stored runs
// ---------------------------------------------------------------------------

const PlanReviewEvidence = z.object({
  round: z.number(),
  plan_hash: z.string(),
  goal_inputs: GoalInputs.optional(),
});

const ArchitectEvidence = z.object({
  revision_of_review: z.string().nullable().optional(),
});

/** A succeeded plan review as stored: its verdict and the plan it judged. */
export interface PlanReviewRecord {
  readonly run: Run;
  readonly verdict: StoredPlanReviewVerdictV1;
  readonly round: number;
  readonly planHash: string;
  readonly goalInputs: GoalInputs | null;
}

export function readPlanReview(run: Run): PlanReviewRecord | null {
  if (
    run.kind !== "plan_review" ||
    run.status !== "succeeded" ||
    !run.envelope_json ||
    !run.evidence_json
  ) {
    return null;
  }
  try {
    const evidence = PlanReviewEvidence.safeParse(
      JSON.parse(run.evidence_json),
    );
    const verdict = StoredPlanReviewVerdictV1.safeParse(
      JSON.parse(run.envelope_json),
    );
    if (!evidence.success || !verdict.success) return null;
    return {
      run,
      verdict: verdict.data,
      round: evidence.data.round,
      planHash: evidence.data.plan_hash,
      goalInputs: evidence.data.goal_inputs ?? null,
    };
  } catch {
    // An unreadable row is no verdict.
    return null;
  }
}

export function readArchitectPlan(run: Run): ArchitectDecompositionV2 | null {
  if (
    run.kind !== "architect" ||
    run.status !== "succeeded" ||
    !run.envelope_json
  ) {
    return null;
  }
  try {
    const parsed = architectDecompositionV2Schema.safeParse(
      JSON.parse(run.envelope_json),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The review an architect run revised, as it recorded on success. */
export function revisedReviewRunId(run: Run): string | null {
  if (run.kind !== "architect" || !run.evidence_json) return null;
  try {
    const evidence = ArchitectEvidence.safeParse(JSON.parse(run.evidence_json));
    return evidence.success ? (evidence.data.revision_of_review ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * The architect run that proposed the plan a review judged: the nearest
 * earlier succeeded architect run whose plan has the reviewed content hash.
 * `notBefore` excludes runs started before a planning-epoch marker.
 */
export function proposingArchitectRun(
  runs: readonly Run[],
  reviewIndex: number,
  reviewedPlanHash: string,
  notBefore?: string,
): { readonly run: Run; readonly plan: ArchitectDecompositionV2 } | null {
  for (let index = reviewIndex - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (run.kind !== "architect" || run.status !== "succeeded") continue;
    if (!run.envelope_json || planHash(run.envelope_json) !== reviewedPlanHash)
      continue;
    if (notBefore !== undefined && run.started_at < notBefore) continue;
    const plan = readArchitectPlan(run);
    if (plan) return { run, plan };
  }
  return null;
}

/**
 * The verdict recorded for exactly this plan: same content (hash) and
 * reviewed after the architect run that proposed it. "After" is the store's
 * run order, not a timestamp: millisecond ties between a review and the next
 * architect run made time-keyed lookups both miss a fresh verdict and
 * inherit a stale one. Keying on content alone would let an architect that
 * resubmits an identical rejected plan inherit the old verdict and never be
 * reviewed - or re-dispatched - again.
 */
export function latestPlanReview(
  ctx: ColonydContext,
  scopeId: string,
  planJson: string,
  proposedByRunId: string,
): PlanReviewRecord | null {
  const hash = planHash(planJson);
  const runs = ctx.store.runsForScope(scopeId);
  const proposedAt = runs.findIndex((run) => run.id === proposedByRunId);
  for (const run of runs.slice(proposedAt + 1).reverse()) {
    const review = readPlanReview(run);
    if (review && review.planHash === hash) return review;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audit epochs
// ---------------------------------------------------------------------------

/**
 * A scope's audit rows newer than the latest row whose action `isMarker`
 * accepts, oldest first, walking pages back until that marker. No marker
 * means the whole history (a legacy scope, col-1e4f99fd).
 */
export function auditSinceMarker(
  ctx: ColonydContext,
  scopeId: string,
  isMarker: (action: string) => boolean,
): { readonly marker: AuditRow | undefined; readonly rows: AuditRow[] } {
  const newestFirst: AuditRow[] = [];
  let beforeId: number | undefined;
  for (;;) {
    const page = ctx.store.listAudit({
      scope_id: scopeId,
      limit: 1000,
      ...(beforeId === undefined ? {} : { before_id: beforeId }),
    });
    for (let index = page.events.length - 1; index >= 0; index -= 1) {
      const row = page.events[index]!;
      if (isMarker(row.action)) {
        return { marker: row, rows: newestFirst.reverse() };
      }
      newestFirst.push(row);
    }
    if (!page.has_more || page.oldest_id === null) {
      return { marker: undefined, rows: newestFirst.reverse() };
    }
    beforeId = page.oldest_id;
  }
}

// ---------------------------------------------------------------------------
// Budget and decision
// ---------------------------------------------------------------------------

/** One rejection, reduced to what the loop decision reads. */
export interface PlanRejection {
  readonly runId: string;
  readonly round: number;
  readonly blockers: number;
  readonly blockedTasks: readonly number[];
  readonly operatorNotes: readonly string[];
}

function rejectionOf(review: PlanReviewRecord): PlanRejection {
  const blockers = review.verdict.findings.filter(
    (finding) => finding.severity === "blocker",
  );
  return {
    runId: review.run.id,
    round: review.round,
    blockers: blockers.length,
    blockedTasks: [
      ...new Set(
        blockers.flatMap((finding) =>
          finding.task === undefined ? [] : [finding.task],
        ),
      ),
    ],
    operatorNotes: blockers
      .filter((finding) => finding.owner === "operator")
      .map((finding) => finding.note),
  };
}

/**
 * Rejections that count against the loop's budget, oldest first: those after
 * the latest operator reset (continue, replan, unblock) and recorded under
 * the current goal inputs.
 */
export function budgetRejections(
  ctx: ColonydContext,
  scope: Scope,
): PlanRejection[] {
  const { rows } = auditSinceMarker(
    ctx,
    scope.id,
    (action) => BUDGET_EPOCH_ACTIONS[action] === true,
  );
  const current = currentGoalInputs(ctx, scope);
  const rejections: PlanRejection[] = [];
  for (const row of rows) {
    if (row.action !== "scope.plan_rejected" || !row.run_id) continue;
    const run = ctx.store.getRun(row.run_id);
    const review = run ? readPlanReview(run) : null;
    if (!review) continue;
    if (changedGoalInputs(review.goalInputs, current).length > 0) continue;
    rejections.push(rejectionOf(review));
  }
  return rejections;
}

export type PlanLoopDecision =
  | { readonly action: "revise" }
  | {
      readonly action: "block";
      readonly kind: PlanReviewBlockKind;
      readonly reason: string;
    };

/**
 * Send the latest rejection back to the architect, or stop for the operator.
 * `taskTitle` names a stuck task in the reason.
 */
export function decidePlanLoop(
  rejections: readonly PlanRejection[],
  taskTitle: (task: number) => string | undefined = () => undefined,
): PlanLoopDecision {
  const latest = rejections.at(-1);
  if (!latest) return { action: "revise" };
  const count = rejections.length;
  const after = `after ${count} rejection${count === 1 ? "" : "s"}`;
  if (latest.operatorNotes.length > 0) {
    const more =
      latest.operatorNotes.length > 1
        ? ` (+${latest.operatorNotes.length - 1} more)`
        : "";
    return {
      action: "block",
      kind: "operator",
      reason: `plan review needs an operator decision ${after}: ${excerpt(latest.operatorNotes[0]!, 240)}${more}`,
    };
  }
  if (count >= MAX_PLAN_REVIEW_ROUNDS) {
    return {
      action: "block",
      kind: "cap",
      reason: `plan review rejected ${count} consecutive times`,
    };
  }
  if (count < PLAN_REVIEW_STALL_WINDOW) return { action: "revise" };
  const window = rejections.slice(-PLAN_REVIEW_STALL_WINDOW);
  const stuck = window[0]!.blockedTasks.find((task) =>
    window.every((rejection) => rejection.blockedTasks.includes(task)),
  );
  if (stuck !== undefined) {
    const title = taskTitle(stuck);
    return {
      action: "block",
      kind: "stalled",
      reason: `plan review stalled ${after}: task ${stuck}${title ? ` (${excerpt(title, 80)})` : ""} has had a blocker in each of the last ${PLAN_REVIEW_STALL_WINDOW} reviews`,
    };
  }
  const blockerCounts = window.map((rejection) => rejection.blockers);
  if (blockerCounts.at(-1)! >= blockerCounts[0]!) {
    return {
      action: "block",
      kind: "stalled",
      reason: `plan review stalled ${after}: blockers did not fall over the last ${PLAN_REVIEW_STALL_WINDOW} reviews (${blockerCounts.join(", ")})`,
    };
  }
  return { action: "revise" };
}

/**
 * Act on a rejected plan still in place while the scope plans: block with it
 * held for the operator, or send it back to the architect with the findings.
 * Returns what it did, so the caller can dispatch the revision at once.
 */
export function advanceRejectedPlan(
  ctx: ColonydContext,
  scope: Scope,
  plan: ArchitectDecompositionV2,
  review: PlanReviewRecord,
): PlanLoopDecision["action"] {
  const rejections = budgetRejections(ctx, scope);
  const decision = decidePlanLoop(
    rejections,
    (task) => plan.tasks[task]?.title,
  );
  if (decision.action === "block") {
    ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
      blocked_reason: decision.reason,
      plan_review_block: decision.kind,
      rejections: rejections.length,
    });
    return "block";
  }
  ctx.store.requestReviewReplan(
    scope.id,
    formatPlanReviewFeedback(review.verdict, review.round),
  );
  return "revise";
}

// ---------------------------------------------------------------------------
// Revision material: the previous review for the reviewer, history for the
// architect.
// ---------------------------------------------------------------------------

/** Task-level differences between a rejected plan and its revision. */
export interface PlanChanges {
  readonly tasks: readonly {
    readonly index: number;
    readonly title: string;
    readonly change: "unchanged" | "changed" | "new";
    readonly fields: readonly string[];
  }[];
  readonly removed: readonly string[];
  /** Plan-level fields that changed. */
  readonly plan: readonly string[];
}

export function diffPlans(
  before: ArchitectDecompositionV2,
  after: ArchitectDecompositionV2,
): PlanChanges {
  const priorByTitle = new Map(
    before.tasks.map((task) => [task.title, task] as const),
  );
  const dependencyTitles = (
    plan: ArchitectDecompositionV2,
    dependsOn: readonly number[],
  ) =>
    dependsOn
      .map((index) => plan.tasks[index]?.title ?? `#${index}`)
      .sort()
      .join("\0");
  const tasks = after.tasks.map((task, index) => {
    const prior = priorByTitle.get(task.title);
    if (!prior) {
      return { index, title: task.title, change: "new" as const, fields: [] };
    }
    const fields: string[] = [];
    if (prior.spec !== task.spec) fields.push("spec");
    if (JSON.stringify(prior.files) !== JSON.stringify(task.files))
      fields.push("files");
    if (JSON.stringify(prior.evidence) !== JSON.stringify(task.evidence))
      fields.push("evidence");
    if (
      dependencyTitles(before, prior.depends_on) !==
      dependencyTitles(after, task.depends_on)
    )
      fields.push("depends_on");
    return {
      index,
      title: task.title,
      change: fields.length > 0 ? ("changed" as const) : ("unchanged" as const),
      fields,
    };
  });
  const currentTitles = new Set(after.tasks.map((task) => task.title));
  const planFields = [
    "summary",
    "requirements",
    "journey",
    "acceptance",
    "operator_decisions",
  ] as const;
  return {
    tasks,
    removed: before.tasks
      .map((task) => task.title)
      .filter((title) => !currentTitles.has(title)),
    plan: planFields.filter(
      (field) =>
        JSON.stringify(before[field] ?? null) !==
        JSON.stringify(after[field] ?? null),
    ),
  };
}

/** The rejection a plan revised, and the plan that rejection judged. */
export interface PreviousPlanReview {
  readonly review: PlanReviewRecord;
  readonly changes: PlanChanges | null;
}

/**
 * The review the proposing architect run revised, with the task-level
 * changes since. Null for a first plan, an operator-directed replan, or an
 * architect run that predates the record.
 */
export function previousPlanReview(
  ctx: ColonydContext,
  scopeId: string,
  proposedByRunId: string,
  plan: ArchitectDecompositionV2,
): PreviousPlanReview | null {
  const proposer = ctx.store.getRun(proposedByRunId);
  const reviewRunId = proposer ? revisedReviewRunId(proposer) : null;
  if (!reviewRunId) return null;
  const runs = ctx.store.runsForScope(scopeId);
  const reviewIndex = runs.findIndex((run) => run.id === reviewRunId);
  const review = reviewIndex >= 0 ? readPlanReview(runs[reviewIndex]!) : null;
  if (!review || review.verdict.verdict !== "request_changes") return null;
  const rejected = proposingArchitectRun(runs, reviewIndex, review.planHash);
  return {
    review,
    changes: rejected ? diffPlans(rejected.plan, plan) : null,
  };
}

/** One earlier rejection as the architect's revision history carries it. */
export interface RevisionHistoryEntry {
  readonly at: string;
  readonly round: number;
  readonly findings: readonly {
    readonly severity: "blocker" | "major" | "minor";
    readonly task?: number;
    readonly owner?: "architect" | "operator";
    readonly note: string;
  }[];
}

/**
 * Earlier rejections among `rejectionRows` (oldest first), excluding the
 * latest one, bounded to the most recent few. Notes are excerpted: the
 * history reminds the architect what was already rejected; the latest review
 * carries the full text.
 */
export function revisionHistory(
  ctx: ColonydContext,
  rejectionRows: readonly AuditRow[],
): RevisionHistoryEntry[] {
  const earlier = rejectionRows.slice(0, -1).slice(-REVISION_HISTORY_LIMIT);
  const history: RevisionHistoryEntry[] = [];
  for (const row of earlier) {
    const run = row.run_id ? ctx.store.getRun(row.run_id) : undefined;
    const review = run ? readPlanReview(run) : null;
    if (!review) continue;
    history.push({
      at: review.run.started_at,
      round: review.round,
      findings: review.verdict.findings.map((finding) => ({
        severity: finding.severity,
        ...(finding.task === undefined ? {} : { task: finding.task }),
        ...(finding.owner === undefined ? {} : { owner: finding.owner }),
        note: excerpt(finding.note, 500),
      })),
    });
  }
  return history;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/**
 * The approved plan with the reviewer's non-blocking findings attached to
 * the task specs they name. Plan-wide findings (no or an unknown task index)
 * go to every task: implementers and code reviewers read the spec, so a note
 * anywhere else is lost.
 */
export function withReviewNotes(
  plan: ArchitectDecompositionV2,
  verdict: StoredPlanReviewVerdictV1,
  round: number,
): ArchitectDecompositionV2 {
  const notes = verdict.findings.filter(
    (finding) => finding.severity !== "blocker",
  );
  if (notes.length === 0) return plan;
  return {
    ...plan,
    tasks: plan.tasks.map((task, index) => {
      const own = notes.filter(
        (finding) =>
          finding.task === undefined ||
          finding.task === index ||
          finding.task >= plan.tasks.length,
      );
      if (own.length === 0) return task;
      return {
        ...task,
        spec: [
          task.spec.trimEnd(),
          "",
          `## Plan review notes (round ${round}, non-blocking)`,
          ...own.map((finding) => `- [${finding.severity}] ${finding.note}`),
        ].join("\n"),
      };
    }),
  };
}

/**
 * The plan to materialize on an operator approval: with the approving
 * review's notes when a reviewer approved exactly this plan.
 */
export function withApprovedReviewNotes(
  ctx: ColonydContext,
  scope: Scope,
  plan: ArchitectDecompositionV2,
): ArchitectDecompositionV2 {
  if (!scope.plan_json) return plan;
  const proposer = ctx.store
    .runsForScope(scope.id)
    .filter((run) => run.kind === "architect" && run.status === "succeeded")
    .at(-1);
  const review = proposer
    ? latestPlanReview(ctx, scope.id, scope.plan_json, proposer.id)
    : null;
  return review?.verdict.verdict === "approve"
    ? withReviewNotes(plan, review.verdict, review.round)
    : plan;
}
