import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import type { AuditRecord, ScopeId, Task, TaskId } from "@colony/domain";
import {
  apiConfigFromEnv,
  createApiClient,
  type ApiError,
  type ProviderSyncItem,
} from "$lib/api";

export const load: PageServerLoad = async ({ fetch, params }) => {
  const cfg = apiConfigFromEnv(process.env);
  const api = createApiClient({ ...cfg, fetch });
  const scopeId = params.scopeId as ScopeId;
  const taskId = params.taskId as TaskId;

  let task: Task | null = null;
  let deps: { blocked_by: readonly TaskId[]; blocks: readonly TaskId[] } = {
    blocked_by: [],
    blocks: [],
  };
  let audit: readonly AuditRecord[] = [];
  let providerSync: ProviderSyncItem | null = null;
  let loadError: string | null = null;

  try {
    task = await api.getTask(taskId);
    if (!task) throw error(404, `task not found: ${taskId}`);
    if (task.scope_id !== scopeId) {
      throw error(404, `task ${taskId} is not in scope ${scopeId}`);
    }
    const [depsResult, auditList, sync] = await Promise.all([
      api.getTaskDependencies(taskId),
      api.scopeAudit(scopeId, { taskId, limit: 50 }),
      api.taskProviderSync(taskId),
    ]);
    if (depsResult) deps = depsResult;
    audit = auditList;
    providerSync = sync;
  } catch (e) {
    if ((e as { status?: number }).status) throw e;
    const err = e as ApiError;
    loadError = err.message
      ? `${err.code ?? "ERR"}: ${err.message}`
      : String(e);
  }

  return { scopeId, task, deps, audit, providerSync, loadError };
};
