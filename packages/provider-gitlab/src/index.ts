/* eslint-disable @typescript-eslint/require-await */

import { randomUUID } from "node:crypto";
import {
  defaultEngineBot,
  defaultReviewerBot,
  type BootstrapAction,
  type BootstrapBotSpec,
  type ProviderAdapter,
  type ProviderBootstrapResult,
  type ProviderBootstrapSpec,
  type ProviderCredential,
  type ProviderMetadata,
  type ProviderRef,
  type ProviderUser,
  type ProviderWebhook,
} from "@colony/provider";

export const COLONY_PROVIDER_GITLAB_PACKAGE =
  "@colony/provider-gitlab" as const;

type Fetch = typeof fetch;

interface GitLabProviderAdapterOptions {
  readonly baseUrl: string;
  readonly fetch?: Fetch;
}

interface GitLabEntity {
  readonly id: number | string;
  readonly iid?: number;
  readonly name?: string;
  readonly username?: string;
  readonly email?: string;
  readonly web_url?: string;
  readonly url?: string;
  readonly path?: string;
  readonly token?: string;
  readonly secret?: string;
  readonly application_id?: string;
}

export class GitLabProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "GitLabProviderError";
  }
}

export class GitLabProviderAdapter implements ProviderAdapter {
  readonly provider = "gitlab" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetch;

