import type { ArchitectDecompositionV2 } from "./envelopes/v2.js";

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

/** A finding of the review that rejected a plan: the task it names, if any. */
export interface RejectingFinding {
  readonly task?: number;
}

/**
 * Why a revision is not a patch of the plan its review rejected. Rewriting
 * tasks nobody flagged is where most revision-introduced defects came from
 * (2026-09-29 audit: about half of the blockers raised against revised plans
 * were defects the revision itself created), so a revision may change or
 * remove only the tasks a finding named. Any other task it changes or removes
 * is declared in unflagged_changes, by its title in the rejected plan, with
 * the reason. Dependency edges alone do not count: they follow from edits
 * elsewhere. Every disputed finding must be a finding of that review.
 */
export function revisionPatchProblems(
  rejected: ArchitectDecompositionV2,
  findings: readonly RejectingFinding[],
  revision: ArchitectDecompositionV2,
): string[] {
  const flagged = new Set<string>();
  for (const finding of findings) {
    const task =
      finding.task === undefined ? undefined : rejected.tasks[finding.task];
    if (task) flagged.add(task.title);
  }
  const declared = new Set(
    (revision.unflagged_changes ?? []).map((change) => change.task),
  );
  const changes = diffPlans(rejected, revision);
  const removed = new Set(changes.removed);
  const changedFields = new Map(
    changes.tasks.map((task) => [
      task.title,
      task.fields.filter((field) => field !== "depends_on"),
    ]),
  );
  const problems: string[] = [];
  for (const { title } of rejected.tasks) {
    if (flagged.has(title) || declared.has(title)) continue;
    if (removed.has(title)) {
      problems.push(
        `task "${title}" is gone although no finding named it: restore it, or list it in unflagged_changes with the reason`,
      );
      continue;
    }
    const fields = changedFields.get(title) ?? [];
    if (fields.length > 0) {
      problems.push(
        `task "${title}" changed (${fields.join(", ")}) although no finding named it: restore its text, or list it in unflagged_changes with the reason`,
      );
    }
  }
  const rejectedTitles = new Set(rejected.tasks.map((task) => task.title));
  for (const title of declared) {
    if (!rejectedTitles.has(title)) {
      problems.push(
        `unflagged_changes names "${title}", which is not a task title of the rejected plan`,
      );
    }
  }
  const disputed = new Set<number>();
  for (const { finding } of revision.disputed_findings ?? []) {
    if (finding > findings.length) {
      problems.push(
        `disputed_findings names finding ${finding}, but the review had ${findings.length}`,
      );
    } else if (disputed.has(finding)) {
      problems.push(`disputed_findings names finding ${finding} twice`);
    }
    disputed.add(finding);
  }
  return problems;
}
