/* eslint-disable @typescript-eslint/require-await */

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

export interface BootstrapBotSpec {
  readonly username: string;
  readonly name: string;
  readonly email: string;
  readonly scopes: readonly string[];
  readonly role?: string;
}

export interface BootstrapGroupSpec {
  readonly name: string;
  readonly path: string;
  readonly parent_id?: ProviderId;
  readonly visibility?: ProviderVisibility;
}

export interface BootstrapProjectSpec {
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
  readonly project: BootstrapProjectSpec;
  readonly bots?: {
    readonly engine?: BootstrapBotSpec;
    readonly reviewer?: BootstrapBotSpec;
  };
  readonly oauth_application: BootstrapOAuthApplicationSpec;
  readonly webhook: BootstrapWebhookSpec;
  readonly rotate_tokens?: boolean;
}

export interface ProviderCredential {
  readonly kind: "admin_pat";
  readonly token: string;
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
  readonly project: ProviderRef;
  readonly bot_users: {
    readonly engine: ProviderUser;
    readonly reviewer: ProviderUser;
  };
  readonly bot_tokens: {
    readonly engine: string;
    readonly reviewer: string;
  };
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

export interface ProviderAdapter {
  readonly provider: ProviderName;
  bootstrap(
    spec: ProviderBootstrapSpec,
    credential: ProviderCredential,
  ): Promise<ProviderBootstrapResult>;
  readonly issues: {
    create(input: CreateIssueInput): Promise<ProviderIssue>;
    update(id: ProviderId, input: UpdateIssueInput): Promise<ProviderIssue>;
    close(id: ProviderId): Promise<ProviderIssue>;
    reopen(id: ProviderId): Promise<ProviderIssue>;
    addLabel(id: ProviderId, label: string): Promise<ProviderIssue>;
    removeLabel(id: ProviderId, label: string): Promise<ProviderIssue>;
    setAssignees(
      id: ProviderId,
      assigneeIds: readonly ProviderId[],
    ): Promise<ProviderIssue>;
    comment(id: ProviderId, body: string): Promise<ProviderComment>;
  };
  readonly epics: {
    create(input: CreateIssueInput): Promise<ProviderIssue>;
    update(id: ProviderId, input: UpdateIssueInput): Promise<ProviderIssue>;
    close(id: ProviderId): Promise<ProviderIssue>;
  };
  readonly mergeRequests: {
    open(input: {
      readonly title: string;
      readonly description: string;
      readonly source_branch: string;
      readonly target_branch: string;
    }): Promise<ProviderMergeRequest>;
    update(
      id: ProviderId,
      input: Partial<Pick<ProviderMergeRequest, "title" | "description">>,
    ): Promise<ProviderMergeRequest>;
    approve(id: ProviderId): Promise<ProviderMergeRequest>;
    unapprove(id: ProviderId): Promise<ProviderMergeRequest>;
    merge(id: ProviderId): Promise<ProviderMergeRequest>;
    close(id: ProviderId): Promise<ProviderMergeRequest>;
    comment(id: ProviderId, body: string): Promise<ProviderComment>;
    addReviewThread(id: ProviderId, body: string): Promise<ProviderComment>;
  };
  readonly branches: {
    create(name: string, ref: string): Promise<ProviderBranch>;
    delete(name: string): Promise<void>;
    protect(name: string): Promise<ProviderBranch>;
  };
  readonly commits: {
    get(sha: string): Promise<ProviderCommit>;
    diff(sha: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
  };
  readonly pipelines: {
    getStatus(id: ProviderId): Promise<ProviderPipeline>;
    trigger(ref: string): Promise<ProviderPipeline>;
  };
  readonly users: {
    resolveById(id: ProviderId): Promise<ProviderUser | null>;
    resolveByUsername(username: string): Promise<ProviderUser | null>;
  };
  readonly webhooks: {
    register(input: {
      readonly url: string;
      readonly secret: string;
      readonly events?: readonly string[];
    }): Promise<ProviderWebhook>;
    unregister(id: ProviderId): Promise<void>;
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
    bot_tokens: {
      engine: redact(result.bot_tokens.engine),
      reviewer: redact(result.bot_tokens.reviewer),
    },
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
  private readonly issuesById = new Map<ProviderId, ProviderIssue>();
  private readonly usersById = new Map<ProviderId, ProviderUser>();
  private readonly usersByUsername = new Map<string, ProviderUser>();
  private readonly mergeRequestsById = new Map<
    ProviderId,
    ProviderMergeRequest
  >();
  private readonly branchesByName = new Map<string, ProviderBranch>();
  private readonly webhooksById = new Map<ProviderId, ProviderWebhook>();

  readonly issues: ProviderAdapter["issues"] = {
    create: async (input) => this.createIssue("issue", input),
    update: async (id, input) => this.updateIssue(id, input),
    close: async (id) => this.setIssueState(id, "closed"),
    reopen: async (id) => this.setIssueState(id, "opened"),
    addLabel: async (id, label) => {
      const issue = this.requireIssue(id);
      return this.replaceIssue(id, {
        ...issue,
        labels: [...new Set([...issue.labels, label])],
      });
    },
    removeLabel: async (id, label) => {
      const issue = this.requireIssue(id);
      return this.replaceIssue(id, {
        ...issue,
        labels: issue.labels.filter((x) => x !== label),
      });
    },
    setAssignees: async (id, assigneeIds) => {
      const issue = this.requireIssue(id);
      return this.replaceIssue(id, {
        ...issue,
        assignee_ids: [...assigneeIds],
      });
    },
    comment: async (_id, body) => this.createComment("issue-comment", body),
  };

  readonly epics: ProviderAdapter["epics"] = {
    create: async (input) => this.createIssue("epic", input),
    update: async (id, input) => this.updateIssue(id, input),
    close: async (id) => this.setIssueState(id, "closed"),
  };

  readonly mergeRequests: ProviderAdapter["mergeRequests"] = {
    open: async (input) => {
      const id = `mr-${this.mrSeq++}`;
      const mr: ProviderMergeRequest = {
        id,
        iid: this.mrSeq - 1,
        title: input.title,
        description: input.description,
        source_branch: input.source_branch,
        target_branch: input.target_branch,
        state: "opened",
        metadata: this.meta(id),
      };
      this.mergeRequestsById.set(id, mr);
      return mr;
    },
    update: async (id, input) => {
      const mr = this.requireMr(id);
      const next = { ...mr, ...input, metadata: this.meta(id) };
      this.mergeRequestsById.set(id, next);
      return next;
    },
    approve: async (id) => this.requireMr(id),
    unapprove: async (id) => this.requireMr(id),
    merge: async (id) =>
      this.replaceMr(id, { ...this.requireMr(id), state: "merged" }),
    close: async (id) =>
      this.replaceMr(id, { ...this.requireMr(id), state: "closed" }),
    comment: async (_id, body) => this.createComment("mr-comment", body),
    addReviewThread: async (_id, body) =>
      this.createComment("review-thread", body),
  };

  readonly branches: ProviderAdapter["branches"] = {
    create: async (name, ref) => {
      const branch = {
        id: name,
        name,
        commit_sha: ref,
        protected: false,
        metadata: this.meta(name),
      };
      this.branchesByName.set(name, branch);
      return branch;
    },
    delete: async (name) => {
      this.branchesByName.delete(name);
    },
    protect: async (name) => {
      const current =
        this.branchesByName.get(name) ??
        ({
          id: name,
          name,
          commit_sha: "HEAD",
          protected: false,
          metadata: this.meta(name),
        } satisfies ProviderBranch);
      const next = { ...current, protected: true, metadata: this.meta(name) };
      this.branchesByName.set(name, next);
      return next;
    },
  };

  readonly commits: ProviderAdapter["commits"] = {
    get: async (sha) => ({ id: sha, sha, metadata: this.meta(sha) }),
    diff: async () => [],
  };

  readonly pipelines: ProviderAdapter["pipelines"] = {
    getStatus: async (id) => ({
      id,
      status: "success",
      metadata: this.meta(id),
    }),
    trigger: async (ref) => ({
      id: `pipeline-${ref}`,
      status: "pending",
      metadata: this.meta(ref),
    }),
  };

  readonly users: ProviderAdapter["users"] = {
    resolveById: async (id) => this.usersById.get(id) ?? null,
    resolveByUsername: async (username) =>
      this.usersByUsername.get(username) ?? null,
  };

  readonly webhooks: ProviderAdapter["webhooks"] = {
    register: async (input) => {
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
    unregister: async (id) => {
      this.webhooksById.delete(id);
    },
    verifySignature: async (input) =>
      input.headers["x-gitlab-token"] === input.secret ||
      input.headers["X-Gitlab-Token"] === input.secret,
  };

  async bootstrap(
    spec: ProviderBootstrapSpec,
    credential: ProviderCredential,
  ): Promise<ProviderBootstrapResult> {
    void credential;
    const group = {
      id: `fake-group-${spec.environment}`,
      metadata: this.meta(`fake-group-${spec.environment}`),
    };
    const project = {
      id: `fake-project-${spec.environment}`,
      metadata: this.meta(`fake-project-${spec.environment}`),
    };
    const engine = this.upsertBot(spec.bots?.engine ?? defaultEngineBot());
    const reviewer = this.upsertBot(
      spec.bots?.reviewer ?? defaultReviewerBot(),
    );
    const webhookSecret =
      spec.webhook.secret ?? `fake-webhook-secret-${spec.environment}`;
    const env = {
      GITLAB_BASE_URL: spec.base_url,
      GITLAB_DEV_PROJECT_ID: project.id,
      GITLAB_TOKEN: `fake-token-${engine.username}`,
      GITLAB_REVIEWER_TOKEN: `fake-token-${reviewer.username}`,
      GITLAB_WEBHOOK_SECRET: webhookSecret,
      OAUTH_CLIENT_ID: `fake-oauth-${spec.environment}`,
      OAUTH_CLIENT_SECRET: `fake-oauth-secret-${spec.environment}`,
    };
    return {
      provider: this.provider,
      environment: spec.environment,
      base_url: spec.base_url,
      group,
      project,
      bot_users: { engine, reviewer },
      bot_tokens: {
        engine: env.GITLAB_TOKEN,
        reviewer: env.GITLAB_REVIEWER_TOKEN,
      },
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
        { resource: "project", status: "existing", provider_id: project.id },
        { resource: "bot:engine", status: "rotated", provider_id: engine.id },
        {
          resource: "bot:reviewer",
          status: "rotated",
          provider_id: reviewer.id,
        },
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
    kind: "issue" | "epic",
    input: CreateIssueInput,
  ): ProviderIssue {
    const id = `${kind}-${this.issueSeq++}`;
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

  private updateIssue(id: ProviderId, input: UpdateIssueInput): ProviderIssue {
    const current = this.requireIssue(id);
    return this.replaceIssue(id, {
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
    id: ProviderId,
    state: ProviderIssueState,
  ): ProviderIssue {
    const current = this.requireIssue(id);
    return this.replaceIssue(id, {
      ...current,
      state,
      metadata: this.meta(id),
    });
  }

  private replaceIssue(id: ProviderId, issue: ProviderIssue): ProviderIssue {
    this.issuesById.set(id, issue);
    return issue;
  }

  private requireIssue(id: ProviderId): ProviderIssue {
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
