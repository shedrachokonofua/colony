import type { OAuthProviderApi } from "@colony/db";

/**
 * COL-2.14c — admin-API-side abstraction over Pi's OAuth helpers.
 *
 * Pi's per-provider login functions (`loginOpenAICodex`, `loginAnthropic`)
 * bake in `localhost:1455/auth/callback` and a manual-paste fallback —
 * they're CLI-shaped. Server-side OAuth in Colony (running inside a
 * container with no operator browser on its loopback) needs an alternate
 * orchestration: the driver yields the authorize URL to the operator, waits
 * on Pi's localhost callback or a manual code/URL paste, then resolves to
 * OAuth credentials.
 *
 * The interface here lets COL-2.14c land complete and testable with a
 * stub driver. COL-2.15 swaps in the production Pi-backed implementation
 * (which can either embed Pi's login() with a pre-bound localhost:1455 to
 * force its manual-paste branch, or re-implement the OAuth code-grant
 * directly against the providers' constants).
 */

export interface OAuthBeginInput {
  readonly providerKey: string;
  readonly providerApi: OAuthProviderApi;
  /** Actor that initiated the flow; used when a driver can persist on callback. */
  readonly initiator: string;
}

export interface OAuthBeginResult {
  /**
   * URL the operator opens in a browser to consent. Some providers also
   * supply human-readable instructions (e.g. "after consent you'll be
   * redirected to a localhost URL — copy the code from the address bar").
   */
  readonly authorizeUrl: string;
  readonly instructions?: string;
}

export interface OAuthSubmitInput {
  /**
   * Whatever the operator copied. For Codex/Anthropic via Pi this is the
   * authorization code (sometimes wrapped in the failed-redirect URL —
   * the driver is responsible for parsing that).
   */
  readonly code: string;
}

export interface OAuthCredentialsBlob {
  /**
   * The Pi-shaped `OAuthCredentials` payload the runner consumes via Pi's
   * `getApiKey(credentials)`. Opaque to Colony; persisted as JSON inside
   * the encrypted ciphertext column.
   */
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly [key: string]: unknown;
}

export interface OAuthDriver {
  /**
   * Begin a server-side OAuth login session. The driver must continue running
   * in the background and resolve credentials after either the provider's
   * localhost callback succeeds or submitCode supplies the manual fallback.
   */
  begin(input: OAuthBeginInput): Promise<{
    readonly result: OAuthBeginResult;
    /** Driver-side handle the session manager passes to submitCode/cancel. */
    readonly handle: OAuthSessionHandle;
  }>;

  submitCode(
    handle: OAuthSessionHandle,
    input: OAuthSubmitInput,
  ): Promise<OAuthCredentialsBlob>;

  cancel(handle: OAuthSessionHandle): Promise<void>;
}

/**
 * Opaque handle the session manager hands back to the driver on
 * submit/cancel. Drivers store whatever in-memory state they need
 * (PKCE verifier, pending promise resolvers) keyed on this id.
 */
export interface OAuthSessionHandle {
  readonly id: string;
  readonly providerKey: string;
}
