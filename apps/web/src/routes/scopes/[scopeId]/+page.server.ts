import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import type { AuditRecord, Scope, ScopeId, Task } from "@colony/domain";
import { apiConfigFromEnv, createApiClient, type ApiError } from "$lib/api";

export const load: PageServerLoad = async ({ fetch, params }) => {
  const cfg = apiConfigFromEnv(process.env);
  const api = createApiClient({ ...cfg, fetch });
  const scopeId = params.scopeId as ScopeId;

  let scope: Scope | null = null;
  let tasks: readonly Task[] = [];
  let readyTaskIds: Set<string> = new Set();
  let audit: readonly AuditRecord[] = [];
  let loadError: string | null = null;

  try {
    scope = await api.getScope(scopeId);
    if (!scope) {
      throw error(404, `scope not found: ${scopeId}`);
    }
    const [taskList, ready, auditList] = await Promise.all([
      api.listTasks(scopeId),
      api.readyTasks(scopeId),
      api.scopeAudit(scopeId, { limit: 50 }),
    ]);
    tasks = taskList;
    readyTaskIds = new Set(ready.map((t) => t.id));
    audit = auditList;
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw e;
    const err = e as ApiError;
    loadError = err.message
      ? `${err.code ?? "ERR"}: ${err.message}`
      : String(e);
  }

  return {
    scope,
    tasks,
    readyTaskIds: Array.from(readyTaskIds),
    audit,
    loadError,
  };
};
