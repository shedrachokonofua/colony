import type { ArchitectDecompositionV2 } from "@colony/schemas";
import type { Project, ProjectFile, Scope, Task } from "@colony/core";
import type { ProviderRepoRef } from "@colony/provider";

/**
 * Shared packet assembly for every agent role. A project's operator-authored
 * context document rides along in the packet body under a stable heading so
 * each role reads the same background, and as a top-level `project` field so
 * callers can tell operator-authored context from agent output. Builders
 * never attach credentials — the caller mints the run token and spreads it
 * into `repo.credentials`.
 */

export interface AgentPacketRepo {
  url: string;
  credentials?: { token: string };
  branch: string;
  base_commit: string;
}

export interface PacketProjectFile {
  id: string;
  filename: string;
  media_type: "text/plain" | "text/markdown";
  byte_size: number;
  path: string;
}

export interface PacketProject {
  name: string;
  context_doc: string;
  files: readonly PacketProjectFile[];
}

export interface ArchitectRevisionContext {
  rejected_plan: ArchitectDecompositionV2;
  review_run_id: string;
  review_base_sha: string | null;
  plan_hash: string;
  planning_epoch: string;
  feedback: string;
}

export interface ArchitectPacket {
  kind: "architect_scope";
  scope_id: string;
  goal: string;
  body: string;
  project: PacketProject | null;
  repo: AgentPacketRepo;
  /** Durable operator-authored amendments to the original scope goal. */
  plan_directives?: string;
  /** Findings from the latest rejected plan review. */
  plan_feedback?: string;
  /** Exact rejected plan and the revision identity it belongs to. */
  revision_context?: ArchitectRevisionContext;
}

export interface PlanReviewPacket {
  kind: "plan_review";
  scope_id: string;
  goal: string;
  body: string;
  project: PacketProject | null;
  repo: AgentPacketRepo;
  plan: ArchitectDecompositionV2;
  /** Durable operator-authored amendments the reviewer must enforce. */
  plan_directives?: string;
  /** Which review round this is (1-based). */
  round: number;
}

export interface ArchitectExtensionPacket {
  kind: "architect_scope_extension";
  scope_id: string;
  goal: string;
  body: string;
  project: PacketProject | null;
  repo: AgentPacketRepo;
  validation_evidence_json: string;
  current_acceptance: readonly { description: string; command: string }[];
  plan_summary: string;
  existing_tasks: readonly {
    id: string;
    title: string;
    state: string;
    depends_on: readonly string[];
  }[];
}

export type ImplementFact<T> =
  | { status: "known"; value: T }
  | { status: "unknown"; reason: string }
  | { status: "not_requested" };

export interface ImplementExecutionContext {
  mode: "fresh" | "repair";
  branch: string;
  target_branch: string;
  target_head_sha: string;
  remote_head: ImplementFact<string>;
  pipeline: ImplementFact<{ status: string; commit_sha?: string }>;
  current_objective: string;
}

export interface ImplementHistoricalEvidence {
  kind: "interrupted" | "review" | "gate";
  at: string;
  head_sha?: string;
  text: string;
}

export interface ImplementPacket {
  kind: "implement_task";
  task_id: string;
  scope_id: string;
  goal: string;
  body: string;
  project: PacketProject | null;
  repo: AgentPacketRepo;
  execution_context: ImplementExecutionContext;
  repair?: {
    rejected_head_sha: string;
  };
}

export interface ReviewPacket {
  kind: "review_task";
  task_id: string;
  scope_id: string;
  goal: string;
  head_sha: string;
  mr_iid: number | null;
  target_branch: string;
  body: string;
  project: PacketProject | null;
  repo: AgentPacketRepo;
}

export function projectContextSection(
  project: { name: string; context_doc: string | null } | null | undefined,
): string {
  if (!project?.context_doc?.trim()) return "";
  return `## Operator-authored project background (project: ${project.name})\n\n${project.context_doc}\n`;
}

