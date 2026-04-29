/* eslint-disable @typescript-eslint/require-await */

import { randomUUID } from "node:crypto";
import {
  botTokenEnv,
  normalizeBootstrapBots,
  type BootstrapAction,
  type BootstrapBotSpec,
  type CreateIssueInput,
  type CreateProviderProjectInput,
  type ProviderAdapter,
  type ProviderBootstrapResult,
  type ProviderBootstrapSpec,
  type ProviderBranch,
  type ProviderComment,
  type ProviderCommit,
  type ProviderGroup,
  type ProviderId,
  type ProviderHealth,
  type ProviderIdentitySnapshot,
  type ProviderIssue,
  type ProviderMergeRequest,
  type ProviderMetadata,
  type ProviderPipeline,
  type ProviderProjectInfo,
  type ProviderProjectRef,
  type ProviderRef,
  type ProviderUser,
  type ProviderVisibility,
  type ProviderWebhook,
  type UpdateIssueInput,
} from "@colony/provider";

export const COLONY_PROVIDER_GITLAB_PACKAGE =
  "@colony/provider-gitlab" as const;

type Fetch = typeof fetch;

interface GitLabProviderAdapterOptions {
  readonly baseUrl: string;
  readonly token?: string;
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
  readonly visibility?: string;
  readonly token?: string;
  readonly secret?: string;
  readonly application_id?: string;
}

interface GitLabProject extends GitLabEntity {
  readonly path_with_namespace?: string;
  readonly default_branch?: string | null;
  readonly visibility?: string;
}

interface GitLabIssue extends GitLabEntity {
  readonly project_id?: number | string;
  readonly title: string;
  readonly description?: string | null;
  readonly state: "opened" | "closed" | (string & {});
  readonly labels?: readonly string[];
  readonly assignee?: GitLabUser | null;
  readonly assignees?: readonly GitLabUser[];
}

interface GitLabNote extends GitLabEntity {
  readonly body?: string;
  readonly note?: string;
  readonly author?: GitLabUser;
  readonly created_at?: string;
}

interface GitLabMergeRequest extends GitLabEntity {
  readonly project_id?: number | string;
  readonly title: string;
  readonly description?: string | null;
  readonly source_branch?: string;
  readonly target_branch?: string;
  readonly state?: "opened" | "closed" | "merged" | "locked" | (string & {});
  readonly sha?: string | null;
  readonly diff_refs?: {
    readonly head_sha?: string | null;
  } | null;
}

interface GitLabBranch extends GitLabEntity {
  readonly name: string;
  readonly commit?: { readonly id?: string };
  readonly protected?: boolean;
}

interface GitLabCommit extends GitLabEntity {
  readonly id: string;
  readonly title?: string;
}

interface GitLabUser extends GitLabEntity {
  readonly bot?: boolean;
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
  private readonly token?: string;
  private readonly fetchImpl: Fetch;

