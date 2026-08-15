import type { Run, Store } from "@colony/core";
import type { ProviderAdapter, ProviderProjectRef } from "@colony/provider";
import { SERVICE_ACTOR } from "../context.js";

const TOKEN_TTL_DAYS = 2;
const GITLAB_DEVELOPER_ACCESS_LEVEL = 30;

export interface MintedToken {
  readonly token: string;
  readonly token_id: string | null;
  readonly expires_at: string;
}

function accessTokenExpiryDate(now = new Date()): string {
  const expires = new Date(now.getTime() + TOKEN_TTL_DAYS * 24 * 60 * 60_000);
  return expires.toISOString().slice(0, 10);
}

/**
 * Mint a per-run project access token. Returns null when the provider does
 * not support access tokens or single-token mode is active; callers then use
 * the shared GITLAB_TOKEN.
 */
export async function mintRunToken(
  provider: ProviderAdapter,
  project: ProviderProjectRef,
  input: {
    readonly name: string;
    readonly scopes: readonly string[];
    readonly singleToken: boolean;
    readonly fallbackToken?: string;
  },
): Promise<MintedToken | null> {
  if (input.singleToken) {
    if (!input.fallbackToken) {
      throw new Error(
        "COLONYD_SINGLE_TOKEN=1 requires a non-empty GITLAB_TOKEN",
      );
    }
    return {
      token: input.fallbackToken,
      token_id: null,
      expires_at: accessTokenExpiryDate(),
    };
  }
  if (!provider.accessTokens) return null;
  const minted = await provider.accessTokens.mint(project, {
    name: input.name,
    scopes: input.scopes,
    access_level: GITLAB_DEVELOPER_ACCESS_LEVEL,
    expires_at: accessTokenExpiryDate(),
  });
  return {
    token: minted.token,
    token_id: minted.id,
    expires_at: minted.expires_at,
  };
}

export async function revokeRunToken(
  provider: ProviderAdapter,
  project: ProviderProjectRef,
  minted: MintedToken | null,
): Promise<void> {
  if (!minted?.token_id || !provider.accessTokens) return;
  await provider.accessTokens.revoke(project, minted.token_id);
}

/**
 * Revoke provider tokens persisted on runs that the process no longer owns
 * (crash-reap / lease expiry). Idempotent: GitLab 404 is swallowed by the
 * adapter; a missing token_id is a no-op (single-token mode).
 */
export async function revokeTokensForRuns(
  store: Store,
  provider: ProviderAdapter,
  runs: readonly Pick<Run, "id" | "scope_id" | "task_id" | "token_id">[],
): Promise<void> {
  if (!provider.accessTokens) return;
  for (const run of runs) {
    if (!run.token_id) continue;
    const scope = store.getScope(run.scope_id);
    if (!scope) continue;
    const project: ProviderProjectRef = {
      id: scope.provider_project_id,
      path: scope.provider_project_path,
    };
    try {
      await provider.accessTokens.revoke(project, run.token_id);
      store.audit(SERVICE_ACTOR, "agent_token.revoked", {
        scope_id: run.scope_id,
        task_id: run.task_id,
        run_id: run.id,
        detail: { reason: "crash_reap", token_id: run.token_id },
      });
    } catch (err) {
      store.audit(SERVICE_ACTOR, "agent_token.revoke_failed", {
        scope_id: run.scope_id,
        task_id: run.task_id,
        run_id: run.id,
        detail: {
          token_id: run.token_id,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}
