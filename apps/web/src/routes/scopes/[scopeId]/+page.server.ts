import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import type { AuditRecord, Scope, ScopeId, Task } from "@colony/domain";
import {
  apiConfigFromEnv,
  createApiClient,
  type ApiError,
  type DecompositionProposalSummary,
  type ScopeProviderSync,
} from "$lib/api";

export const load: PageServerLoad = async ({ fetch, params }) => {
  const cfg = apiConfigFromEnv(process.env);
  const api = createApiClient({ ...cfg, fetch });
  const scopeId = params.scopeId as ScopeId;

  let scope: Scope | null = null;
  let tasks: readonly Task[] = [];
  let readyTaskIds: Set<string> = new Set();
  let audit: readonly AuditRecord[] = [];
  let providerSync: ScopeProviderSync | null = null;
  let proposals: readonly DecompositionProposalSummary[] = [];
  let loadError: string | null = null;

  try {
    scope = await api.getScope(scopeId);
    if (!scope) {
      throw error(404, `scope not found: ${scopeId}`);
    }
    const [taskList, ready, auditList, sync, proposalList] = await Promise.all([
      api.listTasks(scopeId),
      api.readyTasks(scopeId),
      api.scopeAudit(scopeId, { limit: 50 }),
      api.scopeProviderSync(scopeId),
      api.listDecompositionProposals(scopeId).catch(() => []),
    ]);
    tasks = taskList;
    readyTaskIds = new Set(ready.map((t) => t.id));
    audit = auditList;
    providerSync = sync;
    proposals = proposalList;
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
    providerSync,
    proposals,
    loadError,
  };
};
