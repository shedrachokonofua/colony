import type {
  AuditRecord,
  Event,
  ProviderMirror,
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

export interface ApiClient {
  listScopes(): Promise<readonly Scope[]>;
  getScope(id: ScopeId): Promise<Scope | null>;
  listTasks(scopeId: ScopeId): Promise<readonly Task[]>;
  readyTasks(scopeId: ScopeId): Promise<readonly Task[]>;
  scopeProviderSync(scopeId: ScopeId): Promise<ScopeProviderSync>;
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
