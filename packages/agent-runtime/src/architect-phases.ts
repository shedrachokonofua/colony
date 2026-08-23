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
}

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
      prompt: [
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
      prompt: [
        "## Phase: decompose",
        "From your survey memo, produce TWO materially different candidate decompositions of the scope goal — they must differ in slicing or dependency shape (e.g. coarse vertical slices vs. contract-first layering), not cosmetic naming.",
        "For each candidate list every task with a title and a one-line intent. Then STATE YOUR CHOICE explicitly and justify it against the decomposition rules: smallest viable plan, every task lands green alone on the default branch, explicit acyclic depends_on, independent tasks never touch the same files.",
        "Do not submit an envelope yet; deep-dive follows.",
      ].join("\n"),
    },
    {
      name: "deep_dive",
      prompt: [
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
      prompt: [
        "## Phase: consolidate",
        "From your survey memo and the deep-dive material, finalize the plan and submit:",
        "1. Write the final specs. When task B consumes anything task A produces, restate that contract VERBATIM in both specs (exact paths, exported symbols, schema shapes) — implementers never see sibling specs.",
        "2. Wire depends_on EXPLICITLY as indexes into the tasks array: B touching anything A creates means B depends on A; empty depends_on asserts the task lands green on a bare fresh checkout.",
        "3. Self-review walks: coverage (every requirement has a task), consistency (identical names across specs), fresh-checkout (each empty-depends_on task is executable on the default branch alone).",
        '4. Call `submit_architect_decomposition` exactly once with the full envelope (kind "architect_decomposition", summary, acceptance entries with objective commands runnable in a minimal Node sandbox, tasks). Your run does not exist until that call.',
      ].join("\n"),
    },
  ];
}