function packetProject(
  project: Project | null,
  files: readonly ProjectFile[],
): PacketProject | null {
  const hasContext = !!project?.context_doc?.trim();
  const hasFiles = files.length > 0;
  if (!hasContext && !hasFiles) return null;
  const name = project?.name ?? files[0]!.project_name;
  if (!name) return null;
  const context_doc = project?.context_doc ?? "";
  const sorted = [...files].sort((a, b) =>
    a.filename.localeCompare(b.filename),
  );
  return {
    name,
    context_doc,
    files: sorted.map((f) => {
      const entry: PacketProjectFile & { content: string } = {
        id: f.id,
        filename: f.filename,
        media_type: f.media_type,
        byte_size: f.byte_size,
        path: `.colony/project/${f.filename}`,
        content: f.content,
      };
      // content must reach the workspace but never appear in PACKET.json
      // or the packet body (spec: no file content in packet JSON). Keep it
      // on the manifest entry as a non-enumerable property so
      // JSON.stringify(packet) stays compact while
      // materializeProjectFiles(dir, packet) can still read record["content"].
      Object.defineProperty(entry, "content", {
        value: f.content,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      return entry;
    }),
  };
}

function projectFilesSection(files: readonly ProjectFile[]): string {
  if (files.length === 0) return "";
  const sorted = [...files].sort((a, b) =>
    a.filename.localeCompare(b.filename),
  );
  const lines = sorted.map(
    (f) =>
      `- .colony/project/${f.filename} (${f.media_type}, ${f.byte_size} bytes)`,
  );
  return `## Project reference files (read on demand)\n${lines.join("\n")}\n`;
}

function operatorPlanDirectivesSection(scope: Scope): string {
  if (!scope.plan_directives.trim()) return "";
  return [
    "## Authoritative operator planning directives",
    scope.plan_directives,
    "",
    "These directives are durable scope requirements. Later directives supersede earlier directives only where they explicitly conflict.",
  ].join("\n");
}

export function buildArchitectPacket(
  scope: Scope,
  project: Project | null,
  files: readonly ProjectFile[],
  _repo: ProviderRepoRef,
  baseSha: string,
  revisionContext?: ArchitectRevisionContext,
): ArchitectPacket {
  return {
    kind: "architect_scope",
    scope_id: scope.id,
    goal: scope.goal,
    body: [
      buildArchitectBody(scope, revisionContext),
      projectContextSection(project),
      projectFilesSection(files),
    ]
      .filter(Boolean)
      .join("\n"),
    project: packetProject(project, files),
    repo: {
      url: scope.provider_repo_path,
      branch: scope.default_branch,
      base_commit: baseSha,
    },
    ...(scope.plan_feedback ? { plan_feedback: scope.plan_feedback } : {}),
    ...(scope.plan_directives
      ? { plan_directives: scope.plan_directives }
      : {}),
    ...(revisionContext ? { revision_context: revisionContext } : {}),
  };
}

export function buildPlanReviewPacket(
  scope: Scope,
  project: Project | null,
  files: readonly ProjectFile[],
  baseSha: string,
  plan: ArchitectDecompositionV2,
  round: number,
): PlanReviewPacket {
  return {
    kind: "plan_review",
    scope_id: scope.id,
    goal: scope.goal,
    body: [
      `Scope goal: ${scope.goal}`,
      "",
      operatorPlanDirectivesSection(scope),
      `Plan review round ${round}. Judge the proposed plan against this repository and submit plan_review_verdict.`,
      "Return request_changes if the plan omits or contradicts any non-superseded operator directive.",
      projectContextSection(project),
      projectFilesSection(files),
    ]
      .filter(Boolean)
      .join("\n"),
    project: packetProject(project, files),
    repo: {
      url: scope.provider_repo_path,
      branch: scope.default_branch,
      base_commit: baseSha,
    },
    plan,
    ...(scope.plan_directives
      ? { plan_directives: scope.plan_directives }
      : {}),
    round,
  };
}

export interface ArchitectExtensionInput {
  readonly validationEvidenceJson: string;
  readonly currentAcceptance: readonly {
    description: string;
    command: string;
  }[];
  readonly planSummary: string;
  readonly existingTasks: readonly {
    id: string;
    title: string;
    state: string;
    depends_on: readonly string[];
  }[];
}

export function buildArchitectExtensionPacket(
  scope: Scope,
  project: Project | null,
  files: readonly ProjectFile[],
  _repo: ProviderRepoRef,
  baseSha: string,
  input: ArchitectExtensionInput,
): ArchitectExtensionPacket {
  return {
    kind: "architect_scope_extension",
    scope_id: scope.id,
    goal: scope.goal,
    body: [
      `Scope goal: ${scope.goal}`,
      "",
      "Validation failed. Diagnose the failure and submit exactly one extension envelope.",
      "A defective acceptance command requires acceptance_fix; missing or incomplete implementation requires extend; an issue genuinely requiring operator action requires human_required.",
      "Acceptance commands run inside a fresh already-cloned workspace: never clone, never use literal placeholders such as <repo-url>, and never require provider credentials. Prefer `bun run test:unit` plus `npm run typecheck` over full `npm test`, whose integration tests exceed the sandbox execution deadline.",
      "",
      "## Failed validation evidence (verbatim evidence_json)",
      input.validationEvidenceJson,
      "",
      "## Current acceptance criteria",
      JSON.stringify(input.currentAcceptance, null, 2),
      "",
      `## Existing plan summary\n${input.planSummary}`,
      "",
      "## Existing task DAG (titles/states and dependencies)",
      JSON.stringify(input.existingTasks, null, 2),
      "",
      "For extend, preserve all existing tasks. Numeric depends_on values index new tasks in the submitted array; string values reference existing task ids above. The combined DAG must remain acyclic.",
    ].join("\n"),
    project: packetProject(project, files),
    repo: {
      url: scope.provider_repo_path,
      branch: scope.default_branch,
      base_commit: baseSha,
    },
    validation_evidence_json: input.validationEvidenceJson,
    current_acceptance: input.currentAcceptance,
    plan_summary: input.planSummary,
    existing_tasks: input.existingTasks,
  };
}
/** Run-history sections only the dispatching caller can collect from the store. */
export interface ImplementContinuity {
  executionContext?: ImplementExecutionContext;
  historicalEvidence?: readonly ImplementHistoricalEvidence[];
  operatorFeedback?: string;
  currentGateFailure?: string;
  currentReviewFindings?: string;
  currentRejectedHeadSha?: string;
  /** Legacy fields are retained as input compatibility for direct callers. */
  interrupted?: string;
  openMr?: string;
  gateFailure?: string;
  reviewFindings?: string;
  rejectedHeadSha?: string;
}

export function buildImplementPacket(
  task: Task,
  scope: Scope,
  project: Project | null,
  files: readonly ProjectFile[],
  _repo: ProviderRepoRef,
  branch: string,
  baseSha: string,
  continuity: ImplementContinuity = {},
): ImplementPacket {
  const legacyRepair =
    continuity.openMr !== undefined ||
    continuity.gateFailure !== undefined ||
    continuity.reviewFindings !== undefined ||
    continuity.rejectedHeadSha !== undefined ||
    continuity.interrupted !== undefined;
  const executionContext =
    continuity.executionContext ??
    (legacyRepair
      ? {
          ...freshImplementExecutionContext(
            branch,
            scope.default_branch,
            baseSha,
          ),
          mode: "repair" as const,
          current_objective:
            "Inspect the existing task branch and make only the incremental changes needed to complete the task.",
        }
      : freshImplementExecutionContext(branch, scope.default_branch, baseSha));
  const historical = [
    ...(continuity.historicalEvidence ?? []),
    ...legacyHistoricalEvidence(continuity),
  ];
  const operatorFeedback = continuity.operatorFeedback ?? task.human_feedback;
  return {
    kind: "implement_task",
    task_id: task.id,
    scope_id: scope.id,
    goal: task.title,
    body: [
      buildImplementBody(task, executionContext, historical, operatorFeedback, {
        openMr: continuity.openMr,
        gateFailure: continuity.currentGateFailure ?? continuity.gateFailure,
        reviewFindings:
          continuity.currentReviewFindings ?? continuity.reviewFindings,
        rejectedHeadSha:
          continuity.currentRejectedHeadSha ?? continuity.rejectedHeadSha,
        legacy:
          continuity.currentGateFailure === undefined &&
          continuity.currentReviewFindings === undefined &&
          continuity.currentRejectedHeadSha === undefined,
      }),
      projectContextSection(project),
      projectFilesSection(files),
    ]
      .filter(Boolean)
      .join("\n"),
    project: packetProject(project, files),
    repo: {
      url: scope.provider_repo_path,
      branch,
      base_commit: baseSha,
    },
    execution_context: executionContext,
    ...((continuity.currentRejectedHeadSha ?? continuity.rejectedHeadSha)
      ? {
          repair: {
            rejected_head_sha:
              continuity.currentRejectedHeadSha ?? continuity.rejectedHeadSha!,
          },
        }
      : {}),
  };
}

function freshImplementExecutionContext(
  branch: string,
  targetBranch: string,
  targetHeadSha: string,
): ImplementExecutionContext {
  return {
    mode: "fresh",
    branch,
    target_branch: targetBranch,
    target_head_sha: targetHeadSha,
    remote_head: { status: "not_requested" },
    pipeline: { status: "not_requested" },
    current_objective:
      "Implement the durable task requirements on the new task branch.",
  };
}

function legacyHistoricalEvidence(
  continuity: ImplementContinuity,
): ImplementHistoricalEvidence[] {
  const entries: ImplementHistoricalEvidence[] = [];
  if (continuity.interrupted) {
    entries.push({
      kind: "interrupted",
      at: "timestamp unavailable",
      text: continuity.interrupted,
    });
  }
  return entries;
}

export function buildReviewPacket(
  task: Task,
  scope: Scope,
  project: Project | null,
  files: readonly ProjectFile[],
  _repo: ProviderRepoRef,
  headSha: string,
): ReviewPacket {
  return {
    kind: "review_task",
    task_id: task.id,
    scope_id: scope.id,
    goal: task.title,
    head_sha: headSha,
    mr_iid: task.mr_iid,
    target_branch: scope.default_branch,
    body: [
      buildReviewBody(task, scope.default_branch),
      projectContextSection(project),
      projectFilesSection(files),
    ]
      .filter(Boolean)
      .join("\n"),
    project: packetProject(project, files),
    repo: {
      url: scope.provider_repo_path,
      branch: task.branch ?? `colony/${task.id}`,
      base_commit: headSha,
    },
  };
}

function buildArchitectBody(
  scope: Scope,
  revisionContext?: ArchitectRevisionContext,
): string {
  const lines = [
    `Scope goal: ${scope.goal}`,
    "",
    "Inspect the repository (read-only) before decomposing.",
    "Emit architect_decomposition with at most 20 outcome-oriented tasks.",
    "Emit an acceptance array of at least one { description, command } entry proving the SCOPE goal (not per-task evidence). Each command must be objective, cheap to run, tied to an observable outcome of the scope goal, runnable from a fresh checkout of the default branch at HEAD, and exit non-zero if the goal does not hold.",
    "Each task spec must contain: goal, user-observable behavior, invariants, required evidence.",
    "Prefer coarse vertical tasks over file-sliced tasks.",
    "Two tasks must not both introduce schema migrations unless one depends on the other.",
    "depends_on entries are indexes into the tasks array; the graph must be acyclic.",
    "depends_on must be EXPLICIT: if task B touches anything task A creates (files, packages, exports), B depends on A. An empty depends_on is a claim the task can run first in a fresh checkout.",
    "Every task must land green ALONE on top of main: its own MR must pass install, typecheck, lint, and tests without any sibling task. New workspace packages must regenerate the lockfile in the same task.",
    "Pure verify/QA tasks with no diff cannot pass a merge gate — fold verification into the task that produces the change, as required evidence.",
    "Tasks creating shared contracts (schemas, wire protocols, exported test suites) must say so in their spec: contract changes are permanent and get the strictest review.",
  ];
  const directives = operatorPlanDirectivesSection(scope);
  if (directives) lines.push("", directives);
  if (scope.plan_feedback) {
    lines.push(
      "",
      "## Findings from the latest rejected plan review",
      scope.plan_feedback,
      "",
      "Revise the decomposition to address these findings without dropping the scope goal or any non-superseded operator directive.",
    );
  }
  if (revisionContext) {
    lines.push(
      "",
      "## Exact prior rejected plan — revision context",
      `Reviewed plan hash: \`${revisionContext.plan_hash}\`; review run: \`${revisionContext.review_run_id}\`; reviewed base HEAD: \`${revisionContext.review_base_sha}\`; planning epoch: \`${revisionContext.planning_epoch}\`.`,
      "Use this exact rejected plan as an amendment starting point, not as permission to cold-regenerate or resurrect unrelated work. Re-ground repository facts at the current HEAD and preserve every durable requirement and directive.",
    );
  }
  return lines.join("\n");
}

function buildImplementBody(
  task: Task,
  execution: ImplementExecutionContext,
  historical: readonly ImplementHistoricalEvidence[],
  operatorFeedback: string | null | undefined,
  current: {
    openMr?: string;
    gateFailure?: string;
    reviewFindings?: string;
    rejectedHeadSha?: string;
    legacy?: boolean;
  },
): string {
  const sections = [
    "## Current execution brief",
    execution.current_objective,
    `Mode: ${execution.mode}. Inspect current repository and provider facts before editing.`,
    "Do not re-derive or reimplement a completed feature. Do not blindly repeat an old CI fix; verify the current failure and the current diff first.",
    "Resolve and verify every unresolved review finding that applies to the current head.",
    "",
    "## Current provider facts",
    `Task branch: \`${execution.branch}\`; target branch: \`${execution.target_branch}\`; target/base HEAD: \`${execution.target_head_sha}\`.`,
    formatFact(
      "Remote task-branch HEAD",
      execution.remote_head,
      (sha) => `\`${sha}\``,
    ),
    formatFact(
      "Current pipeline",
      execution.pipeline,
      (pipeline) =>
        `status \`${pipeline.status}\`${pipeline.commit_sha ? ` at \`${pipeline.commit_sha}\`` : ""}`,
    ),
    ...(current.gateFailure && !current.legacy
      ? [
          "",
          "## Current gate failure — verify and repair only this outcome",
          current.gateFailure,
        ]
      : []),
    ...(current.reviewFindings && !current.legacy
      ? [
          "",
          "## Current review findings — verify each unresolved finding",
          current.reviewFindings,
          current.rejectedHeadSha
            ? `This applies to current head \`${current.rejectedHeadSha}\`; a repair completion MUST submit a different pushed head SHA.`
            : "",
        ]
      : []),
    "",
    "## Durable task requirements (original specification)",
    task.spec,
  ];
  sections.push(
    "",
    "## Invariants",
    ...(execution.mode === "repair"
      ? [
          "- Start repair work from the remote task branch (`git fetch origin <task branch>` and inspect `origin/<task branch>`); preserve the existing implementation.",
        ]
      : []),
    "- Work on the branch provided in packet.repo; commit there and push.",
    "- colonyd opens the merge request after your run — do NOT open an MR yourself.",
    "- Never commit PACKET.json or credentials; keep the diff limited to this task.",
    "- Use incremental compiling checkpoints; run targeted tests (`bun test <paths you touched>`) plus typecheck. For cross-package changes, verify breadth with `bun run test:unit` (integration tests excluded). Avoid the full `npm test`: its integration tests exceed the sandbox deadline and CI/review run the full suite.",
    "- Push your work early after a green checkpoint; unpushed work does not survive this sandbox.",
    "- If push reports non-fast-forward, resolve it before unrelated edits using the repository's existing conventions; do not squash or rewrite remote history gratuitously.",
    "- Before submitting, fetch the target branch and reconcile it using the repository's existing conventions. If reconciliation touched your files, rerun targeted checks.",
    "- Before submitting: verify the exact pushed head and include command evidence.",
    "- Submit implementer_completion with the exact branch and head SHA you pushed.",
  );
  if (current.legacy && current.openMr) {
    sections.push(
      "",
      "## An MR for this task already exists — LAND IT (legacy evidence; verify current facts)",
      current.openMr,
      "Do NOT start over or open a new MR.",
    );
  }
  if (current.legacy && current.gateFailure) {
    sections.push(
      "",
      "## Historical gate evidence (legacy input; verify before acting)",
      current.gateFailure,
    );
  }
  if (current.legacy && current.reviewFindings) {
    sections.push(
      "",
      "## Historical review evidence (legacy input; verify against current head)",
      current.reviewFindings,
    );
    if (current.rejectedHeadSha) {
      sections.push(
        `The reviewer rejected historical head \`${current.rejectedHeadSha}\`; do not assume that rejection applies to the current head.`,
      );
    }
  }
  if (historical.length > 0) {
    sections.push("", "## Historical evidence (dated and revision-scoped)");
    for (const evidence of historical) {
      const revision = evidence.head_sha
        ? ` at head \`${evidence.head_sha}\``
        : "";
      sections.push(
        `### ${evidence.kind} — ${evidence.at}${revision}`,
        evidence.text,
      );
    }
  }
  if (operatorFeedback?.trim()) {
    sections.push(
      "",
      "## Current operator feedback",
      operatorFeedback,
      "Treat this as operator guidance, retain it, and reconcile it with the durable task requirements without silently dropping either.",
    );
  }
  return sections.join("\n");
}

