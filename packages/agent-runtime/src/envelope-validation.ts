import type {
  ArchitectDecompositionV2,
  TaskCostModelV1,
} from "@colony/schemas";
import type { ArchitectSizeGate } from "./pi-runner-common.js";
import type { ArchitectExtensionEnvelope } from "./architect-extension.js";

export type DecompositionValidationRule =
  | "depends_on_range"
  | "depends_on_cycle"
  | "phantom_dependency"
  | "shared_file_without_edge"
  | "task_over_budget";

export interface DecompositionValidationError {
  readonly taskIndex: number | null;
  readonly rule: DecompositionValidationRule;
  readonly message: string;
}

// A spec that asserts a sibling task produces its precondition — without
// declaring the edge in depends_on — describes a dependency the plan graph
// does not contain. The default branch has no such contract, so the task
// cannot land green alone.
const PHANTOM_DEPENDENCY_PATTERNS: readonly RegExp[] = [
  /created by (a |an )?(prior|previous|sibling|earlier) task/i,
  /produced by (a |an )?(prior|previous|sibling|earlier) task/i,
  /defined by (a |an )?(prior|previous|sibling|earlier) task/i,
  /(verify|check|confirm)( that)? it exists before (starting|you start|beginning)/i,
  /stop and report if (it is |the contract is )?missing/i,
];

const FILE_PATH_PATTERN =
  /[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)+\.[A-Za-z0-9]{1,8}/g;

function checkDependsOnRange(
  envelope: ArchitectDecompositionV2,
): DecompositionValidationError[] {
  const errors: DecompositionValidationError[] = [];
  const taskCount = envelope.tasks.length;
  for (const [taskIndex, task] of envelope.tasks.entries()) {
    for (const dependency of task.depends_on) {
      if (
        !Number.isInteger(dependency) ||
        dependency < 0 ||
        dependency >= taskCount
      ) {
        errors.push({
          taskIndex,
          rule: "depends_on_range",
          message:
            `task ${taskIndex} ("${task.title}") depends_on index ${dependency}, ` +
            `but the tasks array has only ${taskCount} entries. Use an index ` +
            `between 0 and ${taskCount - 1}, or remove the edge.`,
        });
      }
    }
  }
  return errors;
}

function checkDependsOnCycle(
  envelope: ArchitectDecompositionV2,
): DecompositionValidationError[] {
  const errors: DecompositionValidationError[] = [];
  const remaining = new Set(envelope.tasks.keys());
  // pendingPrerequisiteCount[i] = number of not-yet-removed edges pointing at i.
  const pendingEdgeCounts = new Map<number, number>();
  const dependentTasks = new Map<number, number[]>();
  for (const [taskIndex, task] of envelope.tasks.entries()) {
    for (const prerequisite of task.depends_on) {
      if (!remaining.has(prerequisite)) continue;
      pendingEdgeCounts.set(
        prerequisite,
        (pendingEdgeCounts.get(prerequisite) ?? 0) + 1,
      );
      if (!dependentTasks.has(taskIndex)) dependentTasks.set(taskIndex, []);
      dependentTasks.get(taskIndex)!.push(prerequisite);
    }
  }
  while (remaining.size > 0) {
    const ready = [...remaining].filter(
      (index) => (pendingEdgeCounts.get(index) ?? 0) === 0,
    );
    if (ready.length === 0) break;
    for (const index of ready) remaining.delete(index);
    for (const index of ready) {
      for (const dependent of dependentTasks.get(index) ?? []) {
        pendingEdgeCounts.set(
          dependent,
          (pendingEdgeCounts.get(dependent) ?? 1) - 1,
        );
      }
    }
  }
  if (remaining.size === 0) return errors;
  errors.push({
    taskIndex: null,
    rule: "depends_on_cycle",
    message:
      `tasks [${[...remaining].sort((a, b) => a - b).join(", ")}] form a ` +
      `dependency cycle. Restructure the depends_on graph so every edge ` +
      `points from a later task to an earlier one.`,
  });
  return errors;
}

