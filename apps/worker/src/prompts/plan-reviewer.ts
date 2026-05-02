import type { DeveloperPlanEnvelope } from "@colony/schemas";

export interface PlanReviewPromptTask {
  readonly id: string;
  readonly scope_id: string;
  readonly title: string;
  readonly description: string;
  readonly acceptance_criteria: readonly string[];
  readonly non_goals: readonly string[];
}

export interface PlanReviewerPromptInput {
  readonly task: PlanReviewPromptTask;
  readonly developerPlan: DeveloperPlanEnvelope;
  readonly reviewCount: number;
  readonly loopCap: number;
}

export interface PlanReviewerPromptResult {
  readonly system: string;
  readonly user: string;
}

const SYSTEM_PROMPT_BASE = `You are Colony's Plan Reviewer agent.

You judge whether a developer's implementation plan is safe, scoped, and
testable before any code is written. You do not modify code. Your verdict
ends the loop via the terminal tool \`submit_plan_review\`.

# Hard rules

1. **Plan-only review.** Review the proposed approach, files, tests, and risks.
   Do not approve a plan that is too vague to verify later.
2. **The task packet bounds the plan.** The plan must satisfy the acceptance
   criteria, respect non-goals, and avoid unrelated files or broad refactors.
3. **Tests are part of the plan.** If behavior changes without a plausible
   verification path, request changes unless the task explicitly makes tests
   impossible.
4. **Result mapping.**
   - \`approved\`: the plan is specific, bounded, and reviewable. \`next_action\`:
     \`open_gate\`.
   - \`changes_requested\`: the plan needs revision before implementation.
     \`next_action\`: \`return_to_author\`.
   - \`blocked\`: external context is missing. \`next_action\`:
     \`report_blocked\`.
   - \`escalate\`: the plan needs a human reviewer. \`next_action\`:
     \`request_human_review\`.
5. **End the loop with the terminal tool.** Call \`submit_plan_review\` exactly
   once with arguments matching the plan_review envelope. No free-form final
   message.

# Envelope contract (terminal tool)

Required keys:
- \`version\`: 1
- \`result\`: see #4 above.
- \`confidence\`: 0..1 overall.
- \`requires_human\`: true when policy or your judgment requires it.
- \`risk_level\`: \`low\` | \`medium\` | \`high\` | \`critical\`.
- \`artifacts\`: normally empty for plan review.
- \`policy_flags\`: any policy concerns surfaced.
- \`next_action\`: see #4.
- \`freshness\`: ECHO from the developer_plan envelope verbatim.
- \`rationale\`: one or two sentences explaining the verdict.
- \`task_id\`: ECHO from the developer_plan envelope.
- \`role_specific.findings\`: material plan issues only.
- \`role_specific.summary\`: short verdict summary.`;

export function buildPlanReviewerSystemPrompt(): string {
  return SYSTEM_PROMPT_BASE;
}

export function buildPlanReviewerUserPrompt(
  input: PlanReviewerPromptInput,
): string {
  const sections: string[] = [];
  const { task, developerPlan } = input;

  sections.push(`# Plan review for task ${task.id}`);
  sections.push(task.title);

  if (task.description) {
    sections.push("## Description");
    sections.push(task.description);
  }

  sections.push("## Acceptance criteria");
  sections.push(
    task.acceptance_criteria.length > 0
      ? task.acceptance_criteria.map((c) => `- ${c}`).join("\n")
      : "- (none - see title/description)",
  );

  if (task.non_goals.length > 0) {
    sections.push("## Non-goals");
    sections.push(task.non_goals.map((c) => `- ${c}`).join("\n"));
  }

  sections.push("## Developer plan");
  sections.push(
    [
      `- result: ${developerPlan.result}`,
      `- next_action: ${developerPlan.next_action}`,
      `- risk_level: ${developerPlan.risk_level}`,
      `- confidence: ${developerPlan.confidence}`,
      `- rationale: ${developerPlan.rationale}`,
      `- approach: ${developerPlan.role_specific.approach}`,
      `- files_to_touch: ${developerPlan.role_specific.files_to_touch.join(", ") || "(none listed)"}`,
      `- tests_to_add: ${developerPlan.role_specific.tests_to_add.join(", ") || "(none listed)"}`,
      `- risks: ${developerPlan.role_specific.risks.join(", ") || "(none listed)"}`,
    ].join("\n"),
  );

  sections.push("## Review checklist");
  sections.push(
    [
      "- Is the plan specific enough for implementation and later code review?",
      "- Does the plan satisfy every acceptance criterion without violating non-goals?",
      "- Are listed files plausible and narrow for the task?",
      "- Is there a credible verification path?",
      "- Are risks surfaced accurately enough for the developer to handle?",
    ].join("\n"),
  );

  sections.push("## Loop budget");
  sections.push(
    [
      `- review_count: ${input.reviewCount}`,
      `- plan_review_loop_cap: ${input.loopCap}`,
    ].join("\n"),
  );

  sections.push("## Freshness (echo verbatim into the envelope)");
  sections.push(
    [
      `- task_graph_version: ${developerPlan.freshness.task_graph_version}`,
      `- provider_event_ts: ${developerPlan.freshness.provider_event_ts}`,
      `- commit_sha: ${developerPlan.freshness.commit_sha}`,
      `- policy_version: ${developerPlan.freshness.policy_version}`,
      `- memory_bundle_version: ${developerPlan.freshness.memory_bundle_version}`,
      `- packet_hash: ${developerPlan.freshness.packet_hash}`,
    ].join("\n"),
  );

  sections.push(
    "Review the plan, then call `submit_plan_review` exactly once with the envelope arguments.",
  );

  return sections.join("\n\n");
}

export function buildPlanReviewerPrompt(
  input: PlanReviewerPromptInput,
): PlanReviewerPromptResult {
  return {
    system: buildPlanReviewerSystemPrompt(),
    user: buildPlanReviewerUserPrompt(input),
  };
}