function formatFact<T>(
  label: string,
  fact: ImplementFact<T>,
  format: (value: T) => string,
): string {
  if (fact.status === "known") return `${label}: ${format(fact.value)}.`;
  if (fact.status === "unknown") return `${label}: UNKNOWN (${fact.reason}).`;
  return `${label}: not requested for this fresh task.`;
}

function buildReviewBody(task: Task, defaultBranch: string): string {
  return [
    task.spec,
    "",
    "## Review instructions",
    `Diff against origin/${defaultBranch} (\`git diff origin/${defaultBranch}...HEAD\`) and inspect changed files.`,
    "Judge spec compliance and defects. Do not edit files or push.",
    "Sections titled 'Spec amendment (operator...)' are authoritative and supersede earlier spec text they contradict.",
    "Review adversarially — actively look for a reason to reject:",
    "- Trace EVERY input path (config file, env var, override parameter, API body) to its validation; an input accepted on one path but rejected on another is a finding.",
    "- Verify claimed guarantees hold under the substrate: process trees vs single processes, pipe ordering, path resolution, lockfile/CI sync.",
    "- For shared contracts (schemas, wire protocols, exported test suites): over-specification is as much a defect as under-specification — flag assertions no implementation can honestly guarantee.",
    "- Check the change lands green alone: new workspace packages must be in the lockfile, new files in CI's reach.",
    "- Do NOT re-run test suites: the MR pipeline already ran them and the merge gate blocks on its result. Targeted single-file test runs and small hand-written probes are fine; full or per-package suite runs are wasted budget.",
    "- Budget for the verdict: reading and probing should take most of your run, but ALWAYS leave time to submit. A defensible verdict on time beats a perfect one that times out.",
    "Submit reviewer_verdict with the exact head SHA you inspected (`git rev-parse HEAD`).",
    "request_changes requires at least one finding.",
  ].join("\n");
}
