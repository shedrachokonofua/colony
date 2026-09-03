/* eslint-disable @typescript-eslint/require-await */

import { randomUUID } from "node:crypto";
import {
  botTokenEnv,
  normalizeBootstrapBots,
  type BootstrapAction,
  type BootstrapBotSpec,
  type CreateProviderAccessTokenInput,
  type CreateIssueInput,
  type CreateProviderRepoInput,
  type ProviderAccessToken,
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
  type ProviderRepoInfo,
  type ProviderRepoRef,
  type ProviderRef,
  type ProviderUser,
  type ProviderVisibility,
  type ProviderWebhook,
  type UpdateIssueInput,
} from "@colony/provider";

export const COLONY_PROVIDER_GITLAB_PACKAGE =
  "@colony/provider-gitlab" as const;

/** Only the (url, init) call form is used, so test stubs need not implement the
 *  whole runtime `fetch` surface (Bun's adds `preconnect`). */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

interface GitLabProviderAdapterOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: Fetch;
  /** Maximum time allowed for an individual GitLab request. */
  readonly requestTimeoutMs?: number;
  readonly timeoutMs?: number;
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

/** GitLab calls repositories "projects" in its REST API; DTOs keep its names. */
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
  readonly merge_status?: string | null;
  readonly detailed_merge_status?: string | null;
  readonly has_conflicts?: boolean;
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

interface GitLabProjectAccessToken extends GitLabEntity {
  readonly name?: string;
  readonly token?: string;
  readonly scopes?: readonly string[];
  readonly expires_at?: string;
  readonly access_level?: number;
  readonly project_id?: number | string;
  readonly active?: boolean;
  readonly revoked?: boolean;
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
  private readonly requestTimeoutMs: number;

