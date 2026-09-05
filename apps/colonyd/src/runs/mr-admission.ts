import type { Scope, Task } from "@colony/core";
import type { ColonydContext } from "../context.js";

/**
 * Return the authoritative task snapshot for an MR-derived dispatch when the
 * captured scheduler snapshot is still admissible.
 *
 * This check is deliberately synchronous: callers use it immediately before
 * any run/provider side effect, after every awaited provider operation that
 * could have made their snapshot stale. The task state version is the
 * optimistic concurrency token captured by the caller.
 */
export function getCurrentMrTask(
  ctx: ColonydContext,
  scope: Scope,
  task: Task,
  phase: "dispatch" | "in_flight" = "dispatch",
): Task | undefined {
  if (phase === "dispatch" && ctx.draining.isDraining()) return undefined;
  if (task.scope_id !== scope.id) return undefined;

  const currentScope = ctx.store.getScope(scope.id);
  if (
    !currentScope ||
    currentScope.id !== scope.id ||
    currentScope.status !== "active"
  ) {
    return undefined;
  }

  const currentTask = ctx.store.getTask(task.id);
  if (
    !currentTask ||
    currentTask.id !== task.id ||
    currentTask.scope_id !== scope.id ||
    currentTask.state !== "mr_open" ||
    currentTask.state_version !== task.state_version
  ) {
    return undefined;
  }
  return currentTask;
}

/**
 * Return whether any active merge gate belongs to this provider repository.
 * Merge authority is repository-wide: two scopes targeting one repository
 * must not merge concurrently, while unrelated repositories remain parallel.
 */
export function hasActiveRepositoryMergeGate(
  ctx: ColonydContext,
  scope: Scope,
): boolean {
  return ctx.store.activeRuns("merge_gate").some((run) => {
    const runScope = ctx.store.getScope(run.scope_id);
    return runScope?.provider_repo_id === scope.provider_repo_id;
  });
}
