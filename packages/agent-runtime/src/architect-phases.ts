import type { AgentRuntimePacket } from "./adapter.js";
import { buildPacketPrompt } from "./pi-runner-common.js";

/** The harness-owned architect pipeline, in execution order. */
export const ARCHITECT_PHASES = [
  "survey",
  "decompose",
  "deep_dive",
  "consolidate",
] as const;

export type ArchitectPhaseName = (typeof ARCHITECT_PHASES)[number];

export interface ArchitectPhase {
  readonly name: ArchitectPhaseName;
  readonly prompt: string;
  /**
   * Wall-clock budget for this phase. Enforced by the runner through
   * non-abortive nudges folded into tool results (aborting a live session
   * poisons the conversation): past the budget the model is told to close
   * the phase with what it has. Budgets sum below the architect run timeout
   * so every phase gets a turn - run 1 of the phased architect spent 44 of
   * 45 minutes in survey and starved the other three phases.
   */
  readonly budgetMs: number;
}

const MINUTE_MS = 60_000;

export const ARCHITECT_PHASE_BUDGETS_MS: Record<ArchitectPhaseName, number> = {
  survey: 10 * MINUTE_MS,
  decompose: 6 * MINUTE_MS,
  deep_dive: 15 * MINUTE_MS,
  consolidate: 8 * MINUTE_MS,
};

function budgetLine(name: ArchitectPhaseName): string {
  const minutes = Math.round(ARCHITECT_PHASE_BUDGETS_MS[name] / MINUTE_MS);
  return `You have about ${minutes} minutes of wall clock for this phase. When the budget is spent you will be told to close the phase - produce the phase deliverable from what you have by then; depth you cannot afford here belongs to a later phase.`;
}

/** Adversarial critique outcome for a draft decomposition envelope. */
export interface CritiqueReport {
  readonly verdict: "approve" | "request_changes";
  readonly findings: readonly string[];
}

/**
 * The bounded adversarial critique pass between a draft envelope and
 * acceptance: a fresh-context session gets ONLY the scope goal, the project
 * context, and the draft envelope, and its report either accepts the draft or
 * sends concrete findings back to the architect session for one revision.
 */
export interface ArchitectCritiqueSpec {
  readonly systemPrompt: string;
  readonly buildPrompt: (input: {
    readonly goal: string;
    readonly projectContext: string | null;
    readonly envelope: unknown;
  }) => string;
  readonly parseReport: (report: string) => CritiqueReport;
}

const CRITIQUE_RESPONSE_FORMAT = [
  "Answer with STRICT JSON only — no prose before or after:",
  '{ "verdict": "approve" | "request_changes", "findings": string[] }',
  'Use "request_changes" when any walk finds a defect; each finding must name',
  "the defect precisely and be actionable — the architect will fix exactly",
  "what you write and nothing more. Approve only when every walk comes back clean.",
].join("\n");

/**
 * Parse a critique session's final text into a report. Tolerates a leading
 * ```json fence; anything unparseable becomes a request_changes whose single
 * finding is the raw text (truncated), so a broken critic can never silently
 * approve a plan.
 */
export function parseCritiqueReport(report: string): CritiqueReport {
  const normalize = (
    verdict: unknown,
    findings: unknown,
  ): CritiqueReport | null => {
    if (verdict !== "approve" && verdict !== "request_changes") return null;
    if (!Array.isArray(findings)) return null;
    const texts = findings.filter(
      (finding): finding is string => typeof finding === "string",
    );
    if (texts.length !== findings.length) return null;
    // A rejection with no findings carries no actionable information; treat it
    // as approval rather than burning the revision cycle on an empty list.
    if (verdict === "request_changes" && texts.length === 0) {
      return { verdict: "approve", findings: [] };
    }
    return { verdict, findings: texts };
  };
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(report.trim());
  const candidates = [fenced?.[1], report];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // try the next candidate shape
      continue;
    }
    const normalized =
      typeof parsed === "object" && parsed !== null
        ? normalize(
            (parsed as { verdict?: unknown }).verdict,
            (parsed as { findings?: unknown }).findings,
          )
        : null;
    if (normalized) return normalized;
  }
  return {
    verdict: "request_changes",
    findings: [
      report.slice(0, 2000) || "critique returned no parseable report",
    ],
  };
}