  constructor(options: GitLabProviderAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? options.timeoutMs ?? 30_000;
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

  readonly repos: ProviderAdapter["repos"] = {
    create: async (input) => {
      // Idempotent: if a repo with this full path already exists under
      // the bot's namespace, surface it instead of erroring on conflict.
      // Agents call `repos.create` defensively during decomposition.
      const fullPath = input.namespace
        ? `${input.namespace}/${input.path}`
        : input.path;
      const existing = await optionalGet<GitLabProject>(
        () => this.api<GitLabProject>(`/projects/${encodePath(fullPath)}`),
        404,
      );
      if (existing) return toRepoInfo(this.provider, existing);
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
      return toRepoInfo(this.provider, created);
    },
    delete: async (id) => {
      await this.api<unknown>(`/projects/${encodePath(id)}`, {
        method: "DELETE",
      });
    },
    getById: async (id) => {
      const repo = await optionalGet<GitLabProject>(
        () => this.api<GitLabProject>(`/projects/${encodePath(id)}`),
        404,
      );
      return repo ? toRepoInfo(this.provider, repo) : null;
    },
    getByPath: async (path) => {
      const repo = await optionalGet<GitLabProject>(
        () => this.api<GitLabProject>(`/projects/${encodePath(path)}`),
        404,
      );
      return repo ? toRepoInfo(this.provider, repo) : null;
    },
  };

  readonly accessTokens: NonNullable<ProviderAdapter["accessTokens"]> = {
    mint: async (repo, input) => {
      const body = accessTokenInputBody(input);
      const token = await this.repoApi<GitLabProjectAccessToken>(
        repo.id,
        "/access_tokens",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      return toAccessToken(this.provider, repo.id, token);
    },
    revoke: async (repo, id) => {
      try {
        await this.repoApi<unknown>(
          repo.id,
          `/access_tokens/${encodePath(id)}`,
          {
            method: "DELETE",
          },
        );
      } catch (err) {
        if (err instanceof GitLabProviderError && err.status === 404) return;
        throw err;
      }
    },
    list: async (repo) => {
      const tokens = await this.repoApi<GitLabProjectAccessToken[]>(
        repo.id,
        "/access_tokens",
      );
      return (Array.isArray(tokens) ? tokens : [])
        .filter((token) => token.active !== false && token.revoked !== true)
        .map((token) => toAccessTokenListing(this.provider, repo.id, token));
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
    // "Developer" — the lowest level that can create repos under a group.
    const groups = await optionalGet<GitLabEntity[]>(
      () =>
        this.api<GitLabEntity[]>("/groups?min_access_level=30&per_page=100"),
      404,
    );
    const username = me.username ?? String(me.id);
    return {
      user_id: String(me.id),
      username,
      // GitLab stores personal repos under the user's own username.
      default_namespace: username,
      accessible_namespaces: [
        username,
        ...(groups ?? []).map((g) => g.path ?? String(g.id)),
      ],
    };
  }

  readonly issues: ProviderAdapter["issues"] = {
    get: async (repo, id) => {
      const issue = await this.repoApi<GitLabIssue>(
        repo.id,
        `/issues/${encodePath(issueIid(repo.id, id))}`,
      );
      return toIssue(this.provider, repo.id, issue);
    },
    create: async (repo, input) => this.createIssue(repo, input),
    update: async (repo, id, input) => this.updateIssue(repo, id, input),
    close: async (repo, id) => this.updateIssueState(repo, id, "close"),
    reopen: async (repo, id) => this.updateIssueState(repo, id, "reopen"),
    addLabel: async (repo, id, label) =>
      this.updateIssue(repo, id, { add_labels: [label] }),
    removeLabel: async (repo, id, label) =>
      this.updateIssue(repo, id, { remove_labels: [label] }),
    setAssignees: async (repo, id, assigneeIds) =>
      this.updateIssue(repo, id, { assignee_ids: assigneeIds }),
    comment: async (repo, id, body) => this.commentOnIssue(repo, id, body),
  };

  readonly epics: ProviderAdapter["epics"] = {
    create: async (repo, input) =>
      this.createIssue(repo, {
        ...input,
        labels: [...new Set([...(input.labels ?? []), "colony:scope"])],
      }),
    update: async (repo, id, input) => this.updateIssue(repo, id, input),
    close: async (repo, id) => this.updateIssueState(repo, id, "close"),
  };

  readonly mergeRequests: ProviderAdapter["mergeRequests"] = {
    get: async (repo, id) => {
      const mr = await this.repoApi<GitLabMergeRequest>(
        repo.id,
        `/merge_requests/${encodePath(mrIid(repo.id, id))}`,
      );
      return toMergeRequest(this.provider, repo.id, mr);
    },
    open: async (repo, input) => {
      const mr = await this.repoApi<GitLabMergeRequest>(
        repo.id,
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
      return toMergeRequest(this.provider, repo.id, mr);
    },
    update: async (repo, id, input) => {
      const mr = await this.repoApi<GitLabMergeRequest>(
        repo.id,
        `/merge_requests/${encodePath(mrIid(repo.id, id))}`,
        {
          method: "PUT",
          body: JSON.stringify({
            title: input.title,
            description: input.description,
          }),
        },
      );
      return toMergeRequest(this.provider, repo.id, mr);
    },
    approve: async (repo, id) => {
      // GitLab's approve/unapprove endpoints return narrow MergeRequestApproval
      // payloads rather than the canonical merge request shape; refetch the
      // MR so the adapter's normalized response is consistent across calls.
      await this.repoApi<unknown>(
        repo.id,
        `/merge_requests/${encodePath(mrIid(repo.id, id))}/approve`,
        { method: "POST" },
      );
      const mr = await this.repoApi<GitLabMergeRequest>(
        repo.id,
        `/merge_requests/${encodePath(mrIid(repo.id, id))}`,
      );
      return toMergeRequest(this.provider, repo.id, mr);
    },
    unapprove: async (repo, id) => {
      await this.repoApi<unknown>(
        repo.id,
        `/merge_requests/${encodePath(mrIid(repo.id, id))}/unapprove`,
        { method: "POST" },
      );
      const mr = await this.repoApi<GitLabMergeRequest>(
        repo.id,
        `/merge_requests/${encodePath(mrIid(repo.id, id))}`,
      );
      return toMergeRequest(this.provider, repo.id, mr);
    },
    merge: async (repo, id, input) => {
      const iid = mrIid(repo.id, id);
      let preflight = await this.getMergeability(repo.id, iid);
      if (preflight.rejected) {
        return {
          ...toMergeRequest(this.provider, repo.id, preflight.mr),
          merged: false,
          reason: preflight.reason,
        };
      }

      const mergePath = `/merge_requests/${encodePath(iid)}/merge`;
      const body = JSON.stringify(
        input?.merge_commit_message
          ? { sha: input.sha, merge_commit_message: input.merge_commit_message }
          : input?.sha
            ? { sha: input.sha }
            : {},
      );
      try {
        const mr = await this.repoApi<GitLabMergeRequest>(repo.id, mergePath, {
          method: "PUT",
          body,
        });
        return {
          ...toMergeRequest(this.provider, repo.id, mr),
          merged: true,
        };
      } catch (error) {
        if (
          !(error instanceof GitLabProviderError) ||
          (error.status !== 405 && error.status !== 409)
        ) {
          throw error;
        }
        preflight = await this.getMergeability(repo.id, iid);
        if (preflight.rejected) {
          return {
            ...toMergeRequest(this.provider, repo.id, preflight.mr),
            merged: false,
            reason: preflight.reason,
          };
        }
        try {
          const mr = await this.repoApi<GitLabMergeRequest>(
            repo.id,
            mergePath,
            { method: "PUT", body },
          );
          return {
            ...toMergeRequest(this.provider, repo.id, mr),
            merged: true,
          };
        } catch (retryError) {
          if (
            retryError instanceof GitLabProviderError &&
            (retryError.status === 405 || retryError.status === 409)
          ) {
            return {
              ...toMergeRequest(this.provider, repo.id, preflight.mr),
              merged: false,
              reason: `merge_http_${retryError.status}`,
            };
          }
          throw retryError;
        }
      }
    },
    close: async (repo, id) => {
      const mr = await this.repoApi<GitLabMergeRequest>(
        repo.id,
        `/merge_requests/${encodePath(mrIid(repo.id, id))}`,
        {
          method: "PUT",
          body: JSON.stringify({ state_event: "close" }),
        },
      );
      return toMergeRequest(this.provider, repo.id, mr);
    },
    comment: async (repo, id, body) => {
      const note = await this.repoApi<GitLabNote>(
        repo.id,
        `/merge_requests/${encodePath(mrIid(repo.id, id))}/notes`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
      return toComment(this.provider, note);
    },
    addReviewThread: async (repo, id, body) => {
      const discussion = await this.repoApi<{
        readonly id?: string;
        readonly notes?: readonly GitLabNote[];
      }>(
        repo.id,
        `/merge_requests/${encodePath(mrIid(repo.id, id))}/discussions`,
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
    diff: async (repo, id) => {
      const iid = mrIid(repo.id, id);
      // GitLab 17+ deprecated `/changes` for `/diffs`; collect every page.
      let diffs: readonly Readonly<Record<string, unknown>>[] = [];
      try {
        diffs = await this.getAllDiffs(repo.id, iid);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (diffs.length > 0) return diffs;

      let changes:
        | { readonly changes?: readonly Readonly<Record<string, unknown>>[] }
        | undefined;
      try {
        changes = await this.repoApi<{
          readonly changes?: readonly Readonly<Record<string, unknown>>[];
        }>(repo.id, `/merge_requests/${encodePath(iid)}/changes`);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (changes?.changes && changes.changes.length > 0)
        return changes.changes;

      // Last resort: /repository/compare is independent of the MR object's
      // diff cache and reflects the current branch tips.
      let mr:
        | { readonly source_branch?: string; readonly target_branch?: string }
        | undefined;
      try {
        mr = await this.repoApi<{
          readonly source_branch?: string;
          readonly target_branch?: string;
        }>(repo.id, `/merge_requests/${encodePath(iid)}`);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (!mr?.source_branch || !mr.target_branch) return [];
      try {
        const compare = await this.repoApi<{
          readonly diffs?: readonly Readonly<Record<string, unknown>>[];
        }>(
          repo.id,
          `/repository/compare?from=${encodeURIComponent(mr.target_branch)}&to=${encodeURIComponent(mr.source_branch)}`,
        );
        return compare.diffs ?? [];
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
    },
  };

  readonly branches: ProviderAdapter["branches"] = {
    create: async (repo, name, ref) => {
      const branch = await this.repoApi<GitLabBranch>(
        repo.id,
        `/repository/branches?branch=${encodeURIComponent(name)}&ref=${encodeURIComponent(ref)}`,
        { method: "POST" },
      );
      return toBranch(this.provider, repo.id, branch);
    },
    delete: async (repo, name) => {
      await this.repoApi<unknown>(
        repo.id,
        `/repository/branches/${encodePath(name)}`,
        { method: "DELETE" },
      );
    },
    protect: async (repo, name) => {
      // POST /protected_branches with ?name=...; GitLab errors 409 if it
      // already exists, in which case fall through to the GET path so the
      // call is idempotent for callers that don't track prior protection.
      const existing = await optionalGet<GitLabBranch>(
        () =>
          this.repoApi<GitLabBranch>(
            repo.id,
            `/protected_branches/${encodePath(name)}`,
          ),
        404,
      );
      if (existing) {
        return toBranch(this.provider, repo.id, {
          ...existing,
          name,
          protected: true,
        });
      }
      const protectedBranch = await this.repoApi<GitLabBranch>(
        repo.id,
        `/protected_branches?name=${encodeURIComponent(name)}`,
        { method: "POST" },
      );
      return toBranch(this.provider, repo.id, {
        ...protectedBranch,
        name,
        protected: true,
      });
    },
  };

  readonly commits: ProviderAdapter["commits"] = {
    get: async (repo, sha) => {
      const commit = await this.repoApi<GitLabCommit>(
        repo.id,
        `/repository/commits/${encodePath(sha)}`,
      );
      return toCommit(this.provider, repo.id, commit);
    },
    diff: async (repo, sha) => {
      const diff = await this.repoApi<readonly Record<string, unknown>[]>(
        repo.id,
        `/repository/commits/${encodePath(sha)}/diff`,
      );
      return diff;
    },
    create: async (repo, input) => {
      const commit = await this.repoApi<GitLabCommit>(
        repo.id,
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
      return toCommit(this.provider, repo.id, commit);
    },
  };

  readonly pipelines: ProviderAdapter["pipelines"] = {
    getStatus: async (repo, id) => {
      type GitLabPipeline = GitLabEntity & {
        readonly status?: string;
        readonly sha?: string;
      };
      // Callers pass the commit SHA the gate is about to merge. GitLab's
      // /pipelines/:id wants a pipeline id, so a SHA always 404'd and the
      // gate read that as "no pipeline, proceed" - racing CI on every
      // merge (col-e3021988.12: three 405s while its pipeline ran,
      // 2026-09-03). Look the pipeline up by SHA; newest wins.
      const bySha = /^[0-9a-f]{40}$/i.test(String(id));
      if (!bySha) {
        const pipeline = await this.repoApi<GitLabPipeline>(
          repo.id,
          `/pipelines/${encodePath(id)}`,
        );
        return toPipeline(this.provider, pipeline);
      }
      const pipelines = await this.repoApi<GitLabPipeline[]>(
        repo.id,
        `/pipelines?sha=${encodeURIComponent(String(id))}&per_page=1&order_by=id&sort=desc`,
      );
      const newest = pipelines[0];
      if (!newest) {
        throw new GitLabProviderError(
          `no pipeline for sha ${String(id)}`,
          404,
          "pipeline_not_found",
        );
      }
      return toPipeline(this.provider, newest);
    },
    trigger: async (repo, ref) => {
      const pipeline = await this.repoApi<
        GitLabEntity & {
          readonly status?: string;
          readonly sha?: string;
        }
      >(repo.id, `/pipeline?ref=${encodeURIComponent(ref)}`, {
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

    const fullRepoPath = `${groupPath}/${input.repo.path}`;
    const existingRepo = await optionalGet<GitLabEntity>(
      () => api(`/projects/${encodeURIComponent(fullRepoPath)}`),
      404,
    );
    const repo =
      existingRepo ??
      (await api<GitLabEntity>("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: input.repo.name,
          path: input.repo.path,
          description: input.repo.description,
          namespace_id: group.id,
          visibility: input.repo.visibility ?? "private",
        }),
      }));
    actions.push({
      resource: "repo",
      status: existingRepo ? "existing" : "created",
      provider_id: String(repo.id),
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
    const webhook = await this.ensureWebhook(api, input, repo, actions);
    // GITLAB_DEV_REPO_ID is a *seed* for the dev/dogfood environment, not a
    // runtime default on the adapter. Adapter operations always take an
    // explicit ProviderRepoRef; the dev entrypoint reads this env and binds
    // the bootstrapped repo.
    const env = {
      GITLAB_BASE_URL: input.base_url,
      GITLAB_DEV_REPO_ID: String(repo.id),
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
      repo: toRef(this.provider, repo),
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
    repo: ProviderRepoRef,
    input: CreateIssueInput,
  ): Promise<ProviderIssue> {
    const issue = await this.repoApi<GitLabIssue>(repo.id, "/issues", {
      method: "POST",
      body: JSON.stringify(issueInputBody(input)),
    });
    return toIssue(this.provider, repo.id, issue);
  }

  private async updateIssue(
    repo: ProviderRepoRef,
    id: ProviderId,
    input: UpdateIssueInput & {
      readonly add_labels?: readonly string[];
      readonly remove_labels?: readonly string[];
    },
  ): Promise<ProviderIssue> {
    const issue = await this.repoApi<GitLabIssue>(
      repo.id,
      `/issues/${encodePath(issueIid(repo.id, id))}`,
      {
        method: "PUT",
        body: JSON.stringify(issueInputBody(input)),
      },
    );
    return toIssue(this.provider, repo.id, issue);
  }

  private async updateIssueState(
    repo: ProviderRepoRef,
    id: ProviderId,
    stateEvent: "close" | "reopen",
  ): Promise<ProviderIssue> {
    const issue = await this.repoApi<GitLabIssue>(
      repo.id,
      `/issues/${encodePath(issueIid(repo.id, id))}`,
      {
        method: "PUT",
        body: JSON.stringify({ state_event: stateEvent }),
      },
    );
    return toIssue(this.provider, repo.id, issue);
  }

  private async commentOnIssue(
    repo: ProviderRepoRef,
    id: ProviderId,
    body: string,
  ): Promise<ProviderComment> {
    const note = await this.repoApi<GitLabNote>(
      repo.id,
      `/issues/${encodePath(issueIid(repo.id, id))}/notes`,
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
    repo: GitLabEntity,
    actions: BootstrapAction[],
  ): Promise<ProviderWebhook & { readonly secret: string }> {
    const hooks = await api<GitLabEntity[]>(
      `/projects/${encodeURIComponent(String(repo.id))}/hooks`,
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
          `/projects/${encodeURIComponent(String(repo.id))}/hooks/${encodeURIComponent(
            String(existing.id),
          )}`,
          { method: "PUT", body },
        )
      : await api<GitLabEntity>(
          `/projects/${encodeURIComponent(String(repo.id))}/hooks`,
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
    const result = await this.requestPage<T>(path, token, init);
    return result.body;
  }

  private async requestPage<T>(
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<{ readonly body: T; readonly headers: Headers }> {
    for (let attempt = 0; ; attempt += 1) {
      const headers = new Headers(init.headers);
      headers.set("PRIVATE-TOKEN", token);
      headers.set("Content-Type", "application/json");
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.requestTimeoutMs);
      const onAbort = () => controller.abort();
      init.signal?.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/api/v4${path}`, {
          ...init,
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onAbort);
        if (timedOut) {
          throw new GitLabProviderError(
            `GitLab ${init.method ?? "GET"} ${path} timed out`,
            408,
            null,
          );
        }
        throw error;
      }
      let text: string;
      try {
        text = await res.text();
      } catch (error) {
        if (timedOut) {
          throw new GitLabProviderError(
            `GitLab ${init.method ?? "GET"} ${path} timed out`,
            408,
            null,
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onAbort);
      }
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
      }
      if (res.status === 429 && attempt === 0) {
        const retryAfter = retryAfterMs(res.headers.get("Retry-After"));
        await delay(retryAfter);
        continue;
      }
      if (!res.ok) {
        const summary =
          body && typeof body === "object"
            ? ((body as { message?: unknown }).message ??
              (body as { error?: unknown }).error ??
              "")
            : typeof body === "string"
              ? body
              : "";
        const summaryStr =
          typeof summary === "string"
            ? summary
            : summary
              ? JSON.stringify(summary)
              : "";
        throw new GitLabProviderError(
          `GitLab ${init.method ?? "GET"} ${path} returned ${res.status}${summaryStr ? `: ${summaryStr}` : ""}`,
          res.status,
          body,
        );
      }
      return { body: body as T, headers: res.headers };
    }
  }

  private async getAllDiffs(
    repoId: ProviderId,
    iid: string,
  ): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const all: Readonly<Record<string, unknown>>[] = [];
    let page = 1;
    for (;;) {
      const result = await this.repoApiPage<
        readonly Readonly<Record<string, unknown>>[]
      >(
        repoId,
        `/merge_requests/${encodePath(iid)}/diffs?per_page=50&page=${page}`,
      );
      all.push(...result.body);
      const next = result.headers.get("x-next-page");
      if (!next) break;
      const nextPage = Number(next);
      if (!Number.isInteger(nextPage) || nextPage <= page) break;
      page = nextPage;
    }
    return all;
  }
  private async getMergeability(
    repoId: ProviderId,
    iid: string,
  ): Promise<{
    readonly mr: GitLabMergeRequest;
    readonly rejected: boolean;
    readonly reason?: string;
  }> {
    const startedAt = Date.now();
    let pollDelay = 100;
    for (;;) {
      const mr = await this.repoApi<GitLabMergeRequest>(
        repoId,
        `/merge_requests/${encodePath(iid)}?with_merge_status_recheck=true`,
      );
      const detailed = mr.detailed_merge_status ?? undefined;
      const legacy = mr.merge_status ?? undefined;
      const statuses = [detailed, legacy]
        .filter((status): status is string => Boolean(status))
        .map((status) => status.toLowerCase());
      if (mr.has_conflicts || statuses.some(isKnownUnmergeable)) {
        return {
          mr,
          rejected: true,
          reason: mr.has_conflicts ? "conflicts" : (detailed ?? legacy),
        };
      }
      if (
        !statuses.some((status) => ["checking", "unchecked"].includes(status))
      ) {
        return { mr, rejected: false };
      }
      if (Date.now() - startedAt >= 60_000) {
        return {
          mr,
          rejected: true,
          reason: "mergeability_check_timeout",
        };
      }
      await delay(pollDelay);
      pollDelay = Math.min(pollDelay * 2, 2_000);
    }
  }

  private async repoApiPage<T>(
    repoId: ProviderId,
    path: string,
    init?: RequestInit,
  ): Promise<{ readonly body: T; readonly headers: Headers }> {
    const token = this.requireToken();
    return this.requestPage<T>(
      `/projects/${encodePath(repoId)}${path}`,
      token,
      init,
    );
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.requireToken();
    return this.request<T>(path, token, init);
  }

  private async repoApi<T>(
    repoId: ProviderId,
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    return this.api<T>(`/projects/${encodePath(repoId)}${path}`, init);
  }

  private requireToken(): string {
    if (!this.token) {
      throw new GitLabProviderError(
        "GitLab provider requires a token for repo operations",
        500,
        null,
      );
    }
    return this.token;
  }
}
const KNOWN_UNMERGEABLE_STATUSES: Readonly<Record<string, true>> = {
  conflicts: true,
  conflict: true,
  ci_must_pass: true,
  status_checks_must_pass: true,
  not_approved: true,
  draft_status: true,
  not_open: true,
  cannot_be_merged: true,
  discussions_not_resolved: true,
  requested_changes: true,
  blocked_status: true,
  merge_time: true,
};

function isKnownUnmergeable(status: string): boolean {
  return KNOWN_UNMERGEABLE_STATUSES[status] === true;
}

function isNotFound(error: unknown): error is GitLabProviderError {
  return error instanceof GitLabProviderError && error.status === 404;
}

function retryAfterMs(value: string | null): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return Math.min(Math.max(seconds * 1_000, 0), 5_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return 1_000;
  return Math.min(Math.max(date - Date.now(), 0), 5_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function accessTokenInputBody(
  input: CreateProviderAccessTokenInput,
): Record<string, unknown> {
  return {
    name: input.name,
    scopes: input.scopes,
    access_level: input.access_level,
    expires_at: input.expires_at,
  };
}

function toAccessToken(
  provider: "gitlab",
  repoId: ProviderId,
  token: GitLabProjectAccessToken,
): ProviderAccessToken {
  if (!token.token) {
    throw new GitLabProviderError(
      "GitLab did not return a repo access token secret",
      500,
      token,
    );
  }
  return toAccessTokenListing(provider, repoId, token);
}

/** List responses omit the secret; mint responses include it. */
function toAccessTokenListing(
  provider: "gitlab",
  repoId: ProviderId,
  token: GitLabProjectAccessToken,
): ProviderAccessToken {
  return {
    id: String(token.id),
    project_id: String(token.project_id ?? repoId),
    name: token.name ?? String(token.id),
    token: token.token ?? "",
    scopes: [...(token.scopes ?? [])],
    expires_at: token.expires_at ?? "",
    metadata: meta(provider, token),
  };
}

function toIssue(
  provider: "gitlab",
  repoId: ProviderId,
  issue: GitLabIssue,
): ProviderIssue {
  const assignees = issue.assignees ?? (issue.assignee ? [issue.assignee] : []);
  const id = issueId(repoId, issue);
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

function toRepoInfo(provider: "gitlab", repo: GitLabProject): ProviderRepoInfo {
  const visibility: ProviderVisibility =
    repo.visibility === "public" || repo.visibility === "internal"
      ? repo.visibility
      : "private";
  return {
    ...toRef(provider, repo),
    path: repo.path_with_namespace ?? repo.path ?? String(repo.id),
    default_branch: repo.default_branch ?? "main",
    visibility,
  };
}

// CreateProviderRepoInput is part of the adapter's public contract; it is
// referenced via the `repos.create` parameter type.
export type { CreateProviderRepoInput };

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

function issueId(repoId: ProviderId, issue: GitLabIssue): ProviderId {
  return `${String(issue.project_id ?? repoId)}:${String(issue.iid ?? issue.id)}`;
}

function issueIid(repoId: ProviderId, id: ProviderId): string {
  const prefix = `${repoId}:`;
  if (id.startsWith(prefix)) return id.slice(prefix.length);
  const separator = id.lastIndexOf(":");
  return separator === -1 ? id : id.slice(separator + 1);
}
// MR IDs use the same `<project_id>:<iid>` shape as issues.
function mrIid(repoId: ProviderId, id: ProviderId): string {
  return issueIid(repoId, id);
}

function toMergeRequest(
  provider: "gitlab",
  repoId: ProviderId,
  mr: GitLabMergeRequest,
): ProviderMergeRequest {
  const iid = mr.iid ?? Number(mr.id);
  const id = `${String(mr.project_id ?? repoId)}:${String(mr.iid ?? mr.id)}`;
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
    detailed_merge_status:
      mr.detailed_merge_status ?? mr.merge_status ?? undefined,
    has_conflicts: mr.has_conflicts,
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
  repoId: ProviderId,
  branch: GitLabBranch,
): ProviderBranch {
  const id = `${String(repoId)}:${branch.name}`;
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
  repoId: ProviderId,
  commit: GitLabCommit,
): ProviderCommit {
  const id = `${String(repoId)}:${commit.id}`;
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
