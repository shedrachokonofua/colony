/** Pure credential resolution: flags, environment, then stored credentials. */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stringFlag, UsageError } from "./args.js";

export const DEFAULT_SERVER = "https://colony.home.shdr.ch";
export const DEFAULT_ISSUER = "https://auth.shdr.ch/realms/aether";
export const DEVICE_CLIENT_ID = "colony-cli";

/** Refresh or re-mint when the access token has less than this long to live. */
export const EXPIRY_MARGIN_MS = 60_000;

export type TokenSource =
  | "flag"
  | "env"
  | "credentials"
  | "file"
  | "env-client-credentials";

/** A freshly minted token set from the identity provider. */
export interface MintedToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds; absent means "no known expiry". */
  expiresAt?: number;
}

/** Network grants resolveCredentials needs; implemented by oidc.ts. */
export interface CredentialOps {
  mint(input: {
    issuer: string;
    clientId: string;
    clientSecret: string;
  }): Promise<MintedToken>;
  refresh(input: {
    issuer: string;
    clientId: string;
    refreshToken: string;
  }): Promise<MintedToken>;
}

/** Persisted `~/.config/colony/credentials.json` contents (file mode 0600). */
export interface StoredCredentials {
  issuer: string;
  client_id: string;
  grant: "device" | "client_credentials";
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds; absent means "no known expiry". */
  expires_at?: number;
  /** Only for grant "client_credentials"; the 0600 mode makes this safe. */
  client_secret?: string;
}

export function resolveServer(
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
): string {
  const flag = stringFlag(flags, "server");
  if (flag) return flag;
  const fromEnv = env.COLONY_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return DEFAULT_SERVER;
}

/** OIDC issuer for login and env-var token minting. */
export function resolveIssuer(
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
): string {
  const flag = stringFlag(flags, "issuer");
  if (flag) return flag.replace(/\/+$/, "");
  const fromEnv = env.COLONY_OIDC_ISSUER;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().replace(/\/+$/, "");
  return DEFAULT_ISSUER;
}

/**
 * Resolve an API token: --token, COLONY_TOKEN, stored credentials (refreshed
 * or re-minted when within EXPIRY_MARGIN_MS of expiry), the legacy token
 * file, then an in-memory mint from COLONY_CLIENT_ID / COLONY_CLIENT_SECRET.
 */
export async function resolveCredentials(
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  ops: CredentialOps,
): Promise<{ token: string; source: TokenSource }> {
  const flag = stringFlag(flags, "token");
  if (flag) return { token: flag, source: "flag" };
  const fromEnv = env.COLONY_TOKEN;
  if (fromEnv && fromEnv.trim())
    return { token: fromEnv.trim(), source: "env" };

  const stored = readCredentials(homeDir);
  if (stored) {
    return {
      token: await freshen(stored, homeDir, ops),
      source: "credentials",
    };
  }

  const legacy = readTokenFile(join(homeDir, ".config", "colony", "token"));
  if (legacy) return { token: legacy, source: "file" };

  const clientId = env.COLONY_CLIENT_ID?.trim();
  const clientSecret = env.COLONY_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) {
    // In-memory mint: env-var credentials never touch the filesystem.
    const minted = await ops.mint({
      issuer: env.COLONY_OIDC_ISSUER?.trim() || DEFAULT_ISSUER,
      clientId,
      clientSecret,
    });
    return { token: minted.accessToken, source: "env-client-credentials" };
  }

  throw new UsageError(
    "no API token: pass --token, set COLONY_TOKEN, run `colony login`, or set COLONY_CLIENT_ID / COLONY_CLIENT_SECRET",
  );
}

export function resolveActor(
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
): string {
  const flag = stringFlag(flags, "actor");
  if (flag) return flag;
  const fromEnv = env.COLONY_ACTOR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const user = env.USER;
  if (user && user.trim()) return user.trim();
  return "unknown";
}

/** Human label for an auth failure message. */
export function describeTokenSource(source: TokenSource): string {
  switch (source) {
    case "flag":
      return "token from --token";
    case "env":
      return "token from COLONY_TOKEN";
    case "credentials":
      return "token from ~/.config/colony/credentials.json";
    case "file":
      return "token from ~/.config/colony/token";
    case "env-client-credentials":
      return "token minted from COLONY_CLIENT_ID / COLONY_CLIENT_SECRET";
  }
}

