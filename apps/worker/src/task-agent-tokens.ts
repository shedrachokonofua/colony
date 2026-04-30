import type { TaskGraphRepository } from "@colony/db";
import type {
  ActorId,
  Capability,
  ScopeId,
  Task,
  TaskId,
} from "@colony/domain";
import type { ProviderAdapter, ProviderProjectRef } from "@colony/provider";

const SUPERVISOR_ACTOR = "svc:supervisor" as ActorId;
const TASK_DEVELOPER_AGENT_TOKEN_SCOPES = ["api", "write_repository"] as const;
const TASK_READER_AGENT_TOKEN_SCOPES = ["api", "read_repository"] as const;
const GITLAB_DEVELOPER_ACCESS_LEVEL = 30;
// GitLab project access tokens for private repos need Developer-level access
// to clone reliably on the homelab instance. Repository write remains blocked
// by omitting `write_repository` from TASK_READER_AGENT_TOKEN_SCOPES.
const GITLAB_READER_ACCESS_LEVEL = 30;
const TOKEN_TTL_DAYS = 2;

export interface TaskAgentTokenDependencies {
  readonly repo: TaskGraphRepository;
  readonly providerAdapter: ProviderAdapter;
}

export interface MintedTaskAgentToken {
  readonly token: string;
  readonly token_id: string;
  readonly provider_project_id: string;
  readonly expires_at: string;
}

export interface MintTaskAgentTokenOptions {
  readonly purpose?: "developer" | "reader";
  readonly reason?: string;
}

export interface EphemeralProjectAgentToken {
  readonly token: string;
  readonly token_id: string;
  readonly provider_project_id: string;
  readonly expires_at: string;
}

export interface EphemeralProjectAgentTokenAudit {
  readonly scope_id?: ScopeId;
  readonly task_id?: TaskId;
  readonly actor?: ActorId;
  readonly capability?: Capability;
  readonly reason: string;
  readonly purpose: string;
}

export type RevokeTaskAgentTokenResult =
  | { readonly revoked: true; readonly token_id: string }
  | {
      readonly revoked: false;
      readonly reason: "no_active_token" | "provider_unsupported" | "failed";
      readonly error?: string;
    };

export async function mintTaskAgentToken(
  deps: TaskAgentTokenDependencies,
  input: {
    readonly task: Task;
    readonly project: ProviderProjectRef;
    readonly options?: MintTaskAgentTokenOptions;
  },
): Promise<MintedTaskAgentToken | null> {
  if (!deps.providerAdapter.accessTokens) {
    return null;
  }
  const tokenConfig = taskTokenConfig(input.options?.purpose ?? "developer");

  if (
    input.task.agent_token_id &&
    input.task.agent_token_project_id &&
    !input.task.agent_token_revoked_at
  ) {
    const replaced = await revokeTaskAgentToken(deps, {
      task: input.task,
      reason: "pre_mint_replacement",
    });
    if (!replaced.revoked && replaced.reason === "failed") {
      throw new Error(
        `failed to revoke existing task token before mint: ${replaced.error}`,
      );
    }
  }

  const expires_at = accessTokenExpiryDate();
  let minted;
  try {
    minted = await deps.providerAdapter.accessTokens.mint(input.project, {
      name: `colony-${tokenConfig.name}-${input.task.id}`,
      scopes: tokenConfig.scopes,
      access_level: tokenConfig.accessLevel,
      expires_at,
    });
  } catch (err) {
    const reason = errorReason(err);
    await deps.repo.writeAudit({
      scope_id: input.task.scope_id,
      task_id: input.task.id,
      actor: SUPERVISOR_ACTOR,
      action: "task.agent_token.mint_failed",
      capability: "task.assign",
      target_kind: "provider_project",
      target_id: input.project.id,
      reason,
      evidence: {
        provider: deps.providerAdapter.provider,
        provider_project_id: input.project.id,
        scopes: tokenConfig.scopes,
        purpose: tokenConfig.name,
      },
    });
    throw err;
  }

  try {
    await deps.repo.recordTaskAgentToken(
      {
        task_id: input.task.id,
        provider_project_id: minted.project_id,
        token_id: minted.id,
        expires_at: accessTokenExpiresAt(minted.expires_at || expires_at),
      },
      {
        actor: SUPERVISOR_ACTOR,
        capability: "task.assign",
        reason: input.options?.reason ?? `${tokenConfig.name}_run_token_minted`,
      },
    );
  } catch (err) {
    await deps.providerAdapter.accessTokens
      .revoke(input.project, minted.id)
      .catch(() => {});
    throw err;
  }

  return {
    token: minted.token,
    token_id: minted.id,
    provider_project_id: minted.project_id,
    expires_at: minted.expires_at || expires_at,
  };
}

