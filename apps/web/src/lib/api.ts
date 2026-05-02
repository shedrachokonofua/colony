import type {
  AuditRecord,
  Event,
  ProviderMirror,
  ProviderProject,
  Scope,
  ScopeId,
  Task,
  TaskId,
} from "@colony/domain";

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ProviderSyncStatus = "synced" | "pending" | "drifted";

export type ProviderSyncMirror = ProviderMirror & {
  readonly status: ProviderSyncStatus;
  readonly provider_url?: string;
};

export interface ProviderSyncItem {
  readonly colony_id: string;
  readonly entity_kind: "scope" | "task";
  readonly status: ProviderSyncStatus;
  readonly mirrors: readonly ProviderSyncMirror[];
}

export interface ScopeProviderSync {
  readonly scope: ProviderSyncItem;
  readonly tasks: readonly ProviderSyncItem[];
}

export interface OAuthProviderConnection {
  readonly id: string;
  readonly status: "active" | "expired" | "revoked";
  readonly granted_by: string;
  readonly granted_at: string;
  readonly refreshed_at: string | null;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

export interface OAuthProviderSummary {
  readonly key: string;
  readonly api: string;
  readonly subscription?: string;
  readonly models: readonly { readonly id: string; readonly name: string }[];
  readonly connection: OAuthProviderConnection | null;
}

export interface ScopeCloseReadinessSummary {
  readonly scope_id: ScopeId;
  readonly ready: boolean;
  readonly reasons: readonly string[];
  readonly open_task_ids: readonly TaskId[];
  readonly blocked_task_ids: readonly TaskId[];
  readonly pending_sync_task_ids: readonly TaskId[];
  readonly conflict_task_ids: readonly TaskId[];
}

export interface DecompositionProposalSummary {
  readonly id: string;
  readonly scope_id: ScopeId;
  readonly scope_state_version: number;
  readonly scope_brief_version: string;
  readonly status:
    | "proposed"
    | "review_approved"
    | "changes_requested"
    | "human_approved"
    | "committed";
  readonly proposed_tasks: ReadonlyArray<{
    readonly proposed_task_id: TaskId;
    readonly title: string;
    readonly description: string;
    readonly acceptance_criteria: readonly string[];
    readonly non_goals?: readonly string[];
    readonly suggested_role?: string;
    readonly suggested_capabilities?: readonly string[];
    readonly estimated_effort_minutes?: number;
  }>;
  readonly proposed_dependencies: ReadonlyArray<{
    readonly from_task_id: TaskId;
    readonly to_task_id: TaskId;
    readonly kind: string;
  }>;
  readonly target_project_mapping: Readonly<Record<string, string>>;
  readonly assumptions: readonly string[];
  readonly open_questions: readonly string[];
  readonly packet_hash: string;
  readonly envelope_hash: string;
  readonly reviewer?: string;
  readonly reviewer_result?:
    | "approved"
    | "changes_requested"
    | "blocked"
    | "escalate";
  readonly human_approved_by?: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface OAuthBeginResponse {
  readonly session_id: string;
  readonly authorize_url: string;
  readonly instructions?: string;
  readonly expires_at: string;
}

export interface ApiClient {
  listScopes(): Promise<readonly Scope[]>;
  createScope(input: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly provider_project_id?: string;
    readonly mirror_scope?: boolean;
  }): Promise<Scope>;
  requestDecomposition(
    scopeId: ScopeId,
    input?: { readonly provider_project_id?: string; readonly reason?: string },
  ): Promise<unknown>;
  listProviderProjects(): Promise<readonly ProviderProject[]>;
  registerProviderProject(input: {
    readonly path: string;
    readonly provider_id?: string;
    readonly default_branch?: string;
    readonly visibility?: "private" | "internal" | "public";
  }): Promise<ProviderProject>;
  getScope(id: ScopeId): Promise<Scope | null>;
  listTasks(scopeId: ScopeId): Promise<readonly Task[]>;
  readyTasks(scopeId: ScopeId): Promise<readonly Task[]>;
  scopeProviderSync(scopeId: ScopeId): Promise<ScopeProviderSync>;
  listDecompositionProposals(
    scopeId: ScopeId,
  ): Promise<readonly DecompositionProposalSummary[]>;
  scopeCloseReadiness(scopeId: ScopeId): Promise<ScopeCloseReadinessSummary>;
  getTask(taskId: TaskId): Promise<Task | null>;
  taskProviderSync(taskId: TaskId): Promise<ProviderSyncItem | null>;
  getTaskDependencies(taskId: TaskId): Promise<{
    readonly blocked_by: readonly TaskId[];
    readonly blocks: readonly TaskId[];
  } | null>;
  scopeAudit(
    scopeId: ScopeId,
    opts?: { taskId?: TaskId; limit?: number },
  ): Promise<readonly AuditRecord[]>;
  health(): Promise<{
    ok: boolean;
    service: string;
    db: { ok: boolean; version?: string; error?: string };
  }>;
  listOAuthProviders(): Promise<readonly OAuthProviderSummary[]>;
  beginOAuthSession(providerKey: string): Promise<OAuthBeginResponse>;
  submitOAuthCode(
    providerKey: string,
    sessionId: string,
    code: string,
  ): Promise<{
    readonly provider_key: string;
    readonly status: "active";
    readonly granted_at: string;
    readonly expires_at: string | null;
  }>;
  cancelOAuthSession(providerKey: string, sessionId: string): Promise<void>;
  revokeOAuthConnection(providerKey: string): Promise<{
    readonly provider_key: string;
    readonly status: "revoked";
  }>;
}

type Fetcher = typeof fetch;

export function createApiClient(opts: {
  baseUrl: string;
  actor: string;
  fetch?: Fetcher;
}): ApiClient {
  const { baseUrl, actor } = opts;
  const f: Fetcher = opts.fetch ?? fetch;

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await f(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "X-Actor-Id": actor,
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      let code = "HTTP_ERROR";
      let message = `HTTP ${res.status}`;
      let details: Record<string, unknown> | undefined;
      try {
        const body = (await res.json()) as {
          error?: { code?: string; message?: string; details?: unknown };
        };
        if (body?.error) {
          code = body.error.code ?? code;
          message = body.error.message ?? message;
          if (
            body.error.details &&
            typeof body.error.details === "object" &&
            !Array.isArray(body.error.details)
          ) {
            details = body.error.details as Record<string, unknown>;
          }
        }
      } catch {
        // ignore — non-JSON body
      }
      const err: ApiError = { status: res.status, code, message };
      if (details !== undefined) err.details = details;
      throw err;
    }
    return (await res.json()) as T;
  }

