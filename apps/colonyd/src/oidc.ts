import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

/**
 * Keycloak bearer-token verification for the operator API.
 *
 * colonyd validates RS256 access tokens issued by the aether realm
 * (https://auth.shdr.ch/realms/aether) directly against the realm JWKS —
 * the same in-app pattern the seven30 demo API and Grafana use. No
 * client secret exists: the UI is a public PKCE client.
 */

export interface OidcIdentity {
  readonly username: string;
  readonly email?: string;
}

export interface TokenVerifier {
  verify(token: string): Promise<OidcIdentity>;
}

export class OidcError extends Error {}

export interface OidcVerifierOptions {
  /** Issuer URL, e.g. https://auth.shdr.ch/realms/aether */
  readonly issuer: string;
  /** OAuth client_id the token must be issued to (azp or aud). */
  readonly clientId: string;
  /** Realm role required in realm_access.roles / roles. Empty: any user. */
  readonly requiredRole?: string;
  /** Test seam. */
  readonly fetchImpl?: typeof fetch;
  /** JWKS cache TTL in ms. */
  readonly jwksTtlMs?: number;
}

const CLOCK_SKEW_S = 30;

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  nbf?: number;
  sub?: string;
  email?: string;
  preferred_username?: string;
  roles?: string[];
  realm_access?: { roles?: string[] };
}

function decodeSegment<T>(segment: string): T {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
  } catch {
    throw new OidcError("malformed token");
  }
}

export function createOidcVerifier(
  options: OidcVerifierOptions,
): TokenVerifier {
  const issuer = options.issuer.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttl = options.jwksTtlMs ?? 10 * 60_000;

  let keys: Map<string, KeyObject> | undefined;
  let fetchedAt = 0;
  let loading: Promise<Map<string, KeyObject>> | undefined;

  async function fetchKeys(): Promise<Map<string, KeyObject>> {
    const discovery = await fetchImpl(
      `${issuer}/.well-known/openid-configuration`,
    );
    if (!discovery.ok) {
      throw new OidcError(`OIDC discovery failed: ${discovery.status}`);
    }
    const { jwks_uri: jwksUri } = (await discovery.json()) as {
      jwks_uri?: string;
    };
    if (!jwksUri) throw new OidcError("OIDC discovery has no jwks_uri");
    const res = await fetchImpl(jwksUri);
    if (!res.ok) throw new OidcError(`JWKS fetch failed: ${res.status}`);
    const { keys: jwks } = (await res.json()) as {
      keys?: ({ kid?: string; use?: string } & Record<string, unknown>)[];
    };
    const next = new Map<string, KeyObject>();
    for (const jwk of jwks ?? []) {
      if (jwk.use === "enc" || !jwk.kid) continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        // Skip keys node cannot import (e.g. unsupported curves).
      }
    }
    if (!next.size) throw new OidcError("JWKS contains no usable keys");
    keys = next;
    fetchedAt = Date.now();
    return next;
  }

  async function loadKeys(force: boolean): Promise<Map<string, KeyObject>> {
    if (keys && !force && Date.now() - fetchedAt < ttl) return keys;
    loading ??= fetchKeys().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  return {
    async verify(token: string): Promise<OidcIdentity> {
      const parts = token.split(".");
      if (parts.length !== 3) throw new OidcError("malformed token");
      const header = decodeSegment<JwtHeader>(parts[0]);
      const payload = decodeSegment<JwtPayload>(parts[1]);
      if (header.alg !== "RS256") {
        throw new OidcError(`unsupported token alg ${header.alg ?? "none"}`);
      }
      if (!header.kid) throw new OidcError("token has no kid");

      let key = (await loadKeys(false)).get(header.kid);
      // Unknown kid: the realm may have rotated keys — refetch once.
      key ??= (await loadKeys(true)).get(header.kid);
      if (!key) throw new OidcError("unknown signing key");

      const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
      const signature = Buffer.from(parts[2], "base64url");
      if (!cryptoVerify("RSA-SHA256", signed, key, signature)) {
        throw new OidcError("invalid token signature");
      }

      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp !== "number" || payload.exp < now - CLOCK_SKEW_S) {
        throw new OidcError("token expired");
      }
      if (typeof payload.nbf === "number" && payload.nbf > now + CLOCK_SKEW_S) {
        throw new OidcError("token not yet valid");
      }
      if (payload.iss !== issuer) throw new OidcError("wrong token issuer");

      const audiences = Array.isArray(payload.aud)
        ? payload.aud
        : payload.aud
          ? [payload.aud]
          : [];
      if (
        payload.azp !== options.clientId &&
        !audiences.includes(options.clientId)
      ) {
        throw new OidcError("token was not issued to this client");
      }

      if (options.requiredRole) {
        const roles = [
          ...(payload.realm_access?.roles ?? []),
          ...(payload.roles ?? []),
        ];
        if (!roles.includes(options.requiredRole)) {
          throw new OidcError(`missing required role ${options.requiredRole}`);
        }
      }

      const username =
        payload.preferred_username || payload.email || payload.sub;
      if (!username) throw new OidcError("token carries no identity");
      return { username, email: payload.email };
    },
  };
}
