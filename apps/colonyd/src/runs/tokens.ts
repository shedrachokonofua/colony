import type { ProviderAdapter, ProviderProjectRef } from "@colony/provider";

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
