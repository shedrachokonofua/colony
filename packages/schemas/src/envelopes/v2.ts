import { z } from "zod";

const architectTask = z.object({
  title: z.string().min(1),
  /** Outcome-oriented markdown: goal, user-observable behavior, invariants. */
  spec: z.string().min(1),
  /** Indexes into the same tasks array; must be acyclic. */
  depends_on: z.array(z.number().int().nonnegative()).default([]),
  /** Files this task creates or changes. What grounds the size gate and the review. */
  files: z.array(z.string().min(1)).min(1).max(40),
  /** Exact commands whose success proves this task is done, runnable on its branch. */
  evidence: z.array(z.string().min(1)).min(1).max(10),
});

/**
 * Shared shape of the draft (plan stage) and final (verify stage) plan. The
 * draft is what the architect believes; the final is what it verified.
 */
const architectPlanFields = {
  summary: z.string().min(1),
  /** Every requirement from the survey, mapped to the tasks that deliver it. */
  requirements: z
    .array(
      z.object({
        id: z.string().regex(/^R\d+$/),
        text: z.string().min(1),
        tasks: z.array(z.number().int().nonnegative()).min(1),
      }),
    )
    .min(1)
    .max(40),
  /** The end-to-end journey: what works after each step lands, in order. */
  journey: z
    .array(
      z.object({
        after_task: z.number().int().nonnegative(),
        working_state: z.string().min(1),
      }),
    )
    .min(1)
    .max(20),
  acceptance: z
    .array(
      z
        .object({
          description: z.string().min(1),
          command: z.string().min(1),
        })
        .strict(),
    )
    .min(1),
  tasks: z.array(architectTask).min(1).max(20),
  /**
   * Decisions only the operator can make, raised instead of worked around: a
   * requirement that needs something outside this repository, or goal
   * sources in conflict with nothing deciding which wins. Each names the
   * conflict, the options, and the reading the plan assumed.
   */
  operator_decisions: z.array(z.string().min(1)).max(5).optional(),
};

function planRefinements<T extends z.infer<typeof ArchitectDecompositionV2>>(
  plan: T,
  ctx: z.RefinementCtx,
): void {
  const n = plan.tasks.length;
  const bad = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  plan.tasks.forEach((task, i) => {
    for (const dep of task.depends_on) {
      if (dep >= n)
        bad(
          ["tasks", i, "depends_on"],
          `depends_on ${dep} is not a task index (${n} tasks)`,
        );
      if (dep === i)
        bad(["tasks", i, "depends_on"], "a task cannot depend on itself");
    }
  });
  const covered = new Set<number>();
  plan.requirements.forEach((req, i) => {
    for (const t of req.tasks) {
      if (t >= n)
        bad(
          ["requirements", i, "tasks"],
          `${req.id} maps to task ${t}, which does not exist`,
        );
      covered.add(t);
    }
  });
  plan.tasks.forEach((_, i) => {
    if (!covered.has(i))
      bad(
        ["tasks", i],
        `task ${i} delivers no requirement - drop it or map a requirement to it`,
      );
  });
  plan.journey.forEach((step, i) => {
    if (step.after_task >= n)
      bad(
        ["journey", i, "after_task"],
        `journey step references task ${step.after_task}, which does not exist`,
      );
  });
  const last = plan.journey.at(-1);
  if (
    last &&
    !plan.journey.some((step) => step.after_task === n - 1) &&
    n > 0
  ) {
    // The journey must reach the end: the final working state is the goal.
    const maxRef = Math.max(...plan.journey.map((step) => step.after_task));
    if (maxRef !== n - 1)
      bad(
        ["journey"],
        "the journey must end at the last task: the final working state is the delivered goal",
      );
  }
}

export const ArchitectDecompositionV2 = z
  .object({
    kind: z.literal("architect_decomposition"),
    ...architectPlanFields,
  })
  .strict()
  .superRefine(planRefinements);

export type ArchitectDecompositionV2 = z.infer<typeof ArchitectDecompositionV2>;

