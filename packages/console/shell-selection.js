// The shell's deferred task selection: a Running-tab row navigates before the
// scope's detail has loaded, so the task id waits here until a refresh lands a
// detail that actually contains it.
import { parsePlan } from "./dag.js";

/**
 * Select the parked task once the detail holds it, opening its drawer. A task
 * the detail does not contain leaves the id parked: the row's scope may still
 * be loading, and selecting a phantom row would open an empty drawer.
 *
 * @param {import("./shell-data.js").ShellState} app
 * @param {Record<string, any> | null} detail
 */
export function consumePendingTaskSelection(app, detail) {
  const taskId = app.pendingSelectTaskId;
  if (!taskId || !detail) return;
  const tasks = /** @type {any[]} */ (detail.tasks ?? []);
  if (!taskId.startsWith("plan:")) {
    if (!tasks.some((task) => task.id === taskId)) return;
  } else {
    const index = Number(taskId.slice(5));
    const plan = parsePlan(detail.scope?.plan_json);
    if (!Number.isInteger(index) || !plan?.tasks[index]) return;
  }
  app.pendingSelectTaskId = null;
  app.selectedTaskId = taskId;
  app.drawerOpen = true;
  app.confirm = null;
  app.runEvents = null;
}
