import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import type {
  AuditRecord,
  ProviderProject,
  Scope,
  ScopeId,
  Task,
} from "@colony/domain";
import {
  apiConfigFromEnv,
  createApiClient,
  type ApiError,
  type DecompositionProposalSummary,
  type ScopeCloseReadinessSummary,
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
  let closeReadiness: ScopeCloseReadinessSummary | null = null;
  let providerProjects: readonly ProviderProject[] = [];
  let loadError: string | null = null;

  try {
    scope = await api.getScope(scopeId);
    if (!scope) {
      throw error(404, `scope not found: ${scopeId}`);
    }
    const [
      taskList,
      ready,
      auditList,
      sync,
      proposalList,
      readiness,
      projects,
    ] = await Promise.all([
      api.listTasks(scopeId),
      api.readyTasks(scopeId),
      api.scopeAudit(scopeId, { limit: 50 }),
      api.scopeProviderSync(scopeId),
      api.listDecompositionProposals(scopeId).catch(() => []),
      api.scopeCloseReadiness(scopeId).catch(() => null),
      api.listProviderProjects().catch(() => []),
    ]);
    tasks = taskList;
    readyTaskIds = new Set(ready.map((t) => t.id));
    audit = auditList;
    providerSync = sync;
    proposals = proposalList;
    closeReadiness = readiness;
    providerProjects = projects;
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
    closeReadiness,
    providerProjects,
    loadError,
  };
};

export const actions: Actions = {
  runArchitect: async ({ params, request, fetch }) => {
    const form = await request.formData();
    const providerProjectId = String(
      form.get("provider_project_id") ?? "",
    ).trim();
    const api = createApiClient({ ...apiConfigFromEnv(process.env), fetch });
    try {
      await api.requestDecomposition(params.scopeId as ScopeId, {
        provider_project_id: providerProjectId || undefined,
        reason: "web_ui_run_architect",
      });
      return {
        action: "runArchitect" as const,
        notice: "Architect requested.",
      };
    } catch (e) {
      const err = e as ApiError;
      return fail(err.status || 500, {
        action: "runArchitect",
        error: err.message ? `${err.code}: ${err.message}` : String(e),
      });
    }
  },
};
