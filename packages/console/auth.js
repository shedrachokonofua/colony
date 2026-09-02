// Keycloak authorization-code + PKCE client for the console. Ported from the
// monolith's auth block (app.js); colonyd validates the bearer, the browser
// only obtains and refreshes it. Session tokens live in sessionStorage so a
// closed tab signs the operator out; storage failures degrade to in-memory.

/**
 * @typedef {Object} OidcConfig
 * @property {string} client_id
 * @property {string} issuer
 */

/**
 * @typedef {Object} Auth
 * @property {string} token    Keycloak access token (bearer for the API).
 * @property {string} refresh  Refresh token for #ensureFreshToken.
 * @property {number} exp      Token expiry, epoch ms.
 * @property {string} username Display name from the ID token claims.
 */

const AUTH_KEY = "colony.auth";
const PKCE_KEY = "colony.pkce";

/** @returns {Auth | null} the persisted session, or null when signed out. */
export function loadAuth() {
  try {
    const raw = sessionStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** @param {Auth | null} auth [null] clears the persisted session. */
export function saveAuth(auth) {
  try {
    if (auth) sessionStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    else sessionStorage.removeItem(AUTH_KEY);
  } catch {
    /* storage unavailable: keep the in-memory session only */
  }
}

/** @param {Uint8Array} bytes */
function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** @param {string} token */
function decodeJwt(token) {
  try {
    return JSON.parse(
      atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")),
    );
  } catch {
    return {};
  }
}

/** Redirect to Keycloak with a PKCE challenge; colonyd completes the grant. */
/** @param {OidcConfig} oidc */
export async function beginLogin(oidc) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(
    PKCE_KEY,
    JSON.stringify({ verifier, nonce, hash: location.hash }),
  );
  const params = new URLSearchParams({
    client_id: oidc.client_id,
    redirect_uri: `${location.origin}/`,
    response_type: "code",
    scope: "openid profile email",
    state: nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  location.assign(`${oidc.issuer}/protocol/openid-connect/auth?${params}`);
}

/**
 * @param {OidcConfig} oidc
 * @param {Record<string, string>} body grant_type + its credentials
 * @returns {Promise<Auth>} the persisted grant
 */
async function tokenGrant(oidc, body) {
  const res = await fetch(`${oidc.issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oidc.client_id,
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`sign-in failed (${res.status})`);
  const data = await res.json();
  const claims = decodeJwt(data.access_token);
  const auth = {
    token: data.access_token,
    refresh: data.refresh_token,
    exp: (claims.exp || 0) * 1000,
    username: claims.preferred_username || claims.email || "operator",
  };
  saveAuth(auth);
  return auth;
}

/**
 * Finish a ?code= redirect: swap the code for tokens when PKCE state matches.
 * @param {OidcConfig} oidc
 * @returns {Promise<Auth | null>} null when no redirect is in flight or the
 *   state check fails (the operator just lands back on the console signed out).
 */
export async function completeLogin(oidc) {
  const query = new URLSearchParams(location.search);
  const code = query.get("code");
  if (!code) return null;
  const stash = JSON.parse(sessionStorage.getItem(PKCE_KEY) || "null");
  sessionStorage.removeItem(PKCE_KEY);
  history.replaceState(null, "", `/${stash?.hash || ""}`);
  if (!stash || stash.nonce !== query.get("state")) return null;
  return tokenGrant(oidc, {
    grant_type: "authorization_code",
    code,
    redirect_uri: `${location.origin}/`,
    code_verifier: stash.verifier,
  });
}

/**
 * Refresh proactively a minute early; a failed refresh signs the operator out.
 * @param {OidcConfig} oidc
 * @param {Auth | null} auth
 * @returns {Promise<Auth | null>}
 */
export async function ensureFreshToken(oidc, auth) {
  if (!auth) return auth;
  if (Date.now() < auth.exp - 60_000) return auth;
  try {
    return await tokenGrant(oidc, {
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
    });
  } catch {
    saveAuth(null);
    return null;
  }
}

/** Clear the session locally and end it at Keycloak when one is configured. */
/** @param {OidcConfig | null} oidc */
export function signOut(oidc) {
  saveAuth(null);
  const issuer = oidc?.issuer;
  if (issuer) {
    const params = new URLSearchParams({
      client_id: oidc.client_id,
      post_logout_redirect_uri: `${location.origin}/`,
    });
    location.assign(`${issuer}/protocol/openid-connect/logout?${params}`);
  }
}
