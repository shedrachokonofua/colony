import type { OAuthCredentialRepository } from "@colony/db";

/**
 * COL-2.14b — Postgres-backed AuthStorage adapter.
 *
 * Pi's coding-agent SDK calls into an opaque token store at request time
 * (`getApiKey` for raw keys; `AuthStorage` for OAuth subscriptions). The
 * Pi-specific shape lives in `@mariozechner/pi-coding-agent`; we don't
 * import it here to keep CI from resolving Pi when AGENT_RUNTIME=fake.
 *
 * Instead this module exposes a minimal interface that Pi's AuthStorage
 * can structurally match: `load()` returns the token payload Pi needs,
 * `save(payload)` is invoked when Pi refreshes the token. Both calls go
 * through `OAuthCredentialRepository` so persistence stays in one place
 * and ciphertext never leaks to a runner.
 *
 * The runtime adapter for Pi will wrap an `OAuthAuthStorage<TPayload>`
 * instance into Pi's `AuthStorage` interface in COL-2.15. That wrapper
 * is the one place this module's `TPayload` is bound to Pi's actual
 * AuthStorage value type.
 */

export interface OAuthAuthStorage<TPayload = unknown> {
  /**
   * Returns the current token payload for `providerKey`. Resolves to null
   * when there is no active connection — runner must surface this as a
   * structured error rather than calling Pi without auth.
   */
  load(): Promise<TPayload | null>;
  /**
   * Persists a refreshed token payload back to Postgres in place. Called
   * by Pi when its OAuth client rotates the access token. The connection
   * id is taken from the row that was loaded; reconnects (which mint a
   * new id) go through `OAuthCredentialRepository.upsertConnection`.
   */
  save(payload: TPayload, expiresAt?: Date | null): Promise<void>;
}

export interface CreateOAuthAuthStorageInput {
  readonly providerKey: string;
  readonly repo: OAuthCredentialRepository;
  /**
   * Stamped on every save audit row in the future runner-side
   * implementation. Today the repo doesn't audit, but the runner will
   * pass an actor id so audit can land later without breaking callers.
   */
  readonly actor?: string;
}

export function createOAuthAuthStorage<TPayload = unknown>(
  input: CreateOAuthAuthStorageInput,
): OAuthAuthStorage<TPayload> {
  // The connection id is captured on first successful load and reused for
  // every subsequent save in the same run. A reconnect happening mid-run
  // (rare; would require an admin click) invalidates the captured id;
  // save() handles that by falling back to upsertConnection.
  let cachedId: string | null = null;

  return {
    async load(): Promise<TPayload | null> {
      const conn = await input.repo.getActiveConnection<TPayload>(
        input.providerKey,
      );
      if (!conn) {
        cachedId = null;
        return null;
      }
      cachedId = conn.id;
      return conn.payload;
    },
    async save(payload: TPayload, expiresAt?: Date | null): Promise<void> {
      if (cachedId) {
        const refreshed = await input.repo.recordRefresh<TPayload>({
          id: cachedId,
          payload,
          expiresAt,
        });
        if (refreshed) return;
        // Row went away (revoked between load and save) — fall through.
        cachedId = null;
      }
      const meta = await input.repo.getConnectionMetadata(input.providerKey);
      if (!meta || meta.status === "revoked") {
        throw new Error(
          `oauth save for ${input.providerKey} failed: no active connection`,
        );
      }
      // Upsert REPLACES the row with a new id; the next save in this
      // closure will pick the fresh id up via load().
      await input.repo.upsertConnection<TPayload>({
        providerKey: input.providerKey,
        providerApi: meta.providerApi,
        payload,
        grantedBy: input.actor ?? meta.grantedBy,
        expiresAt,
      });
      cachedId = null;
    },
  };
}
