import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { SecretEncryption } from "./secret-encryption.js";

/**
 * COL-2.14b — OAuth credential store.
 *
 * Persists Pi-shaped AuthStorage payloads encrypted at rest. The repository
 * is the only place plaintext crosses a Postgres boundary; callers receive
 * decrypted payloads as opaque JSON and re-encrypt before persistence.
 *
 * One active connection per provider key. `upsertConnection` REPLACES any
 * prior row for the same provider in a single transaction so a reconnect
 * cleanly wipes stale ciphertext.
 *
 * `recordRefresh` is the write-back hook for Pi's AuthStorage — when the
 * SDK refreshes a token mid-run, the runner-side AuthStorage adapter calls
 * this with the new payload; the row is rewritten in place (id stable).
 *
 * Pending-state rows back the OAuth code-grant CSRF / PKCE flow used by
 * the admin API (COL-2.14c). They TTL out quickly; the repo exposes a
 * sweep that the admin route calls before consuming a state token.
 */

export type OAuthProviderApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "azure-openai-responses"
  | "google-generative-ai"
  | "google-gemini-cli"
  | "google-vertex"
  | "mistral-conversations"
  | "bedrock-converse-stream";

export type OAuthConnectionStatus = "active" | "expired" | "revoked";

export interface OAuthConnectionMetadata {
  readonly id: string;
  readonly providerKey: string;
  readonly providerApi: OAuthProviderApi;
  readonly status: OAuthConnectionStatus;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly refreshedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface OAuthConnection<
  TPayload = unknown,
> extends OAuthConnectionMetadata {
  readonly payload: TPayload;
}

export interface UpsertConnectionInput<TPayload> {
  readonly providerKey: string;
  readonly providerApi: OAuthProviderApi;
  readonly payload: TPayload;
  readonly grantedBy: string;
  readonly expiresAt?: Date | null;
}

export interface RecordRefreshInput<TPayload> {
  readonly id: string;
  readonly payload: TPayload;
  readonly expiresAt?: Date | null;
}

export interface CreatePendingStateInput {
  readonly providerKey: string;
  readonly initiator: string;
  readonly redirectUri: string;
  readonly pkceVerifier?: string;
  /** TTL in milliseconds (default 15 min). */
  readonly ttlMs?: number;
}

export interface PendingState {
  readonly stateToken: string;
  readonly providerKey: string;
  readonly initiator: string;
  readonly redirectUri: string;
  readonly pkceVerifier: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface ConnectionRow {
  id: string;
  provider_key: string;
  provider_api: OAuthProviderApi;
  ciphertext: Buffer;
  status: OAuthConnectionStatus;
  granted_by: string;
  granted_at: Date;
  refreshed_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

type MetaRow = Omit<ConnectionRow, "ciphertext">;

interface PendingStateRow {
  state_token: string;
  provider_key: string;
  initiator: string;
  redirect_uri: string;
  pkce_verifier: string | null;
  created_at: Date;
  expires_at: Date;
}

const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1000;

export class OAuthCredentialRepository {
  constructor(
    private readonly pool: Pool,
    private readonly crypto: SecretEncryption,
  ) {}

  // -------------------------------------------------------------------------
  // Connections.
  // -------------------------------------------------------------------------

  async upsertConnection<TPayload>(
    input: UpsertConnectionInput<TPayload>,
  ): Promise<OAuthConnectionMetadata> {
    const ciphertext = this.crypto.encrypt(JSON.stringify(input.payload));
    const id = `oauth-${randomUUID()}`;
    // Wipe any prior non-revoked row so the partial unique index permits the
    // insert. Done in a transaction so the table is never observed empty.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM provider_oauth_connections
         WHERE provider_key = $1 AND status <> 'revoked'`,
        [input.providerKey],
      );
      const { rows } = await client.query<MetaRow>(
        `INSERT INTO provider_oauth_connections
           (id, provider_key, provider_api, ciphertext, status,
            granted_by, granted_at, refreshed_at, expires_at)
         VALUES ($1, $2, $3, $4, 'active', $5, now(), NULL, $6)
         RETURNING id, provider_key, provider_api, status, granted_by,
                   granted_at, refreshed_at, expires_at, revoked_at`,
        [
          id,
          input.providerKey,
          input.providerApi,
          ciphertext,
          input.grantedBy,
          input.expiresAt ?? null,
        ],
      );
      await client.query("COMMIT");
      return mapMeta(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async recordRefresh<TPayload>(
    input: RecordRefreshInput<TPayload>,
  ): Promise<OAuthConnectionMetadata | null> {
    const ciphertext = this.crypto.encrypt(JSON.stringify(input.payload));
    const { rows } = await this.pool.query<MetaRow>(
      `UPDATE provider_oauth_connections
         SET ciphertext = $2,
             refreshed_at = now(),
             expires_at = COALESCE($3, expires_at),
             status = CASE WHEN status = 'expired' THEN 'active' ELSE status END
       WHERE id = $1 AND status <> 'revoked'
       RETURNING id, provider_key, provider_api, status, granted_by,
                 granted_at, refreshed_at, expires_at, revoked_at`,
      [input.id, ciphertext, input.expiresAt ?? null],
    );
    return rows[0] ? mapMeta(rows[0]) : null;
  }

  async getActiveConnection<TPayload>(
    providerKey: string,
  ): Promise<OAuthConnection<TPayload> | null> {
    const { rows } = await this.pool.query<ConnectionRow>(
      `SELECT id, provider_key, provider_api, ciphertext, status, granted_by,
              granted_at, refreshed_at, expires_at, revoked_at
       FROM provider_oauth_connections
       WHERE provider_key = $1 AND status = 'active'
       LIMIT 1`,
      [providerKey],
    );
    const row = rows[0];
    if (!row) return null;
    const json = this.crypto.decryptToString(row.ciphertext);
    let payload: TPayload;
    try {
      payload = JSON.parse(json) as TPayload;
    } catch (e) {
      throw new Error(
        `oauth connection ${row.id} payload was not valid JSON after decrypt: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return { ...mapMeta(row), payload };
  }

  async getConnectionMetadata(
    providerKey: string,
  ): Promise<OAuthConnectionMetadata | null> {
    const { rows } = await this.pool.query<MetaRow>(
      `SELECT id, provider_key, provider_api, status, granted_by,
              granted_at, refreshed_at, expires_at, revoked_at
       FROM provider_oauth_connections
       WHERE provider_key = $1
       ORDER BY granted_at DESC
       LIMIT 1`,
      [providerKey],
    );
    return rows[0] ? mapMeta(rows[0]) : null;
  }

  async listConnectionMetadata(): Promise<OAuthConnectionMetadata[]> {
    const { rows } = await this.pool.query<MetaRow>(
      `SELECT DISTINCT ON (provider_key)
              id, provider_key, provider_api, status, granted_by,
              granted_at, refreshed_at, expires_at, revoked_at
       FROM provider_oauth_connections
       ORDER BY provider_key, granted_at DESC`,
    );
    return rows.map(mapMeta);
  }

  async revokeConnection(
    providerKey: string,
  ): Promise<OAuthConnectionMetadata | null> {
    const { rows } = await this.pool.query<MetaRow>(
      `UPDATE provider_oauth_connections
         SET status = 'revoked', revoked_at = now()
       WHERE provider_key = $1 AND status <> 'revoked'
       RETURNING id, provider_key, provider_api, status, granted_by,
                 granted_at, refreshed_at, expires_at, revoked_at`,
      [providerKey],
    );
    return rows[0] ? mapMeta(rows[0]) : null;
  }

  async markExpired(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE provider_oauth_connections
         SET status = 'expired'
       WHERE id = $1 AND status = 'active'`,
      [id],
    );
  }

  // -------------------------------------------------------------------------
  // Pending OAuth state (CSRF / PKCE).
  // -------------------------------------------------------------------------

  async createPendingState(
    input: CreatePendingStateInput,
  ): Promise<PendingState> {
    const stateToken = `oauth-state-${randomUUID()}`;
    const ttl = input.ttlMs ?? DEFAULT_PENDING_TTL_MS;
    const expiresAt = new Date(Date.now() + ttl);
    const { rows } = await this.pool.query<PendingStateRow>(
      `INSERT INTO provider_oauth_pending_state
         (state_token, provider_key, initiator, redirect_uri, pkce_verifier,
          created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       RETURNING state_token, provider_key, initiator, redirect_uri,
                 pkce_verifier, created_at, expires_at`,
      [
        stateToken,
        input.providerKey,
        input.initiator,
        input.redirectUri,
        input.pkceVerifier ?? null,
        expiresAt,
      ],
    );
    return mapPending(rows[0]);
  }

  async consumePendingState(stateToken: string): Promise<PendingState | null> {
    const { rows } = await this.pool.query<PendingStateRow>(
      `DELETE FROM provider_oauth_pending_state
       WHERE state_token = $1 AND expires_at > now()
       RETURNING state_token, provider_key, initiator, redirect_uri,
                 pkce_verifier, created_at, expires_at`,
      [stateToken],
    );
    return rows[0] ? mapPending(rows[0]) : null;
  }

  async sweepExpiredPendingState(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM provider_oauth_pending_state WHERE expires_at <= now()`,
    );
    return rowCount ?? 0;
  }
}

const toIso = (d: Date) => d.toISOString();

function mapMeta(r: MetaRow): OAuthConnectionMetadata {
  return {
    id: r.id,
    providerKey: r.provider_key,
    providerApi: r.provider_api,
    status: r.status,
    grantedBy: r.granted_by,
    grantedAt: toIso(r.granted_at),
    refreshedAt: r.refreshed_at ? toIso(r.refreshed_at) : null,
    expiresAt: r.expires_at ? toIso(r.expires_at) : null,
    revokedAt: r.revoked_at ? toIso(r.revoked_at) : null,
  };
}

function mapPending(r: PendingStateRow): PendingState {
  return {
    stateToken: r.state_token,
    providerKey: r.provider_key,
    initiator: r.initiator,
    redirectUri: r.redirect_uri,
    pkceVerifier: r.pkce_verifier,
    createdAt: toIso(r.created_at),
    expiresAt: toIso(r.expires_at),
  };
}