  constructor(options: GitLabProviderAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  readonly groups: ProviderAdapter["groups"] = {
    create: async (input) => {
      const fullPath = input.parent
        ? `${input.parent}/${input.path}`
        : input.path;
      const existing = await optionalGet<GitLabEntity>(
        () => this.api<GitLabEntity>(`/groups/${encodePath(fullPath)}`),
        404,
      );
      if (existing) return toGroup(this.provider, existing);
      // GitLab takes parent_id (numeric) or parent path resolved out-of-band.
      // For the homelab path we accept either; passing a path string lets
      // GitLab error on resolution rather than us pre-resolving.
      const created = await this.api<GitLabEntity>("/groups", {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          path: input.path,
          parent_id: input.parent,
          description: input.description,
          visibility: input.visibility ?? "private",
        }),
      });
      return toGroup(this.provider, created);
    },
    delete: async (id) => {
      await this.api<unknown>(`/groups/${encodePath(id)}`, {
        method: "DELETE",
      });
    },
    getByPath: async (path) => {
      const group = await optionalGet<GitLabEntity>(
        () => this.api<GitLabEntity>(`/groups/${encodePath(path)}`),
        404,
      );
      return group ? toGroup(this.provider, group) : null;
    },
  };

  readonly projects: ProviderAdapter["projects"] = {
    create: async (input) => {
      // Idempotent: if a project with this full path already exists under
      // the bot's namespace, surface it instead of erroring on conflict.
      // Agents call `projects.create` defensively during decomposition.
      const fullPath = input.namespace
        ? `${input.namespace}/${input.path}`
        : input.path;
      const existing = await optionalGet<GitLabProject>(
        () => this.api<GitLabProject>(`/projects/${encodePath(fullPath)}`),
        404,
      );
      if (existing) return toProjectInfo(this.provider, existing);
      const created = await this.api<GitLabProject>("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          path: input.path,
          // GitLab accepts numeric namespace_id or path. We pass through.
          namespace_id: input.namespace,
          description: input.description,
          visibility: input.visibility ?? "private",
          default_branch: input.default_branch,
        }),
      });
      return toProjectInfo(this.provider, created);
    },
    delete: async (id) => {
      await this.api<unknown>(`/projects/${encodePath(id)}`, {
        method: "DELETE",
      });
    },
    getById: async (id) => {
      const project = await optionalGet<GitLabProject>(
        () => this.api<GitLabProject>(`/projects/${encodePath(id)}`),
        404,
      );
      return project ? toProjectInfo(this.provider, project) : null;
    },
    getByPath: async (path) => {
      const project = await optionalGet<GitLabProject>(
        () => this.api<GitLabProject>(`/projects/${encodePath(path)}`),
        404,
      );
      return project ? toProjectInfo(this.provider, project) : null;
    },
  };

  async health(): Promise<ProviderHealth> {
    const checked_at = new Date().toISOString();
    const started = Date.now();
    try {
      const v = await this.api<{ version?: string; revision?: string }>(
        "/version",
      );
      return {
        ok: true,
        checked_at,
        latency_ms: Date.now() - started,
        version: v.version ?? v.revision,
      };
    } catch (e) {
      return {
        ok: false,
        checked_at,
        latency_ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async identity(): Promise<ProviderIdentitySnapshot> {
    const me = await this.api<GitLabUser>("/user");
    // Groups the bot can write into. min_access_level=30 is GitLab's
    // "Developer" — the lowest level that can create projects under a group.
    const groups = await optionalGet<GitLabEntity[]>(
      () =>
        this.api<GitLabEntity[]>("/groups?min_access_level=30&per_page=100"),
      404,
    );
    const username = me.username ?? String(me.id);
    return {
      user_id: String(me.id),
      username,
      // GitLab stores personal projects under the user's own username.
      default_namespace: username,
      accessible_namespaces: [
        username,
        ...(groups ?? []).map((g) => g.path ?? String(g.id)),
      ],
    };
  }

  readonly issues: ProviderAdapter["issues"] = {
    get: async (project, id) => {
      const issue = await this.projectApi<GitLabIssue>(
        project.id,
        `/issues/${encodePath(issueIid(project.id, id))}`,
      );
      return toIssue(this.provider, project.id, issue);
    },
    create: async (project, input) => this.createIssue(project, input),
    update: async (project, id, input) => this.updateIssue(project, id, input),
    close: async (project, id) => this.updateIssueState(project, id, "close"),
    reopen: async (project, id) => this.updateIssueState(project, id, "reopen"),
    addLabel: async (project, id, label) =>
      this.updateIssue(project, id, { add_labels: [label] }),
    removeLabel: async (project, id, label) =>
      this.updateIssue(project, id, { remove_labels: [label] }),
    setAssignees: async (project, id, assigneeIds) =>
      this.updateIssue(project, id, { assignee_ids: assigneeIds }),
    comment: async (project, id, body) =>
      this.commentOnIssue(project, id, body),
  };

  readonly epics: ProviderAdapter["epics"] = {
    create: async (project, input) =>
      this.createIssue(project, {
        ...input,
        labels: [...(input.labels ?? []), "colony:scope"],
      }),
    update: async (project, id, input) => this.updateIssue(project, id, input),
    close: async (project, id) => this.updateIssueState(project, id, "close"),
  };

  readonly mergeRequests: ProviderAdapter["mergeRequests"] = {
    get: async (project, id) => {
      const mr = await this.projectApi<GitLabMergeRequest>(
        project.id,
        `/merge_requests/${encodePath(mrIid(project.id, id))}`,
      );
      return toMergeRequest(this.provider, project.id, mr);
    },
    open: async (project, input) => {
      const mr = await this.projectApi<GitLabMergeRequest>(
        project.id,
        "/merge_requests",
        {
          method: "POST",
          body: JSON.stringify({
            title: input.title,
            description: input.description,
            source_branch: input.source_branch,
            target_branch: input.target_branch,
          }),
        },
      );
      return toMergeRequest(this.provider, project.id, mr);
    },
    update: async (project, id, input) => {
      const mr = await this.projectApi<GitLabMergeRequest>(
        project.id,
        `/merge_requests/${encodePath(mrIid(project.id, id))}`,
        {
          method: "PUT",
          body: JSON.stringify({
            title: input.title,
            description: input.description,
          }),
        },
      );
      return toMergeRequest(this.provider, project.id, mr);
    },
    approve: async (project, id) => {
      // GitLab's approve/unapprove endpoints return narrow MergeRequestApproval
      // payloads rather than the canonical merge request shape; refetch the
      // MR so the adapter's normalized response is consistent across calls.
      await this.projectApi<unknown>(
        project.id,
        `/merge_requests/${encodePath(mrIid(project.id, id))}/approve`,
        { method: "POST" },
      );
      const mr = await this.projectApi<GitLabMergeRequest>(
        project.id,
        `/merge_requests/${encodePath(mrIid(project.id, id))}`,
      );
      return toMergeRequest(this.provider, project.id, mr);
    },
    unapprove: async (project, id) => {
      await this.projectApi<unknown>(
        project.id,
        `/merge_requests/${encodePath(mrIid(project.id, id))}/unapprove`,
        { method: "POST" },
      );
      const mr = await this.projectApi<GitLabMergeRequest>(
        project.id,
        `/merge_requests/${encodePath(mrIid(project.id, id))}`,
      );
      return toMergeRequest(this.provider, project.id, mr);
    },
    merge: async (project, id) => {
      const mr = await this.projectApi<GitLabMergeRequest>(
        project.id,
        `/merge_requests/${encodePath(mrIid(project.id, id))}/merge`,
        { method: "PUT", body: JSON.stringify({}) },
      );
      return toMergeRequest(this.provider, project.id, mr);
    },
    close: async (project, id) => {
      const mr = await this.projectApi<GitLabMergeRequest>(
        project.id,
        `/merge_requests/${encodePath(mrIid(project.id, id))}`,
        {
          method: "PUT",
          body: JSON.stringify({ state_event: "close" }),
        },
      );
      return toMergeRequest(this.provider, project.id, mr);
    },
    comment: async (project, id, body) => {
      const note = await this.projectApi<GitLabNote>(
        project.id,
        `/merge_requests/${encodePath(mrIid(project.id, id))}/notes`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
      return toComment(this.provider, note);
    },
    addReviewThread: async (project, id, body) => {
      const discussion = await this.projectApi<{
        readonly id?: string;
        readonly notes?: readonly GitLabNote[];
      }>(
        project.id,
        `/merge_requests/${encodePath(mrIid(project.id, id))}/discussions`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
      const note = discussion.notes?.[0];
      if (!note) {
        throw new GitLabProviderError(
          "GitLab discussion response missing note",
          500,
          discussion,
        );
      }
      return toComment(this.provider, note);
    },
    diff: async (project, id) => {
      const iid = mrIid(project.id, id);
      // GitLab 17+ deprecated `/changes` for `/diffs` (paginated array).
      try {
        const diffs = await this.projectApi<
          readonly Readonly<Record<string, unknown>>[]
        >(project.id, `/merge_requests/${encodePath(iid)}/diffs?per_page=50`);
        if (diffs.length > 0) return diffs;
      } catch {
        // fall through
      }
      try {
        const changes = await this.projectApi<{
          readonly changes?: readonly Readonly<Record<string, unknown>>[];
        }>(project.id, `/merge_requests/${encodePath(iid)}/changes`);
        if (changes.changes && changes.changes.length > 0)
          return changes.changes;
      } catch {
        // fall through
      }
      // Last resort: /merge_requests/<iid>/diffs and /changes can return
      // empty briefly after MR creation while GitLab computes them.
      // /repository/compare is independent of the MR object's diff cache
      // and always reflects the current branch tips.
      try {
        const mr = await this.projectApi<{
          readonly source_branch?: string;
          readonly target_branch?: string;
        }>(project.id, `/merge_requests/${encodePath(iid)}`);
        if (mr.source_branch && mr.target_branch) {
          const compare = await this.projectApi<{
            readonly diffs?: readonly Readonly<Record<string, unknown>>[];
          }>(
            project.id,
            `/repository/compare?from=${encodeURIComponent(mr.target_branch)}&to=${encodeURIComponent(mr.source_branch)}`,
          );
          return compare.diffs ?? [];
        }
      } catch {
        // give up
      }
      return [];
    },
  };

  readonly branches: ProviderAdapter["branches"] = {
    create: async (project, name, ref) => {
      const branch = await this.projectApi<GitLabBranch>(
        project.id,
        `/repository/branches?branch=${encodeURIComponent(name)}&ref=${encodeURIComponent(ref)}`,
        { method: "POST" },
      );
      return toBranch(this.provider, project.id, branch);
    },
    delete: async (project, name) => {
      await this.projectApi<unknown>(
        project.id,
        `/repository/branches/${encodePath(name)}`,
        { method: "DELETE" },
      );
    },
    protect: async (project, name) => {
      // POST /protected_branches with ?name=...; GitLab errors 409 if it
      // already exists, in which case fall through to the GET path so the
      // call is idempotent for callers that don't track prior protection.
      const existing = await optionalGet<GitLabBranch>(
        () =>
          this.projectApi<GitLabBranch>(
            project.id,
            `/protected_branches/${encodePath(name)}`,
          ),
        404,
      );
      if (existing) {
        return toBranch(this.provider, project.id, {
          ...existing,
          name,
          protected: true,
        });
      }
      const protectedBranch = await this.projectApi<GitLabBranch>(
        project.id,
        `/protected_branches?name=${encodeURIComponent(name)}`,
        { method: "POST" },
      );
      return toBranch(this.provider, project.id, {
        ...protectedBranch,
        name,
        protected: true,
      });
    },
  };

  readonly commits: ProviderAdapter["commits"] = {
    get: async (project, sha) => {
      const commit = await this.projectApi<GitLabCommit>(
        project.id,
        `/repository/commits/${encodePath(sha)}`,
      );
      return toCommit(this.provider, project.id, commit);
    },
    diff: async (project, sha) => {
      const diff = await this.projectApi<readonly Record<string, unknown>[]>(
        project.id,
        `/repository/commits/${encodePath(sha)}/diff`,
      );
      return diff;
    },
    create: async (project, input) => {
      const commit = await this.projectApi<GitLabCommit>(
        project.id,
        "/repository/commits",
        {
          method: "POST",
          body: JSON.stringify({
            branch: input.branch,
            commit_message: input.message,
            actions: input.actions.map((a) => ({
              action: a.action,
              file_path: a.file_path,
              ...(a.content !== undefined ? { content: a.content } : {}),
            })),
          }),
        },
      );
      return toCommit(this.provider, project.id, commit);
    },
  };

  readonly pipelines: ProviderAdapter["pipelines"] = {
    getStatus: async (project, id) => {
      const pipeline = await this.projectApi<
        GitLabEntity & {
          readonly status?: string;
          readonly sha?: string;
        }
      >(project.id, `/pipelines/${encodePath(id)}`);
      return toPipeline(this.provider, pipeline);
    },
    trigger: async (project, ref) => {
      const pipeline = await this.projectApi<
        GitLabEntity & {
          readonly status?: string;
          readonly sha?: string;
        }
      >(project.id, `/pipeline?ref=${encodeURIComponent(ref)}`, {
        method: "POST",
      });
      return toPipeline(this.provider, pipeline);
    },
  };

  readonly users: ProviderAdapter["users"] = {
    create: async (input) => {
      const existing = await this.api<GitLabUser[]>(
        `/users?username=${encodeURIComponent(input.username)}`,
      );
      if (existing[0]) return toUser(this.provider, existing[0]);
      const user = await this.api<GitLabUser>("/users", {
        method: "POST",
        body: JSON.stringify({
          email: input.email,
          username: input.username,
          name: input.name,
          password: `colony-${randomUUID()}A1!`,
          skip_confirmation: true,
          bot: input.bot ?? false,
          admin: input.admin ?? false,
        }),
      });
      return toUser(this.provider, user);
    },
    resolveById: async (id) =>
      optionalGet(
        () => this.api<GitLabUser>(`/users/${encodePath(id)}`),
        404,
      ).then((user) => (user ? toUser(this.provider, user) : null)),
    resolveByUsername: async (username) => {
      const users = await this.api<GitLabUser[]>(
        `/users?username=${encodeURIComponent(username)}`,
      );
      return users[0] ? toUser(this.provider, users[0]) : null;
    },
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
  ): Promise<ProviderBootstrapResult> {
    // The configured bot credential is used directly; provider-side scope
    // (admin flag, fine-grained permissions) decides what succeeds.
    const actions: BootstrapAction[] = [];
    const token = this.requireToken();
    const api = <T>(path: string, init?: RequestInit) =>
      this.request<T>(path, token, init);

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

    const botSpecs = normalizeBootstrapBots(input.bots);
    const botUsers: Record<string, GitLabEntity> = {};
    for (const [role, spec] of Object.entries(botSpecs)) {
      botUsers[role] = await this.ensureBot(api, spec, actions, role);
    }

    const botTokens: Record<string, string> = {};
    for (const [role, user] of Object.entries(botUsers)) {
      const spec = botSpecs[role];
      if (!spec) {
        throw new GitLabProviderError(`Missing bot spec for ${role}`, 500, {
          role,
        });
      }
      botTokens[role] = await this.rotateToken(api, user, spec, actions, role);
    }

    const oauth = await this.ensureOAuthApplication(api, input, actions);
    const webhook = await this.ensureWebhook(api, input, project, actions);
    // GITLAB_DEV_PROJECT_ID is a *seed* for the dev/dogfood ProviderProject
    // registry, not a runtime default on the adapter. Adapter operations
    // always take an explicit ProviderProjectRef; the dev entrypoint reads
    // this env and registers the bootstrapped project via
    // ProviderProjectRepository.upsertProject.
    const env = {
      GITLAB_BASE_URL: input.base_url,
      GITLAB_DEV_PROJECT_ID: String(project.id),
      ...botTokenEnv(botTokens),
      // Back-compat aliases for current adapter constructor wiring.
      GITLAB_TOKEN: botTokens.engine ?? "",
      GITLAB_REVIEWER_TOKEN: botTokens.reviewer ?? "",
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
      bot_users: Object.fromEntries(
        Object.entries(botUsers).map(([role, user]) => [
          role,
          toUser(this.provider, user),
        ]),
      ),
      bot_tokens: botTokens,
      oauth_application: oauth,
      webhook,
      actions,
      env,
      redacted_env: Object.entries(env)
        .map(([k, v]) => `${k}=${sensitive(k) ? redact(v) : v}`)
        .join("\n"),
    };
  }

  private async createIssue(
    project: ProviderProjectRef,
    input: CreateIssueInput,
  ): Promise<ProviderIssue> {
    const issue = await this.projectApi<GitLabIssue>(project.id, "/issues", {
      method: "POST",
      body: JSON.stringify(issueInputBody(input)),
    });
    return toIssue(this.provider, project.id, issue);
  }

  private async updateIssue(
    project: ProviderProjectRef,
    id: ProviderId,
    input: UpdateIssueInput & {
      readonly add_labels?: readonly string[];
      readonly remove_labels?: readonly string[];
    },
  ): Promise<ProviderIssue> {
    const issue = await this.projectApi<GitLabIssue>(
      project.id,
      `/issues/${encodePath(issueIid(project.id, id))}`,
      {
        method: "PUT",
        body: JSON.stringify(issueInputBody(input)),
      },
    );
    return toIssue(this.provider, project.id, issue);
  }

  private async updateIssueState(
    project: ProviderProjectRef,
    id: ProviderId,
    stateEvent: "close" | "reopen",
  ): Promise<ProviderIssue> {
    const issue = await this.projectApi<GitLabIssue>(
      project.id,
      `/issues/${encodePath(issueIid(project.id, id))}`,
      {
        method: "PUT",
        body: JSON.stringify({ state_event: stateEvent }),
      },
    );
    return toIssue(this.provider, project.id, issue);
  }

  private async commentOnIssue(
    project: ProviderProjectRef,
    id: ProviderId,
    body: string,
  ): Promise<ProviderComment> {
    const note = await this.projectApi<GitLabNote>(
      project.id,
      `/issues/${encodePath(issueIid(project.id, id))}/notes`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
      },
    );
    return toComment(this.provider, note);
  }

  private async ensureBot(
    api: <T>(path: string, init?: RequestInit) => Promise<T>,
    spec: BootstrapBotSpec,
    actions: BootstrapAction[],
    role: string,
  ): Promise<GitLabEntity> {
    const users = await api<GitLabEntity[]>(
      `/users?username=${encodeURIComponent(spec.username)}`,
    );
    const existing = users[0];
    if (existing) {
      actions.push({
        resource: `bot:${role}`,
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
      resource: `bot:${role}`,
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
    role: string,
  ): Promise<string> {
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const token = await api<GitLabEntity>(
      `/users/${encodeURIComponent(String(user.id))}/personal_access_tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          name: `colony-${role}-${Date.now()}`,
          scopes: spec.scopes,
          expires_at: expires,
        }),
      },
    );
    actions.push({
      resource: `bot_token:${role}`,
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

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.requireToken();
    return this.request<T>(path, token, init);
  }

  private async projectApi<T>(
    projectId: ProviderId,
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    return this.api<T>(`/projects/${encodePath(projectId)}${path}`, init);
  }

  private requireToken(): string {
    if (!this.token) {
      throw new GitLabProviderError(
        "GitLab provider requires a token for project operations",
        500,
        null,
      );
    }
    return this.token;
  }
}

function issueInputBody(
  input: UpdateIssueInput & {
    readonly add_labels?: readonly string[];
    readonly remove_labels?: readonly string[];
  },
): Record<string, unknown> {
  return {
    title: input.title,
    description: input.description,
    labels: input.labels ? input.labels.join(",") : undefined,
    add_labels: input.add_labels ? input.add_labels.join(",") : undefined,
    remove_labels: input.remove_labels
      ? input.remove_labels.join(",")
      : undefined,
    assignee_ids: input.assignee_ids,
  };
}

function toIssue(
  provider: "gitlab",
  projectId: ProviderId,
  issue: GitLabIssue,
): ProviderIssue {
  const assignees = issue.assignees ?? (issue.assignee ? [issue.assignee] : []);
  const id = issueId(projectId, issue);
  return {
    id,
    iid: issue.iid,
    title: issue.title,
    description: issue.description ?? "",
    state: issue.state === "closed" ? "closed" : "opened",
    labels: [...(issue.labels ?? [])],
    assignee_ids: assignees.map((user) => String(user.id)),
    metadata: {
      ...meta(provider, issue),
      id,
    },
  };
}

function toComment(provider: "gitlab", note: GitLabNote): ProviderComment {
  return {
    id: String(note.id),
    body: note.body ?? note.note ?? "",
    author_id: note.author ? String(note.author.id) : undefined,
    created_at: note.created_at ?? new Date(0).toISOString(),
    metadata: meta(provider, note),
  };
}

function toRef(provider: "gitlab", entity: GitLabEntity): ProviderRef {
  return {
    id: String(entity.id),
    iid: entity.iid,
    metadata: meta(provider, entity),
  };
}

function toGroup(provider: "gitlab", entity: GitLabEntity): ProviderGroup {
  const visibility: ProviderVisibility =
    entity.visibility === "public" || entity.visibility === "internal"
      ? entity.visibility
      : "private";
  return {
    ...toRef(provider, entity),
    path: entity.path ?? String(entity.id),
    visibility,
  };
}

function toProjectInfo(
  provider: "gitlab",
  project: GitLabProject,
): ProviderProjectInfo {
  const visibility: ProviderVisibility =
    project.visibility === "public" || project.visibility === "internal"
      ? project.visibility
      : "private";
  return {
    ...toRef(provider, project),
    path: project.path_with_namespace ?? project.path ?? String(project.id),
    default_branch: project.default_branch ?? "main",
    visibility,
  };
}

// CreateProviderProjectInput is part of the adapter's public contract; it is
// referenced via the `projects.create` parameter type.
export type { CreateProviderProjectInput };

function toUser(provider: "gitlab", entity: GitLabEntity): ProviderUser {
  return {
    ...toRef(provider, entity),
    username: entity.username ?? String(entity.id),
    name: entity.name ?? entity.username ?? String(entity.id),
    email: entity.email,
    bot: "bot" in entity && entity.bot === true,
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

function issueId(projectId: ProviderId, issue: GitLabIssue): ProviderId {
  return `${String(issue.project_id ?? projectId)}:${String(issue.iid ?? issue.id)}`;
}

function issueIid(projectId: ProviderId, id: ProviderId): string {
  const prefix = `${projectId}:`;
  if (id.startsWith(prefix)) return id.slice(prefix.length);
  const separator = id.lastIndexOf(":");
  return separator === -1 ? id : id.slice(separator + 1);
}

// MR IDs use the same `<project_id>:<iid>` shape as issues so a single ID is
// stable across project context. `mrIid` strips the project prefix so the
// caller can hit GitLab's `/merge_requests/<iid>` endpoint.
function mrIid(projectId: ProviderId, id: ProviderId): string {
  return issueIid(projectId, id);
}

function toMergeRequest(
  provider: "gitlab",
  projectId: ProviderId,
  mr: GitLabMergeRequest,
): ProviderMergeRequest {
  const iid = mr.iid ?? Number(mr.id);
  const id = `${String(mr.project_id ?? projectId)}:${String(mr.iid ?? mr.id)}`;
  const state = normalizeMrState(mr.state);
  return {
    id,
    iid,
    title: mr.title,
    description: mr.description ?? "",
    source_branch: mr.source_branch ?? "",
    target_branch: mr.target_branch ?? "",
    state,
    head_commit_sha: mr.sha ?? mr.diff_refs?.head_sha ?? undefined,
    metadata: { ...meta(provider, mr), id },
  };
}

function normalizeMrState(
  state: GitLabMergeRequest["state"],
): ProviderMergeRequest["state"] {
  if (state === "merged") return "merged";
  if (state === "closed" || state === "locked") return "closed";
  return "opened";
}

function toBranch(
  provider: "gitlab",
  projectId: ProviderId,
  branch: GitLabBranch,
): ProviderBranch {
  const id = `${String(projectId)}:${branch.name}`;
  return {
    id,
    name: branch.name,
    commit_sha: branch.commit?.id ?? "",
    protected: branch.protected ?? false,
    metadata: { ...meta(provider, branch), id },
  };
}

function toCommit(
  provider: "gitlab",
  projectId: ProviderId,
  commit: GitLabCommit,
): ProviderCommit {
  const id = `${String(projectId)}:${commit.id}`;
  return {
    id,
    sha: commit.id,
    title: commit.title,
    metadata: { ...meta(provider, commit), id },
  };
}

function toPipeline(
  provider: "gitlab",
  pipeline: GitLabEntity & {
    readonly status?: string;
    readonly sha?: string;
  },
): ProviderPipeline {
  return {
    id: String(pipeline.id),
    status: pipeline.status ?? "unknown",
    commit_sha: pipeline.sha,
    metadata: meta(provider, pipeline),
  };
}

function encodePath(value: string | number): string {
  return encodeURIComponent(String(value));
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
