/* eslint-disable @typescript-eslint/require-await */

export * from "./commands.js";

export const COLONY_PROVIDER_PACKAGE = "@colony/provider" as const;

export type ProviderId = string;
export type ProviderName = "gitlab" | "fake" | (string & {});
export type ProviderVisibility = "private" | "internal" | "public";

export interface ProviderMetadata {
  readonly provider: ProviderName;
  readonly id: ProviderId;
  readonly web_url?: string;
  readonly version?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface ProviderRef {
  readonly id: ProviderId;
  readonly iid?: number;
  readonly metadata: ProviderMetadata;
}

export type ProviderIssueState = "opened" | "closed";

export interface ProviderIssue extends ProviderRef {
  readonly title: string;
  readonly description: string;
  readonly state: ProviderIssueState;
  readonly labels: readonly string[];
  readonly assignee_ids: readonly ProviderId[];
}

export interface ProviderComment extends ProviderRef {
  readonly body: string;
  readonly author_id?: ProviderId;
  readonly created_at: string;
}

export interface ProviderMergeRequest extends ProviderRef {
  readonly title: string;
  readonly description: string;
  readonly source_branch: string;
  readonly target_branch: string;
  readonly state: "opened" | "closed" | "merged";
  readonly head_commit_sha?: string;
  readonly detailed_merge_status?: string;
  readonly has_conflicts?: boolean;
  readonly merged?: boolean;
  /**
   * Set on a merge result when the provider could not complete the merge.
   * Ordinary merge requests omit this field.
   */
  readonly reason?: string;
}

export interface ProviderBranch extends ProviderRef {
  readonly name: string;
  readonly commit_sha: string;
  readonly protected: boolean;
}

export interface ProviderCommit extends ProviderRef {
  readonly sha: string;
  readonly title?: string;
}

export interface ProviderPipeline extends ProviderRef {
  readonly status: string;
  readonly commit_sha?: string;
}

export interface ProviderUser extends ProviderRef {
  readonly username: string;
  readonly name: string;
  readonly email?: string;
  readonly bot: boolean;
}

export interface ProviderWebhook extends ProviderRef {
  readonly url: string;
  readonly events: readonly string[];
}

export interface ProviderAccessToken extends ProviderRef {
  readonly project_id: ProviderId;
  readonly name: string;
  readonly token: string;
  readonly scopes: readonly string[];
  readonly expires_at: string;
}

/**
 * Provider-side view of a git repository. This is what an adapter returns
 * from `repos.create` / `repos.get*` so call sites can hand the result
 * straight to the store's scope creation.
 */
export interface ProviderRepoInfo extends ProviderRef {
  readonly path: string;
  readonly default_branch: string;
  readonly visibility: ProviderVisibility;
}

export interface CreateProviderRepoInput {
  readonly name: string;
  readonly path: string;
  /**
   * Opaque owner of the new repo. Provider-resolved: a GitLab group
   * path or numeric group ID, a GitHub org/user login. Omit to put the
   * repo under the bot's own namespace (discovered via `identity()`).
   */
  readonly namespace?: string;
  readonly description?: string;
  readonly visibility?: ProviderVisibility;
  readonly default_branch?: string;
}

export interface ProviderGroup extends ProviderRef {
  readonly path: string;
  readonly visibility: ProviderVisibility;
}

export interface CreateProviderGroupInput {
  readonly name: string;
  readonly path: string;
  readonly parent?: string;
  readonly visibility?: ProviderVisibility;
  readonly description?: string;
}

export interface CreateProviderUserInput {
  readonly username: string;
  readonly name: string;
  readonly email: string;
  readonly bot?: boolean;
  readonly admin?: boolean;
}

/**
 * Self-identification for the bot the adapter is running as.
 *
 * Deliberately does not encode "is_admin" — token power is provider-shaped
 * (GitLab user-admin flag, GitHub fine-grained scopes, GitHub App
 * permissions, GitLab project-access tokens) and "admin" doesn't translate.
 * Operations that need elevated power succeed or fail at call time; callers
 * shouldn't pre-flight against a boolean.
 */
export interface ProviderIdentitySnapshot {
  readonly user_id: ProviderId;
  readonly username: string;
  readonly default_namespace: string;
  readonly accessible_namespaces: readonly string[];
}

export interface BootstrapBotSpec {
  readonly username: string;
  readonly name: string;
  readonly email: string;
  readonly scopes: readonly string[];
  readonly role?: string;
}

export type BootstrapBotSpecs =
  | Readonly<Record<string, BootstrapBotSpec>>
  | BootstrapBotSpec[];

export interface BootstrapGroupSpec {
  readonly name: string;
  readonly path: string;
  readonly parent_id?: ProviderId;
  readonly visibility?: ProviderVisibility;
}

export interface BootstrapRepoSpec {
  readonly name: string;
  readonly path: string;
  readonly description?: string;
  readonly visibility?: ProviderVisibility;
}

export interface BootstrapOAuthApplicationSpec {
  readonly name: string;
  readonly redirect_uris: readonly string[];
  readonly scopes: readonly string[];
  readonly confidential?: boolean;
}

export interface BootstrapWebhookSpec {
  readonly url: string;
  readonly secret?: string;
  readonly events?: readonly string[];
  readonly enable_ssl_verification?: boolean;
}

export interface ProviderBootstrapSpec {
  readonly provider: ProviderName;
  readonly environment: string;
  readonly base_url: string;
  readonly group: BootstrapGroupSpec;
  readonly repo: BootstrapRepoSpec;
  readonly bots?: BootstrapBotSpecs;
  readonly oauth_application: BootstrapOAuthApplicationSpec;
  readonly webhook: BootstrapWebhookSpec;
  readonly rotate_tokens?: boolean;
}

export type BootstrapActionStatus =
  | "created"
  | "existing"
  | "updated"
  | "rotated";

export interface BootstrapAction {
  readonly resource: string;
  readonly status: BootstrapActionStatus;
  readonly provider_id: ProviderId;
}

export interface ProviderBootstrapResult {
  readonly provider: ProviderName;
  readonly environment: string;
  readonly base_url: string;
  readonly group: ProviderRef;
  readonly repo: ProviderRef;
  readonly bot_users: Readonly<Record<string, ProviderUser>>;
  readonly bot_tokens: Readonly<Record<string, string>>;
  readonly oauth_application: ProviderRef & {
    readonly client_id: string;
    readonly client_secret?: string;
  };
  readonly webhook: ProviderWebhook & {
    readonly secret: string;
  };
  readonly actions: readonly BootstrapAction[];
  readonly env: Readonly<Record<string, string>>;
  readonly redacted_env: string;
}

export interface CreateIssueInput {
  readonly title: string;
  readonly description: string;
  readonly labels?: readonly string[];
  readonly assignee_ids?: readonly ProviderId[];
}

export interface UpdateIssueInput {
  readonly title?: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly assignee_ids?: readonly ProviderId[];
}

/**
 * Per-operation provider repo context (COL-1.2b).
 *
 * Every issue/MR/branch/commit/pipeline call carries the repo it acts on
 * so a single adapter instance can serve multiple git repositories under
 * the same scope. `id` is the provider repo ID (the durable identifier);
 * `path` is included for logging and for webhook lookups that match by path.
 */
export interface ProviderRepoRef {
  readonly id: ProviderId;
  readonly path?: string;
}

export interface CreateProviderAccessTokenInput {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly access_level?: number;
  readonly expires_at: string;
}

export interface ProviderHealth {
  readonly ok: boolean;
  /** ISO-8601 timestamp; provider package keeps it as plain string. */
  readonly checked_at: string;
  readonly latency_ms?: number;
  readonly error?: string;
  readonly version?: string;
}

export interface ProviderAdapter {
  readonly provider: ProviderName;
  /**
   * Provision groups, repos, bot users, OAuth applications, and webhooks
   * using the adapter's configured bot credential. The credential's scope is
   * provider-shaped — GitLab admin PAT, GitHub App permissions, fine-grained
   * GitHub PAT — and operations succeed or fail at call time. Authorization
   * to call this is gated upstream by `provider.admin.bootstrap` capability,
   * not by token swap.
   */
  bootstrap(spec: ProviderBootstrapSpec): Promise<ProviderBootstrapResult>;
  /**
   * Self-identification for the bot the adapter is running as. Used by
   * agents and the gateway to discover the default namespace, list
   * groups/orgs the bot can write to, and decide whether admin-only ops
   * are even possible.
   */
  identity(): Promise<ProviderIdentitySnapshot>;
  /**
   * Cheap reachability check used by the supervisor before issuing
   * provider-visible writes. Should never throw; always returns a
   * `ProviderHealth` snapshot with `ok=false` + `error` on failure.
   * Implementations: GitLab hits `/api/v4/version`; the fake adapter
   * returns ok unless `setHealthOverride({ ok: false, error })` was
   * called.
   */
  health(): Promise<ProviderHealth>;
  readonly groups: {
    create(input: CreateProviderGroupInput): Promise<ProviderGroup>;
    delete(id: ProviderId): Promise<void>;
    getByPath(path: string): Promise<ProviderGroup | null>;
  };
  /**
   * Repo lifecycle. The adapter uses its configured bot credential —
   * homelab defaults run with broad scope; production setups will narrow
   * the credential and rely on call-time failure when scope is insufficient.
   * Authorization is gated upstream by capability + Tool Gateway.
   */
  readonly repos: {
    create(input: CreateProviderRepoInput): Promise<ProviderRepoInfo>;
    delete(id: ProviderId): Promise<void>;
    getById(id: ProviderId): Promise<ProviderRepoInfo | null>;
    getByPath(path: string): Promise<ProviderRepoInfo | null>;
  };
  readonly accessTokens?: {
    mint(
      repo: ProviderRepoRef,
      input: CreateProviderAccessTokenInput,
    ): Promise<ProviderAccessToken>;
    revoke(repo: ProviderRepoRef, id: ProviderId): Promise<void>;
    list(repo: ProviderRepoRef): Promise<readonly ProviderAccessToken[]>;
  };
  readonly issues: {
    get(repo: ProviderRepoRef, id: ProviderId): Promise<ProviderIssue>;
    create(
      repo: ProviderRepoRef,
      input: CreateIssueInput,
    ): Promise<ProviderIssue>;
    update(
      repo: ProviderRepoRef,
      id: ProviderId,
      input: UpdateIssueInput,
    ): Promise<ProviderIssue>;
    close(repo: ProviderRepoRef, id: ProviderId): Promise<ProviderIssue>;
    reopen(repo: ProviderRepoRef, id: ProviderId): Promise<ProviderIssue>;
    addLabel(
      repo: ProviderRepoRef,
      id: ProviderId,
      label: string,
    ): Promise<ProviderIssue>;
    removeLabel(
      repo: ProviderRepoRef,
      id: ProviderId,
      label: string,
    ): Promise<ProviderIssue>;
    setAssignees(
      repo: ProviderRepoRef,
      id: ProviderId,
      assigneeIds: readonly ProviderId[],
    ): Promise<ProviderIssue>;
    comment(
      repo: ProviderRepoRef,
      id: ProviderId,
      body: string,
    ): Promise<ProviderComment>;
  };
  readonly epics: {
    create(
      repo: ProviderRepoRef,
      input: CreateIssueInput,
    ): Promise<ProviderIssue>;
    update(
      repo: ProviderRepoRef,
      id: ProviderId,
      input: UpdateIssueInput,
    ): Promise<ProviderIssue>;
    close(repo: ProviderRepoRef, id: ProviderId): Promise<ProviderIssue>;
  };
  readonly mergeRequests: {
    get(repo: ProviderRepoRef, id: ProviderId): Promise<ProviderMergeRequest>;
    open(
      repo: ProviderRepoRef,
      input: {
        readonly title: string;
        readonly description: string;
        readonly source_branch: string;
        readonly target_branch: string;
      },
    ): Promise<ProviderMergeRequest>;
    update(
      repo: ProviderRepoRef,
      id: ProviderId,
      input: Partial<Pick<ProviderMergeRequest, "title" | "description">>,
    ): Promise<ProviderMergeRequest>;
    approve(
      repo: ProviderRepoRef,
      id: ProviderId,
    ): Promise<ProviderMergeRequest>;
    unapprove(
      repo: ProviderRepoRef,
      id: ProviderId,
    ): Promise<ProviderMergeRequest>;
    merge(
      repo: ProviderRepoRef,
      id: ProviderId,
      input?: { readonly sha?: string },
    ): Promise<ProviderMergeRequest>;
    close(repo: ProviderRepoRef, id: ProviderId): Promise<ProviderMergeRequest>;
    comment(
      repo: ProviderRepoRef,
      id: ProviderId,
      body: string,
    ): Promise<ProviderComment>;
    addReviewThread(
      repo: ProviderRepoRef,
      id: ProviderId,
      body: string,
    ): Promise<ProviderComment>;
    diff(
      repo: ProviderRepoRef,
      id: ProviderId,
    ): Promise<readonly Readonly<Record<string, unknown>>[]>;
  };
  readonly branches: {
    create(
      repo: ProviderRepoRef,
      name: string,
      ref: string,
    ): Promise<ProviderBranch>;
    delete(repo: ProviderRepoRef, name: string): Promise<void>;
    protect(repo: ProviderRepoRef, name: string): Promise<ProviderBranch>;
  };
  readonly commits: {
    get(repo: ProviderRepoRef, sha: string): Promise<ProviderCommit>;
    diff(
      repo: ProviderRepoRef,
      sha: string,
    ): Promise<readonly Readonly<Record<string, unknown>>[]>;
    /**
     * Push a multi-file commit to a branch. Used by the Architect
     * activity to materialize the proposed decomposition as a spec MR
     * (spec.md + decomposition.json) so reviewers and humans can read
     * + comment on the architect's output through GitLab's standard MR
     * UX. `actions` follows GitLab's `repository/commits` shape.
     */
    create(
      repo: ProviderRepoRef,
      input: {
        readonly branch: string;
        readonly message: string;
        readonly actions: readonly {
          readonly action: "create" | "update" | "delete";
          readonly file_path: string;
          readonly content?: string;
        }[];
      },
    ): Promise<ProviderCommit>;
  };
  readonly pipelines: {
    getStatus(repo: ProviderRepoRef, id: ProviderId): Promise<ProviderPipeline>;
    trigger(repo: ProviderRepoRef, ref: string): Promise<ProviderPipeline>;
  };
  readonly users: {
    create(input: CreateProviderUserInput): Promise<ProviderUser>;
    resolveById(id: ProviderId): Promise<ProviderUser | null>;
    resolveByUsername(username: string): Promise<ProviderUser | null>;
  };
  readonly webhooks: {
    register(
      repo: ProviderRepoRef,
      input: {
        readonly url: string;
        readonly secret: string;
        readonly events?: readonly string[];
      },
    ): Promise<ProviderWebhook>;
    unregister(repo: ProviderRepoRef, id: ProviderId): Promise<void>;
    verifySignature(input: {
      readonly headers: Readonly<Record<string, string | undefined>>;
      readonly body: string;
      readonly secret: string;
    }): Promise<boolean>;
  };
}

const iso = () => new Date(0).toISOString();

function redactedEnv(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(
      ([k, v]) =>
        `${k}=${k.includes("TOKEN") || k.includes("SECRET") ? redact(v) : v}`,
    )
    .join("\n");
}

export function redact(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function redactBootstrapResult(
  result: ProviderBootstrapResult,
): ProviderBootstrapResult {
  const env = Object.fromEntries(
    Object.entries(result.env).map(([k, v]) => [
      k,
      k.includes("TOKEN") || k.includes("SECRET") ? redact(v) : v,
    ]),
  );
  return {
    ...result,
    bot_tokens: Object.fromEntries(
      Object.entries(result.bot_tokens).map(([role, token]) => [
        role,
        redact(token),
      ]),
    ),
    oauth_application: {
      ...result.oauth_application,
      client_secret: result.oauth_application.client_secret
        ? redact(result.oauth_application.client_secret)
        : undefined,
    },
    webhook: {
      ...result.webhook,
      secret: redact(result.webhook.secret),
    },
    env,
    redacted_env: redactedEnv(env),
  };
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly provider = "fake" as const;
  private issueSeq = 1;
  private commentSeq = 1;
  private mrSeq = 1;
  private repoSeq = 1;
  private accessTokenSeq = 1;
  private readonly issuesById = new Map<ProviderId, ProviderIssue>();
  private readonly usersById = new Map<ProviderId, ProviderUser>();
  private readonly usersByUsername = new Map<string, ProviderUser>();
  private readonly mergeRequestsById = new Map<
    ProviderId,
    ProviderMergeRequest
  >();
  private readonly branchesByName = new Map<string, ProviderBranch>();
  private readonly webhooksById = new Map<ProviderId, ProviderWebhook>();
  private readonly reposById = new Map<ProviderId, ProviderRepoInfo>();
  private readonly reposByPath = new Map<string, ProviderRepoInfo>();
  private readonly groupsById = new Map<ProviderId, ProviderGroup>();
  private readonly groupsByPath = new Map<string, ProviderGroup>();
  private readonly accessTokensById = new Map<
    ProviderId,
    ProviderAccessToken
  >();
  private groupSeq = 1;

  readonly groups: ProviderAdapter["groups"] = {
    create: async (input) => {
      const fullPath = input.parent
        ? `${input.parent}/${input.path}`
        : input.path;
      const existing = this.groupsByPath.get(fullPath);
      if (existing) return existing;
      const id = `fake-group-${this.groupSeq++}`;
      const group: ProviderGroup = {
        id,
        path: fullPath,
        visibility: input.visibility ?? "private",
        metadata: this.meta(id),
      };
      this.groupsById.set(id, group);
      this.groupsByPath.set(fullPath, group);
      return group;
    },
    delete: async (id) => {
      const existing = this.groupsById.get(id);
      this.groupsById.delete(id);
      if (existing) this.groupsByPath.delete(existing.path);
      // cascade: drop repos under this group (path-prefix match)
      for (const [path, repo] of this.reposByPath) {
        if (path.startsWith(`${existing?.path ?? id}/`)) {
          this.reposByPath.delete(path);
          this.reposById.delete(repo.id);
        }
      }
    },
    getByPath: async (path) => this.groupsByPath.get(path) ?? null,
  };

  readonly repos: ProviderAdapter["repos"] = {
    create: async (input) => {
      const fullPath = input.namespace
        ? `${input.namespace}/${input.path}`
        : input.path;
      const existing = this.reposByPath.get(fullPath);
      if (existing) return existing;
      const id = `fake-repo-${this.repoSeq++}`;
      const repo: ProviderRepoInfo = {
        id,
        path: fullPath,
        default_branch: input.default_branch ?? "main",
        visibility: input.visibility ?? "private",
        metadata: this.meta(id),
      };
      this.reposById.set(id, repo);
      this.reposByPath.set(fullPath, repo);
      return repo;
    },
    delete: async (id) => {
      const existing = this.reposById.get(id);
      this.reposById.delete(id);
      if (existing) this.reposByPath.delete(existing.path);
    },
    getById: async (id) => this.reposById.get(id) ?? null,
    getByPath: async (path) => this.reposByPath.get(path) ?? null,
  };

  readonly accessTokens: NonNullable<ProviderAdapter["accessTokens"]> = {
    mint: async (repo, input) => {
      const id = `${repo.id}:access-token-${this.accessTokenSeq++}`;
      const token: ProviderAccessToken = {
        id,
        project_id: repo.id,
        name: input.name,
        token: `fake-agent-token-${id}`,
        scopes: [...input.scopes],
        expires_at: input.expires_at,
        metadata: this.meta(id),
      };
      this.accessTokensById.set(id, token);
      return token;
    },
    revoke: async (_repo, id) => {
      this.accessTokensById.delete(id);
    },
    list: async (repo) =>
      [...this.accessTokensById.values()].filter(
        (token) => token.project_id === repo.id,
      ),
  };

  /** Test seam: inspect tokens the fake adapter still considers live. */
  listAccessTokens(): ProviderAccessToken[] {
    return [...this.accessTokensById.values()];
  }

  async identity(): Promise<ProviderIdentitySnapshot> {
    return {
      user_id: "fake-bot",
      username: "fake-bot",
      default_namespace: "fake-bot",
      accessible_namespaces: ["fake-bot", ...this.groupsByPath.keys()],
    };
  }

  /**
   * Test/dogfood lever: forces subsequent `health()` calls to return
   * `{ ok: false, error }`. Pass `null` to clear the override and resume
   * always-healthy responses.
   */
  setHealthOverride(override: { ok: boolean; error?: string } | null): void {
    this.healthOverride = override;
  }
  private healthOverride: { ok: boolean; error?: string } | null = null;

  async health(): Promise<ProviderHealth> {
    const checked_at = new Date().toISOString();
    if (this.healthOverride && !this.healthOverride.ok) {
      return {
        ok: false,
        checked_at,
        error: this.healthOverride.error ?? "fake_provider_unhealthy",
      };
    }
    return { ok: true, checked_at, latency_ms: 0, version: "fake-1.0.0" };
  }

  readonly issues: ProviderAdapter["issues"] = {
    get: async (repo, id) => this.requireIssue(repo, id),
    create: async (repo, input) => this.createIssue(repo, "issue", input),
    update: async (repo, id, input) => this.updateIssue(repo, id, input),
    close: async (repo, id) => this.setIssueState(repo, id, "closed"),
    reopen: async (repo, id) => this.setIssueState(repo, id, "opened"),
    addLabel: async (repo, id, label) => {
      const issue = this.requireIssue(repo, id);
      return this.replaceIssue(repo, id, {
        ...issue,
        labels: [...new Set([...issue.labels, label])],
      });
    },
    removeLabel: async (repo, id, label) => {
      const issue = this.requireIssue(repo, id);
      return this.replaceIssue(repo, id, {
        ...issue,
        labels: issue.labels.filter((x) => x !== label),
      });
    },
    setAssignees: async (repo, id, assigneeIds) => {
      const issue = this.requireIssue(repo, id);
      return this.replaceIssue(repo, id, {
        ...issue,
        assignee_ids: [...assigneeIds],
      });
    },
    comment: async (_repo, _id, body) =>
      this.createComment("issue-comment", body),
  };

  readonly epics: ProviderAdapter["epics"] = {
    create: async (repo, input) => this.createIssue(repo, "epic", input),
    update: async (repo, id, input) => this.updateIssue(repo, id, input),
    close: async (repo, id) => this.setIssueState(repo, id, "closed"),
  };

  readonly mergeRequests: ProviderAdapter["mergeRequests"] = {
    get: async (_repo, id) => this.requireMr(id),
    open: async (repo, input) => {
      const iid = this.mrSeq++;
      const id = `${repo.id}:${iid}`;
      const sourceHead = this.branchesByName.get(
        branchKey(repo, input.source_branch),
      )?.commit_sha;
      const mr: ProviderMergeRequest = {
        id,
        iid,
        title: input.title,
        description: input.description,
        source_branch: input.source_branch,
        target_branch: input.target_branch,
        state: "opened",
        head_commit_sha: sourceHead,
        metadata: this.meta(id),
      };
      this.mergeRequestsById.set(id, mr);
      return mr;
    },
    update: async (_repo, id, input) => {
      const mr = this.requireMr(id);
      const next = { ...mr, ...input, metadata: this.meta(id) };
      this.mergeRequestsById.set(id, next);
      return next;
    },
    approve: async (_repo, id) => this.requireMr(id),
    unapprove: async (_repo, id) => this.requireMr(id),
    merge: async (_repo, id) =>
      this.replaceMr(id, {
        ...this.requireMr(id),
        state: "merged",
        merged: true,
      }),
    close: async (_repo, id) =>
      this.replaceMr(id, { ...this.requireMr(id), state: "closed" }),
    comment: async (_repo, _id, body) => this.createComment("mr-comment", body),
    addReviewThread: async (_repo, _id, body) =>
      this.createComment("review-thread", body),
    diff: async () => [],
  };

  readonly branches: ProviderAdapter["branches"] = {
    create: async (repo, name, ref) => {
      const key = branchKey(repo, name);
      const branch = {
        id: key,
        name,
        commit_sha: ref,
        protected: false,
        metadata: this.meta(key),
      };
      this.branchesByName.set(key, branch);
      return branch;
    },
    delete: async (repo, name) => {
      this.branchesByName.delete(branchKey(repo, name));
    },
    protect: async (repo, name) => {
      const key = branchKey(repo, name);
      const current =
        this.branchesByName.get(key) ??
        ({
          id: key,
          name,
          commit_sha: "HEAD",
          protected: false,
          metadata: this.meta(key),
        } satisfies ProviderBranch);
      const next = { ...current, protected: true, metadata: this.meta(key) };
      this.branchesByName.set(key, next);
      return next;
    },
  };

  readonly commits: ProviderAdapter["commits"] = {
    get: async (repo, ref) => {
      // A branch name resolves to the branch head commit; any other ref is
      // echoed back (test-controlled SHAs).
      const branch = this.branchesByName.get(branchKey(repo, ref));
      const sha = branch ? branch.commit_sha : ref;
      return {
        id: `${repo.id}:${sha}`,
        sha,
        metadata: this.meta(`${repo.id}:${sha}`),
      };
    },
    diff: async () => [],
    create: async (repo, input) => {
      const sha = `fake-sha-${Date.now()}-${input.branch.replace(/[^a-zA-Z0-9]/g, "-")}`;
      const branch = this.branchesByName.get(branchKey(repo, input.branch));
      if (branch) {
        this.branchesByName.set(branchKey(repo, input.branch), {
          ...branch,
          commit_sha: sha,
        });
      }
      return {
        id: `${repo.id}:${sha}`,
        sha,
        metadata: this.meta(`${repo.id}:${sha}`),
      };
    },
  };

  readonly pipelines: ProviderAdapter["pipelines"] = {
    getStatus: async (_repo, id) => ({
      id,
      status: "success",
      metadata: this.meta(id),
    }),
    trigger: async (repo, ref) => ({
      id: `pipeline-${repo.id}-${ref}`,
      status: "pending",
      metadata: this.meta(ref),
    }),
  };

  readonly users: ProviderAdapter["users"] = {
    create: async (input) => {
      const existing = this.usersByUsername.get(input.username);
      if (existing) return existing;
      const user: ProviderUser = {
        id: `fake-user-${input.username}`,
        username: input.username,
        name: input.name,
        email: input.email,
        bot: input.bot ?? false,
        metadata: this.meta(`fake-user-${input.username}`),
      };
      this.usersById.set(user.id, user);
      this.usersByUsername.set(user.username, user);
      return user;
    },
    resolveById: async (id) => this.usersById.get(id) ?? null,
    resolveByUsername: async (username) =>
      this.usersByUsername.get(username) ?? null,
  };

  readonly webhooks: ProviderAdapter["webhooks"] = {
    register: async (_repo, input) => {
      const id = `webhook-${this.webhooksById.size + 1}`;
      const hook = {
        id,
        url: input.url,
        events: input.events ?? [
          "issues",
          "merge_requests",
          "notes",
          "pipelines",
        ],
        metadata: this.meta(id),
      };
      this.webhooksById.set(id, hook);
      return hook;
    },
    unregister: async (_repo, id) => {
      this.webhooksById.delete(id);
    },
    verifySignature: async (input) =>
      input.headers["x-gitlab-token"] === input.secret ||
      input.headers["X-Gitlab-Token"] === input.secret,
  };

  async bootstrap(
    spec: ProviderBootstrapSpec,
  ): Promise<ProviderBootstrapResult> {
    const group = {
      id: `fake-group-${spec.environment}`,
      metadata: this.meta(`fake-group-${spec.environment}`),
    };
    const repo = {
      id: `fake-repo-${spec.environment}`,
      metadata: this.meta(`fake-repo-${spec.environment}`),
    };
    const botSpecs = normalizeBootstrapBots(spec.bots);
    const botUsers = Object.fromEntries(
      Object.entries(botSpecs).map(([role, botSpec]) => [
        role,
        this.upsertBot(botSpec),
      ]),
    );
    const botTokens = Object.fromEntries(
      Object.entries(botUsers).map(([role, user]) => [
        role,
        `fake-token-${user.username}`,
      ]),
    );
    const webhookSecret =
      spec.webhook.secret ?? `fake-webhook-secret-${spec.environment}`;
    const env = {
      GITLAB_BASE_URL: spec.base_url,
      GITLAB_DEV_REPO_ID: repo.id,
      ...botTokenEnv(botTokens),
      // Back-compat aliases for current adapter constructor wiring.
      GITLAB_TOKEN: botTokens.engine ?? "",
      GITLAB_REVIEWER_TOKEN: botTokens.reviewer ?? "",
      GITLAB_WEBHOOK_SECRET: webhookSecret,
      OAUTH_CLIENT_ID: `fake-oauth-${spec.environment}`,
      OAUTH_CLIENT_SECRET: `fake-oauth-secret-${spec.environment}`,
    };
    return {
      provider: this.provider,
      environment: spec.environment,
      base_url: spec.base_url,
      group,
      repo,
      bot_users: botUsers,
      bot_tokens: botTokens,
      oauth_application: {
        id: `fake-oauth-${spec.environment}`,
        client_id: `fake-oauth-${spec.environment}`,
        client_secret: env.OAUTH_CLIENT_SECRET,
        metadata: this.meta(`fake-oauth-${spec.environment}`),
      },
      webhook: {
        id: `fake-webhook-${spec.environment}`,
        url: spec.webhook.url,
        secret: webhookSecret,
        events: spec.webhook.events ?? [
          "issues",
          "merge_requests",
          "notes",
          "pipelines",
        ],
        metadata: this.meta(`fake-webhook-${spec.environment}`),
      },
      actions: [
        { resource: "group", status: "existing", provider_id: group.id },
        { resource: "repo", status: "existing", provider_id: repo.id },
        ...Object.entries(botUsers).flatMap(([role, user]) => [
          {
            resource: `bot:${role}`,
            status: "existing" as const,
            provider_id: user.id,
          },
          {
            resource: `bot_token:${role}`,
            status: "rotated" as const,
            provider_id: `fake-token-${role}`,
          },
        ]),
        {
          resource: "oauth_application",
          status: "existing",
          provider_id: `fake-oauth-${spec.environment}`,
        },
        {
          resource: "webhook",
          status: "updated",
          provider_id: `fake-webhook-${spec.environment}`,
        },
      ],
      env,
      redacted_env: redactedEnv(env),
    };
  }

  private createIssue(
    repo: ProviderRepoRef,
    kind: "issue" | "epic",
    input: CreateIssueInput,
  ): ProviderIssue {
    const id = `${repo.id}:${kind}-${this.issueSeq++}`;
    const issue: ProviderIssue = {
      id,
      iid: this.issueSeq - 1,
      title: input.title,
      description: input.description,
      state: "opened",
      labels: [...(input.labels ?? [])],
      assignee_ids: [...(input.assignee_ids ?? [])],
      metadata: this.meta(id),
    };
    this.issuesById.set(id, issue);
    return issue;
  }

  private updateIssue(
    repo: ProviderRepoRef,
    id: ProviderId,
    input: UpdateIssueInput,
  ): ProviderIssue {
    const current = this.requireIssue(repo, id);
    return this.replaceIssue(repo, id, {
      ...current,
      ...input,
      labels: input.labels ? [...input.labels] : current.labels,
      assignee_ids: input.assignee_ids
        ? [...input.assignee_ids]
        : current.assignee_ids,
      metadata: this.meta(id),
    });
  }

  private setIssueState(
    repo: ProviderRepoRef,
    id: ProviderId,
    state: ProviderIssueState,
  ): ProviderIssue {
    const current = this.requireIssue(repo, id);
    return this.replaceIssue(repo, id, {
      ...current,
      state,
      metadata: this.meta(id),
    });
  }

  private replaceIssue(
    _repo: ProviderRepoRef,
    id: ProviderId,
    issue: ProviderIssue,
  ): ProviderIssue {
    this.issuesById.set(id, issue);
    return issue;
  }

  private requireIssue(_repo: ProviderRepoRef, id: ProviderId): ProviderIssue {
    const issue = this.issuesById.get(id);
    if (!issue) throw new Error(`fake provider issue not found: ${id}`);
    return issue;
  }

  private requireMr(id: ProviderId): ProviderMergeRequest {
    const mr = this.mergeRequestsById.get(id);
    if (!mr) throw new Error(`fake provider MR not found: ${id}`);
    return mr;
  }

  private replaceMr(
    id: ProviderId,
    mr: ProviderMergeRequest,
  ): ProviderMergeRequest {
    this.mergeRequestsById.set(id, mr);
    return mr;
  }

  private createComment(prefix: string, body: string): ProviderComment {
    const id = `${prefix}-${this.commentSeq++}`;
    return { id, body, created_at: iso(), metadata: this.meta(id) };
  }

  private upsertBot(spec: BootstrapBotSpec): ProviderUser {
    const existing = this.usersByUsername.get(spec.username);
    if (existing) return existing;
    const user = {
      id: `fake-user-${spec.username}`,
      username: spec.username,
      name: spec.name,
      email: spec.email,
      bot: true,
      metadata: this.meta(`fake-user-${spec.username}`),
    };
    this.usersById.set(user.id, user);
    this.usersByUsername.set(user.username, user);
    return user;
  }

  private meta(id: ProviderId): ProviderMetadata {
    return {
      provider: this.provider,
      id,
      web_url: `https://fake.provider/${id}`,
      version: "1",
    };
  }
}

function branchKey(repo: ProviderRepoRef, name: string): string {
  return `${repo.id}:${name}`;
}

export function defaultEngineBot(): BootstrapBotSpec {
  return {
    username: "colony-engine",
    name: "Colony Engine",
    email: "colony-engine@example.invalid",
    scopes: ["api", "read_repository", "write_repository"],
    role: "engine",
  };
}

export function defaultReviewerBot(): BootstrapBotSpec {
  return {
    username: "colony-reviewer",
    name: "Colony Reviewer",
    email: "colony-reviewer@example.invalid",
    scopes: ["api", "read_repository"],
    role: "reviewer",
  };
}

export function defaultArchitectBot(): BootstrapBotSpec {
  return {
    username: "colony-architect",
    name: "Colony Architect",
    email: "colony-architect@example.invalid",
    scopes: ["api", "read_repository"],
    role: "architect",
  };
}

export function defaultIntegratorBot(): BootstrapBotSpec {
  return {
    username: "colony-integrator",
    name: "Colony Integrator",
    email: "colony-integrator@example.invalid",
    scopes: ["api", "read_repository", "write_repository"],
    role: "integrator",
  };
}

export function defaultMemoryConsolidatorBot(): BootstrapBotSpec {
  return {
    username: "colony-memory-consolidator",
    name: "Colony Memory Consolidator",
    email: "colony-memory-consolidator@example.invalid",
    scopes: ["api", "read_repository"],
    role: "memory_consolidator",
  };
}

export function defaultSupervisorBot(): BootstrapBotSpec {
  return {
    username: "colony-supervisor",
    name: "Colony Supervisor",
    email: "colony-supervisor@example.invalid",
    scopes: ["api", "read_repository"],
    role: "supervisor",
  };
}

export function defaultBootstrapBots(): Readonly<
  Record<string, BootstrapBotSpec>
> {
  return {
    engine: defaultEngineBot(),
    reviewer: defaultReviewerBot(),
    architect: defaultArchitectBot(),
    integrator: defaultIntegratorBot(),
    memory_consolidator: defaultMemoryConsolidatorBot(),
    supervisor: defaultSupervisorBot(),
  };
}

export function normalizeBootstrapBots(
  bots: BootstrapBotSpecs | undefined,
): Readonly<Record<string, BootstrapBotSpec>> {
  if (!bots) return defaultBootstrapBots();
  if (Array.isArray(bots)) {
    const botList: readonly BootstrapBotSpec[] = bots;
    return Object.fromEntries(
      botList.map((bot) => [bot.role ?? bot.username, botWithRole(bot)]),
    );
  }
  const botRecord: Readonly<Record<string, BootstrapBotSpec>> = bots;
  return Object.fromEntries(
    Object.entries(botRecord).map(([role, bot]) => [
      role,
      bot.role === role ? bot : { ...bot, role },
    ]),
  );
}

export function botTokenEnv(
  botTokens: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(botTokens).map(([role, token]) => [
      `GITLAB_BOT_${envRole(role)}_TOKEN`,
      token,
    ]),
  );
}

function botWithRole(bot: BootstrapBotSpec): BootstrapBotSpec {
  return bot.role ? bot : { ...bot, role: bot.username };
}

function envRole(role: string): string {
  return role
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}
