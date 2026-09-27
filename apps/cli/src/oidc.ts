/**
 * OIDC network plumbing: discovery, client credentials, refresh, and the
 * RFC 8628 device authorization grant. The only auth module that performs
 * network I/O; every entry point takes an injectable fetch.
 */

import type { CredentialOps, MintedToken } from "./auth.js";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Injected clock for device-code polling (tests skip the real waits). */
export interface PollClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const REAL_CLOCK: PollClock = {
  now: () => Date.now(),
  sleep: (ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  },
};

/** RFC 8628 §3.5: slow_down adds 5 seconds to the polling interval. */
const SLOW_DOWN_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_DEVICE_TTL_S = 600;

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export class OidcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OidcError";
    this.code = code;
  }
}

export interface OidcEndpoints {
  token_endpoint: string;
  device_authorization_endpoint?: string;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalMs: number;
  expiresAt: number;
}

interface TokenJson {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** GET `<issuer>/.well-known/openid-configuration` and pick out endpoints. */
export async function discover(
  issuer: string,
  fetchFn: FetchLike = fetch,
): Promise<OidcEndpoints> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let body: Record<string, unknown>;
  try {
    const res = await fetchFn(url);
    body = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw new OidcError(
      "discovery_failed",
      `could not read ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const token = body.token_endpoint;
  if (typeof token !== "string" || token === "") {
    throw new OidcError("invalid_discovery", `${url} has no token_endpoint`);
  }
  const device = body.device_authorization_endpoint;
  return {
    token_endpoint: token,
    device_authorization_endpoint:
      typeof device === "string" && device !== "" ? device : undefined,
  };
}

/** client_credentials grant: mint an access token from a client secret. */
export async function clientCredentialsLogin(opts: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetchFn?: FetchLike;
}): Promise<MintedToken> {
  const fetchFn = opts.fetchFn ?? fetch;
  const { token_endpoint } = await discover(opts.issuer, fetchFn);
  return toMinted(
    await postForm(
      token_endpoint,
      {
        grant_type: "client_credentials",
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
      },
      fetchFn,
    ),
  );
}

/** refresh_token grant: trade a refresh token for a fresh access token. */
export async function refreshLogin(opts: {
  issuer: string;
  clientId: string;
  refreshToken: string;
  fetchFn?: FetchLike;
}): Promise<MintedToken> {
  const fetchFn = opts.fetchFn ?? fetch;
  const { token_endpoint } = await discover(opts.issuer, fetchFn);
  return toMinted(
    await postForm(
      token_endpoint,
      {
        grant_type: "refresh_token",
        refresh_token: opts.refreshToken,
        client_id: opts.clientId,
      },
      fetchFn,
    ),
  );
}

/** RFC 8628 step 1: obtain a user code to show the operator. */
export async function deviceAuthorize(opts: {
  issuer: string;
  clientId: string;
  scope?: string;
  fetchFn?: FetchLike;
}): Promise<{ authorization: DeviceAuthorization; tokenEndpoint: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const endpoints = await discover(opts.issuer, fetchFn);
  const endpoint = endpoints.device_authorization_endpoint;
  if (!endpoint) {
    throw new OidcError(
      "unsupported",
      `${opts.issuer} does not advertise a device_authorization_endpoint`,
    );
  }
  const body = (await postForm(
    endpoint,
    {
      client_id: opts.clientId,
      ...(opts.scope ? { scope: opts.scope } : {}),
    },
    fetchFn,
  )) as TokenJson & Record<string, unknown>;
  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
  } = body;
  if (
    typeof device_code !== "string" ||
    typeof user_code !== "string" ||
    typeof verification_uri !== "string"
  ) {
    throw new OidcError(
      body.error ?? "invalid_response",
      body.error_description ??
        `${endpoint} returned no device_code/user_code/verification_uri`,
    );
  }
  const intervalS =
    typeof body.interval === "number" ? body.interval : undefined;
  const ttlS =
    typeof body.expires_in === "number" ? body.expires_in : undefined;
  return {
    tokenEndpoint: endpoints.token_endpoint,
    authorization: {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: verification_uri,
      verificationUriComplete:
        typeof verification_uri_complete === "string"
          ? verification_uri_complete
          : undefined,
      intervalMs: (intervalS ?? DEFAULT_POLL_INTERVAL_MS / 1000) * 1000,
      expiresAt: Date.now() + (ttlS ?? DEFAULT_DEVICE_TTL_S) * 1000,
    },
  };
}

/** RFC 8628 step 3: poll the token endpoint until the user authorizes. */
export async function pollDeviceToken(opts: {
  tokenEndpoint: string;
  clientId: string;
  authorization: DeviceAuthorization;
  fetchFn?: FetchLike;
  clock?: PollClock;
}): Promise<MintedToken> {
  const fetchFn = opts.fetchFn ?? fetch;
  const clock = opts.clock ?? REAL_CLOCK;
  let intervalMs = opts.authorization.intervalMs;
  for (;;) {
    if (clock.now() >= opts.authorization.expiresAt) {
      throw new OidcError(
        "expired_token",
        "device code expired before authorization completed",
      );
    }
    await clock.sleep(intervalMs);
    const body = await postForm(
      opts.tokenEndpoint,
      {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: opts.authorization.deviceCode,
        client_id: opts.clientId,
      },
      fetchFn,
    );
    if (typeof body.access_token === "string" && body.access_token !== "") {
      return toMinted(body);
    }
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += SLOW_DOWN_MS;
        continue;
      case "expired_token":
        throw new OidcError(
          "expired_token",
          "device code expired before authorization completed",
        );
      case "access_denied":
        throw new OidcError("access_denied", "authorization was denied");
      default:
        throw new OidcError(
          body.error ?? "invalid_response",
          body.error_description ?? "token endpoint returned no access_token",
        );
    }
  }
}

/** Wire the oidc grants into the ops the credential resolver needs. */
export function credentialOps(fetchFn: FetchLike = fetch): CredentialOps {
  return {
    mint: (input) => clientCredentialsLogin({ ...input, fetchFn }),
    refresh: (input) => refreshLogin({ ...input, fetchFn }),
  };
}

async function postForm(
  endpoint: string,
  params: Record<string, string>,
  fetchFn: FetchLike,
): Promise<TokenJson> {
  let body: unknown;
  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    body = await res.json();
  } catch (err) {
    throw new OidcError(
      "token_endpoint_failed",
      `could not read ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return (body ?? {}) as TokenJson;
}

function toMinted(body: TokenJson): MintedToken {
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new OidcError(
      body.error ?? "invalid_response",
      body.error_description ?? "token endpoint returned no access_token",
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token !== ""
        ? body.refresh_token
        : undefined,
    expiresAt:
      typeof body.expires_in === "number"
        ? Date.now() + body.expires_in * 1000
        : undefined,
  };
}
