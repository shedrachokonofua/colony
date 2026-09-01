/** Pure credential resolution: flags, environment, then the token file. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stringFlag, UsageError } from "./args.js";

export const DEFAULT_SERVER = "https://colony.home.shdr.ch";

export type TokenSource = "flag" | "env" | "file";

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

export function resolveCredentials(
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): { token: string; source: TokenSource } {
  const flag = stringFlag(flags, "token");
  if (flag) return { token: flag, source: "flag" };
  const fromEnv = env.COLONY_TOKEN;
  if (fromEnv && fromEnv.trim())
    return { token: fromEnv.trim(), source: "env" };
  const fromFile = readTokenFile(join(homeDir, ".config", "colony", "token"));
  if (fromFile) return { token: fromFile, source: "file" };
  throw new UsageError(
    "no API token: pass --token, set COLONY_TOKEN, or write ~/.config/colony/token",
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
    case "file":
      return "token from ~/.config/colony/token";
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
