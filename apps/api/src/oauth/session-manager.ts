import { randomUUID } from "node:crypto";
import type { OAuthProviderApi } from "@colony/db";
import type { OAuthDriver, OAuthSessionHandle } from "./types.js";

/**
 * In-memory store of in-flight OAuth sessions. Each entry holds the driver
 * handle and a TTL; callers retrieve a session by id, submit a code, and
 * the driver resolves the credential payload.
 *
 * The store is intentionally process-local — a worker restart drops all
 * pending sessions, the operator clicks Connect again. Persisting them
 * isn't worth the complexity given they're short-lived and contain
 * untrusted in-flight tokens.
 *
 * `provider_oauth_pending_state` exists for any DB-side CSRF/PKCE state
 * an alternate driver might want to outlast a process restart; this
 * default in-memory manager doesn't use it.
 */

interface SessionEntry {
  readonly handle: OAuthSessionHandle;
  readonly initiator: string;
  readonly providerKey: string;
  readonly providerApi: OAuthProviderApi;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly authorizeUrl: string;
}

export interface OAuthSessionManagerOptions {
  /** Default 15 minutes. */
  readonly ttlMs?: number;
  readonly clock?: () => number;
}

export class OAuthSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly driver: OAuthDriver,
    options: OAuthSessionManagerOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    this.clock = options.clock ?? Date.now;
  }

  async begin(input: {
    readonly providerKey: string;
    readonly providerApi: SessionEntry["providerApi"];
    readonly initiator: string;
  }): Promise<{
    readonly sessionId: string;
    readonly authorizeUrl: string;
    readonly instructions?: string;
    readonly expiresAt: string;
  }> {
    this.sweepExpired();
    const begun = await this.driver.begin({
      providerKey: input.providerKey,
      providerApi: input.providerApi,
      initiator: input.initiator,
    });
    // Driver provides a handle; we assign a session id (UUID) the API client
    // uses on the wire. The handle.id and session id are intentionally
    // separate so a buggy driver can't be coerced into accepting a forged
    // handle by the API caller.
    const sessionId = `oauth-session-${randomUUID()}`;
    const createdAt = this.clock();
    const entry: SessionEntry = {
      handle: begun.handle,
      initiator: input.initiator,
      providerKey: input.providerKey,
      providerApi: input.providerApi,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      authorizeUrl: begun.result.authorizeUrl,
    };
    this.sessions.set(sessionId, entry);
    return {
      sessionId,
      authorizeUrl: begun.result.authorizeUrl,
      instructions: begun.result.instructions,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  async submit(input: {
    readonly sessionId: string;
    readonly initiator: string;
    readonly code: string;
  }): Promise<{
    readonly providerKey: string;
    readonly providerApi: string;
    readonly credentials: {
      readonly access: string;
      readonly refresh: string;
      readonly expires: number;
      readonly [key: string]: unknown;
    };
  }> {
    const entry = this.requireSession(input.sessionId, input.initiator);
    const credentials = await this.driver.submitCode(entry.handle, {
      code: input.code,
    });
    this.sessions.delete(input.sessionId);
    return {
      providerKey: entry.providerKey,
      providerApi: entry.providerApi,
      credentials,
    };
  }

  async cancel(input: {
    readonly sessionId: string;
    readonly initiator: string;
  }): Promise<void> {
    const entry = this.sessions.get(input.sessionId);
    if (!entry) return;
    if (entry.initiator !== input.initiator) {
      throw new OAuthSessionError(
        "FORBIDDEN",
        "session belongs to a different initiator",
      );
    }
    await this.driver.cancel(entry.handle).catch(() => {});
    this.sessions.delete(input.sessionId);
  }

  /** Test/debug introspection only. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  size(): number {
    this.sweepExpired();
    return this.sessions.size;
  }

  private requireSession(sessionId: string, initiator: string): SessionEntry {
    this.sweepExpired();
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new OAuthSessionError(
        "NOT_FOUND",
        `oauth session ${sessionId} not found or expired`,
      );
    }
    if (entry.initiator !== initiator) {
      throw new OAuthSessionError(
        "FORBIDDEN",
        "session belongs to a different initiator",
      );
    }
    return entry;
  }

  private sweepExpired(): void {
    const now = this.clock();
    for (const [id, entry] of this.sessions) {
      if (entry.expiresAt <= now) {
        this.driver.cancel(entry.handle).catch(() => {});
        this.sessions.delete(id);
      }
    }
  }
}

export class OAuthSessionError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "FORBIDDEN" | "INVALID",
    message: string,
  ) {
    super(message);
    this.name = "OAuthSessionError";
  }
}
