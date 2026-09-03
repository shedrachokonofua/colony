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

export interface ArchitectPacket {
  kind: "architect_scope";
  scope_id: string;
  goal: string;
  body: string;
  project: PacketProject | null;
  repo: AgentPacketRepo;
  /** Findings from the previous plan's review (reviewer or operator). */
  plan_feedback?: string;
}

export interface PlanReviewPacket {
  kind: "plan_review";
  scope_id: string;
  goal: string;
  body: string;
  project: PacketProject | null;
  repo: AgentPacketRepo;
  plan: ArchitectDecompositionV2;
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

export interface ImplementPacket {
  kind: "implement_task";
  task_id: string;
  scope_id: string;
  goal: string;
  body: string;
  project: PacketProject | null;
  repo: AgentPacketRepo;
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

export function buildArchitectPacket(
  scope: Scope,
  project: Project | null,
  files: readonly ProjectFile[],
  _repo: ProviderRepoRef,
  baseSha: string,
): ArchitectPacket {
  return {
    kind: "architect_scope",
    scope_id: scope.id,
    goal: scope.goal,
    body: [
      buildArchitectBody(scope),
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
      `Plan review round ${round}. Judge the proposed plan against this repository and submit plan_review_verdict.`,
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
  interrupted?: string;
  /** Set when the task already has an open MR: land it, do not restart. */
  openMr?: string;
  gateFailure?: string;
  reviewFindings?: string;
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
  return {
    kind: "implement_task",
    task_id: task.id,
    scope_id: scope.id,
    goal: task.title,
    body: [
      buildImplementBody(task, continuity),
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
  };
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

function buildArchitectBody(scope: Scope): string {
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
  if (scope.plan_feedback) {
    lines.push(
      "",
      "## Operator feedback on your previous plan",
      scope.plan_feedback,
      "",
      "The previous decomposition was rejected. Revise it to address this feedback.",
    );
  }
  return lines.join("\n");
}

function buildImplementBody(
  task: Task,
  continuity: ImplementContinuity,
): string {
  const sections = [
    task.spec,
    "",
    "## Invariants",
    "- Work on the branch provided in packet.repo; commit there and push.",
    "- colonyd opens the merge request after your run — do NOT open an MR yourself.",
    "- Never commit PACKET.json or credentials; keep the diff limited to this task.",
    "- Iterate with targeted tests (bun test <paths you touched>) plus typecheck. For cross-package changes, verify breadth with `bun run test:unit` (integration tests excluded). Avoid the full `npm test`: its integration tests exceed the sandbox's 15-minute exec deadline and return nothing — CI and review run the full suite for you.",
    "- Push your work early and after every green test run; unpushed work does not survive this sandbox.",
    "- Before submitting: git fetch origin && git rebase origin/<target branch>. Resolve conflicts now - you have the context; a later run does not. If the rebase touched your files, rerun your targeted tests.",
    "- Submit implementer_completion with the exact branch and head SHA you pushed.",
  ];
  if (continuity.interrupted) {
    sections.push(
      "",
      "## Previous attempt was interrupted — RESUME MODE",
      continuity.interrupted,
    );
  }
  if (continuity.openMr) {
    sections.push(
      "",
      "## An MR for this task already exists — LAND IT",
      continuity.openMr,
      "Rebase the existing branch onto the target branch, resolve conflicts,",
      "and push to the same branch. Do NOT start over or open a new MR.",
    );
  }
  if (continuity.gateFailure) {
    sections.push(
      "",
      "## Previous gate failure — LANDING MODE",
      continuity.gateFailure,
      "",
      "The task's implementation was already written and reviewed. Your job",
      "now is to LAND it, not to re-derive or redesign it:",
      "- Rebase the existing branch onto the latest target branch and resolve",
      "  merge conflicts minimally, preserving the reviewed change.",
      "- Fix failing tests/lint/typecheck with the smallest change that makes",
      "  the suite green — if a test broke because main moved underneath you,",
      "  reconcile with main's behavior rather than reverting main's changes.",
      "- Keep the final diff against the target branch as close as possible",
      "  to the previously reviewed diff. Review re-runs at your new head;",
      "  gratuitous changes cost another full cycle.",
      "- Run the full gate-relevant checks (install, typecheck, lint, tests)",
      "  before submitting and include them as command evidence.",
    );
  }
  if (continuity.reviewFindings) {
    sections.push("", "## Previous review findings", continuity.reviewFindings);
  }
  if (task.human_feedback) {
    sections.push("", "## Operator feedback", task.human_feedback);
  }
  return sections.join("\n");
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