export function credentialsPath(homeDir: string): string {
  return join(homeDir, ".config", "colony", "credentials.json");
}

/** Parse a credentials.json document; malformed input reads as absent. */
export function parseCredentials(text: string): StoredCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const c = parsed as Record<string, unknown>;
  if (
    typeof c.issuer !== "string" ||
    typeof c.client_id !== "string" ||
    typeof c.access_token !== "string" ||
    (c.grant !== "device" && c.grant !== "client_credentials")
  ) {
    return undefined;
  }
  return {
    issuer: c.issuer,
    client_id: c.client_id,
    grant: c.grant,
    access_token: c.access_token,
    refresh_token:
      typeof c.refresh_token === "string" && c.refresh_token !== ""
        ? c.refresh_token
        : undefined,
    expires_at: typeof c.expires_at === "number" ? c.expires_at : undefined,
    client_secret:
      typeof c.client_secret === "string" && c.client_secret !== ""
        ? c.client_secret
        : undefined,
  };
}

export function serializeCredentials(creds: StoredCredentials): string {
  return `${JSON.stringify(creds, null, 2)}\n`;
}

export function readCredentials(
  homeDir: string,
): StoredCredentials | undefined {
  let text: string;
  try {
    text = readFileSync(credentialsPath(homeDir), "utf8");
  } catch {
    return undefined;
  }
  return parseCredentials(text);
}

/** Write credentials.json with mode 0600 (chmod covers pre-existing files). */
export function writeCredentials(
  homeDir: string,
  creds: StoredCredentials,
): void {
  const path = credentialsPath(homeDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, serializeCredentials(creds), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Remove credentials.json; returns whether a file was actually deleted. */
export function deleteCredentials(homeDir: string): boolean {
  try {
    rmSync(credentialsPath(homeDir));
    return true;
  } catch {
    return false;
  }
}

/** Return a usable access token, refreshing or re-minting when near expiry. */
async function freshen(
  stored: StoredCredentials,
  homeDir: string,
  ops: CredentialOps,
): Promise<string> {
  const now = Date.now();
  const fresh =
    stored.expires_at === undefined ||
    stored.expires_at - now > EXPIRY_MARGIN_MS;
  if (fresh) return stored.access_token;

  const secret = stored.client_secret;
  if (stored.grant === "client_credentials" && secret !== undefined) {
    const minted = await mintedOrLoginError(() =>
      ops.mint({
        issuer: stored.issuer,
        clientId: stored.client_id,
        clientSecret: secret,
      }),
    );
    writeCredentials(homeDir, {
      ...stored,
      access_token: minted.accessToken,
      refresh_token: minted.refreshToken,
      expires_at: minted.expiresAt,
    });
    return minted.accessToken;
  }

  const refresh = stored.refresh_token;
  if (refresh !== undefined) {
    const minted = await mintedOrLoginError(() =>
      ops.refresh({
        issuer: stored.issuer,
        clientId: stored.client_id,
        refreshToken: refresh,
      }),
    );
    writeCredentials(homeDir, {
      ...stored,
      access_token: minted.accessToken,
      refresh_token: minted.refreshToken ?? refresh,
      expires_at: minted.expiresAt,
    });
    return minted.accessToken;
  }

  if (stored.expires_at !== undefined && stored.expires_at <= now) {
    throw new UsageError("stored credentials expired: run `colony login`");
  }
  // Nothing to refresh with and still valid for a few seconds: use as-is.
  return stored.access_token;
}

/** Label grant failures with the actionable recovery: re-run colony login. */
async function mintedOrLoginError(
  grant: () => Promise<MintedToken>,
): Promise<MintedToken> {
  try {
    return await grant();
  } catch (err) {
    throw new Error(
      `could not renew stored credentials: ${err instanceof Error ? err.message : String(err)} — run \`colony login\``,
    );
  }
}

function readTokenFile(path: string): string | undefined {
  let token: string;
  try {
    token = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const trimmed = token.trim();
  return trimmed === "" ? undefined : trimmed;
}
