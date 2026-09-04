import { Type } from "@oh-my-pi/omptype/typebox";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { ArchitectDecompositionV2, PlanReviewVerdictV1 } from "@colony/schemas";
import type { AgentRuntimePacket } from "./adapter.js";
import { validateDecompositionEnvelope } from "./envelope-validation.js";
import {
  buildArchitectDecompositionRules,
  buildPacketPrompt,
  parseEnvelopeArguments,
  type ArchitectSizeGate,
} from "./pi-runner-common.js";

/**
 * The architect as two fresh chats with a typed hand-off.
 *
 * Grounding is work, not a deliverable. A standalone survey stage added a
 * schema submission and retry boundary, then the planning stage reopened the
 * same files. Discovery now happens in the planning session. The runner
 * records successful inspection inputs mechanically and gives that manifest,
 * rather than model-authored survey prose, to an independent verifier.
 *
 * Each stage ends only through its submit tool. Past a turn cap, the runner
 * removes every other tool. Runtime ceilings stay in the runner; prompts do
 * not tell the model how long it may spend.
 *
 *   plan    packet + repository ─▶ draft plan + inspection manifest
 *   verify  goal + draft + manifest ─▶ final plan (size-gated)
 *
 * Review happens outside the run: colonyd sends the final plan through the
 * reviewer chain and re-dispatches the architect with findings.
 */
export const ARCHITECT_STAGES = ["plan", "verify"] as const;
export type ArchitectStageName = (typeof ARCHITECT_STAGES)[number];

/** Sandbox tools a stage may use besides its own submit tool. */
export type StageToolSet = "inspect" | "read_only";

export interface ArchitectStage {
  readonly name: ArchitectStageName;
  readonly systemPrompt: string;
  /** The stage's single user turn, built from the artifacts before it. */
  readonly prompt: (artifacts: StageArtifacts) => string;
  readonly tools: StageToolSet;
  /** Whether the stage may delegate to `task` subagents. */
  readonly subagents: boolean;
  /**
   * Assistant turns after which the stage's tools collapse to its submit
   * tool. This is an internal ceiling, never a prompt allowance.
   */
  readonly turnCap: number;
  /** The stage's terminal tool; its capture is the stage artifact. */
  readonly submitTool: (
    capture: (value: unknown) => void,
    sizeGate?: ArchitectSizeGate,
  ) => ToolDefinition;
}

export interface InspectionManifest {
  readonly paths: readonly string[];
  readonly searches: readonly string[];
  readonly commands: readonly string[];
}

export interface StageArtifacts {
  readonly packet: AgentRuntimePacket;
  readonly inspection?: InspectionManifest;
  readonly draft?: ArchitectDecompositionV2;
}

// ---------------------------------------------------------------------------
// Wire schemas (TypeBox mirrors of the zod contracts; the zod parses)
// ---------------------------------------------------------------------------

const architectTaskTypeBox = Type.Object(
  {
    title: Type.String({ minLength: 1 }),
    spec: Type.String({ minLength: 1 }),
    depends_on: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
    files: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 40,
      description:
        "Repository files this task creates or changes. Every path must exist on the default branch or be created by a task this one depends on.",
    }),
    evidence: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 10,
      description:
        "Exact commands that fail before this task and pass after it, runnable on the task's own branch.",
    }),
  },
  { additionalProperties: false },
);