  return {
    async listScopes() {
      const body = await req<{ items: Scope[] }>("/scopes");
      return body.items;
    },
    async createScope(input) {
      const provider_targets = input.provider_project_id
        ? [{ provider_project_id: input.provider_project_id, role: "primary" }]
        : undefined;
      return req<Scope>("/scopes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `web-create-scope:${input.id}`,
        },
        body: JSON.stringify({
          id: input.id,
          title: input.title,
          description: input.description,
          provider_targets,
          provider_mirror:
            input.provider_project_id && input.mirror_scope
              ? { provider_project_id: input.provider_project_id }
              : undefined,
        }),
      });
    },
    async requestDecomposition(scopeId, input) {
      return req(
        `/scopes/${encodeURIComponent(scopeId)}/decomposition-request`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `web-decomposition-request:${scopeId}`,
          },
          body: JSON.stringify({
            provider_targets: input?.provider_project_id
              ? [
                  {
                    provider_project_id: input.provider_project_id,
                    role: "primary",
                  },
                ]
              : undefined,
            reason: input?.reason ?? "web_ui",
          }),
        },
      );
    },
    async listProviderProjects() {
      const body = await req<{ items: ProviderProject[] }>(
        "/admin/provider/projects",
      );
      return body.items;
    },
    async registerProviderProject(input) {
      const body = await req<{ project: ProviderProject }>(
        "/admin/provider/projects",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `web-register-project:${input.provider_id ?? input.path}`,
          },
          body: JSON.stringify({ provider: "gitlab", ...input }),
        },
      );
      return body.project;
    },
    async getScope(id) {
      try {
        return await req<Scope>(`/scopes/${encodeURIComponent(id)}`);
      } catch (e) {
        if ((e as ApiError).status === 404) return null;
        throw e;
      }
    },
    async listTasks(scopeId) {
      const body = await req<{ items: Task[] }>(
        `/scopes/${encodeURIComponent(scopeId)}/tasks`,
      );
      return body.items;
    },
    async readyTasks(scopeId) {
      const body = await req<{ items: Task[] }>(
        `/scopes/${encodeURIComponent(scopeId)}/ready-tasks`,
      );
      return body.items;
    },
    async scopeProviderSync(scopeId) {
      return req<ScopeProviderSync>(
        `/scopes/${encodeURIComponent(scopeId)}/provider-sync`,
      );
    },
    async listDecompositionProposals(scopeId) {
      const body = await req<{
        proposals: DecompositionProposalSummary[];
      }>(`/scopes/${encodeURIComponent(scopeId)}/decomposition-proposals`);
      return body.proposals;
    },
    async scopeCloseReadiness(scopeId) {
      const body = await req<{ readiness: ScopeCloseReadinessSummary }>(
        `/scopes/${encodeURIComponent(scopeId)}/close-readiness`,
      );
      return body.readiness;
    },
    async getTask(taskId) {
      try {
        return await req<Task>(`/tasks/${encodeURIComponent(taskId)}`);
      } catch (e) {
        if ((e as ApiError).status === 404) return null;
        throw e;
      }
    },
    async taskProviderSync(taskId) {
      try {
        return await req<ProviderSyncItem>(
          `/tasks/${encodeURIComponent(taskId)}/provider-sync`,
        );
      } catch (e) {
        if ((e as ApiError).status === 404) return null;
        throw e;
      }
    },
    async getTaskDependencies(taskId) {
      try {
        return await req<{
          blocked_by: TaskId[];
          blocks: TaskId[];
        }>(`/tasks/${encodeURIComponent(taskId)}/dependencies`);
      } catch (e) {
        if ((e as ApiError).status === 404) return null;
        throw e;
      }
    },
    async scopeAudit(scopeId, opts) {
      const q = new URLSearchParams();
      if (opts?.taskId) q.set("task_id", opts.taskId);
      if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
      const suffix = q.size > 0 ? `?${q}` : "";
      const body = await req<{ items: AuditRecord[] }>(
        `/scopes/${encodeURIComponent(scopeId)}/audit${suffix}`,
      );
      return body.items;
    },
    async health() {
      return req("/health");
    },
    async listOAuthProviders() {
      const body = await req<{ providers: OAuthProviderSummary[] }>(
        "/admin/providers",
      );
      return body.providers;
    },
    async beginOAuthSession(providerKey) {
      return req<OAuthBeginResponse>(
        `/admin/providers/${encodeURIComponent(providerKey)}/oauth/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
    },
    async submitOAuthCode(providerKey, sessionId, code) {
      return req(
        `/admin/providers/${encodeURIComponent(providerKey)}/oauth/submit-code`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, code }),
        },
      );
    },
    async cancelOAuthSession(providerKey, sessionId) {
      await req(
        `/admin/providers/${encodeURIComponent(providerKey)}/oauth/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        },
      );
    },
    async revokeOAuthConnection(providerKey) {
      return req(
        `/admin/providers/${encodeURIComponent(providerKey)}/oauth/connection`,
        { method: "DELETE" },
      );
    },
  };
}

export function apiConfigFromEnv(env: NodeJS.ProcessEnv): {
  baseUrl: string;
  actor: string;
} {
  const baseUrl =
    env["COLONY_API_URL"] ?? `http://localhost:${env["API_PORT"] ?? 4000}`;
  const actor = env["COLONY_WEB_ACTOR"] ?? "human:op-1";
  return { baseUrl, actor };
}

export type { AuditRecord, Event, Scope, Task };
