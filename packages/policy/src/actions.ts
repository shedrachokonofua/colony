import type { Capability } from "@colony/domain";

/**
 * Coarse task-graph operations the HTTP API maps to for policy (COL-0.8 / COL-0.9).
 */
export type TaskGraphAction =
  | "scope.create"
  | "scope.read"
  | "scope.list"
  | "task.create"
  | "task.read"
  | "task.list"
  | "ready.read"
  | "task.claim"
  | "event.record"
  | "audit.read";

const READ_ACTIONS: ReadonlySet<TaskGraphAction> = new Set([
  "scope.read",
  "scope.list",
  "task.read",
  "task.list",
  "ready.read",
  "audit.read",
]);

export function requiredCapabilityForAction(
  action: TaskGraphAction,
): Capability {
  if (action === "task.claim") return "task.claim";
  if (READ_ACTIONS.has(action)) return "graph.read";
  return "graph.write";
}
