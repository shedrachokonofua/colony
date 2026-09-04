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

export const ReviewerVerdictV2 = z
  .object({
    kind: z.literal("reviewer_verdict"),
    verdict: z.enum(["approve", "request_changes"]),
    summary: z.string().min(1),
    findings: z
      .array(
        z.object({
          severity: z.enum(["blocker", "major", "minor"]),
          file: z.string().min(1).optional(),
          note: z.string().min(1),
        }),
      )
      .default([]),
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
    // the SHA the reviewer actually inspected; colonyd rejects a mismatch
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict()
  .refine((v) => v.verdict !== "request_changes" || v.findings.length > 0, {
    message: "request_changes requires at least one finding",
  })
  .refine((v) => v.verdict !== "approve" || v.inspected.length > 0, {
    message:
      "approve requires at least one inspected file with a note on what was checked",
  })
  .refine((v) => v.verdict !== "approve" || v.summary.trim().length >= 80, {
    message:
      "approve requires a substantive summary (>= 80 chars): what the change does and why it satisfies the spec",
  });

export type ReviewerVerdictV2 = z.infer<typeof ReviewerVerdictV2>;

/**
 * A reviewer's verdict on a proposed plan. Same loop as code review: findings
 * name the task, approve names what was inspected.
 */
export const PlanReviewVerdictV1 = z
  .object({
    kind: z.literal("plan_review_verdict"),
    verdict: z.enum(["approve", "request_changes"]),
    summary: z.string().min(1),
    findings: z
      .array(
        z.object({
          severity: z.enum(["blocker", "major", "minor"]),
          /** Index into the plan's tasks; absent for plan-wide findings. */
          task: z.number().int().nonnegative().optional(),
          note: z.string().min(1),
        }),
      )
      .default([]),
    /** What the reviewer read against the plan: files, and what was checked. */
    inspected: z
      .array(z.object({ file: z.string().min(1), note: z.string().min(1) }))
      .default([]),
  })
  .strict()
  .refine((v) => v.verdict !== "request_changes" || v.findings.length > 0, {
    message: "request_changes requires at least one finding",
  })
  .refine((v) => v.verdict !== "approve" || v.inspected.length > 0, {
    message:
      "approve requires at least one inspected file with a note on what was checked",
  })
  .refine((v) => v.verdict !== "approve" || v.summary.trim().length >= 80, {
    message:
      "approve requires a substantive summary (>= 80 chars): why this plan delivers the goal end to end",
  });

export type PlanReviewVerdictV1 = z.infer<typeof PlanReviewVerdictV1>;