/**
 * The revision turn sent to the MAIN architect session after a request_changes
 * report: the numbered findings plus the one-revision budget, so the model
 * knows this is its final submission.
 */
export function buildRevisionPrompt(findings: readonly string[]): string {
  return [
    "## Revision",
    "An independent adversarial critique of your draft decomposition found these defects:",
    ...findings.map((finding, index) => `${index + 1}. ${finding}`),
    "",
    "Correct the decomposition so every finding is resolved — restate consumed",
    "contracts verbatim in both specs, fix depends_on edges, close coverage gaps —",
    "then call `submit_architect_decomposition` exactly once more with the full",
    "corrected envelope. This is the only revision cycle: the next valid",
    "submission is accepted as-is.",
  ].join("\n");
}

/**
 * Colony's architect critique pass: same walks the consolidation phase applies
 * to itself, applied adversarially by a session that owes the draft nothing.
 */
export const ARCHITECT_CRITIQUE: ArchitectCritiqueSpec = {
  systemPrompt: [
    "# Role",
    "You are the Colony Decomposition Critic: an adversarial reviewer between an architect's draft task DAG and its acceptance. You review to REJECT — approve only when you fail to find a defect.",
    "",
    "# Inputs",
    "You receive exactly three things in one prompt: the scope goal, the operator-authored project context (or `(none)`), and the draft decomposition envelope as JSON. You have no conversation history, no repository access, and no tools — judge the envelope on what is written in front of you, nothing else.",
    "",
    "# Walks",
    "Apply all three walks adversarially; actively look for a reason to reject at each:",
    "1. Coverage: enumerate every requirement in the scope goal and point to the task that implements it. A requirement with no task, or a task whose deliverable no requirement needs, is a finding.",
    "2. Consistency: collect every file path, exported symbol, schema shape, and type name that appears in more than one spec and verify they match EXACTLY character for character. `clearLayers` in one task and `clearFullLayers` in another is a finding — implementers never see sibling specs, so a drifted contract produces an unbuildable task.",
    "3. Fresh-checkout: for every task with empty `depends_on`, ask whether its spec is executable against the default branch alone. A spec that references files, symbols, or packages no task creates and the default branch cannot be assumed to contain is a finding.",
    "",
    "# Verdict discipline",
    `- Every finding must be concrete and actionable: name the task, the defect, and the correction. \"Task 2's spec says src/utils/hash.ts but task 1 creates src/utils/digest.ts — align both on one path\" qualifies; \"specs could be clearer\" does not.`,
    "- Do not reject for taste, style, or decomposition philosophy. Reject for defects that would make a task unbuildable, a requirement uncovered, or a contract broken.",
    "- Verify each finding against the envelope text before including it: half of false positives collapse at restatement. You are biased toward over-reporting real defects, not inventing them.",
    "",
    CRITIQUE_RESPONSE_FORMAT,
  ].join("\n"),
  buildPrompt: ({ goal, projectContext, envelope }) =>
    [
      "## Critique",
      "Scope goal:",
      goal,
      "",
      "Project context:",
      projectContext ?? "(none)",
      "",
      "Draft decomposition envelope:",
      JSON.stringify(envelope, null, 2),
      "",
      "Apply the three walks and answer with STRICT JSON per the format above.",
    ].join("\n"),
  parseReport: parseCritiqueReport,
};

/**
 * Build the deterministic phase prompts for one architect run. Each prompt is
 * a full user turn: it carries everything the model must do in that phase,
 * so the runner — not the model — owns when planning moves forward.
 */