export const ImplementerCompletionV2 = z
  .object({
    kind: z.literal("implementer_completion"),
    status: z.enum(["complete", "blocked"]),
    summary: z.string().min(1),
    branch: z.string().min(1),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    commands: z
      .array(z.object({ cmd: z.string(), exit_code: z.number().int() }))
      .default([]),
    blocked_reason: z.string().optional(),
  })
  .strict();

export type ImplementerCompletionV2 = z.infer<typeof ImplementerCompletionV2>;

/**
 * One code review finding. `owner` says who must act: the implementer (the
 * default) changes the code; the operator must decide what no change in the
 * repository can settle - a capability outside it, or a spec that
 * contradicts a repository guarantee.
 */
const reviewFinding = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  file: z.string().min(1).optional(),
  note: z.string().min(1),
  owner: z.enum(["implementer", "operator"]).optional(),
});

/** A finding of the previous review, by its 1-based number, and whether it still holds. */
const previousFindingStatus = z
  .object({
    finding: z.number().int().positive(),
    status: z.enum(["resolved", "open"]),
  })
  .strict();

export type PreviousFindingStatus = z.infer<typeof previousFindingStatus>;

export const ReviewerVerdictV2 = z
  .object({
    kind: z.literal("reviewer_verdict"),
    verdict: z.enum(["approve", "request_changes"]),
    summary: z.string().min(1),
    findings: z.array(reviewFinding).default([]),
    /**
     * The status of each finding the previous review left open, when the
     * review packet carries them (CodeReviewRoundV1.open_findings).
     */
    previous_findings: z.array(previousFindingStatus).optional(),
    // What the reviewer actually read against the spec. An approve is a
    // claim about the diff; it must name the files behind it. 123 of 123
    // approvals in one 48h window carried zero findings and a summary under
    // 80 chars (2026-09-02) - the schema permitted "LGTM".
    inspected: z
      .array(
        z.object({
          file: z.string().min(1),
          note: z.string().min(1),
        }),
      )
      .default([]),
    // Auditable review coverage: which review dimensions were exercised and
    // whether at least one was judged without the task spec in view. The
    // fallback approve below carries a single entry; human/model verdicts
    // carry 2..6. The schema admits 1..6 so the fallback parses; the lower
    // bound for real reviews is doctrine, enforced by the reviewer prompt.
    dimensions: z
      .array(
        z
          .object({
            name: z.string().min(1),
            spec_blind: z.boolean(),
            target_files: z.array(z.string().min(1)),
            findings: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    // How many candidate findings the reviewer challenged before submitting:
    // reviewed must cover every submitted finding.
    challenged: z
      .object({
        reviewed: z.number().int().nonnegative(),
        dropped: z.number().int().nonnegative(),
      })
      .strict(),
    // the SHA the reviewer actually inspected; colonyd rejects a mismatch
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict()
  .refine(
    (v) =>
      v.verdict !== "request_changes" ||
      v.findings.length > 0 ||
      (v.previous_findings ?? []).some((p) => p.status === "open"),
    {
      message:
        "request_changes requires at least one finding or a previous finding still open",
    },
  )
  .refine((v) => v.verdict !== "approve" || v.inspected.length > 0, {
    message:
      "approve requires at least one inspected file with a note on what was checked",
  })
  .refine((v) => v.verdict !== "approve" || v.summary.trim().length >= 80, {
    message:
      "approve requires a substantive summary (>= 80 chars): what the change does and why it satisfies the spec",
  })
  .refine(
    (v) =>
      v.verdict !== "approve" && v.verdict !== "request_changes"
        ? true
        : v.dimensions.some((d) => d.spec_blind),
    {
      message: "verdict requires at least one spec_blind review dimension",
    },
  )
  .refine(
    (v) =>
      v.verdict !== "approve" && v.verdict !== "request_changes"
        ? true
        : v.challenged.reviewed >= v.findings.length,
    {
      message: "challenged.reviewed must cover every submitted finding",
    },
  )
  .refine(
    (v) =>
      v.verdict !== "approve" ||
      v.findings.every((f) => f.severity !== "blocker"),
    {
      message:
        "approve cannot carry a blocker finding; request_changes instead",
    },
  )
  .refine(
    (v) =>
      v.findings.every(
        (f) => f.owner !== "operator" || f.severity === "blocker",
      ),
    { message: "an operator-owned finding must be a blocker" },
  );

export type ReviewerVerdictV2 = z.infer<typeof ReviewerVerdictV2>;

/**
 * A finding a code review left open, as the loop carries it into the next
 * review: numbered by position (from 1), with the review round that first
 * raised it and whether it still blocks approval. Majors raised once the
 * early rounds are over are tracked, not blocking: on approval they become
 * a follow-up task.
 */
export const OpenReviewFindingV1 = z
  .object({
    severity: z.enum(["blocker", "major"]),
    file: z.string().min(1).optional(),
    note: z.string().min(1),
    blocking: z.boolean(),
    since_round: z.number().int().positive(),
  })
  .strict();

export type OpenReviewFindingV1 = z.infer<typeof OpenReviewFindingV1>;

/**
 * What one code review round must account for. colonyd derives it from the
 * task's review history; the review packet carries it as `review_round`.
 */
export const CodeReviewRoundV1 = z
  .object({
    /** 1-based count of this task's reviews, this one included. */
    round: z.number().int().positive(),
    /** Whether a new major can hold the change back this round. */
    majors_block: z.boolean(),
    open_findings: z.array(OpenReviewFindingV1),
  })
  .strict();

export type CodeReviewRoundV1 = z.infer<typeof CodeReviewRoundV1>;

/**
 * Where `statuses` fails to give each of `count` previous findings exactly
 * one status. Empty when it does, or when there is nothing to account for.
 */
export function previousFindingsProblems(
  statuses: readonly PreviousFindingStatus[] | undefined,
  count: number,
): string[] {
  if (count === 0) return [];
  const counts = new Map<number, number>();
  for (const entry of statuses ?? []) {
    counts.set(entry.finding, (counts.get(entry.finding) ?? 0) + 1);
  }
  const problems: string[] = [];
  const missing: number[] = [];
  for (let finding = 1; finding <= count; finding += 1) {
    if (!counts.has(finding)) missing.push(finding);
  }
  if (missing.length > 0) {
    problems.push(`no status for previous finding ${missing.join(", ")}`);
  }
  const unknown = [...counts.keys()].filter((n) => n > count);
  if (unknown.length > 0) {
    problems.push(
      `there are ${count} previous findings; there is no finding ${unknown.join(", ")}`,
    );
  }
  const repeated = [...counts].filter(([, n]) => n > 1).map(([f]) => f);
  if (repeated.length > 0) {
    problems.push(
      `more than one status for previous finding ${repeated.join(", ")}`,
    );
  }
  return problems;
}

/**
 * Where a schema-valid code review verdict breaks its round's rules; empty
 * when it complies. The rules make the loop converge on what it found:
 * - every finding the previous review left open gets exactly one status;
 * - request_changes rests on a blocker, a blocking open finding that is
 *   still open, or - while majors block - a new major;
 * - approve leaves no blocking finding open.
 */
export function codeReviewRoundProblems(
  verdict: ReviewerVerdictV2,
  round: CodeReviewRoundV1,
): string[] {
  const problems = previousFindingsProblems(
    verdict.previous_findings,
    round.open_findings.length,
  );
  if (problems.length > 0) return problems;
  const stillBlocking = (verdict.previous_findings ?? [])
    .filter(
      (entry) =>
        entry.status === "open" &&
        round.open_findings[entry.finding - 1]?.blocking === true,
    )
    .map((entry) => entry.finding)
    .sort((a, b) => a - b);
  if (verdict.verdict === "approve") {
    return stillBlocking.length > 0
      ? [
          `approve cannot leave blocking previous finding ${stillBlocking.join(", ")} open; request_changes instead`,
        ]
      : [];
  }
  const holds =
    stillBlocking.length > 0 ||
    verdict.findings.some(
      (f) =>
        f.severity === "blocker" ||
        (round.majors_block && f.severity === "major"),
    );
  if (holds) return [];
  return [
    round.majors_block
      ? "request_changes needs a blocker, a major, or a blocking previous finding still open; minors alone approve"
      : `request_changes needs a blocker or a blocking previous finding still open: from review round ${round.round} on, new majors do not hold the change back - approve and list them, and colonyd files them as a follow-up task`,
  ];
}

/**
 * One plan review finding. `owner` says who must act: the architect (the
 * default) revises the plan; the operator must decide what no plan can settle
 * from the repository - a capability outside it, or goal sources in conflict.
 */
const planReviewFinding = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  /** Index into the plan's tasks; absent for plan-wide findings. */
  task: z.number().int().nonnegative().optional(),
  note: z.string().min(1),
  owner: z.enum(["architect", "operator"]).optional(),
});

/**
 * The plan review verdict's shape without its submission rules. Stored
 * verdicts read through this, so a verdict recorded under older rules (a
 * rejection carrying majors only) still reads as what it was.
 */
export const StoredPlanReviewVerdictV1 = z
  .object({
    kind: z.literal("plan_review_verdict"),
    verdict: z.enum(["approve", "request_changes"]),
    summary: z.string().min(1),
    findings: z.array(planReviewFinding).default([]),
    /** What the reviewer read against the plan: files, and what was checked. */
    inspected: z
      .array(z.object({ file: z.string().min(1), note: z.string().min(1) }))
      .default([]),
    /**
     * The status of each finding of the previous review, by its 1-based
     * number, when this plan revises a rejected one.
     */
    previous_findings: z.array(previousFindingStatus).optional(),
  })
  .strict();

export type StoredPlanReviewVerdictV1 = z.infer<
  typeof StoredPlanReviewVerdictV1
>;

/**
 * A reviewer's verdict on a proposed plan. Same loop as code review: findings
 * name the task, approve names what was inspected. Severity decides the
 * verdict: a blocker sends the plan back; majors and minors ride into the
 * task specs of the approved plan.
 */
export const PlanReviewVerdictV1 = StoredPlanReviewVerdictV1.refine(
  (v) =>
    v.verdict !== "request_changes" ||
    v.findings.some((f) => f.severity === "blocker"),
  {
    message:
      "request_changes requires at least one blocker finding; majors and minors alone approve and ride into the task specs",
  },
)
  .refine(
    (v) =>
      v.verdict !== "approve" ||
      v.findings.every((f) => f.severity !== "blocker"),
    {
      message:
        "approve cannot carry a blocker finding; request_changes instead",
    },
  )
  .refine(
    (v) =>
      v.findings.every(
        (f) => f.owner !== "operator" || f.severity === "blocker",
      ),
    { message: "an operator-owned finding must be a blocker" },
  )
  .refine((v) => v.verdict !== "approve" || v.inspected.length > 0, {
    message:
      "approve requires at least one inspected file with a note on what was checked",
  })
  .refine((v) => v.verdict !== "approve" || v.summary.trim().length >= 80, {
    message:
      "approve requires a substantive summary (>= 80 chars): why this plan delivers the goal end to end",
  });

export type PlanReviewVerdictV1 = z.infer<typeof PlanReviewVerdictV1>;

/** Why a repair run was dispatched. Evidence entries are sanitized, bounded
 *  excerpts and identifiers — never raw logs. */
export const RepairIntentV1 = z
  .object({
    kind: z.enum(["ci_failure", "merge_conflict", "merge_gate_failure"]),
    source_head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    target_head_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    provider: z
      .object({
        pipeline_id: z.string().optional(),
        pipeline_url: z.string().optional(),
        job_ids: z.array(z.string()).optional(),
        job_names: z.array(z.string()).optional(),
        job_urls: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type RepairIntentV1 = z.infer<typeof RepairIntentV1>;
