/** `colony login` / `colony logout`: OAuth login and credential storage. */

import { homedir } from "node:os";
import type { ParsedCommand } from "../args.js";
import { stringFlag, UsageError } from "../args.js";
import {
  DEVICE_CLIENT_ID,
  deleteCredentials,
  resolveIssuer,
  writeCredentials,
} from "../auth.js";
import {
  clientCredentialsLogin,
  deviceAuthorize,
  pollDeviceToken,
  REAL_CLOCK,
  type FetchLike,
  type PollClock,
} from "../oidc.js";

const DEVICE_SCOPE = "openid offline_access";

/** Injectable I/O so the login flows stay testable. */
export interface LoginDeps {
  fetchFn: FetchLike;
  clock: PollClock;
  out: (text: string) => void;
}

export async function run(cmd: ParsedCommand): Promise<number> {
  return login(cmd, homedir(), process.env, {
    fetchFn: fetch,
    clock: REAL_CLOCK,
    out: (text) => {
      process.stderr.write(text);
    },
  });
}

export async function runLogout(): Promise<number> {
  return logout(homedir(), (text) => {
    process.stderr.write(text);
  });
}

export async function login(
  cmd: ParsedCommand,
  homeDir: string,
  env: NodeJS.ProcessEnv,
  deps: LoginDeps,
): Promise<number> {
  const issuer = resolveIssuer(cmd.flags, env);

  if (cmd.flags["client-credentials"] === true) {
    const clientId =
      stringFlag(cmd.flags, "client-id") ?? env.COLONY_CLIENT_ID?.trim();
    const clientSecret =
      stringFlag(cmd.flags, "client-secret") ??
      env.COLONY_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new UsageError(
        "login --client-credentials requires --client-id/--client-secret or COLONY_CLIENT_ID / COLONY_CLIENT_SECRET",
      );
    }
    const minted = await clientCredentialsLogin({
      issuer,
      clientId,
      clientSecret,
      fetchFn: deps.fetchFn,
    });
    writeCredentials(homeDir, {
      issuer,
      client_id: clientId,
      grant: "client_credentials",
      access_token: minted.accessToken,
      refresh_token: minted.refreshToken,
      expires_at: minted.expiresAt,
      client_secret: clientSecret,
    });
    deps.out(`logged in to ${issuer} (client credentials as ${clientId})\n`);
    return 0;
  }

  const clientId = env.COLONY_OIDC_CLIENT_ID?.trim() || DEVICE_CLIENT_ID;
  const { authorization, tokenEndpoint } = await deviceAuthorize({
    issuer,
    clientId,
    scope: DEVICE_SCOPE,
    fetchFn: deps.fetchFn,
  });
  deps.out(`verification URL: ${authorization.verificationUri}\n`);
  if (authorization.verificationUriComplete) {
    deps.out(`or open ${authorization.verificationUriComplete}\n`);
  }
  deps.out(`user code: ${authorization.userCode}\n`);
  deps.out("waiting for authorization...\n");
  const minted = await pollDeviceToken({
    tokenEndpoint,
    clientId,
    authorization,
    fetchFn: deps.fetchFn,
    clock: deps.clock,
  });
  writeCredentials(homeDir, {
    issuer,
    client_id: clientId,
    grant: "device",
    access_token: minted.accessToken,
    refresh_token: minted.refreshToken,
    expires_at: minted.expiresAt,
  });
  deps.out(`logged in to ${issuer} (device flow as ${clientId})\n`);
  return 0;
}

export function logout(homeDir: string, out: (text: string) => void): number {
  if (deleteCredentials(homeDir)) {
    out("logged out: removed ~/.config/colony/credentials.json\n");
  } else {
    out("not logged in: no ~/.config/colony/credentials.json\n");
  }
  return 0;
}