  constructor(options: GitLabProviderAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  readonly issues: ProviderAdapter["issues"] = {
    create: async () => notImplemented(),
    update: async () => notImplemented(),
    close: async () => notImplemented(),
    reopen: async () => notImplemented(),
    addLabel: async () => notImplemented(),
    removeLabel: async () => notImplemented(),
    setAssignees: async () => notImplemented(),
    comment: async () => notImplemented(),
  };

  readonly epics: ProviderAdapter["epics"] = {
    create: async () => notImplemented(),
    update: async () => notImplemented(),
    close: async () => notImplemented(),
  };

  readonly mergeRequests: ProviderAdapter["mergeRequests"] = {
    open: async () => notImplemented(),
    update: async () => notImplemented(),
    approve: async () => notImplemented(),
    unapprove: async () => notImplemented(),
    merge: async () => notImplemented(),
    close: async () => notImplemented(),
    comment: async () => notImplemented(),
    addReviewThread: async () => notImplemented(),
  };

  readonly branches: ProviderAdapter["branches"] = {
    create: async () => notImplemented(),
    delete: async () => notImplemented(),
    protect: async () => notImplemented(),
  };

  readonly commits: ProviderAdapter["commits"] = {
    get: async () => notImplemented(),
    diff: async () => notImplemented(),
  };

  readonly pipelines: ProviderAdapter["pipelines"] = {
    getStatus: async () => notImplemented(),
    trigger: async () => notImplemented(),
  };

  readonly users: ProviderAdapter["users"] = {
    resolveById: async () => notImplemented(),
    resolveByUsername: async () => notImplemented(),
  };

  readonly webhooks: ProviderAdapter["webhooks"] = {
    register: async () => notImplemented(),
    unregister: async () => notImplemented(),
    verifySignature: async (input) =>
      input.headers["x-gitlab-token"] === input.secret ||
      input.headers["X-Gitlab-Token"] === input.secret,
  };

  async bootstrap(
    input: ProviderBootstrapSpec,
    credential: ProviderCredential,
  ): Promise<ProviderBootstrapResult> {
    const actions: BootstrapAction[] = [];
    const api = <T>(path: string, init?: RequestInit) =>
      this.request<T>(path, credential.token, init);

    const groupPath = input.group.path;
    const existingGroup = await optionalGet<GitLabEntity>(
      () => api(`/groups/${encodeURIComponent(groupPath)}`),
      404,
    );
    const group =
      existingGroup ??
      (await api<GitLabEntity>("/groups", {
        method: "POST",
        body: JSON.stringify({
          name: input.group.name,
          path: input.group.path,
          parent_id: input.group.parent_id,
          visibility: input.group.visibility ?? "private",
        }),
      }));
    actions.push({
      resource: "group",
      status: existingGroup ? "existing" : "created",
      provider_id: String(group.id),
    });

    const fullProjectPath = `${groupPath}/${input.project.path}`;
    const existingProject = await optionalGet<GitLabEntity>(
      () => api(`/projects/${encodeURIComponent(fullProjectPath)}`),
      404,
    );
    const project =
      existingProject ??
      (await api<GitLabEntity>("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: input.project.name,
          path: input.project.path,
          description: input.project.description,
          namespace_id: group.id,
          visibility: input.project.visibility ?? "private",
        }),
      }));
    actions.push({
      resource: "project",
      status: existingProject ? "existing" : "created",
      provider_id: String(project.id),
    });

    const engine = await this.ensureBot(
      api,
      input.bots?.engine ?? defaultEngineBot(),
      actions,
      "engine",
    );
    const reviewer = await this.ensureBot(
      api,
      input.bots?.reviewer ?? defaultReviewerBot(),
      actions,
      "reviewer",
    );
    const engineToken = await this.rotateToken(
      api,
      engine,
      input.bots?.engine ?? defaultEngineBot(),
      actions,
      "engine",
    );
    const reviewerToken = await this.rotateToken(
      api,
      reviewer,
      input.bots?.reviewer ?? defaultReviewerBot(),
      actions,
      "reviewer",
    );

    const oauth = await this.ensureOAuthApplication(api, input, actions);
    const webhook = await this.ensureWebhook(api, input, project, actions);
    const env = {
      GITLAB_BASE_URL: input.base_url,
      GITLAB_DEV_PROJECT_ID: String(project.id),
      GITLAB_TOKEN: engineToken,
      GITLAB_REVIEWER_TOKEN: reviewerToken,
      GITLAB_WEBHOOK_SECRET: webhook.secret,
      OAUTH_CLIENT_ID: oauth.client_id,
      OAUTH_CLIENT_SECRET: oauth.client_secret ?? "",
    };
    return {
      provider: this.provider,
      environment: input.environment,
      base_url: input.base_url,
      group: toRef(this.provider, group),
      project: toRef(this.provider, project),
      bot_users: {
        engine: toUser(this.provider, engine),
        reviewer: toUser(this.provider, reviewer),
      },
      bot_tokens: { engine: engineToken, reviewer: reviewerToken },
      oauth_application: oauth,
      webhook,
      actions,
      env,
      redacted_env: Object.entries(env)
        .map(([k, v]) => `${k}=${sensitive(k) ? redact(v) : v}`)
        .join("\n"),
    };
  }

  private async ensureBot(
    api: <T>(path: string, init?: RequestInit) => Promise<T>,
    spec: BootstrapBotSpec,
    actions: BootstrapAction[],
    name: "engine" | "reviewer",
  ): Promise<GitLabEntity> {
    const users = await api<GitLabEntity[]>(
      `/users?username=${encodeURIComponent(spec.username)}`,
    );
    const existing = users[0];
    if (existing) {
      actions.push({
        resource: `bot:${name}`,
        status: "existing",
        provider_id: String(existing.id),
      });
      return existing;
    }
    const created = await api<GitLabEntity>("/users", {
      method: "POST",
      body: JSON.stringify({
        email: spec.email,
        username: spec.username,
        name: spec.name,
        password: `colony-${randomUUID()}A1!`,
        skip_confirmation: true,
        bot: true,
      }),
    });
    actions.push({
      resource: `bot:${name}`,
      status: "created",
      provider_id: String(created.id),
    });
    return created;
  }

  private async rotateToken(
    api: <T>(path: string, init?: RequestInit) => Promise<T>,
    user: GitLabEntity,
    spec: BootstrapBotSpec,
    actions: BootstrapAction[],
    name: "engine" | "reviewer",
  ): Promise<string> {
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const token = await api<GitLabEntity>(
      `/users/${encodeURIComponent(String(user.id))}/personal_access_tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          name: `colony-${name}-${Date.now()}`,
          scopes: spec.scopes,
          expires_at: expires,
        }),
      },
    );
    actions.push({
      resource: `bot_token:${name}`,
      status: "rotated",
      provider_id: String(token.id),
    });
    if (!token.token) {
      throw new GitLabProviderError(
        "GitLab did not return a bot token",
        500,
        token,
      );
    }
    return token.token;
  }

  private async ensureOAuthApplication(
    api: <T>(path: string, init?: RequestInit) => Promise<T>,
    input: ProviderBootstrapSpec,
    actions: BootstrapAction[],
  ): Promise<
    ProviderRef & {
      readonly client_id: string;
      readonly client_secret?: string;
    }
  > {
    const apps = await optionalGet<GitLabEntity[]>(
      () => api("/applications"),
      404,
    );
    const existing = apps?.find(
      (app) => app.name === input.oauth_application.name,
    );
    if (existing) {
      actions.push({
        resource: "oauth_application",
        status: "existing",
        provider_id: String(existing.id),
      });
      return {
        ...toRef(this.provider, existing),
        client_id: String(existing.application_id ?? existing.id),
      };
    }
    const created = await api<GitLabEntity>("/applications", {
      method: "POST",
      body: JSON.stringify({
        name: input.oauth_application.name,
        redirect_uri: input.oauth_application.redirect_uris.join("\n"),
        scopes: input.oauth_application.scopes.join(" "),
        confidential: input.oauth_application.confidential ?? true,
      }),
    });
    actions.push({
      resource: "oauth_application",
      status: "created",
      provider_id: String(created.id),
    });
    return {
      ...toRef(this.provider, created),
      client_id: String(created.application_id ?? created.id),
      client_secret: created.secret,
    };
  }

  private async ensureWebhook(
    api: <T>(path: string, init?: RequestInit) => Promise<T>,
    input: ProviderBootstrapSpec,
    project: GitLabEntity,
    actions: BootstrapAction[],
  ): Promise<ProviderWebhook & { readonly secret: string }> {
    const hooks = await api<GitLabEntity[]>(
      `/projects/${encodeURIComponent(String(project.id))}/hooks`,
    );
    const existing = hooks.find(
      (hook) => (hook.url ?? hook.web_url) === input.webhook.url,
    );
    const secret = input.webhook.secret ?? randomUUID();
    const body = JSON.stringify({
      url: input.webhook.url,
      token: secret,
      issues_events: true,
      merge_requests_events: true,
      note_events: true,
      pipeline_events: true,
      push_events: false,
      enable_ssl_verification: input.webhook.enable_ssl_verification ?? true,
    });
    const hook = existing
      ? await api<GitLabEntity>(
          `/projects/${encodeURIComponent(String(project.id))}/hooks/${encodeURIComponent(
            String(existing.id),
          )}`,
          { method: "PUT", body },
        )
      : await api<GitLabEntity>(
          `/projects/${encodeURIComponent(String(project.id))}/hooks`,
          { method: "POST", body },
        );
    actions.push({
      resource: "webhook",
      status: existing ? "updated" : "created",
      provider_id: String(hook.id),
    });
    return {
      id: String(hook.id),
      url: input.webhook.url,
      secret,
      events: input.webhook.events ?? [
        "issues",
        "merge_requests",
        "notes",
        "pipelines",
      ],
      metadata: meta(this.provider, hook),
    };
  }

  private async request<T>(
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("PRIVATE-TOKEN", token);
    headers.set("Content-Type", "application/json");
    const res = await this.fetchImpl(`${this.baseUrl}/api/v4${path}`, {
      ...init,
      headers,
    });
    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      throw new GitLabProviderError(
        `GitLab ${init.method ?? "GET"} ${path} returned ${res.status}`,
        res.status,
        body,
      );
    }
    return body as T;
  }
}

function toRef(provider: "gitlab", entity: GitLabEntity): ProviderRef {
  return {
    id: String(entity.id),
    iid: entity.iid,
    metadata: meta(provider, entity),
  };
}

function toUser(provider: "gitlab", entity: GitLabEntity): ProviderUser {
  return {
    ...toRef(provider, entity),
    username: entity.username ?? String(entity.id),
    name: entity.name ?? entity.username ?? String(entity.id),
    email: entity.email,
    bot: true,
  };
}

function meta(provider: "gitlab", entity: GitLabEntity): ProviderMetadata {
  return {
    provider,
    id: String(entity.id),
    web_url: entity.web_url,
    raw: entity as unknown as Record<string, unknown>,
  };
}

async function optionalGet<T>(
  fn: () => Promise<T>,
  status: number,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GitLabProviderError && e.status === status) return null;
    throw e;
  }
}

function notImplemented(): never {
  throw new Error("GitLab provider method is not implemented yet");
}

function sensitive(key: string): boolean {
  return key.includes("TOKEN") || key.includes("SECRET");
}

function redact(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