export const architectDecompositionEnvelopeTypeBox = Type.Object(
  {
    kind: Type.Literal("architect_decomposition"),
    summary: Type.String({ minLength: 1 }),
    requirements: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^R\\d+$" }),
          text: Type.String({ minLength: 1 }),
          tasks: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: 40,
        description:
          "Every goal or operator-directive requirement, each mapped to the task indexes that deliver it. A task no requirement maps to is rejected.",
      },
    ),
    journey: Type.Array(
      Type.Object(
        {
          after_task: Type.Integer({ minimum: 0 }),
          working_state: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: 20,
        description:
          "The end-to-end journey in landing order: what a user can do after each task merges. Must end at the last task: that state is the delivered goal.",
      },
    ),
    acceptance: Type.Array(
      Type.Object(
        {
          description: Type.String({ minLength: 1 }),
          command: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    tasks: Type.Array(architectTaskTypeBox, { minItems: 1, maxItems: 20 }),
  },
  { additionalProperties: false },
);

export const planReviewVerdictTypeBox = Type.Object(
  {
    kind: Type.Literal("plan_review_verdict"),
    verdict: Type.Union([
      Type.Literal("approve"),
      Type.Literal("request_changes"),
    ]),
    summary: Type.String({ minLength: 1 }),
    findings: Type.Optional(
      Type.Array(
        Type.Object(
          {
            severity: Type.Union([
              Type.Literal("blocker"),
              Type.Literal("major"),
              Type.Literal("minor"),
            ]),
            task: Type.Optional(Type.Integer({ minimum: 0 })),
            note: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    inspected: Type.Optional(
      Type.Array(
        Type.Object(
          {
            file: Type.String({ minLength: 1 }),
            note: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        {
          description:
            "Files you read to judge the plan, each with what you checked it against. Required (non-empty) on approve.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Submit tools
// ---------------------------------------------------------------------------

export function createPlanDraftSubmitTool(
  capture: (value: unknown) => void,
): ToolDefinition {
  return {
    name: "submit_plan_draft",
    label: "Submit plan draft",
    description:
      "Final action of planning. Submit the draft plan: requirements mapped to tasks, the end-to-end journey, acceptance, and every task with its files and evidence. The verify stage checks it against the repository; a rejected submission keeps the session open so you can correct and resubmit.",
    parameters: architectDecompositionEnvelopeTypeBox,
    execute: async (_toolCallId, rawParams) => {
      // The draft carries the plan's shape rules but not the size gate: the
      // verify stage grounds file lists, and the gate is priced on those.
      const params = parseEnvelopeArguments(
        ArchitectDecompositionV2,
        rawParams,
      );
      const errors = validateDecompositionEnvelope(params);
      if (errors.length > 0) {
        throw new Error(
          "Draft rejected: plan failed mechanical validation:\n" +
            errors.map((e) => `  - [${e.rule}] ${e.message}`).join("\n"),
        );
      }
      capture(params);
      return Promise.resolve({
        content: [{ type: "text", text: "plan draft captured" }],
        details: {},
        terminate: true,
      });
    },
  };
}

export function createArchitectSubmitTool(
  capture: (value: unknown) => void,
  sizeGate?: ArchitectSizeGate,
): ToolDefinition {
  return {
    name: "submit_architect_decomposition",
    label: "Submit architect decomposition",
    description:
      "Final action. Submit exactly one schema-valid architect_decomposition: the verified plan with every task grounded (files that exist or are created by a dependency, evidence commands that run). Rejected: phantom-dependency phrasing with empty depends_on, file paths shared between unrelated tasks, out-of-range or cyclic depends_on, a task no requirement needs, a journey that does not reach the last task, and a task whose predicted cost exceeds the implementer budget - a rejected submission keeps the session open so you can correct and resubmit.",
    parameters: architectDecompositionEnvelopeTypeBox,
    execute: async (_toolCallId, rawParams) => {
      const params = parseEnvelopeArguments(
        ArchitectDecompositionV2,
        rawParams,
      );
      const errors = validateDecompositionEnvelope(params, sizeGate);
      if (errors.length > 0) {
        throw new Error(
          "Submission rejected: decomposition failed mechanical validation:\n" +
            errors.map((e) => `  - [${e.rule}] ${e.message}`).join("\n"),
        );
      }
      capture(params);
      return Promise.resolve({
        content: [{ type: "text", text: "architect envelope captured" }],
        details: {},
        terminate: true,
      });
    },
  };
}

export function createPlanReviewSubmitTool(
  capture: (value: unknown) => void,
): ToolDefinition {
  return {
    name: "submit_plan_review_verdict",
    label: "Submit plan review verdict",
    description:
      "Final action. Submit exactly one plan_review_verdict. request_changes requires findings that name the task and the correction; approve requires `inspected` (the files you read against the plan, each with what you checked) and a summary of at least 80 chars saying why the sequence delivers the goal end to end.",
    parameters: planReviewVerdictTypeBox,
    execute: async (_toolCallId, rawParams) => {
      capture(parseEnvelopeArguments(PlanReviewVerdictV1, rawParams));
      return Promise.resolve({
        content: [{ type: "text", text: "plan review verdict captured" }],
        details: {},
        terminate: true,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function goalOf(packet: AgentRuntimePacket): string {
  const goal = "goal" in packet ? packet.goal : undefined;
  const base = typeof goal === "string" ? goal : JSON.stringify(packet);
  const directives =
    "plan_directives" in packet ? packet.plan_directives : undefined;
  if (typeof directives !== "string" || !directives.trim()) return base;
  return [
    base,
    "",
    "## Authoritative operator planning directives",
    directives,
    "",
    "These directives are mandatory. Later directives supersede earlier directives only where they explicitly conflict.",
  ].join("\n");
}

function projectContextOf(packet: AgentRuntimePacket): string | null {
  const project = "project" in packet ? packet.project : undefined;
  const doc =
    project && typeof project === "object" && "context_doc" in project
      ? project.context_doc
      : undefined;
  return typeof doc === "string" && doc.trim() ? doc : null;
}

function reviewFeedbackOf(packet: AgentRuntimePacket): string | null {
  const feedback = "plan_feedback" in packet ? packet.plan_feedback : undefined;
  return typeof feedback === "string" && feedback.trim() ? feedback : null;
}

const ENVIRONMENT_BLOCK = [
  "# Environment",
  "Your working directory is a read-only clone of the target repository at its default branch. Project reference files listed in the packet are available read-only at `.colony/project/<filename>`; never modify anything under `.colony/project/`.",
].join("\n");

function terminalRule(tool: string, deliverable: string): string {
  return `# How this session ends\nThis session ends when you call \`${tool}\`, and only then. ${deliverable} If you run out of turns, your tools will be reduced to that one call: submit what you have rather than nothing.`;
}

const PLAN_SYSTEM_PROMPT = [
  "# Role",
  "You are the Colony Architect, discovering and planning. Inspect the goal against the repository, then produce a task DAG that autonomous implementers execute independently. Each implementer sees ONLY its task spec, so every spec must be complete.",
  "",
  ENVIRONMENT_BLOCK,
  "",
  "# Discover only what the plan needs",
  "- Split the goal and operator directives into atomic requirements a reviewer can check. Number them R1, R2, ...; preserve everything requested.",
  "- Inspect the source, tests, manifests, and existing seams that determine the change. Use only paths you verify or explicitly assign a task to create.",
  "- Find the repository's real install, build, typecheck, lint, and test commands needed as evidence.",
  "- Delegate independent lookups together. Stop broad exploration once the requirements, seams, contracts, and commands needed for a defensible plan are known.",
  "",
  buildArchitectDecompositionRules(),
  "",
  "# The plan is a claim you back",
  "- requirements: map every goal and operator-directive requirement to the task indexes that deliver it. A task that delivers no requirement is padding and is rejected.",
  "- journey: state what works after each task lands. The final state delivers the whole goal; fold non-observable scaffolding into the task that makes it usable.",
  "- Every task names verified or explicitly created files and exact evidence commands. Evidence must fail on the default branch and pass on the task branch.",
  "",
  terminalRule(
    "submit_plan_draft",
    "The grounded draft plan is the deliverable.",
  ),
].join("\n");

const VERIFY_SYSTEM_PROMPT = [
  "# Role",
  "You are the Colony Architect, verifying. You have a draft plan and the repository. Your job is to make every claim in the plan true against the code, then submit the final plan.",
  "",
  ENVIRONMENT_BLOCK,
  "",
  "# What to verify, per task",
  "- files: every path exists on the default branch or is created by a task this one depends on. Add paths the spec implies and drop ones it does not touch.",
  "- evidence: each command runs in this repository (correct runner, correct test path, correct flags) and would fail before the task lands.",
  "- contracts: where task B consumes what task A produces, both specs state the same exact paths, exported symbols, and shapes. Restate them verbatim in both.",
  "- depends_on: an edge for every produced-consumed relation; no edge where there is none.",
  "Delegate independent per-task verification together; give each subagent the goal, the mechanical inspection manifest, and one task.",
  "",
  buildArchitectDecompositionRules(),
  "",
  "# Fix, do not annotate",
  "Correct the plan in place: adjust files, evidence, specs, edges, journey, and requirement mapping so the submitted plan is true. Do not add caveats for the implementer to resolve.",
  "",
  terminalRule(
    "submit_architect_decomposition",
    "The verified plan is the deliverable.",
  ),
].join("\n");

export const PLAN_REVIEW_SYSTEM_PROMPT = [
  "# Role",
  "You are the Colony Plan Reviewer: the same review an implementer's merge request gets, applied to an architect's plan before any implementer starts. You review to find what will go wrong; approve only when you looked and found nothing.",
  "",
  ENVIRONMENT_BLOCK,
  "",
  "# What you judge",
  "1. Increments: each task lands as its own green merge request on the default branch with no sibling present. A task that cannot build alone, or that a later task rewrites, is a finding.",
  "2. Validatable: each task's evidence commands run in this repository and prove that task, not a neighbour. Check the commands against the manifests.",
  "3. Size: a task is one reviewable change - not a scaffold, not three features. Padding (a task no requirement needs) and overloading (a task a reviewer could only half-reject) are findings.",
  "4. Journey: the sequence of working states is real - after each task, the state described is observable - and the last state is the goal, whole.",
  "5. Coverage: every requirement maps to a task that actually delivers it; every task delivers a requirement.",
  "6. Contracts: anything one task produces and another consumes is stated identically in both specs, with exact paths and symbols that exist or are created by an edge.",
  "Open the files the plan names; a plan is judged against the repository, not against itself.",
  "",
  "# Verdict discipline",
  "- A finding names the task index, the defect, and the correction. The architect will fix exactly what you write.",
  "- Do not reject for taste or decomposition philosophy. Reject for a task that cannot land, evidence that cannot prove, a requirement left uncovered, a journey with a hole, or a contract that drifts.",
  "- Approve requires `inspected`: the files you read and what you checked each against.",
  "",
  terminalRule("submit_plan_review_verdict", "The verdict is the deliverable."),
].join("\n");

function inspectionBlock(manifest: InspectionManifest): string {
  return [
    "## Mechanical inspection manifest",
    "Generated from successful tool calls in the planning session:",
    JSON.stringify(manifest, null, 2),
  ].join("\n");
}

function feedbackBlock(packet: AgentRuntimePacket): string[] {
  const feedback = reviewFeedbackOf(packet);
  if (!feedback) return [];
  return [
    "",
    "## Review of your previous plan",
    feedback,
    "",
    "The previous plan was rejected. Address every finding; a finding you disagree with still needs a plan the reviewer cannot reject on that ground.",
  ];
}

export function buildArchitectStages(): readonly ArchitectStage[] {
  return [
    {
      name: "plan",
      systemPrompt: PLAN_SYSTEM_PROMPT,
      tools: "inspect",
      subagents: true,
      turnCap: 40,
      submitTool: (capture) => createPlanDraftSubmitTool(capture),
      prompt: ({ packet }) =>
        [
          buildPacketPrompt(packet),
          ...feedbackBlock(packet),
          "",
          "## Discover and plan",
          "Inspect the repository until the plan is grounded, then submit the draft.",
        ].join("\n"),
    },
    {
      name: "verify",
      systemPrompt: VERIFY_SYSTEM_PROMPT,
      tools: "inspect",
      subagents: true,
      turnCap: 40,
      submitTool: (capture, sizeGate) =>
        createArchitectSubmitTool(capture, sizeGate),
      prompt: ({ packet, inspection, draft }) =>
        [
          "## Goal",
          goalOf(packet),
          ...(projectContextOf(packet)
            ? ["", "## Project context", projectContextOf(packet)!]
            : []),
          "",
          inspectionBlock(inspection!),
          "",
          "## Draft plan",
          JSON.stringify(draft, null, 2),
          ...feedbackBlock(packet),
          "",
          "## Verify",
          "Check the draft against the repository, fix it in place, and submit the final plan.",
        ].join("\n"),
    },
  ];
}

/** Reviewer findings as the architect's next plan stage will read them. */
export function formatPlanReviewFeedback(
  verdict: PlanReviewVerdictV1,
  round: number,
): string {
  const lines = [
    `Plan review round ${round}: request_changes.`,
    verdict.summary,
    "",
  ];
  verdict.findings.forEach((f, i) => {
    const where = f.task === undefined ? "plan" : `task ${f.task}`;
    lines.push(`${i + 1}. [${f.severity}] ${where}: ${f.note}`);
  });
  return lines.join("\n");
}