function findPhantomDependencyPhrase(spec: string): string | null {
  for (const pattern of PHANTOM_DEPENDENCY_PATTERNS) {
    const match = pattern.exec(spec);
    if (match) return match[0];
  }
  return null;
}

function checkPhantomDependencies(
  envelope: ArchitectDecompositionV2,
): DecompositionValidationError[] {
  const errors: DecompositionValidationError[] = [];
  for (const [taskIndex, task] of envelope.tasks.entries()) {
    if (task.depends_on.length > 0) continue;
    const phrase = findPhantomDependencyPhrase(task.spec);
    if (!phrase) continue;
    errors.push({
      taskIndex,
      rule: "phantom_dependency",
      message:
        `task ${taskIndex} ("${task.title}") asserts a sibling-produced ` +
        `contract with empty depends_on: "${phrase}". Declare the edge in ` +
        `depends_on, or restate the spec so the contract is asserted against ` +
        `the default branch.`,
    });
  }
  return errors;
}

function extractFilePaths(spec: string): string[] {
  const matches = spec.match(FILE_PATH_PATTERN) ?? [];
  return [
    ...new Set(
      matches.map((path) => (path.startsWith("./") ? path.slice(2) : path)),
    ),
  ];
}

function reachableFrom(
  start: number,
  deps: ReadonlyArray<readonly number[]>,
): Set<number> {
  const reached = new Set<number>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.pop()!;
    // Out-of-range indexes are reported by depends_on_range; do not crash here.
    for (const next of deps[current] ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

function checkSharedFilesWithoutEdge(
  envelope: ArchitectDecompositionV2,
): DecompositionValidationError[] {
  const errors: DecompositionValidationError[] = [];
  const pathsByTask = envelope.tasks.map((task) => extractFilePaths(task.spec));
  const reachable = envelope.tasks.map((_task, index) =>
    reachableFrom(
      index,
      envelope.tasks.map((t) => t.depends_on),
    ),
  );
  for (let first = 0; first < envelope.tasks.length; first++) {
    for (let second = first + 1; second < envelope.tasks.length; second++) {
      const shared = pathsByTask[first].filter((p) =>
        pathsByTask[second].includes(p),
      );
      const connected =
        reachable[first].has(second) || reachable[second].has(first);
      if (shared.length === 0 || connected) continue;
      errors.push({
        taskIndex: first,
        rule: "shared_file_without_edge",
        message:
          `tasks ${first} ("${envelope.tasks[first].title}") and ${second} ` +
          `("${envelope.tasks[second].title}") both reference ` +
          `${shared.join(", ")}. Add a depends_on edge between them, or ` +
          `confine the reference to one task.`,
      });
    }
  }
  return errors;
}

/**
 * Per-task session-cost arithmetic mirroring `predictTaskCost` (@colony/core).
 * That module lives behind a dependency this package must not take — colonyd
 * builds the model and supplies it precomputed — so only the linear cost
 * line is replicated here, against the same deduped path list.
 */
function predictTaskCost(
  model: TaskCostModelV1,
  filePaths: readonly string[],
  budgetMs: number,
): { predicted_ms: number; budget_ms: number; files_touched: number } {
  const files = [...new Set(filePaths)];
  const predicted_ms = model.ms_per_file * files.length;
  return { predicted_ms, budget_ms: budgetMs, files_touched: files.length };
}

/**
 * Predicted per-task session cost from the offline model must fit the
 * implementer budget. Oversized tasks get the same replan treatment as DAG
 * defects: a named mechanical error and an open session — the machine never
 * splits a task automatically.
 */
function checkTaskOverBudget(
  envelope: ArchitectDecompositionV2,
  gate: ArchitectSizeGate,
): DecompositionValidationError[] {
  const errors: DecompositionValidationError[] = [];
  for (const [taskIndex, task] of envelope.tasks.entries()) {
    const prediction = predictTaskCost(
      gate.model,
      extractFilePaths(task.spec),
      gate.budget_ms,
    );
    if (prediction.predicted_ms <= prediction.budget_ms) continue;
    errors.push({
      taskIndex,
      rule: "task_over_budget",
      message:
        `task ${taskIndex} ("${task.title}") predicted ${prediction.predicted_ms} ms ` +
        `from ${prediction.files_touched} spec file paths (model v1, ${gate.model.sample_size} samples) ` +
        `which exceeds the ${prediction.budget_ms} ms implementer budget. Re-plan this task into smaller outcome-oriented tasks.`,
    });
  }
  return errors;
}

export function validateDecompositionEnvelope(
  envelope: ArchitectDecompositionV2,
  gate?: ArchitectSizeGate,
): DecompositionValidationError[] {
  return [
    ...checkDependsOnRange(envelope),
    ...checkDependsOnCycle(envelope),
    ...checkPhantomDependencies(envelope),
    ...checkSharedFilesWithoutEdge(envelope),
    ...(gate ? checkTaskOverBudget(envelope, gate) : []),
  ];
}
/**
 * Validate only the graph delta in an architect extension. Existing task ids
 * are the stable namespace; numeric references are indexes into the appended
 * task list. Building one graph before running Kahn's algorithm catches a new
 * task cycle that only appears through an edge back into an existing chain.
 */
export function validateExtensionEnvelope(
  envelope: Extract<ArchitectExtensionEnvelope, { kind: "extend" }>,
  existingTasks: readonly { id: string; depends_on: readonly string[] }[],
): DecompositionValidationError[] {
  const errors: DecompositionValidationError[] = [];
  const existingIds = new Set(existingTasks.map((task) => task.id));
  const nodeForIndex = (index: number): string => `new:${index}`;
  const nodes = [
    ...existingTasks.map((task) => task.id),
    ...envelope.tasks.map((_task, index) => nodeForIndex(index)),
  ];
  const deps = new Map<string, string[]>();
  for (const task of existingTasks) {
    deps.set(
      task.id,
      task.depends_on.filter((id) => existingIds.has(id)),
    );
  }
  for (const [taskIndex, task] of envelope.tasks.entries()) {
    const taskDeps: string[] = [];
    for (const dependency of task.depends_on) {
      if (typeof dependency === "number") {
        if (
          !Number.isInteger(dependency) ||
          dependency < 0 ||
          dependency >= envelope.tasks.length ||
          dependency === taskIndex
        ) {
          errors.push({
            taskIndex,
            rule: "depends_on_range",
            message:
              `task ${taskIndex} ("${task.title}") depends_on new-task index ${dependency}, ` +
              `but the extension has ${envelope.tasks.length} tasks.`,
          });
          continue;
        }
        taskDeps.push(nodeForIndex(dependency));
      } else if (!existingIds.has(dependency)) {
        errors.push({
          taskIndex,
          rule: "depends_on_range",
          message: `task ${taskIndex} ("${task.title}") depends_on unknown existing task id "${dependency}".`,
        });
      } else {
        taskDeps.push(dependency);
      }
    }
    deps.set(nodeForIndex(taskIndex), taskDeps);
  }
  const remaining = new Set(nodes);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [node, nodeDeps] of deps) {
    indegree.set(node, nodeDeps.length);
    for (const prerequisite of nodeDeps) {
      const list = dependents.get(prerequisite) ?? [];
      list.push(node);
      dependents.set(prerequisite, list);
    }
  }
  while (remaining.size > 0) {
    const ready = [...remaining].filter(
      (node) => (indegree.get(node) ?? 0) === 0,
    );
    if (ready.length === 0) break;
    for (const node of ready) remaining.delete(node);
    for (const node of ready) {
      for (const dependent of dependents.get(node) ?? []) {
        indegree.set(dependent, (indegree.get(dependent) ?? 1) - 1);
      }
    }
  }
  if (remaining.size > 0) {
    errors.push({
      taskIndex: null,
      rule: "depends_on_cycle",
      message: `combined existing + extension tasks form a dependency cycle: ${[...remaining].join(", ")}.`,
    });
  }
  return errors;
}
