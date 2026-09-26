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
    operator_decisions: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 5,
        description:
          "Decisions only the operator can make: a requirement that needs something outside this repository, or goal sources in conflict with nothing deciding which wins. Each names the conflict, the options, and the reading this plan assumed. Omit when there are none.",
      }),
    ),
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
            severity: Type.Union(
              [
                Type.Literal("blocker"),
                Type.Literal("major"),
                Type.Literal("minor"),
              ],
              {
                description:
                  "blocker: the plan cannot deliver the goal as written. major: a real defect the implementer can fix inside the task without changing the plan's shape. minor: clarity or wording. request_changes needs at least one blocker; approve carries none.",
              },
            ),
            task: Type.Optional(Type.Integer({ minimum: 0 })),
            note: Type.String({ minLength: 1 }),
            owner: Type.Optional(
              Type.Union(
                [Type.Literal("architect"), Type.Literal("operator")],
                {
                  description:
                    "Who must act. architect (default): the plan must change. operator: a decision no plan can make from this repository - name the conflict or missing capability and the options. Operator findings are blockers.",
                },
              ),
            ),
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
    previous_findings: Type.Optional(
      Type.Array(
        Type.Object(
          {
            finding: Type.Integer({ minimum: 1 }),
            status: Type.Union([
              Type.Literal("resolved"),
              Type.Literal("open"),
            ]),
          },
          { additionalProperties: false },
        ),
        {
          description:
            "Required when the packet carries a previous review: one entry per numbered finding of that review, resolved or open. Repeat every open finding in findings.",
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

/**
 * How many findings of the previous review a verdict must account for. The
 * plan-review packet names the count when the plan under review revises a
 * rejected one; otherwise there is nothing to account for.
 */
export function previousReviewFindingCount(
  packet: AgentRuntimePacket | undefined,
): number {
  const previous = packet?.["previous_review"];
  if (
    !previous ||
    typeof previous !== "object" ||
    !("finding_count" in previous)
  )
    return 0;
  const count = previous.finding_count;
  return typeof count === "number" && Number.isInteger(count) && count > 0
    ? count
    : 0;
}

function previousFindingsProblems(
  verdict: PlanReviewVerdictV1,
  previousCount: number,
): string[] {
  if (previousCount === 0) return [];
  const counts = new Map<number, number>();
  for (const entry of verdict.previous_findings ?? []) {
    counts.set(entry.finding, (counts.get(entry.finding) ?? 0) + 1);
  }
  const problems: string[] = [];
  const missing: number[] = [];
  for (let finding = 1; finding <= previousCount; finding += 1) {
    if (!counts.has(finding)) missing.push(finding);
  }
  if (missing.length > 0) {
    problems.push(`no status for previous finding ${missing.join(", ")}`);
  }
  const unknown = [...counts.keys()].filter((n) => n > previousCount);
  if (unknown.length > 0) {
    problems.push(
      `the previous review has ${previousCount} findings; there is no finding ${unknown.join(", ")}`,
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

export function createPlanReviewSubmitTool(
  capture: (value: unknown) => void,
  previousFindingCount = 0,
): ToolDefinition {
  return {
    name: "submit_plan_review_verdict",
    label: "Submit plan review verdict",
    description:
      "Final action. Submit exactly one plan_review_verdict. request_changes requires at least one blocker, and every finding names the task and the end state that must hold; approve carries no blocker and requires `inspected` (the files you read against the plan, each with what you checked) and a summary of at least 80 chars saying why the sequence delivers the goal end to end. When the packet carries a previous review, previous_findings gives each of its numbered findings a status. A rejected submission keeps the session open so you can correct and resubmit.",
    parameters: planReviewVerdictTypeBox,
    execute: async (_toolCallId, rawParams) => {
      const verdict = parseEnvelopeArguments(PlanReviewVerdictV1, rawParams);
      const problems = previousFindingsProblems(verdict, previousFindingCount);
      if (problems.length > 0) {
        throw new Error(
          "Verdict rejected: previous_findings must give each finding of the previous review a status (resolved or open):\n" +
            problems.map((problem) => `  - ${problem}`).join("\n"),
        );
      }
      capture(verdict);
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

interface RevisionHistoryEntry {
  readonly at: string;
  readonly round: number;
  readonly findings: readonly {
    readonly severity: string;
    readonly task?: number;
    readonly owner?: string;
    readonly note: string;
  }[];
}

interface RevisionContextPrompt {
  readonly rejected_plan: ArchitectDecompositionV2;
  readonly review_run_id: string;
  readonly review_base_sha: string | null;
  readonly plan_hash: string;
  readonly planning_epoch: string;
  readonly feedback: string;
  readonly review_history: readonly RevisionHistoryEntry[];
  readonly goal_changes: readonly string[];
}

function historyEntryOf(raw: unknown): RevisionHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  if (!("at" in raw) || typeof raw.at !== "string") return null;
  if (!("round" in raw) || typeof raw.round !== "number") return null;
  if (!("findings" in raw) || !Array.isArray(raw.findings)) return null;
  const findings: RevisionHistoryEntry["findings"][number][] = [];
  const rawFindings: unknown[] = raw.findings;
  for (const finding of rawFindings) {
    if (!finding || typeof finding !== "object") return null;
    if (!("severity" in finding) || typeof finding.severity !== "string")
      return null;
    if (!("note" in finding) || typeof finding.note !== "string") return null;
    const task =
      "task" in finding && typeof finding.task === "number"
        ? finding.task
        : undefined;
    const owner =
      "owner" in finding && typeof finding.owner === "string"
        ? finding.owner
        : undefined;
    findings.push({
      severity: finding.severity,
      task,
      owner,
      note: finding.note,
    });
  }
  return { at: raw.at, round: raw.round, findings };
}

/**
 * The packet is structurally open because colonyd owns its assembly. Keep the
 * revision shape local so a malformed packet cannot put an untrusted object in
 * the prompt.
 */
function revisionContextOf(
  packet: AgentRuntimePacket,
): RevisionContextPrompt | null {
  const raw = packet.revision_context;
  if (!raw || typeof raw !== "object") return null;
  // Every field is re-checked below; the cast only names the keys to read.
  const context = raw as Partial<Record<keyof RevisionContextPrompt, unknown>>;
  const reviewBase = context.review_base_sha;
  const plan = ArchitectDecompositionV2.safeParse(context.rejected_plan);
  if (
    !plan.success ||
    typeof context.review_run_id !== "string" ||
    (typeof reviewBase !== "string" && reviewBase !== null) ||
    typeof context.plan_hash !== "string" ||
    typeof context.planning_epoch !== "string" ||
    typeof context.feedback !== "string" ||
    !context.feedback.trim()
  ) {
    return null;
  }
  const history = Array.isArray(context.review_history)
    ? context.review_history.map(historyEntryOf)
    : [];
  const goalChanges = Array.isArray(context.goal_changes)
    ? context.goal_changes.filter(
        (label): label is string => typeof label === "string",
      )
    : [];
  return {
    rejected_plan: plan.data,
    review_run_id: context.review_run_id,
    review_base_sha: reviewBase,
    plan_hash: context.plan_hash,
    planning_epoch: context.planning_epoch,
    feedback: context.feedback,
    review_history: history.filter(
      (entry): entry is RevisionHistoryEntry => entry !== null,
    ),
    goal_changes: goalChanges,
  };
}

function packetBaseCommit(packet: AgentRuntimePacket): string | null {
  const repo = packet["repo"];
  if (!repo || typeof repo !== "object" || !("base_commit" in repo))
    return null;
  return typeof repo.base_commit === "string" ? repo.base_commit : null;
}

/** One plan review finding as every prompt renders it: severity, owner, task, note. */
export function formatPlanReviewFinding(finding: {
  readonly severity: string;
  readonly task?: number;
  readonly owner?: string;
  readonly note: string;
}): string {
  const where = finding.task === undefined ? "plan" : `task ${finding.task}`;
  const tag =
    finding.owner === "operator"
      ? `${finding.severity}, operator`
      : finding.severity;
  return `[${tag}] ${where}: ${finding.note}`;
}

function revisionBlock(packet: AgentRuntimePacket): string[] {
  const revision = revisionContextOf(packet);
  if (!revision) return [];
  const baseCommit = packetBaseCommit(packet);
  const lines = [
    "",
    "## Exact rejected plan to amend",
    "This is the exact plan that the latest review rejected. Amend it; do not start from a blank plan.",
    `Origin review run: ${revision.review_run_id}`,
    `Origin review base: ${revision.review_base_sha}`,
    `Planning epoch: ${revision.planning_epoch}`,
    `Reviewed plan content hash: ${revision.plan_hash}`,
    "",
    "Preserve requirements, tasks, and repository grounding that remain valid. Inspect the current repository and changed facts before retaining paths, symbols, commands, or migration numbers. Make any structural correction needed to address the findings; do not blindly preserve stale details. The authoritative operator directives still apply.",
  ];
  if (
    revision.review_base_sha &&
    baseCommit &&
    revision.review_base_sha !== baseCommit
  ) {
    lines.push(
      "",
      `The default branch moved since that review. Run \`git diff --stat ${revision.review_base_sha} ${baseCommit}\` and re-read every changed goal, spec, or design document before amending: a finding may rest on text that changed.`,
    );
  }
  if (revision.goal_changes.length > 0) {
    lines.push(
      "",
      `The operator changed these goal inputs since that review: ${revision.goal_changes.join(", ")}. Re-read them; findings about the old goal may no longer apply.`,
    );
  }
  if (revision.review_history.length > 0) {
    lines.push(
      "",
      "## Earlier rejections in this planning line",
      "Each finding below rejected an approach an earlier revision tried. Do not bring an approach back unless the revision fixes what its finding names.",
    );
    for (const entry of revision.review_history) {
      lines.push(`### Round ${entry.round} (${entry.at})`);
      lines.push(
        ...entry.findings.map(
          (finding) => `- ${formatPlanReviewFinding(finding)}`,
        ),
      );
    }
  }
  return lines;
}

const ENVIRONMENT_BLOCK = [
  "# Environment",
  "Your working directory is a read-only clone of the target repository at its default branch. Project reference files listed in the packet are available read-only at `.colony/project/<filename>`; never modify anything under `.colony/project/`.",
].join("\n");

function terminalRule(tool: string, deliverable: string): string {
  return `# How this session ends\nThis session ends when you call \`${tool}\`, and only then. ${deliverable} If you run out of turns, your tools will be reduced to that one call: submit what you have rather than nothing.`;
}

const GOAL_SOURCES_RULE =
  "Goal sources rank: operator planning directives (later ones win where they conflict), then the scope goal, then the operator-authored project background, then repository documents. An explicit precedence statement by the operator decides a conflict it covers; read any repository document it names as authoritative. A conflict nothing decides is an operator decision.";

const IAC_EVIDENCE_RULE =
  "For infrastructure, deployment, and CI changes (IaC, Dockerfiles, proxy and pipeline configuration), evidence is a repository check that reads the changed configuration and fails on its old shape - a script or test in the repository, or a validator the checkout has - never a grep that also matches unrelated resources. Applying, deploying, and live smoke tests belong in scope acceptance, not task evidence.";

const PLAN_SYSTEM_PROMPT = [
  "# Role",
  "You are the Colony Architect, discovering and planning. Inspect the goal against the repository, then produce a task DAG that autonomous implementers execute independently. Each implementer sees ONLY its task spec, so every spec must be complete.",
  "",
  ENVIRONMENT_BLOCK,
  "",
  "# Discover only what the plan needs",
  "- Split the goal and operator directives into atomic requirements a reviewer can check. Number them R1, R2, ...; preserve everything requested.",
  `- ${GOAL_SOURCES_RULE}`,
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
  `- ${IAC_EVIDENCE_RULE}`,
  "",
  "# Decisions only the operator can make",
  "When a requirement needs something outside this repository (shared infrastructure, another repository, an unpublished package), or goal sources conflict with nothing deciding which wins, do not invent a workaround the reviewer will reject. Plan around the most defensible reading and list the decision in operator_decisions: the conflict or missing capability, the options, and the reading you planned for.",
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
  `- evidence: each command runs in this repository (correct runner, correct test path, correct flags) and would fail before the task lands. ${IAC_EVIDENCE_RULE}`,
  "- references: when a task deletes, renames, or moves a resource, variable, route, script, or export, search the repository for every reference to it (CI jobs, IaC variables and outputs, Dockerfiles, scripts, imports) and handle each in the same task.",
  "- contracts: where task B consumes what task A produces, both specs state the same exact paths, exported symbols, and shapes. Restate them verbatim in both.",
  "- depends_on: an edge for every produced-consumed relation; no edge where there is none.",
  "- operator_decisions: keep each decision the draft raised unless the repository settles it; add one when a claim cannot be made true from this repository.",
  "Delegate independent per-task verification together; give each subagent the goal, the mechanical inspection manifest, and one task.",
  "",
  `# Goal sources\n${GOAL_SOURCES_RULE}`,
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
  "You are the Colony Plan Reviewer: the same review an implementer's merge request gets, applied to an architect's plan before any implementer starts. Find what will go wrong, and say exactly what must hold instead.",
  "",
  ENVIRONMENT_BLOCK,
  "",
  "# What you judge",
  "1. Increments: each task lands as its own green merge request on the default branch with no sibling present. A task that cannot build alone is a finding. So is a task whose output a later task rewrites or discards, unless the journey declares it transitional: a migration may keep an existing path live, or bridge to it, until a named later task retires it.",
  `2. Validatable: each task's evidence commands run in this repository and prove that task, not a neighbour. Check the commands against the manifests. ${IAC_EVIDENCE_RULE}`,
  "3. Size: a task is one reviewable change - not a scaffold, not three features. Padding (a task no requirement needs) and overloading (a task a reviewer could only half-reject) are findings.",
  "4. Journey: the sequence of working states is real - after each task, the state described is observable - and the last state is the goal, whole.",
  "5. Coverage: every requirement maps to a task that actually delivers it; every task delivers a requirement.",
  "6. Contracts: anything one task produces and another consumes is stated identically in both specs, with exact paths and symbols that exist or are created by an edge.",
  "Open the files the plan names; a plan is judged against the repository, not against itself.",
  "",
  `# Goal sources\n${GOAL_SOURCES_RULE}`,
  "",
  "# Severity decides the verdict",
  "- blocker: the plan cannot deliver the goal as written - a task that cannot land alone, evidence that cannot run or cannot prove its task, an uncovered requirement, an unobservable journey step, a contract two tasks state differently, or a violated directive or goal constraint.",
  "- major: a real defect the implementer can fix inside the task without changing the plan's shape - an incomplete file list, a weak but runnable evidence command, an unstated edge case.",
  "- minor: clarity or wording.",
  "request_changes if and only if there is at least one blocker. Otherwise approve: majors and minors are attached to the task specs for the implementers.",
  "",
  "# Decisions only the operator can make",
  'Some blockers no plan can fix: the goal needs something outside this repository (shared infrastructure, another repository, an unpublished package), or goal sources conflict with nothing deciding which wins. File each as one blocker with owner "operator" that names the conflicting sources or the missing capability, and the options. The scope stops and asks the operator, so do not reject each workaround the architect invents for the same cause. When the plan lists operator_decisions, judge each one: confirm it with an operator-owned blocker, or reject it with an architect-owned finding that says how the repository and goal sources settle it.',
  "",
  "# Previous review",
  "When the packet carries a previous review, first check each of its numbered findings against this plan and give it a status in previous_findings: resolved or open. Repeat every open finding in findings. The plan changes show what the architect touched: a new finding on an unchanged task must say why the previous review missed it.",
  "",
  "# Verdict discipline",
  "- A finding names the task index, the defect, and the end state that must hold. The architect applies corrections literally: when your correction deletes, renames, or moves something, name the references you checked (CI jobs, IaC variables and outputs, Dockerfiles, scripts, imports) and every one that must change with it.",
  "- Do not reject for taste or decomposition philosophy.",
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
    "The previous plan was rejected. Fix every architect-owned finding. A correction names an end state: trace every reference the change touches rather than applying only the edit it spells out. A finding you believe no plan can satisfy from this repository is an operator decision: list it in operator_decisions instead of inventing a workaround. Findings marked operator went to the operator, who let planning continue: re-read the goal sources, which may have changed, and plan for the reading they now support.",
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
          ...revisionBlock(packet),
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
    lines.push(`${i + 1}. ${formatPlanReviewFinding(f)}`);
  });
  const previous = verdict.previous_findings ?? [];
  if (previous.length > 0) {
    const resolved = previous
      .filter((entry) => entry.status === "resolved")
      .map((entry) => entry.finding)
      .sort((a, b) => a - b);
    const open = previous
      .filter((entry) => entry.status === "open")
      .map((entry) => entry.finding)
      .sort((a, b) => a - b);
    lines.push(
      "",
      `Previous review's findings: resolved ${resolved.join(", ") || "none"}; still open ${open.join(", ") || "none"}.`,
    );
  }
  return lines.join("\n");
}