export async function mintEphemeralProjectAgentToken(
  deps: TaskAgentTokenDependencies,
  input: {
    readonly project: ProviderProjectRef;
    readonly audit: EphemeralProjectAgentTokenAudit;
  },
): Promise<EphemeralProjectAgentToken | null> {
  if (!deps.providerAdapter.accessTokens) {
    return null;
  }

  const expires_at = accessTokenExpiryDate();
  let minted;
  try {
    minted = await deps.providerAdapter.accessTokens.mint(input.project, {
      name: `colony-${input.audit.purpose}-${packetSafeId(
        input.audit.task_id ?? input.audit.scope_id ?? "run",
      )}`,
      scopes: TASK_READER_AGENT_TOKEN_SCOPES,
      access_level: GITLAB_READER_ACCESS_LEVEL,
      expires_at,
    });
  } catch (err) {
    const reason = errorReason(err);
    await deps.repo.writeAudit({
      scope_id: input.audit.scope_id,
      task_id: input.audit.task_id,
      actor: input.audit.actor ?? SUPERVISOR_ACTOR,
      action: "agent_token.ephemeral_mint_failed",
      capability: input.audit.capability,
      target_kind: "provider_project",
      target_id: input.project.id,
      reason,
      evidence: {
        provider: deps.providerAdapter.provider,
        provider_project_id: input.project.id,
        scopes: TASK_READER_AGENT_TOKEN_SCOPES,
        purpose: input.audit.purpose,
      },
    });
    throw err;
  }

  await deps.repo.writeAudit({
    scope_id: input.audit.scope_id,
    task_id: input.audit.task_id,
    actor: input.audit.actor ?? SUPERVISOR_ACTOR,
    action: "agent_token.ephemeral_minted",
    capability: input.audit.capability,
    target_kind: "provider_access_token",
    target_id: minted.id,
    reason: input.audit.reason,
    evidence: {
      provider: deps.providerAdapter.provider,
      provider_project_id: minted.project_id,
      expires_at: accessTokenExpiresAt(minted.expires_at || expires_at),
      scopes: TASK_READER_AGENT_TOKEN_SCOPES,
      purpose: input.audit.purpose,
    },
  });

  return {
    token: minted.token,
    token_id: minted.id,
    provider_project_id: minted.project_id,
    expires_at: minted.expires_at || expires_at,
  };
}

export async function revokeEphemeralProjectAgentToken(
  deps: TaskAgentTokenDependencies,
  input: {
    readonly project: ProviderProjectRef;
    readonly token: EphemeralProjectAgentToken | null;
    readonly audit: EphemeralProjectAgentTokenAudit;
  },
): Promise<void> {
  if (!input.token || !deps.providerAdapter.accessTokens) return;
  try {
    await deps.providerAdapter.accessTokens.revoke(
      input.project,
      input.token.token_id,
    );
    await deps.repo.writeAudit({
      scope_id: input.audit.scope_id,
      task_id: input.audit.task_id,
      actor: input.audit.actor ?? SUPERVISOR_ACTOR,
      action: "agent_token.ephemeral_revoked",
      capability: input.audit.capability,
      target_kind: "provider_access_token",
      target_id: input.token.token_id,
      reason: input.audit.reason,
      evidence: {
        provider: deps.providerAdapter.provider,
        provider_project_id: input.token.provider_project_id,
        purpose: input.audit.purpose,
      },
    });
  } catch (err) {
    await deps.repo.writeAudit({
      scope_id: input.audit.scope_id,
      task_id: input.audit.task_id,
      actor: input.audit.actor ?? SUPERVISOR_ACTOR,
      action: "agent_token.ephemeral_revoke_failed",
      capability: input.audit.capability,
      target_kind: "provider_access_token",
      target_id: input.token.token_id,
      reason: errorReason(err),
      evidence: {
        provider: deps.providerAdapter.provider,
        provider_project_id: input.token.provider_project_id,
        purpose: input.audit.purpose,
      },
    });
  }
}

export async function revokeTaskAgentToken(
  deps: TaskAgentTokenDependencies,
  input: {
    readonly task: Task;
    readonly project?: ProviderProjectRef;
    readonly reason: string;
  },
): Promise<RevokeTaskAgentTokenResult> {
  const token_id = input.task.agent_token_id;
  const provider_project_id =
    input.task.agent_token_project_id ?? input.project?.id;
  if (!token_id || !provider_project_id || input.task.agent_token_revoked_at) {
    return { revoked: false, reason: "no_active_token" };
  }
  if (!deps.providerAdapter.accessTokens) {
    return { revoked: false, reason: "provider_unsupported" };
  }

  try {
    await deps.providerAdapter.accessTokens.revoke(
      input.project ?? { id: provider_project_id },
      token_id,
    );
    await deps.repo.markTaskAgentTokenRevoked(
      { task_id: input.task.id, token_id },
      {
        actor: SUPERVISOR_ACTOR,
        capability: "task.assign",
        reason: input.reason,
      },
    );
    return { revoked: true, token_id };
  } catch (err) {
    const reason = errorReason(err);
    await deps.repo.writeAudit({
      scope_id: input.task.scope_id,
      task_id: input.task.id,
      actor: SUPERVISOR_ACTOR,
      action: "task.agent_token.revoke_failed",
      capability: "task.assign",
      target_kind: "provider_access_token",
      target_id: token_id,
      reason,
      evidence: {
        provider: deps.providerAdapter.provider,
        provider_project_id,
      },
    });
    return { revoked: false, reason: "failed", error: reason };
  }
}

function accessTokenExpiryDate(now = new Date()): string {
  const expires = new Date(now.getTime() + TOKEN_TTL_DAYS * 24 * 60 * 60_000);
  return expires.toISOString().slice(0, 10);
}

function accessTokenExpiresAt(dateOnly: string): string {
  return `${dateOnly}T23:59:59.999Z`;
}

function taskTokenConfig(purpose: "developer" | "reader"): {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly accessLevel: number;
} {
  if (purpose === "reader") {
    return {
      name: "reader",
      scopes: TASK_READER_AGENT_TOKEN_SCOPES,
      accessLevel: GITLAB_READER_ACCESS_LEVEL,
    };
  }
  return {
    name: "task",
    scopes: TASK_DEVELOPER_AGENT_TOKEN_SCOPES,
    accessLevel: GITLAB_DEVELOPER_ACCESS_LEVEL,
  };
}

function packetSafeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