export function buildArchitectPhases(
  packet: AgentRuntimePacket,
): readonly ArchitectPhase[] {
  return [
    {
      name: "survey",
      budgetMs: ARCHITECT_PHASE_BUDGETS_MS.survey,
      prompt: [
        budgetLine("survey"),
        buildPacketPrompt(packet),
        "",
        "## Phase: survey",
        "Explore this repository and its project context before any planning. Use read/grep/ls/bash to inspect the root layout, package manifests, scripts, test setup, CI configuration, and every area the goal touches.",
        "Then produce a constraints memo with VERIFIED facts only:",
        "- real install/build/typecheck/lint/test commands, as defined in the manifests you read;",
        "- code and test conventions you actually observed (file placement, naming, framework idioms);",
        "- exact file paths that matter for the goal, each confirmed to exist.",
        "Do NOT propose tasks or decompose anything in this phase. End your reply with the memo.",
      ].join("\n"),
    },
    {
      name: "decompose",
      budgetMs: ARCHITECT_PHASE_BUDGETS_MS.decompose,
      prompt: [
        budgetLine("decompose"),
        "## Phase: decompose",
        "From your survey memo, produce TWO materially different candidate decompositions of the scope goal — they must differ in slicing or dependency shape (e.g. coarse vertical slices vs. contract-first layering), not cosmetic naming.",
        "For each candidate list every task with a title and a one-line intent. Then STATE YOUR CHOICE explicitly and justify it against the decomposition rules: smallest viable plan, every task lands green alone on the default branch, explicit acyclic depends_on, independent tasks never touch the same files.",
        "Do not submit an envelope yet; deep-dive follows.",
      ].join("\n"),
    },
    {
      name: "deep_dive",
      budgetMs: ARCHITECT_PHASE_BUDGETS_MS.deep_dive,
      prompt: [
        budgetLine("deep_dive"),
        "## Phase: deep_dive",
        "For EACH task of your chosen decomposition, issue exactly one `task` subagent call. Issue all independent calls together in one turn so they run concurrently (the tool caps concurrency itself).",
        "Each subagent prompt is self-contained — the child sees none of this conversation — and must include: the scope goal, the project context from your survey memo (real commands, conventions, paths), and the candidate task's title plus intent.",
        "Instruct every subagent to verify against the actual repository that every file, symbol, and script the future spec will reference exists (read/grep/ls/bash), and to return COMPRESSED spec material only:",
        "- goal of the task;",
        "- user-observable behavior;",
        "- invariants that must hold;",
        "- falsifiable evidence commands (exact commands whose success proves completion);",
        "- consumed/produced contracts verbatim: file paths, exported symbols, schema shapes.",
        "No envelope yet.",
      ].join("\n"),
    },
    {
      name: "consolidate",
      budgetMs: ARCHITECT_PHASE_BUDGETS_MS.consolidate,
      prompt: [
        budgetLine("consolidate"),
        "## Phase: consolidate",
        "From your survey memo and the deep-dive material, finalize the plan and submit:",
        "1. Write the final specs. When task B consumes anything task A produces, restate that contract VERBATIM in both specs (exact paths, exported symbols, schema shapes) — implementers never see sibling specs.",
        "2. Wire depends_on EXPLICITLY as indexes into the tasks array: B touching anything A creates means B depends on A; empty depends_on asserts the task lands green on a bare fresh checkout.",
        "3. Self-review walks: coverage (every requirement has a task), consistency (identical names across specs), fresh-checkout (each empty-depends_on task is executable on the default branch alone).",
        "4. Size each task against the implementer budget before submitting: the predicted session cost is the count of distinct file paths in its spec times the observed ms-per-file from landed history, and `submit_architect_decomposition` mechanically rejects any task whose prediction exceeds the budget (`task_over_budget` — the rejection names the predicted ms, the budget ms, and the spec file-path count it was computed from). A task that comes out oversized must be re-planned into smaller outcome-oriented tasks; nothing ever splits it automatically.",
        '5. Call `submit_architect_decomposition` exactly once with the full envelope (kind "architect_decomposition", summary, acceptance entries with objective commands runnable in a minimal Node sandbox, tasks). Your run does not exist until that call.',
      ].join("\n"),
    },
  ];
}
